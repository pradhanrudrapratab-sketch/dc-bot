'use strict';
const { SlidingWindowCounter } = require('../utils/slidingWindow');
const { classifyDiscordError } = require('./permissions');
const logger = require('../utils/logger');

// Separately named event types; unrelated events are never pooled. Kick + ban share one bucket (spec 12).
const TYPES = Object.freeze({ channel_delete: 'channel_delete', role_delete: 'role_delete', member_kick: 'member_kick_ban', member_ban: 'member_kick_ban' });
const DEFAULT_THRESHOLD = 3; // trigger when MORE than 3 within the window
const WINDOW_MS = 60_000;

const snapshotChannel = (c) => ({
  name: c.name, type: c.type, parentId: c.parentId ?? null, topic: c.topic ?? undefined, nsfw: c.nsfw ?? undefined,
  position: c.rawPosition ?? c.position,
  permissionOverwrites: [...(c.permissionOverwrites?.cache?.values?.() ?? [])].map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield })),
});
const snapshotRole = (r) => ({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield });

function createAntiNuke({ db, moderation, audit, logs, superAdmins, now = () => Date.now(), threshold = DEFAULT_THRESHOLD, windowMs = WINDOW_MS }) {
  const counter = new SlidingWindowCounter({ windowMs, now });
  const triggered = new Map(); // `${guild}:${actor}` -> ts
  const deleted = new Map(); // objectId -> { kind, snap, at }

  const isAllowlisted = async (guildId, userId) =>
    (await db.query('SELECT 1 AS x FROM antinuke_allowlist WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).rows.length > 0;
  async function allowlist(guildId) {
    return (await db.query('SELECT user_id, added_by, added_at FROM antinuke_allowlist WHERE guild_id = $1 ORDER BY added_at', [guildId])).rows;
  }
  async function addAllowlist(guildId, userId, by) {
    await db.query(`INSERT INTO antinuke_allowlist (guild_id, user_id, added_by, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, user_id) DO NOTHING`, [guildId, userId, by, now()]);
  }
  async function removeAllowlist(guildId, userId) {
    return (await db.query('DELETE FROM antinuke_allowlist WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).rowCount > 0;
  }

  /** Called from channelDelete/roleDelete so we hold a snapshot when the audit entry arrives. */
  function rememberDeleted(kind, obj) {
    const t = now();
    for (const [k, v] of deleted) if (t - v.at > 10 * 60_000) deleted.delete(k);
    deleted.set(obj.id, { kind, snap: kind === 'channel' ? snapshotChannel(obj) : snapshotRole(obj), at: t });
  }

  /** Pure counting step. @returns {{exceeded:boolean,type:string,count:number}|null} */
  function count({ guildId, executorId, action, targetId }) {
    const type = TYPES[action];
    if (!type) return null;
    const n = counter.record(`${guildId}:${executorId}:${type}`, { targetId, action });
    return { exceeded: n > threshold, type, count: n };
  }

  async function restore(guild, targetIds) {
    const restored = [];
    const failed = [];
    for (const id of targetIds) {
      const d = deleted.get(id);
      if (!d) continue;
      try {
        if (d.kind === 'channel') await guild.channels.create({ ...d.snap, reason: 'Anti-nuke restore (best effort)' });
        else await guild.roles.create({ ...d.snap, reason: 'Anti-nuke restore (best effort)' });
        restored.push(`${d.kind}:${d.snap.name}`);
      } catch (err) {
        failed.push(`${d.kind}:${d.snap.name}:${classifyDiscordError(err)}`);
      }
    }
    return { restored, failed };
  }

  /**
   * Process one audit-log entry. `executorId` is Discord's own attribution; null means unknown and we never
   * ban a guess. Returns a result object describing exactly what happened.
   */
  async function handleEntry({ guild, settings, action, executorId, targetId }) {
    if (!settings?.antinuke_enabled) return { handled: false, reason: 'DISABLED' };
    const botId = guild.members.me.id;
    if (executorId === botId) return { handled: false, reason: 'SELF' };
    if (!executorId) return { handled: false, reason: 'NO_EXECUTOR' };
    if (executorId === guild.ownerId || superAdmins.has(executorId)) return { handled: false, reason: 'TRUSTED' };
    if (await isAllowlisted(guild.id, executorId)) return { handled: false, reason: 'ALLOWLISTED' };

    const c = count({ guildId: guild.id, executorId, action, targetId });
    if (!c || !c.exceeded) return { handled: false, reason: 'BELOW_THRESHOLD', count: c?.count };

    const key = `${guild.id}:${executorId}`;
    const t = now();
    if (triggered.has(key) && t - triggered.get(key) < windowMs) return { handled: false, reason: 'ALREADY_TRIGGERED' };
    triggered.set(key, t);

    const events = counter.peek(`${guild.id}:${executorId}:${c.type}`);
    const res = { handled: true, type: c.type, count: c.count, executorId, banned: false, errors: [], restored: [], restoreFailed: [] };
    const r = await moderation.ban({ guild, targetId: executorId, reason: `Anti-nuke: ${c.count} ${c.type} actions in ${Math.round(windowMs / 1000)}s`, auto: true });
    res.banned = r.ok;
    if (!r.ok) res.errors.push(`ban:${r.code}`);

    if (c.type !== 'member_kick_ban') {
      const rr = await restore(guild, events.map((e) => e.meta.targetId));
      res.restored = rr.restored;
      res.restoreFailed = rr.failed;
    }

    await audit.recordSecurityEvent({
      guildId: guild.id, eventType: 'antinuke_trigger', actorId: executorId,
      evidence: { type: c.type, count: c.count, windowMs, events: events.map((e) => ({ at: e.at, ...e.meta })) },
      actionTaken: res.banned ? 'ban' : 'alert', outcome: JSON.stringify({ errors: res.errors, restored: res.restored, restoreFailed: res.restoreFailed }),
    });
    const desc = [
      `<@${executorId}> performed **${c.count}** \`${c.type}\` actions within ${Math.round(windowMs / 1000)} seconds (limit ${threshold}).`,
      `Ban: ${res.banned ? 'success' : `FAILED (${r.message})`}`,
      res.restored.length ? `Restored (best effort): ${res.restored.join(', ')}` : null,
      res.restoreFailed.length ? `Could not restore: ${res.restoreFailed.join(', ')}` : null,
      'Irreversible actions (e.g. kicked/banned members, message loss) cannot be rolled back.',
    ].filter(Boolean).join('\n');
    await logs.alertStaff(guild, { title: 'Anti-nuke triggered', description: desc, severity: res.banned ? 'warn' : 'error' }).catch((e) => logger.warn('[ANTINUKE] alert failed', { error: e }));
    if (!res.banned) await logs.alertSuperAdmins([...superAdmins], { content: `Anti-nuke could not ban <@${executorId}> in **${guild.name}**: ${r.message}` }).catch(() => {});
    return res;
  }

  return { handleEntry, count, rememberDeleted, restore, allowlist, addAllowlist, removeAllowlist, isAllowlisted, _counter: counter };
}

module.exports = { createAntiNuke, TYPES, WINDOW_MS, DEFAULT_THRESHOLD, snapshotChannel, snapshotRole };
