'use strict';
const { Events, PermissionFlagsBits } = require('discord.js');
const { parseOwoPayment, validatePayment } = require('../../services/payments');
const { parsePrefixMessage, prefixContext } = require('../../framework/prefixAdapter');
const { runCommand } = require('../../framework/runner');
const { buildInviteUrl } = require('../../utils/invite');
const { embed } = require('../../utils/embeds');
const logger = require('../../utils/logger');

const summary = (m) => ({
  id: m.id, guildId: m.guildId, channelId: m.channelId, authorId: m.author?.id, authorIsBot: !!m.author?.bot, webhookId: m.webhookId,
  system: !!m.system, content: m.content, contentLength: m.content?.length ?? 0,
  attachments: [...(m.attachments?.values?.() ?? [])].map((a) => ({ url: a.url, name: a.name, size: a.size })),
  embeds: (m.embeds || []).filter((e) => e.data?.type === 'rich' || e.data?.type === undefined).map((e) => e.data ?? e),
});

/** OwO payment -> subscription. Recoverable and idempotent (see services/payments). */
async function handlePayment(c, message) {
  const { config } = c;
  if (!message.guild || message.guild.id !== config.bot.masterGuildId || message.author.id !== config.bot.owoBotId) return false;
  const parsed = parseOwoPayment(message.content);
  if (!parsed) return false;
  const v = validatePayment(parsed, { ownerId: config.bot.ownerId, amount: config.subscription.amount });
  if (!v.ok) { logger.info(`[PAYMENT] ignored (${v.reason})`, { messageId: message.id }); return true; }

  let username = null;
  try { username = (await message.client.users.fetch(parsed.senderId)).tag; } catch { /* resolved below: payment must not be lost */ }
  const r = await c.payments.process({ messageId: message.id, ...parsed, username: username || undefined, placeholderName: !username });
  logger.info(`[PAYMENT] ${r.status}`, { messageId: message.id, senderId: parsed.senderId });
  if (r.status === 'FAILED') {
    await c.logs.alertSuperAdmins(config.bot.superAdmins, { content: `⚠️ Payment ${message.id} from <@${parsed.senderId}> was recorded but could not be activated (${r.error}). It will be retried automatically.` }).catch(() => {});
  }
  if (r.status === 'PROCESSED') {
    const days = Math.round(c.subs.durationMs / 86_400_000);
    try {
      const user = await message.client.users.fetch(parsed.senderId);
      await user.send({ embeds: [embed.success(r.renewed ? 'Subscription Renewed' : 'Payment Received', [
        r.renewed ? `Your subscription was extended by **${days} days**.` : `Your **${days}-day** Minecraft AFK subscription is active.`,
        `**Expires:** <t:${Math.floor(r.expiresAt / 1000)}:F>`, '',
        '**Next steps**', `1. [Invite the bot to your server](${buildInviteUrl(config.discord.clientId, PermissionFlagsBits)})`, '2. In your server run `/assign` (you need Administrator there)', '3. Control the AFK bot with `/status`, `/start`, `/stop`',
      ].join('\n'))] });
    } catch { logger.info('[PAYMENT] could not DM subscriber (DMs closed)'); }
  }
  return true;
}

async function handleAnnouncement(c, message) {
  if (!message.guild || message.author.id === message.client.user.id) return;
  const src = await c.announcements.getSource();
  const s = summary(message);
  if (!c.announcements.isEligible(s, src, message.client.user.id)) return;
  const results = await c.announcements.relay(s, async (guildId, channelId, payload) => {
    const guild = message.client.guilds.cache.get(guildId);
    const channel = guild ? await guild.channels.fetch(channelId).catch(() => null) : null;
    if (!channel?.send) throw Object.assign(new Error('channel missing'), { code: 10003 });
    await channel.send(payload);
  });
  const failed = results.filter((r) => r.status === 'FAILED');
  if (failed.length) logger.warn(`[ANNOUNCE] ${failed.length}/${results.length} deliveries failed`, { failed });
  await c.audit.record({ guildId: message.guildId, category: 'announcement', action: 'announcement_relayed', actorId: message.author.id, details: { sent: results.filter((r) => r.status === 'SENT').length, failed: failed.length } });
}

module.exports = {
  name: Events.MessageCreate,
  async execute(c, message) {
    if (message.partial) { try { await message.fetch(); } catch { return; } }

    // 1. OwO payment (a bot author, so it must run before the bot filter)
    if (await handlePayment(c, message).catch((e) => { logger.error('[PAYMENT] handler failed', { error: e }); return false; })) return;

    if (!message.guild) return;

    // 2. Announcement relay (own try/catch: must not block other handlers)
    await handleAnnouncement(c, message).catch((e) => logger.error('[ANNOUNCE] relay failed', { error: e }));

    // 3. Honeypot (non-bot, non-webhook, configured channel only)
    if (!message.author.bot && !message.webhookId) {
      const settings = await c.guildSettings.get(message.guildId);
      if (settings.honeypot_enabled && message.channelId === settings.honeypot_channel_id) {
        await c.honeypot.handleMessage({ message: summary(message), guild: message.guild, settings, discordMessage: message })
          .catch((e) => logger.error('[HONEYPOT] handler failed', { error: e }));
        return;
      }
    }

    if (message.author.bot || message.webhookId || message.system) return;

    // 4. Message snapshot for edit/delete logs (only when message logging is on for this guild)
    if (await c.logs.isEnabled(message.guildId, 'message').catch(() => false)) c.messageCache.put(message);

    // 5. Prefix commands
    const prefix = await c.guildSettings.getPrefix(message.guildId);
    const parsed = parsePrefixMessage(message.content, prefix, c.registry.prefix);
    if (!parsed) return;
    if (parsed.error) { await message.reply({ embeds: [embed.error('Invalid Usage', parsed.error)], allowedMentions: { parse: [], repliedUser: false } }).catch(() => {}); return; }
    await runCommand(parsed.command, prefixContext(message, parsed, c.deps), c.runEnv);
  },
};
