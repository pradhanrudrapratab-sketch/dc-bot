'use strict';

/**
 * Role-hierarchy decision (pure). Positions are role.position of each party's highest role.
 * Mirrors Discord's rules: owners are untouchable, and both the acting moderator and the bot
 * must outrank the target.
 * @returns {{ok:true}|{ok:false, reason:string, message:string}}
 */
function checkHierarchy({ guildOwnerId, botId, botTop, actorId, actorTop, targetId, targetTop = null }) {
  const no = (reason, message) => ({ ok: false, reason, message });
  if (targetId === botId) return no('TARGET_IS_BOT', 'I cannot take moderation action against myself.');
  if (targetId === guildOwnerId) return no('TARGET_IS_OWNER', 'The server owner cannot be targeted.');
  if (actorId && targetId === actorId) return no('TARGET_IS_ACTOR', 'You cannot target yourself.');
  if (targetTop === null) return { ok: true }; // target not in the server (e.g. ban by ID): hierarchy not applicable
  if (actorId && actorId !== guildOwnerId && actorTop <= targetTop) {
    return no('ACTOR_NOT_ABOVE_TARGET', 'Your highest role must be above the target’s highest role.');
  }
  if (botTop <= targetTop) return no('BOT_NOT_ABOVE_TARGET', 'My highest role must be above the target’s highest role. Move my role higher in Server Settings → Roles.');
  return { ok: true };
}

/** Classify a discord.js/REST error into something we can report honestly. */
function classifyDiscordError(err) {
  const code = err?.code;
  const status = err?.status;
  if (code === 50013) return 'PERMISSION_OR_HIERARCHY'; // Discord uses one code for both
  if (code === 50001) return 'MISSING_ACCESS';
  if (code === 50007) return 'DM_CLOSED';
  if (code === 10007 || code === 10013) return 'UNKNOWN_TARGET';
  if (code === 10003 || code === 10008) return 'UNKNOWN_CHANNEL_OR_MESSAGE';
  if (code === 30008 || code === 30007) return 'LIMIT_REACHED';
  if (status === 429) return 'RATE_LIMITED';
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) || err?.name === 'AbortError') return 'NETWORK';
  if (status >= 500) return 'DISCORD_SERVER_ERROR';
  return 'OTHER';
}

const topRolePosition = (member) => member?.roles?.highest?.position ?? 0;

/** Gather hierarchy inputs from discord.js objects and run checkHierarchy. */
function hierarchyFor({ guild, actorMember, targetMember, targetId }) {
  return checkHierarchy({
    guildOwnerId: guild.ownerId,
    botId: guild.members.me.id,
    botTop: topRolePosition(guild.members.me),
    actorId: actorMember?.id ?? null,
    actorTop: actorMember ? topRolePosition(actorMember) : 0,
    targetId,
    targetTop: targetMember ? topRolePosition(targetMember) : null,
  });
}

/**
 * Permission-monitor state machine (pure). Notifies once when a feature becomes blocked (or its
 * missing set changes, at most hourly), and once when it recovers. No periodic nagging.
 */
function evaluateTransition(prev, missing, now, { changeRenotifyMs = 3_600_000 } = {}) {
  const key = [...missing].sort().join(',');
  if (missing.length) {
    if (!prev || !prev.blocked) return { notify: 'blocked', next: { blocked: 1, missing: key, notifiedAt: now } };
    if (prev.missing !== key && now - (prev.notifiedAt || 0) >= changeRenotifyMs) return { notify: 'blocked', next: { blocked: 1, missing: key, notifiedAt: now } };
    return { notify: null, next: { blocked: 1, missing: key, notifiedAt: prev.notifiedAt } };
  }
  if (prev && prev.blocked) return { notify: 'recovered', next: { blocked: 0, missing: '', notifiedAt: now } };
  return { notify: null, next: { blocked: 0, missing: '', notifiedAt: prev?.notifiedAt ?? null } };
}

function createPermissionMonitor({ db, now = () => Date.now(), onChange = async () => {} }) {
  /** Report the current missing-permission set for (guild, feature). */
  async function report(guildId, feature, missing) {
    const prevRow = (await db.query('SELECT blocked, missing, notified_at FROM permission_state WHERE guild_id = $1 AND feature = $2', [guildId, feature])).rows[0];
    const prev = prevRow ? { blocked: prevRow.blocked, missing: prevRow.missing || '', notifiedAt: prevRow.notified_at } : null;
    const t = now();
    const { notify, next } = evaluateTransition(prev, missing, t);
    if (!prev && !next.blocked) return { notify: null }; // healthy and never seen: don't create rows
    await db.query(
      `INSERT INTO permission_state (guild_id, feature, blocked, missing, notified_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (guild_id, feature) DO UPDATE SET blocked = excluded.blocked, missing = excluded.missing,
         notified_at = excluded.notified_at, updated_at = excluded.updated_at`,
      [guildId, feature, next.blocked, next.missing, next.notifiedAt ?? null, t]
    );
    if (notify) await onChange({ guildId, feature, state: notify, missing });
    return { notify };
  }
  const listBlocked = async (guildId) => (await db.query('SELECT feature, missing FROM permission_state WHERE guild_id = $1 AND blocked = 1', [guildId])).rows;
  return { report, listBlocked };
}

module.exports = { checkHierarchy, classifyDiscordError, topRolePosition, hierarchyFor, evaluateTransition, createPermissionMonitor };
