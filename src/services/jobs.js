'use strict';
const logger = require('../utils/logger');
const { runExpiry } = require('./expiry');

/**
 * Background jobs. Each tick is isolated: an exception is logged and never kills the process or later ticks.
 * @param {object} c container with db, subs, slots, payments, warnings, getClient, notifyExpired
 */
function startJobs(c, cron) {
  const safe = (name, fn) => async () => {
    try { await fn(); } catch (err) { logger.error(`[JOB] ${name} failed`, { error: err }); }
  };

  const expiry = safe('expiry', async () => {
    const r = await runExpiry({ db: c.db, subs: c.subs, slots: c.slots });
    if (r.expired || r.released.length) logger.info(`[JOB] expiry: ${r.expired} expired, ${r.released.length} slot(s) released`);
    for (const rel of r.released) await c.notifyExpired?.(rel).catch(() => {});
  });
  const reconcile = safe('payment-reconcile', async () => {
    const r = await c.payments.reconcile();
    if (r.length) logger.info(`[JOB] reconciled ${r.length} payment(s)`, { statuses: r.map((x) => x.status) });
  });
  const warnReset = safe('warning-reset', async () => {
    const rows = await c.warnings.resetExpired();
    for (const row of rows) await c.audit.record({ guildId: row.guild_id, category: 'moderation', action: 'warnings_auto_reset', targetId: row.user_id, actorId: null, details: { reason: '30 days without a new warning' } });
  });

  const tasks = [
    cron.schedule('0 * * * *', expiry),
    cron.schedule('*/10 * * * *', reconcile),
    cron.schedule('15 3 * * *', warnReset),
  ];
  // run once at startup so a long outage does not leave expired slots assigned
  void expiry(); void reconcile(); void warnReset();
  logger.info('[JOB] started: expiry hourly, payment reconcile every 10m, warning reset daily');
  return () => tasks.forEach((t) => t.stop());
}

module.exports = { startJobs };
