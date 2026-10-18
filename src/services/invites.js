'use strict';
const { KeyedMutex } = require('../utils/mutex');
const logger = require('../utils/logger');

const DELETE_GRACE_MS = 15_000;

/**
 * Decide which invite a new member used by diffing use-count snapshots (pure).
 * @param {Map<string,{uses:number,maxUses:number,inviterId:string|null,deletedAt?:number}>} before
 * @param {Map<string,{uses:number,maxUses:number,inviterId:string|null}>} after
 * @returns {{attribution:'KNOWN'|'VANITY'|'UNKNOWN', code:string|null, inviterId:string|null, reason?:string}}
 * Ambiguity (0 or >1 candidates) always yields UNKNOWN: we never invent an inviter.
 */
function attributeJoin(before, after, { vanityBefore, vanityAfter, now = Date.now() } = {}) {
  const candidates = [];
  for (const [code, a] of after) {
    const b = before.get(code);
    if (b ? a.uses > b.uses : a.uses > 0) candidates.push({ code, inviterId: a.inviterId ?? null, kind: 'KNOWN' });
  }
  for (const [code, b] of before) {
    if (after.has(code)) continue;
    const recentlyDeleted = b.deletedAt === undefined || now - b.deletedAt <= DELETE_GRACE_MS;
    // A max-uses invite disappears the moment its last use is consumed.
    if (recentlyDeleted && b.maxUses > 0 && b.uses + 1 >= b.maxUses) candidates.push({ code, inviterId: b.inviterId ?? null, kind: 'KNOWN' });
  }
  if (vanityBefore !== undefined && vanityAfter !== undefined && vanityAfter > vanityBefore) {
    candidates.push({ code: 'vanity', inviterId: null, kind: 'VANITY' });
  }
  if (candidates.length === 1) return { attribution: candidates[0].kind, code: candidates[0].code, inviterId: candidates[0].inviterId };
  return { attribution: 'UNKNOWN', code: null, inviterId: null, reason: candidates.length ? 'AMBIGUOUS' : 'NO_MATCH' };
}

const toMap = (invites) => new Map(invites.map((i) => [i.code, { uses: i.uses ?? 0, maxUses: i.maxUses ?? 0, inviterId: i.inviterId ?? i.inviter?.id ?? null }]));

/** Persistent invite relationships. Active count is derived (COUNT) so it cannot drift. */
function createInviteRepo({ db, now = () => Date.now() }) {
  /** @returns {Promise<boolean>} true if a new join session was recorded (false = duplicate event) */
  async function recordJoin({ guildId, memberId, inviterId, code, attribution, accountCreatedAt = null, joinedAt = now() }) {
    const r = await db.query(
      `INSERT INTO invite_attributions (guild_id, member_id, inviter_id, invite_code, attribution, account_created_at, joined_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1) ON CONFLICT (guild_id, member_id) WHERE active = 1 DO NOTHING RETURNING id`,
      [guildId, memberId, inviterId, code, attribution, accountCreatedAt, joinedAt]
    );
    return r.rows.length > 0;
  }
  /** Close the open session. Returns the inviter it had been attributed to (or null). Idempotent. */
  async function recordLeave(guildId, memberId, leftAt = now()) {
    const r = await db.query(
      `UPDATE invite_attributions SET active = 0, left_at = $1 WHERE guild_id = $2 AND member_id = $3 AND active = 1 RETURNING inviter_id, attribution, invite_code`,
      [leftAt, guildId, memberId]
    );
    return r.rows[0] || null;
  }
  async function stats(guildId, inviterId) {
    const row = (await db.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS active
         FROM invite_attributions WHERE guild_id = $1 AND inviter_id = $2`, [guildId, inviterId])).rows[0];
    return { total: row.total, active: Number(row.active), departed: row.total - Number(row.active) };
  }
  async function leaderboard(guildId, limit = 10) {
    return (await db.query(
      `SELECT inviter_id, COUNT(*) AS total, COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS active
         FROM invite_attributions WHERE guild_id = $1 AND inviter_id IS NOT NULL
        GROUP BY inviter_id ORDER BY active DESC, total DESC LIMIT $2`, [guildId, Math.min(limit, 25)]
    )).rows.map((r) => ({ inviterId: r.inviter_id, total: r.total, active: Number(r.active), departed: r.total - Number(r.active) }));
  }
  return { recordJoin, recordLeave, stats, leaderboard };
}

/** Holds per-guild invite snapshots and serialises join handling per guild (simultaneous joins). */
function createInviteTracker({ repo, now = () => Date.now(), onDegraded = async () => {} }) {
  const snapshots = new Map(); // guildId -> Map(code -> info)
  const vanity = new Map(); // guildId -> uses
  const mutex = new KeyedMutex();

  async function fetchState(guild) {
    const invites = await guild.invites.fetch();
    let vanityUses;
    if (guild.vanityURLCode) {
      try { vanityUses = (await guild.fetchVanityData()).uses; } catch { vanityUses = undefined; }
    }
    return { map: toMap([...invites.values()]), vanityUses };
  }

  /** (Re)build the snapshot. Missing Manage Server permission degrades only this feature. */
  async function refresh(guild) {
    try {
      const { map, vanityUses } = await fetchState(guild);
      snapshots.set(guild.id, map);
      if (vanityUses !== undefined) vanity.set(guild.id, vanityUses);
      await onDegraded(guild.id, []);
      return true;
    } catch (err) {
      logger.warn('[INVITES] cannot fetch invites', { error: err, guildId: guild.id });
      await onDegraded(guild.id, ['ManageGuild']);
      return false;
    }
  }

  const onInviteCreate = (invite) => {
    const m = snapshots.get(invite.guild?.id);
    if (m) m.set(invite.code, { uses: invite.uses ?? 0, maxUses: invite.maxUses ?? 0, inviterId: invite.inviter?.id ?? null });
  };
  const onInviteDelete = (invite) => {
    const entry = snapshots.get(invite.guild?.id)?.get(invite.code);
    if (entry) entry.deletedAt = now();
  };

  /**
   * Attribute and persist a join. Serialised per guild so concurrent joins cannot corrupt the diff.
   * @returns {Promise<{attribution:string, code:string|null, inviterId:string|null, recorded:boolean}>}
   */
  function handleJoin(member) {
    const guild = member.guild;
    return mutex.run(guild.id, async () => {
      const before = snapshots.get(guild.id);
      let result = { attribution: 'UNKNOWN', code: null, inviterId: null, reason: 'NO_SNAPSHOT' };
      try {
        const { map: after, vanityUses } = await fetchState(guild);
        if (before) result = attributeJoin(before, after, { vanityBefore: vanity.get(guild.id), vanityAfter: vanityUses, now: now() });
        snapshots.set(guild.id, after);
        if (vanityUses !== undefined) vanity.set(guild.id, vanityUses);
      } catch (err) {
        result = { attribution: 'UNKNOWN', code: null, inviterId: null, reason: 'FETCH_FAILED' };
        logger.warn('[INVITES] join attribution failed', { error: err, guildId: guild.id });
      }
      const recorded = await repo.recordJoin({
        guildId: guild.id, memberId: member.id, inviterId: result.inviterId, code: result.code,
        attribution: result.attribution, accountCreatedAt: member.user?.createdTimestamp ?? null, joinedAt: now(),
      });
      return { ...result, recorded };
    });
  }

  const handleLeave = (guildId, memberId) => repo.recordLeave(guildId, memberId, now());

  return { refresh, onInviteCreate, onInviteDelete, handleJoin, handleLeave, _snapshots: snapshots };
}

module.exports = { attributeJoin, createInviteRepo, createInviteTracker, toMap };
