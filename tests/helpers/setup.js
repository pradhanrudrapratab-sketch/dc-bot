'use strict';
const { createSqliteDb } = require('./sqliteAdapter');
const { runMigrations } = require('../../src/database/migrate');
const { createUsers } = require('../../src/services/users');
const { createSubscriptions } = require('../../src/services/subscriptions');
const { createSlots } = require('../../src/services/slots');
const { createPaymentProcessor } = require('../../src/services/payments');

const DAY = 86_400_000;

/** Fresh migrated DB + AFK services driven by a controllable clock. */
async function makeAfkEnv({ days = 30, start = Date.UTC(2026, 0, 1) } = {}) {
  const clock = { t: start };
  const now = () => clock.t;
  const db = createSqliteDb();
  await runMigrations(db);
  const users = createUsers({ now });
  const subs = createSubscriptions({ durationMs: days * DAY, now });
  const slots = createSlots({ now });
  const payments = createPaymentProcessor({ db, users, subs, now });
  return { db, clock, now, users, subs, slots, payments, DAY };
}

module.exports = { makeAfkEnv, DAY };
