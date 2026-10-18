'use strict';
const { hierarchyFor, classifyDiscordError } = require('./permissions');
const { MAX_TIMEOUT_MS, formatDuration, DAY } = require('../utils/time');
const logger = require('../utils/logger');

const AUTO_TIMEOUT_MS = DAY; // warning #3
const MAX_BAN_DELETE_SECONDS = 7 * 86400;

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
const ok = (message, extra = {}) => ({ ok: true, code: 'SUCCESS', message, ...extra });

const ERROR_TEXT = {
  PERMISSION_OR_HIERARCHY: 'Discord refused the action (missing permission or role hierarchy changed).',
  MISSING_ACCESS: 'I no longer have access to that target.',
  UNKNOWN_TARGET: 'That user or member does not exist.',
  RATE_LIMITED: 'Discord rate-limited the request. Try again shortly.',
  NETWORK: 'Network problem talking to Discord. Try again.',
  DISCORD_SERVER_ERROR: 'Discord had a server error. Try again.',
};

/**
 * Moderation actions with permission + hierarchy pre-checks, honest failure reporting and auditing.
 * `guild` etc. are discord.js objects (duck-typed so tests can fake them).
 */
function createModeration({ warnings, audit, logs, now = () => Date.now() }) {
  const reasonFor = (reason, actorTag, actorId) => `${reason} | by ${actorTag || 'unknown'} (${actorId})`.slice(0, 512);
  const actorLabel = (actor) => ({ id: actor.id, tag: actor.user?.tag ?? actor.tag ?? actor.id });

  async function preflight({ guild, actorMember, targetId, needPerm, needMember }) {
    const me = guild.members.me;
    if (!me.permissions.has(needPerm)) return fail('BOT_MISSING_PERMISSION', `I need the **${needPerm}** permission for this.`, { missing: [needPerm] });
    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (needMember && !targetMember) return fail('NOT_IN_SERVER', 'That user is not in this server.');
    const h = hierarchyFor({ guild, actorMember, targetMember, targetId });
    if (!h.ok) return fail(h.reason, h.message);
    return { ok: true, targetMember };
  }

  async function finish({ guild, actor, targetId, action, reason, auto, result, details }) {
    await audit.record({
      guildId: guild.id, category: 'moderation', action: auto ? `auto_${action}` : action,
      actorId: actor.id, targetId, result: result.ok ? 'SUCCESS' : 'FAILED', details: { reason, code: result.code, message: result.ok ? undefined : result.message, ...details },
    });
    if (!result.ok && auto) {
      await logs.alertStaff(guild, {
        title: `Automatic ${action} failed`,
        description: `Could not ${action} <@${targetId}> automatically: ${result.message}\nA moderator needs to handle this manually.`,
        severity: 'error',
      }).catch(() => {});
    }
    return result;
  }

  async function run(ctxIn, { action, perm, needMember, call, success, details }) {
    const { guild, targetId, reason, auto = false } = ctxIn;
    const actorMember = ctxIn.actorMember;
    const actor = auto ? { id: guild.members.me.id, tag: 'DC Bot (automatic)' } : actorLabel(actorMember);
    const pre = await preflight({ guild, actorMember: auto ? null : actorMember, targetId, needPerm: perm, needMember });
    if (!pre.ok) return finish({ guild, actor, targetId, action, reason, auto, result: pre, details });
    try {
      await call(pre.targetMember, reasonFor(reason, actor.tag, actor.id));
      return finish({ guild, actor, targetId, action, reason, auto, result: ok(success), details });
    } catch (err) {
      const kind = classifyDiscordError(err);
      logger.warn(`[MOD] ${action} failed`, { error: err, guildId: guild.id, kind });
      return finish({ guild, actor, targetId, action, reason, auto, result: fail(kind, ERROR_TEXT[kind] || 'The action failed unexpectedly.'), details });
    }
  }

  const ban = (c) => run(c, {
    action: 'ban', perm: 'BanMembers', needMember: false,
    call: (_m, r) => c.guild.members.ban(c.targetId, { reason: r, deleteMessageSeconds: Math.min(Math.max(c.deleteSeconds || 0, 0), MAX_BAN_DELETE_SECONDS) }),
    success: `Banned <@${c.targetId}>.`, details: { deleteSeconds: c.deleteSeconds || 0 },
  });
  const kick = (c) => run(c, { action: 'kick', perm: 'KickMembers', needMember: true, call: (m, r) => m.kick(r), success: `Kicked <@${c.targetId}>.` });
  const timeout = (c) => {
    const ms = Math.min(c.durationMs, MAX_TIMEOUT_MS);
    return run(c, {
      action: 'timeout', perm: 'ModerateMembers', needMember: true, call: (m, r) => m.timeout(ms, r),
      success: `Timed out <@${c.targetId}> for ${formatDuration(ms)}.`, details: { durationMs: ms },
    });
  };
  const untimeout = (c) => run(c, { action: 'untimeout', perm: 'ModerateMembers', needMember: true, call: (m, r) => m.timeout(null, r), success: `Removed the timeout from <@${c.targetId}>.` });

  async function unban(c) {
    const { guild, targetId, reason } = c;
    const actor = actorLabel(c.actorMember);
    if (!guild.members.me.permissions.has('BanMembers')) {
      return finish({ guild, actor, targetId, action: 'unban', reason, result: fail('BOT_MISSING_PERMISSION', 'I need the **BanMembers** permission for this.', { missing: ['BanMembers'] }) });
    }
    try {
      await guild.members.unban(targetId, reasonFor(reason, actor.tag, actor.id));
      return finish({ guild, actor, targetId, action: 'unban', reason, result: ok(`Unbanned \`${targetId}\`.`) });
    } catch (err) {
      const kind = classifyDiscordError(err);
      const msg = kind === 'UNKNOWN_TARGET' ? 'That user is not banned (or the ID is wrong).' : ERROR_TEXT[kind] || 'The action failed unexpectedly.';
      return finish({ guild, actor, targetId, action: 'unban', reason, result: fail(kind, msg) });
    }
  }

  /** Issue a warning and carry out the automatic escalation. Never reports a failed action as success. */
  async function warn({ guild, actorMember, targetId, reason, idempotencyKey }) {
    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (!targetMember) return { ok: false, code: 'NOT_IN_SERVER', message: 'That user is not in this server.' };
    const h = hierarchyFor({ guild, actorMember, targetMember, targetId });
    if (!h.ok) return { ok: false, code: h.reason, message: h.message };

    const w = await warnings.add({ guildId: guild.id, userId: targetId, moderatorId: actorMember.id, reason, idempotencyKey });
    if (w.duplicate) return { ok: true, duplicate: true, activeCount: w.activeCount, action: w.action, escalation: null, message: 'This warning was already recorded.' };

    await audit.record({ guildId: guild.id, category: 'moderation', action: 'warn', actorId: actorMember.id, targetId, details: { reason, activeCount: w.activeCount, warningId: w.warningId, resetApplied: w.resetApplied } });

    let escalation = null;
    if (w.action !== 'none') {
      const base = { guild, targetId, reason: `Automatic action: warning #${w.activeCount} (${reason})`, auto: true };
      const r = w.action === 'timeout' ? await timeout({ ...base, durationMs: AUTO_TIMEOUT_MS })
        : w.action === 'kick' ? await kick(base)
          : await ban({ ...base, deleteSeconds: 0 });
      await warnings.recordEscalationResult(w.warningId, r.ok ? 'SUCCESS' : 'FAILED', r.ok ? null : r.message);
      escalation = { action: w.action, ok: r.ok, message: r.message };
    }
    return { ok: true, duplicate: false, activeCount: w.activeCount, action: w.action, escalation, warningId: w.warningId, resetApplied: w.resetApplied };
  }

  /** Bulk delete recent messages (Discord limits: 1-100, <14 days old). */
  async function purge({ guild, channel, actorMember, count, targetUserId = null }) {
    const actor = actorLabel(actorMember);
    const n = Math.floor(count);
    if (!(n >= 1 && n <= 100)) return fail('BAD_COUNT', 'Choose a number from 1 to 100.');
    const perms = channel.permissionsFor?.(guild.members.me);
    if (!perms?.has('ManageMessages') || !perms?.has('ReadMessageHistory')) {
      return finish({ guild, actor, targetId: targetUserId, action: 'purge', reason: `purge ${n}`, result: fail('BOT_MISSING_PERMISSION', 'I need **Manage Messages** and **Read Message History** in this channel.', { missing: ['ManageMessages', 'ReadMessageHistory'] }) });
    }
    try {
      let deleted;
      if (targetUserId) {
        const fetched = await channel.messages.fetch({ limit: 100 });
        const picked = [...fetched.values()].filter((m) => m.author.id === targetUserId).slice(0, n);
        deleted = await channel.bulkDelete(picked, true);
      } else {
        deleted = await channel.bulkDelete(n, true);
      }
      const size = deleted.size ?? deleted.length ?? 0;
      return finish({ guild, actor, targetId: targetUserId, action: 'purge', reason: `purge ${n}`, result: ok(`Deleted ${size} message(s).${size < n ? ' (Discord cannot bulk-delete messages older than 14 days.)' : ''}`, { deleted: size }), details: { channelId: channel.id, requested: n, deleted: size } });
    } catch (err) {
      const kind = classifyDiscordError(err);
      return finish({ guild, actor, targetId: targetUserId, action: 'purge', reason: `purge ${n}`, result: fail(kind, ERROR_TEXT[kind] || 'Could not delete messages.') });
    }
  }

  return { ban, kick, timeout, untimeout, unban, warn, purge, AUTO_TIMEOUT_MS };
}

module.exports = { createModeration, AUTO_TIMEOUT_MS };
