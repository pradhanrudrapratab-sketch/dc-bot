'use strict';
const { classifyDiscordError } = require('./permissions');
const { embed } = require('../utils/embeds');
const logger = require('../utils/logger');

const DELETE_SECONDS = 7 * 86400;

const NOTICE_TITLE = '⛔ HONEYPOT CHANNEL';
const NOTICE_BODY = [
  '⚠️ **DO NOT SEND MESSAGES IN THIS CHANNEL**',
  'This channel is an automated honeypot trap monitored by DC Bot.',
  'Sending a message here may trigger an immediate server ban and a request to delete the sender\'s messages from the previous seven days.',
  'Use the community\'s normal channels instead.',
].join('\n');

const buildNotice = () => embed.error('HONEYPOT CHANNEL', NOTICE_BODY).setTitle(NOTICE_TITLE).setFooter({ text: 'DC Bot • Automated Security System' });
const buildDm = (guildName) =>
  `You have been banned from **${guildName}** because a message was detected in the server's honeypot security channel. ` +
  'If you believe this was a mistake or your account was compromised, contact the server administrators to appeal. ' +
  'This is an automated notification from DC Bot.';

/**
 * Pure decision: should this message trip the honeypot?
 * Ignores our own messages (no recursion), other bots, webhooks, system messages and other channels.
 */
function shouldTrigger({ message, settings, botId }) {
  if (!settings?.honeypot_enabled || !settings.honeypot_channel_id) return { trigger: false, reason: 'DISABLED' };
  if (message.channelId !== settings.honeypot_channel_id) return { trigger: false, reason: 'OTHER_CHANNEL' };
  if (message.authorId === botId) return { trigger: false, reason: 'SELF' };
  if (message.webhookId) return { trigger: false, reason: 'WEBHOOK' };
  if (message.system) return { trigger: false, reason: 'SYSTEM' };
  if (message.authorIsBot) return { trigger: false, reason: 'OTHER_BOT' };
  return { trigger: true };
}

/** Permission overwrites for the honeypot channel. Verified members are hidden so they cannot trip it by accident. */
function planHoneypotOverwrites({ everyoneId, verifiedRoleId, botId }) {
  const out = [
    { id: everyoneId, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'], deny: [] },
    { id: botId, allow: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ManageMessages'], deny: [] },
  ];
  if (verifiedRoleId) out.push({ id: verifiedRoleId, allow: [], deny: ['ViewChannel'] });
  return out;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

function createHoneypot({ moderation, audit, logs, now = () => Date.now() }) {
  const seen = new Map(); // `${guild}:${user}` -> ts (dedupe bursts of messages from one spammer)

  /**
   * @param {{message:object, guild:object, settings:object}} p  message is a plain summary
   * @returns {Promise<object>} outcome record
   */
  async function handleMessage({ message, guild, settings, discordMessage }) {
    const botId = guild.members.me.id;
    const decision = shouldTrigger({ message, settings, botId });
    if (!decision.trigger) return { handled: false, reason: decision.reason };

    const key = `${guild.id}:${message.authorId}`;
    const t = now();
    for (const [k, ts] of seen) if (t - ts > 60_000) seen.delete(k);
    if (seen.has(key)) return { handled: false, reason: 'DEDUPED' };
    seen.set(key, t);

    const outcome = { handled: true, userId: message.authorId, banned: false, deletionRequested: false, dmSent: false, errors: [] };

    // DM first: Discord usually blocks DMs once the user no longer shares a server with the bot.
    try {
      const user = await guild.client.users.fetch(message.authorId);
      await withTimeout(user.send(buildDm(guild.name)), 2500);
      outcome.dmSent = true;
    } catch (err) {
      outcome.errors.push(`dm:${classifyDiscordError(err)}`);
    }

    const r = await moderation.ban({
      guild, targetId: message.authorId, reason: 'Honeypot channel trigger', auto: true, deleteSeconds: DELETE_SECONDS,
    });
    outcome.banned = r.ok;
    outcome.deletionRequested = r.ok; // delivered via Discord's ban option; Discord does not report how many messages it removed
    if (!r.ok) {
      outcome.errors.push(`ban:${r.code}`);
      try { await discordMessage?.delete(); } catch { /* best effort cleanup of the spam */ }
    }

    await audit.recordSecurityEvent({
      guildId: guild.id, eventType: 'honeypot_trigger', actorId: message.authorId, targetId: message.authorId,
      evidence: { channelId: message.channelId, messageId: message.id, contentLength: message.contentLength ?? null },
      actionTaken: 'ban+delete7d+dm', outcome: JSON.stringify({ banned: outcome.banned, dm: outcome.dmSent, errors: outcome.errors }),
    });
    await logs.alertStaff(guild, {
      title: outcome.banned ? 'Honeypot triggered: member banned' : 'Honeypot triggered: ban FAILED',
      description: [
        `<@${message.authorId}> (\`${message.authorId}\`) posted in <#${message.channelId}>.`,
        `Ban: ${outcome.banned ? 'success (7-day message deletion requested)' : `failed (${r.message})`}`,
        `DM notice: ${outcome.dmSent ? 'delivered' : 'not delivered'}`,
        outcome.banned ? '' : 'A moderator must handle this member manually.',
      ].filter(Boolean).join('\n'),
      severity: outcome.banned ? 'warn' : 'error',
    }).catch((e) => logger.warn('[HONEYPOT] alert failed', { error: e }));
    return outcome;
  }

  /**
   * React to the configured honeypot channel being deleted. `executorId` MUST come from a matched audit-log
   * entry (guildAuditLogEntryCreate). A null executor is never guessed.
   */
  async function handleChannelDeleted({ guild, settings, executorId, authorizedIds, createChannel, onRecreated }) {
    const botId = guild.members.me.id;
    if (executorId === botId) return { handled: false, reason: 'SELF' };
    const result = { handled: true, executorId, authorized: null, recreated: false, banned: false, errors: [] };

    if (!executorId) result.errors.push('actor_unknown');
    else result.authorized = authorizedIds.has(executorId);

    try {
      const channel = await createChannel();
      result.recreated = true;
      result.newChannelId = channel.id;
      await onRecreated(channel);
    } catch (err) {
      result.errors.push(`recreate:${classifyDiscordError(err)}`);
    }

    if (executorId && result.authorized === false && settings.honeypot_tamper_action === 'ban') {
      const r = await moderation.ban({ guild, targetId: executorId, reason: 'Deleted the honeypot security channel', auto: true });
      result.banned = r.ok;
      if (!r.ok) result.errors.push(`ban:${r.code}`);
    }

    await audit.recordSecurityEvent({
      guildId: guild.id, eventType: 'honeypot_deleted', actorId: executorId, targetId: settings.honeypot_channel_id,
      evidence: { authorized: result.authorized }, actionTaken: result.banned ? 'ban' : 'alert', outcome: JSON.stringify(result.errors),
    });
    const problems = result.errors.length > 0;
    await logs.alertStaff(guild, {
      title: problems ? 'Honeypot channel deleted: attention needed' : 'Honeypot channel deleted and restored',
      description: [
        `Deleted by: ${executorId ? `<@${executorId}>${result.authorized ? ' (authorized)' : ''}` : '**unknown** (audit log did not identify the actor; not guessed)'}`,
        `Channel restored: ${result.recreated ? `yes → <#${result.newChannelId}>` : 'NO'}`,
        executorId && result.authorized === false ? `Security action (${settings.honeypot_tamper_action}): ${result.banned ? 'banned' : settings.honeypot_tamper_action === 'ban' ? 'ban failed' : 'alert only'}` : null,
        problems ? `Problems: ${result.errors.join(', ')}` : null,
      ].filter(Boolean).join('\n'),
      severity: problems ? 'error' : 'warn',
    }).catch(() => {});
    return result;
  }

  return { handleMessage, handleChannelDeleted };
}

module.exports = { createHoneypot, shouldTrigger, planHoneypotOverwrites, buildNotice, buildDm, DELETE_SECONDS };
