'use strict';
const logger = require('./utils/logger');
const { registerSecret } = require('./utils/redact');

async function main() {
  const { getConfig, ConfigError } = require('./config');
  let config;
  try {
    config = getConfig();
  } catch (err) {
    if (err instanceof ConfigError) { console.error(`[STARTUP] ${err.message}`); process.exit(1); }
    throw err;
  }
  logger.setLevel(config.logging.level);
  registerSecret(config.discord.token);
  registerSecret(config.afk.globalApiKey);

  const { createDatabase } = require('./database');
  const { runMigrations } = require('./database/migrate');
  const db = createDatabase(config.database);
  await db.query('SELECT 1'); // fail fast with a clear message if the DB is unreachable
  const applied = await runMigrations(db, { log: (m) => logger.info(`[DB] ${m}`) });
  logger.info(`[DB] connected; ${applied.length} migration(s) applied`);

  const { createClient, registerEvents } = require('./bot/client');
  const { createContainer } = require('./bot/container');
  const { startHealthServer } = require('./services/healthServer');
  const { startJobs } = require('./services/jobs');
  const cron = require('node-cron');
  const { embed } = require('./utils/embeds');

  const client = createClient();
  const container = createContainer({ config, db, getClient: () => client });
  container.notifyExpired = async ({ slotNumber, userId, serverId }) => {
    const user = await db.query('SELECT discord_user_id FROM users WHERE id = $1', [userId]);
    const did = user.rows[0]?.discord_user_id;
    if (!did) return;
    const u = await client.users.fetch(did);
    await u.send({ embeds: [embed.warn('Subscription Expired', `Your subscription ended, so slot #${slotNumber} was released from server \`${serverId}\`. Renew in the Master Discord Server to get a slot again.`)] });
  };
  registerEvents(client, container);

  const health = startHealthServer({ port: config.http.port, getClient: () => client, db });
  const stopJobs = startJobs(container, cron);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info(`[BOT] ${signal} received, shutting down`);
    try { stopJobs(); health.close(); await client.destroy(); await db.close(); } catch (err) { logger.error('[BOT] shutdown error', { error: err }); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('[PROCESS] unhandledRejection', { error: reason }));
  process.on('uncaughtException', (err) => logger.error('[PROCESS] uncaughtException', { error: err }));

  await client.login(config.discord.token);
}

main().catch((err) => {
  logger.error('[STARTUP] fatal', { error: err });
  console.error('[STARTUP] fatal:', err.message);
  process.exit(1);
});
