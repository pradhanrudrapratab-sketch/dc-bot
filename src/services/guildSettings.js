'use strict';

const COLUMNS = new Set([
  'prefix', 'verification_enabled', 'verification_channel_id', 'verification_role_id', 'verification_message_id',
  'verification_lockdown', 'honeypot_enabled', 'honeypot_channel_id', 'honeypot_message_id', 'honeypot_tamper_action',
  'announcement_channel_id', 'invite_tracking_enabled', 'invite_log_channel_id', 'antinuke_enabled',
  'botguard_enabled', 'botguard_fallback',
]);

const DEFAULTS = Object.freeze({
  prefix: '!', verification_enabled: 0, verification_channel_id: null, verification_role_id: null,
  verification_message_id: null, verification_lockdown: null, honeypot_enabled: 0, honeypot_channel_id: null,
  honeypot_message_id: null, honeypot_tamper_action: 'alert', announcement_channel_id: null,
  invite_tracking_enabled: 0, invite_log_channel_id: null, antinuke_enabled: 0, botguard_enabled: 0, botguard_fallback: 'alert',
});

const MAX_PREFIX = 5;

/** @returns {{ok:true, value:string}|{ok:false, error:string}} */
function validatePrefix(input) {
  const p = String(input ?? '');
  if (!p.length) return { ok: false, error: 'Prefix cannot be empty.' };
  if (p.length > MAX_PREFIX) return { ok: false, error: `Prefix can be at most ${MAX_PREFIX} characters.` };
  if (/\s/.test(p)) return { ok: false, error: 'Prefix cannot contain spaces.' };
  if (/[`\\<>@#\/]/.test(p)) return { ok: false, error: 'Prefix cannot contain ` \\ < > @ # or /.' };
  if (/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202f]/.test(p)) return { ok: false, error: 'Prefix contains invalid characters.' };
  return { ok: true, value: p };
}

/** Per-guild settings with a short read-through cache. The prefix is only ever read through here. */
function createGuildSettings({ db, now = () => Date.now(), cacheMs = 30_000 }) {
  const cache = new Map();

  async function get(guildId) {
    const hit = cache.get(guildId);
    if (hit && hit.at > now() - cacheMs) return hit.row;
    const r = await db.query('SELECT * FROM guild_settings WHERE guild_id = $1', [guildId]);
    const row = r.rows[0] ? { ...DEFAULTS, ...r.rows[0] } : { ...DEFAULTS, guild_id: guildId };
    cache.set(guildId, { at: now(), row });
    return row;
  }

  const getPrefix = async (guildId) => (await get(guildId)).prefix;

  /** Upsert whitelisted columns. Unknown columns throw (no dynamic SQL from user input). */
  async function update(guildId, patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return get(guildId);
    for (const k of keys) if (!COLUMNS.has(k)) throw new Error(`Unknown guild setting: ${k}`);
    const t = now();
    const cols = ['guild_id', ...keys, 'created_at', 'updated_at'];
    const params = [guildId, ...keys.map((k) => patch[k]), t, t];
    const placeholders = params.map((_, i) => `$${i + 1}`);
    const sets = [...keys, 'updated_at'].map((k) => `${k} = excluded.${k}`).join(', ');
    await db.query(`INSERT INTO guild_settings (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (guild_id) DO UPDATE SET ${sets}`, params);
    cache.delete(guildId);
    return get(guildId);
  }

  const invalidate = (guildId) => cache.delete(guildId);

  /** All guilds where a feature column equals 1 (used at startup to rebuild in-memory state). */
  async function listWhere(column, value = 1) {
    if (!COLUMNS.has(column)) throw new Error(`Unknown guild setting: ${column}`);
    return (await db.query(`SELECT * FROM guild_settings WHERE ${column} = $1`, [value])).rows;
  }

  return { get, getPrefix, update, invalidate, listWhere };
}

module.exports = { createGuildSettings, validatePrefix, DEFAULTS };
