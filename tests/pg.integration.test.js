'use strict';
/**
 * REAL PostgreSQL concurrency tests. Skipped unless TEST_DATABASE_URL is set.
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/dcbot_test npm test
 * Use a throw-away database: the test creates and then DROPS all tables in the `public` schema.
 * These cover what the SQLite adapter cannot: true multi-connection races on the conditional UPDATEs
 * and partial unique indexes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const URL = process.env.TEST_DATABASE_URL;
const t = URL ? test : test.skip;

async function setup() {
  const { createDatabase } = require('../src/database');
  const { runMigrations } = require('../src/database/migrate');
  const db = createDatabase({ url: URL, ssl: 'auto', poolMax: 20 });
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
  await runMigrations(db);
  return db;
}

t('postgres: migrations are idempotent', async () => {
  const db = await setup();
  const { runMigrations } = require('../src/database/migrate');
  assert.deepEqual(await runMigrations(db), []);
  await db.close();
});

t('postgres: 20 users racing for 5 slots claim exactly 5, no slot twice', async () => {
  const db = await setup();
  const { createSlots } = require('../src/services/slots');
  const { createUsers } = require('../src/services/users');
  const slots = createSlots({});
  const users = createUsers({});
  for (let i = 0; i < 5; i++) await slots.add(db, `https://s${i}.example.com`);
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push((await users.upsert(db, `${100000000000000000n + BigInt(i)}`, `u${i}`)).id);
  const res = await Promise.all(ids.map((id, i) => slots.claim(db, { userId: id, serverId: `server-${i}`, serverName: `s${i}` })));
  assert.equal(res.filter((r) => r.ok).length, 5);
  assert.equal(new Set(res.filter((r) => r.ok).map((r) => r.slot.id)).size, 5);
  assert.equal((await db.query('SELECT COUNT(*) AS c FROM slot_assignments WHERE released_at IS NULL')).rows[0].c, 5);
  await db.close();
});

t('postgres: one user cannot hold two slots under concurrent claims', async () => {
  const db = await setup();
  const { createSlots } = require('../src/services/slots');
  const { createUsers } = require('../src/services/users');
  const slots = createSlots({});
  for (let i = 0; i < 3; i++) await slots.add(db, `https://s${i}.example.com`);
  const u = await createUsers({}).upsert(db, '200000000000000000', 'u');
  const res = await Promise.all([1, 2, 3].map((i) => slots.claim(db, { userId: u.id, serverId: `srv-${i}` })));
  assert.equal(res.filter((r) => r.ok).length, 1);
  await db.close();
});

t('postgres: concurrent duplicate payment events grant once', async () => {
  const db = await setup();
  const { createUsers } = require('../src/services/users');
  const { createSubscriptions } = require('../src/services/subscriptions');
  const { createPaymentProcessor } = require('../src/services/payments');
  const subs = createSubscriptions({ durationMs: 30 * 86_400_000 });
  const p = createPaymentProcessor({ db, users: createUsers({}), subs });
  const args = { messageId: 'dup-1', senderId: '300000000000000000', receiverId: '1', amount: 25000000, username: 'u' };
  const r = await Promise.all(Array.from({ length: 10 }, () => p.process(args)));
  assert.equal(r.filter((x) => x.status === 'PROCESSED').length, 1);
  assert.equal((await db.query('SELECT COUNT(*) AS c FROM subscriptions')).rows[0].c, 1);
  await db.close();
});

t('postgres: concurrent debits never overdraw', async () => {
  const db = await setup();
  const eco = require('../src/services/economy').createEconomy({ db });
  await eco.credit('A', 100, 'seed');
  const r = await Promise.all(Array.from({ length: 10 }, () => eco.debit('A', 30, 'spend')));
  assert.equal(r.filter((x) => x.ok).length, 3);
  assert.equal(await eco.balance('A'), 10);
  await db.close();
});
