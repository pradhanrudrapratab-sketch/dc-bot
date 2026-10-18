'use strict';
const { isSafeHttpsLiteral } = require('./urlGuard');
const logger = require('../utils/logger');

/** Every fun action is independent: its own template, media and cooldown. Add names here to add commands. */
const FUN_ACTIONS = Object.freeze({
  slap: { verb: 'slaps', template: '{actor} slaps {target}!' },
  hug: { verb: 'hugs', template: '{actor} hugs {target}!' },
  pat: { verb: 'pats', template: '{actor} pats {target}!' },
  bonk: { verb: 'bonks', template: '{actor} bonks {target}! Go to horny jail.' },
  highfive: { verb: 'high-fives', template: '{actor} high-fives {target}!' },
  punt: { verb: 'punts', template: '{actor} punts {target} across the room!' },
});

const ALLOWED_PLACEHOLDERS = new Set(['actor', 'target', 'guild']);
const MAX_TEMPLATE = 300;
const MEDIA_EXT = /\.(gif|png|jpe?g|webp)(\?.*)?$/i;
const MEDIA_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net', 'media.tenor.com', 'c.tenor.com', 'media.giphy.com', 'i.giphy.com', 'i.imgur.com']);

/** @returns {{ok:true,value:string}|{ok:false,error:string}} */
function validateTemplate(text) {
  const s = String(text ?? '').trim();
  if (!s) return { ok: false, error: 'Message cannot be empty.' };
  if (s.length > MAX_TEMPLATE) return { ok: false, error: `Message must be at most ${MAX_TEMPLATE} characters.` };
  for (const m of s.matchAll(/\{([^{}]*)\}/g)) {
    if (!ALLOWED_PLACEHOLDERS.has(m[1])) return { ok: false, error: `Unknown placeholder {${m[1]}}. Allowed: {actor}, {target}, {guild}.` };
  }
  if (/[{}]/.test(s.replace(/\{(actor|target|guild)\}/g, ''))) return { ok: false, error: 'Unbalanced { } in message.' };
  return { ok: true, value: s };
}

/** Plain string substitution only: nothing is evaluated. */
function renderTemplate(template, vars) {
  return String(template).replace(/\{(actor|target|guild)\}/g, (_, k) => String(vars[k] ?? ''));
}

function validateMediaUrl(input) {
  const s = String(input ?? '').trim();
  if (s.length > 500) return { ok: false, error: 'URL is too long.' };
  if (!isSafeHttpsLiteral(s)) return { ok: false, error: 'Use a public https:// URL.' };
  const u = new URL(s);
  if (!MEDIA_EXT.test(u.pathname + u.search) && !MEDIA_HOSTS.has(u.hostname)) {
    return { ok: false, error: 'URL must point to an image/GIF (.gif .png .jpg .webp) or a known media host.' };
  }
  return { ok: true, value: u.toString() };
}

function createGiphyProvider({ apiKey, http }) {
  return {
    name: 'giphy',
    /** Returns a validated https image URL or null. Provider output is never trusted blindly. */
    async fetchGif(query) {
      const res = await http.get('https://api.giphy.com/v1/gifs/random', {
        params: { api_key: apiKey, tag: String(query).slice(0, 50), rating: 'pg-13' }, timeout: 5000, maxRedirects: 0, maxContentLength: 256 * 1024,
      });
      const url = res.data?.data?.images?.original?.url;
      const v = typeof url === 'string' ? validateMediaUrl(url) : { ok: false };
      return v.ok ? v.value : null;
    },
  };
}

/** Per-guild overrides on top of global defaults, stored in fun_responses (guild_id '*' = global). */
function createFun({ db, provider = null, now = () => Date.now() }) {
  const GLOBAL = '*';

  const row = async (guildId, action) => (await db.query('SELECT * FROM fun_responses WHERE guild_id = $1 AND action = $2', [guildId, action])).rows[0] || null;

  /** Effective config: guild row fields override global row fields override built-in defaults. */
  async function effective(guildId, action) {
    const def = FUN_ACTIONS[action];
    const g = await row(guildId, action);
    const glob = await row(GLOBAL, action);
    const pick = (f) => (g && g[f] != null ? g[f] : glob && glob[f] != null ? glob[f] : null);
    return {
      template: pick('message_template') || def.template,
      mediaUrl: pick('media_url'),
      source: (g?.source ?? glob?.source) || 'direct',
      providerQuery: pick('provider_query') || action,
      enabled: (g ? g.enabled : glob ? glob.enabled : 1) === 1,
    };
  }

  async function upsert(guildId, action, fields, updatedBy) {
    if (!FUN_ACTIONS[action]) throw new Error(`Unknown fun action: ${action}`);
    const allowed = ['message_template', 'media_url', 'source', 'provider_query', 'enabled'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return;
    const cols = ['guild_id', 'action', ...keys, 'updated_by', 'updated_at'];
    const params = [guildId, action, ...keys.map((k) => fields[k]), updatedBy, now()];
    await db.query(
      `INSERT INTO fun_responses (${cols.join(', ')}) VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (guild_id, action) DO UPDATE SET ${[...keys, 'updated_by', 'updated_at'].map((k) => `${k} = excluded.${k}`).join(', ')}`, params);
  }
  const reset = async (guildId, action) => (await db.query('DELETE FROM fun_responses WHERE guild_id = $1 AND action = $2', [guildId, action])).rowCount > 0;

  /**
   * Build the reply for an action. A broken URL/provider degrades to text only; this never throws.
   * @returns {{text:string, imageUrl:string|null, degraded:boolean}}
   */
  async function compose({ guildId, guildName, action, actorMention, targetMention }) {
    const cfg = await effective(guildId, action);
    const text = renderTemplate(cfg.template, { actor: actorMention, target: targetMention, guild: guildName });
    let imageUrl = null;
    let degraded = false;
    try {
      if (cfg.source === 'provider') {
        if (!provider) degraded = true;
        else { imageUrl = await provider.fetchGif(cfg.providerQuery); if (!imageUrl) degraded = true; }
      } else if (cfg.mediaUrl) {
        const v = validateMediaUrl(cfg.mediaUrl);
        if (v.ok) imageUrl = v.value; else degraded = true;
      }
    } catch (err) {
      degraded = true;
      logger.warn('[FUN] media lookup failed', { action, error: err });
    }
    return { text, imageUrl, degraded, enabled: cfg.enabled };
  }

  return { effective, upsert, reset, compose, GLOBAL };
}

module.exports = { FUN_ACTIONS, validateTemplate, renderTemplate, validateMediaUrl, createFun, createGiphyProvider };
