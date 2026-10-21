'use strict';
process.removeAllListeners('warning');
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeAfkEnv, DAY } = require('./helpers/setup');
const { parseOwoPayment, validatePayment } = require('../src/services/payments');
const { runExpiry } = require('../src/services/expiry');

const pay = (id, sender = '111111111111111111') => ({ messageId: id, senderId: sender, receiverId: '999999999999999999', amount: 25000000, username: 'tester' });

test('OWO message parsing and validation', () => {
  const p = parseOwoPayment('💳 | <@111111111111111111> sent 25,000,000 cowoncy to <@999999999999999999>!');
  assert.deepEqual(p, { senderId: '111111111111111111', receiverId: '999999999999999999', amount: 25000000 });
  assert.equal(parseOwoPayment('hello'), null);
  const policy = { ownerId: '999999999999999999', amount: 25000000 };
  assert.equal(validatePayment(p, policy).ok, true);
  assert.equal(validatePayment({ ...p, amount: 1 }, policy).reason, 'AMOUNT_MISMATCH');
  assert.equal(validatePayment({ ...p, receiverId: '5' }, policy).reason, 'RECEIVER_NOT_OWNER');
});

test('duplicate payment event is processed once', async () => {
  const e = await makeAfkEnv();
  const a = await e.payments.process(pay('m1'));
  const b = await e.payments.process(pay('m1'));
  assert.equal(a.status, 'PROCESSED');
  assert.equal(b.status, 'DUPLICATE');
  const subs = (await e.db.query('SELECT COUNT(*) AS c FROM subscriptions')).rows[0].c;
  assert.equal(subs, 1);
});

test('concurrent identical payment events grant exactly once', async () => {
  const e = await makeAfkEnv();
  const results = await Promise.all([e.payments.process(pay('m2')), e.payments.process(pay('m2')), e.payments.process(pay('m2'))]);
  assert.equal(results.filter((r) => r.status === 'PROCESSED').length, 1);
  assert.equal((await e.db.query('SELECT COUNT(*) AS c FROM subscriptions')).rows[0].c, 1);
});

test('renewal extends from current expiry (not from now)', async () => {
  const e = await makeAfkEnv();
  const first = await e.payments.process(pay('a'));
  e.clock.t += 10 * DAY;
  const second = await e.payments.process(pay('b'));
  assert.equal(second.renewed, true);
  assert.equal(second.expiresAt, first.expiresAt + 30 * DAY);
});

test('payment after expiry (cron not yet run) starts a fresh subscription', async () => {
  const e = await makeAfkEnv();
  await e.payments.process(pay('a'));
  e.clock.t += 31 * DAY; // expired, status still ACTIVE in DB
  const r = await e.payments.process(pay('b'));
  assert.equal(r.status, 'PROCESSED');
  assert.equal(r.renewed, false);
  assert.equal(r.expiresAt, e.clock.t + 30 * DAY);
});

test('partial processing failure is recorded and recovered by reconcile', async () => {
  const e = await makeAfkEnv();
  const realGrant = e.subs.grant;
  e.subs.grant = async () => { throw new Error('boom'); };
  const r = await e.payments.process(pay('m3'));
  assert.equal(r.status, 'FAILED');
  const row = (await e.db.query("SELECT status, attempts, last_error FROM payments WHERE payment_message_id = 'm3'")).rows[0];
  assert.equal(row.status, 'FAILED');
  assert.equal((await e.db.query('SELECT COUNT(*) AS c FROM subscriptions')).rows[0].c, 0); // transaction rolled back
  e.subs.grant = realGrant;
  e.clock.t += 120_000;
  const rec = await e.payments.reconcile();
  assert.equal(rec[0].status, 'PROCESSED');
  assert.equal((await e.db.query('SELECT COUNT(*) AS c FROM subscriptions')).rows[0].c, 1);
});

test('placeholder username does not overwrite a real one', async () => {
  const e = await makeAfkEnv();
  await e.payments.process(pay('a'));
  await e.users.upsert(e.db, '111111111111111111', 'user_111', { placeholder: true });
  assert.equal((await e.users.findByDiscordId(e.db, '111111111111111111')).username, 'tester');
});

async function seedUser(e, n) {
  const u = await e.users.upsert(e.db, `20000000000000000${n}`, `u${n}`);
  await e.users.validate(e.db, u.discord_user_id);
  await e.subs.grant(e.db, u.id);
  return u;
}

test('two simultaneous assignment attempts cannot claim one slot', async () => {
  const e = await makeAfkEnv();
  await e.slots.add(e.db, 'https://slot1.example.com');
  const u1 = await seedUser(e, 1);
  const u2 = await seedUser(e, 2);
  const [a, b] = await Promise.all([
    e.slots.claim(e.db, { userId: u1.id, serverId: 'S1', serverName: 'one' }),
    e.slots.claim(e.db, { userId: u2.id, serverId: 'S2', serverName: 'two' }),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal([a, b].find((r) => !r.ok).reason, 'NO_SLOT');
});

test('claim rejects second slot for same user / second slot for same server', async () => {
  const e = await makeAfkEnv();
  await e.slots.add(e.db, 'https://a.example.com');
  await e.slots.add(e.db, 'https://b.example.com');
  const u1 = await seedUser(e, 1);
  const u2 = await seedUser(e, 2);
  assert.equal((await e.slots.claim(e.db, { userId: u1.id, serverId: 'S1' })).ok, true);
  assert.equal((await e.slots.claim(e.db, { userId: u1.id, serverId: 'S9' })).reason, 'USER_HAS_SLOT');
  assert.equal((await e.slots.claim(e.db, { userId: u2.id, serverId: 'S1' })).reason, 'SERVER_HAS_SLOT');
});

test('unhealthy slots are skipped and health never frees an assigned slot', async () => {
  const e = await makeAfkEnv();
  await e.slots.add(e.db, 'https://a.example.com');
  await e.slots.add(e.db, 'https://b.example.com');
  await e.slots.setHealth(e.db, 1, false);
  const u1 = await seedUser(e, 1);
  const c = await e.slots.claim(e.db, { userId: u1.id, serverId: 'S1' });
  assert.equal(c.slot.slot_number, 2);
  await e.slots.setHealth(e.db, 2, false);
  await e.slots.setHealth(e.db, 2, true);
  assert.equal((await e.slots.getByNumber(e.db, 2)).status, 'ASSIGNED');
  const st = await e.slots.stats(e.db);
  assert.deepEqual(st, { total: 2, available: 0, assigned: 1, inactive: 1 });
});

test('expiry releases only the expired owner’s slot', async () => {
  const e = await makeAfkEnv();
  await e.slots.add(e.db, 'https://a.example.com');
  await e.slots.add(e.db, 'https://b.example.com');
  const u1 = await seedUser(e, 1);
  e.clock.t += 20 * DAY;
  const u2 = await seedUser(e, 2); // u2 expires 20 days after u1
  await e.slots.claim(e.db, { userId: u1.id, serverId: 'S1' });
  await e.slots.claim(e.db, { userId: u2.id, serverId: 'S2' });
  e.clock.t += 11 * DAY; // u1 expired, u2 still active
  const r = await runExpiry({ db: e.db, subs: e.subs, slots: e.slots, now: e.now });
  assert.equal(r.expired, 1);
  assert.deepEqual(r.released.map((x) => x.serverId), ['S1']);
  assert.equal((await e.slots.getActiveAssignmentByServer(e.db, 'S2')).server_id, 'S2');
  assert.equal(await e.slots.getActiveAssignmentByServer(e.db, 'S1'), null);
});

test('expiry compares epoch-ms correctly within the same day (old ISO-vs-datetime bug)', async () => {
  const e = await makeAfkEnv({ days: 1 });
  const u = await seedUser(e, 1);
  e.clock.t += DAY - 1000;
  assert.ok(await e.subs.getActive(e.db, u.id));
  e.clock.t += 2000;
  assert.equal(await e.subs.getActive(e.db, u.id), null);
});

test('deleting a slot with history retires it and preserves assignment rows', async () => {
  const e = await makeAfkEnv();
  await e.slots.add(e.db, 'https://a.example.com');
  const u = await seedUser(e, 1);
  await e.slots.claim(e.db, { userId: u.id, serverId: 'S1' });
  const r = await e.slots.retire(e.db, 1);
  assert.deepEqual([r.ok, r.mode, r.released], [true, 'RETIRED', true]);
  assert.equal((await e.db.query('SELECT COUNT(*) AS c FROM slot_assignments')).rows[0].c, 1);
  assert.equal(await e.slots.getByNumber(e.db, 1), null);
  assert.equal(await e.slots.add(e.db, 'https://c.example.com'), 2); // number 1 is never reused
});

test('deleting a never-used slot hard-deletes it', async () => {
  const e = await makeAfkEnv();
  await e.slots.add(e.db, 'https://a.example.com');
  assert.equal((await e.slots.retire(e.db, 1)).mode, 'DELETED');
});

test('revoke + release leave consistent state', async () => {
  const e = await makeAfkEnv();
  await e.slots.add(e.db, 'https://a.example.com');
  const u = await seedUser(e, 1);
  await e.slots.claim(e.db, { userId: u.id, serverId: 'S1' });
  assert.equal(await e.subs.revoke(e.db, u.id), 1);
  assert.equal(await e.slots.releaseByUser(e.db, u.id, 'REVOKED'), true);
  assert.equal((await e.slots.getById(e.db, 1)).status, 'AVAILABLE');
  assert.equal(await e.subs.getActive(e.db, u.id), null);
});

test('two reconcilers racing on the same unfinished payment grant exactly once (conditional-claim guard)', async () => {
  const e = await makeAfkEnv();
  const real = e.subs.grant;
  e.subs.grant = async () => { throw new Error('transient'); };
  await e.payments.process(pay('race')); // leaves the payment FAILED
  e.subs.grant = real;
  e.clock.t += 120_000;
  const [a, b] = await Promise.all([e.payments.reconcile(), e.payments.reconcile()]);
  const statuses = [...a, ...b].map((r) => r.status).sort();
  assert.deepEqual(statuses, ['DUPLICATE', 'PROCESSED']);
  const sub = (await e.db.query('SELECT expires_at FROM subscriptions')).rows;
  assert.equal(sub.length, 1);
  assert.equal(sub[0].expires_at, e.clock.t + 30 * DAY); // granted once, not twice
});
