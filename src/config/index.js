'use strict';

class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const SNOWFLAKE = /^\d{15,25}$/;

function int(env, key, def, problems, { min = 0 } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(String(raw).trim())) {
    problems.push(`${key} must be a non-negative integer (got "${raw}")`);
    return def;
  }
  const n = parseInt(raw, 10);
  if (n < min) problems.push(`${key} must be >= ${min}`);
  return n;
}

function bool(env, key, def) {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

/**
 * Validate environment variables and return a frozen config object.
 * Throws ConfigError listing *all* problems at once.
 * @param {Record<string,string|undefined>} env
 */
function buildConfig(env = process.env) {
  const problems = [];
  const req = (key) => {
    const v = env[key];
    if (!v || !String(v).trim()) problems.push(`${key} is required`);
    return v ? String(v).trim() : '';
  };

  const token = req('DISCORD_TOKEN');
  const clientId = req('CLIENT_ID');
  const ownerId = req('BOT_OWNER_ID');
  const databaseUrl = req('DATABASE_URL');
  const masterGuildId = req('MASTER_SERVER_ID');

  for (const [k, v] of [['CLIENT_ID', clientId], ['BOT_OWNER_ID', ownerId], ['MASTER_SERVER_ID', masterGuildId]]) {
    if (v && !SNOWFLAKE.test(v)) problems.push(`${k} must be a Discord snowflake ID`);
  }

  if (databaseUrl && !/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    problems.push(
      'DATABASE_URL must be a PostgreSQL URL (postgresql://...). SQLite file paths are no longer supported; ' +
        'see docs/MIGRATION.md to import an old SQLite database.'
    );
  }

  const superAdmins = new Set([ownerId].filter(Boolean));
  for (const id of String(env.SUPER_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!SNOWFLAKE.test(id)) problems.push(`SUPER_ADMIN_IDS contains an invalid ID: ${id}`);
    else superAdmins.add(id);
  }

  const owoBotId = env.OWO_BOT_ID || '408785106942164992';
  if (!SNOWFLAKE.test(owoBotId)) problems.push('OWO_BOT_ID must be a Discord snowflake ID');

  const amount = int(env, 'SUBSCRIPTION_AMOUNT', 25000000, problems, { min: 1 });
  const days = int(env, 'SUBSCRIPTION_DAYS', 30, problems, { min: 1 });

  const apiKeyMode = (env.AFK_API_KEY_MODE || 'query').toLowerCase();
  if (!['query', 'header'].includes(apiKeyMode)) problems.push('AFK_API_KEY_MODE must be "query" or "header"');

  let encryptionKey = null;
  if (env.SECRETS_ENCRYPTION_KEY) {
    const raw = env.SECRETS_ENCRYPTION_KEY.trim();
    const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (buf.length !== 32) problems.push('SECRETS_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars or base64)');
    else encryptionKey = buf;
  }

  const gifProvider = (env.GIF_PROVIDER || 'none').toLowerCase();
  if (!['none', 'giphy'].includes(gifProvider)) problems.push('GIF_PROVIDER must be "none" or "giphy"');
  if (gifProvider !== 'none' && !env.GIF_API_KEY) problems.push('GIF_API_KEY is required when GIF_PROVIDER is set');

  const sslMode = (env.DATABASE_SSL || 'auto').toLowerCase();
  if (!['true', 'false', 'auto'].includes(sslMode)) problems.push('DATABASE_SSL must be true, false or auto');

  const port = int(env, 'HEALTH_PORT', int(env, 'PORT', 3000, problems), problems);
  const poolMax = int(env, 'DATABASE_POOL_MAX', 10, problems, { min: 1 });
  const nukeThreshold = int(env, 'ANTINUKE_THRESHOLD', 3, problems, { min: 1 });
  const nukeWindow = int(env, 'ANTINUKE_WINDOW_SECONDS', 60, problems, { min: 5 });

  if (problems.length) throw new ConfigError(problems);

  return Object.freeze({
    discord: Object.freeze({ token, clientId }),
    bot: Object.freeze({ ownerId, superAdmins, masterGuildId, owoBotId }),
    database: Object.freeze({ url: databaseUrl, ssl: sslMode, poolMax }),
    subscription: Object.freeze({ amount, days }),
    afk: Object.freeze({
      globalApiKey: env.GLOBAL_API_KEY || '',
      apiKeyMode,
      allowPrivateSlotUrls: bool(env, 'ALLOW_PRIVATE_SLOT_URLS', false),
      encryptionKey,
    }),
    gif: Object.freeze({ provider: gifProvider, apiKey: env.GIF_API_KEY || '' }),
    antinuke: Object.freeze({ threshold: nukeThreshold, windowMs: nukeWindow * 1000 }),
    http: Object.freeze({ port }),
    logging: Object.freeze({ level: env.LOG_LEVEL || 'info' }),
  });
}

let cached = null;
/** Lazily validated process-wide config (reads process.env once). */
function getConfig() {
  if (!cached) {
    require('dotenv').config();
    cached = buildConfig(process.env);
  }
  return cached;
}

module.exports = { buildConfig, getConfig, ConfigError };
