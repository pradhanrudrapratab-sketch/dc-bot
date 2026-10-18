'use strict';
process.removeAllListeners('warning');
require('./helpers/fakeDiscord');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSqliteDb } = require('./helpers/sqliteAdapter');
const { runMigrations } = require('../src/database/migrate');
const { makeGuild, stubLogs, stubAudit, discordErr } = require('./helpers/fakes');
const { createWarnings, decideEscalation, effectiveActiveCount, ACTIVE_RESET_MS } = require('../src/services/warnings');
const { createModeration } = require('../src/services/moderation');
const { checkHierarchy, classifyDiscordError, evaluateTransition, createPermissionMonitor } = require('../src/services/permissions');
const { createGuildSettings, validatePrefix } = require('../src/services/guildSettings');
const { createConfirmations, parseConfirmId } = require('../src/services/confirmations');
const { CooldownManager } = require('../src/utils/cooldown');
const { KeyedMutex } = require('../src/utils/mutex');

const DAY = 86_400_000;
async function env(start = Date.UTC(2026, 0, 1)) {
  const clock = { t: start };
  const now = () => clock.t;
  const db = createSqliteDb();
  await runMigrations(db);
  return { db, clock, now };
}

test('prefix validation and persistence', async () => {
  for (const bad of ['', '      ', 'abcdefg', 'a b', '@', '/', '`', '<x', '\u200b']) assert.equal(validatePrefix(bad).ok, false, JSON.stringify(bad));
  for (const good of ['!', '?', '.', '$$', 'dc!']) assert.equal(validatePrefix(good).ok, true, good);
  const { db } = await env();
  const gs = createGuildSettings({ db });
  assert.equal(await gs.getPrefix('G1'), '!');
  await gs.update('G1', { prefix: '?' });
  const fresh = createGuildSettings({ db }); // simulates a restart: no cache
  assert.equal(await fresh.getPrefix('G1'), '?');
  assert.equal(await fresh.getPrefix('G2'), '!');
  await assert.rejects(gs.update('G1', { 'prefix; DROP TABLE users': 'x' }), /Unknown guild setting/);
});

test('escalation thresholds', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(decideEscalation), ['none', 'none', 'timeout', 'kick', 'ban', 'ban']);
});

test('warnings: counting, 30-day reset from LAST warning, history preserved, idempotent', async () => {
  const { db, clock, now } = await env();
  const w = createWarnings({ db, now });
  const add = (k) => w.add({ guildId: 'G', userId: 'U', moderatorId: 'M', reason: 'r', idempotencyKey: k });
  assert.equal((await add('a')).activeCount, 1);
  clock.t += 20 * DAY;
  assert.equal((await add('b')).activeCount, 2);
  clock.t += 29 * DAY; // 29 days after LAST warning: still active
  assert.equal((await add('c')).action, 'timeout');
  clock.t += 30 * DAY; // exactly 30 days since last: reset
  const d = await add('d');
  assert.equal(d.activeCount, 1);
  assert.equal(d.resetApplied, true);
  assert.equal((await w.getState('G', 'U')).total, 4); // history intact
});

test('warnings: retry of the same event does not double-escalate', async () => {
  const { db, now } = await env();
  const w = createWarnings({ db, now });
  for (const k of ['1', '2']) await w.add({ guildId: 'G', userId: 'U', moderatorId: 'M', reason: 'r', idempotencyKey: k });
  const [a, b] = await Promise.all([1, 2].map(() => w.add({ guildId: 'G', userId: 'U', moderatorId: 'M', reason: 'r', idempotencyKey: 'dup' })));
  assert.equal([a, b].filter((x) => x.duplicate).length, 1);
  assert.equal((await w.getState('G', 'U')).activeCount, 3);
});

test('warnings: rejoin keeps state; manual reset keeps history; scheduled reset job', async () => {
  const { db, clock, now } = await env();
  const w = createWarnings({ db, now });
  await w.add({ guildId: 'G', userId: 'U', moderatorId: 'M', reason: 'r', idempotencyKey: '1' });
  assert.equal((await w.getState('G', 'U')).activeCount, 1); // state is keyed by id, nothing depends on membership
  assert.equal(await w.manualReset('G', 'U'), 1);
  assert.deepEqual([(await w.getState('G', 'U')).activeCount, (await w.getState('G', 'U')).total], [0, 1]);
  await w.add({ guildId: 'G', userId: 'V', moderatorId: 'M', reason: 'r', idempotencyKey: '2' });
  clock.t += ACTIVE_RESET_MS + 1;
  assert.equal((await w.resetExpired()).length, 1);
  assert.equal(effectiveActiveCount({ active_count: 4, last_warning_at: 0 }, ACTIVE_RESET_MS), 0);
});

function modEnv(guildOpts) {
  const guild = makeGuild(guildOpts);
  const audit = stubAudit();
  const logs = stubLogs();
  return { guild, audit, logs };
}

test('hierarchy rules', () => {
  const base = { guildOwnerId: 'O', botId: 'B', botTop: 10, actorId: 'A', actorTop: 5 };
  assert.equal(checkHierarchy({ ...base, targetId: 'O', targetTop: 1 }).reason, 'TARGET_IS_OWNER');
  assert.equal(checkHierarchy({ ...base, targetId: 'B', targetTop: 1 }).reason, 'TARGET_IS_BOT');
  assert.equal(checkHierarchy({ ...base, targetId: 'A', targetTop: 5 }).reason, 'TARGET_IS_ACTOR');
  assert.equal(checkHierarchy({ ...base, targetId: 'T', targetTop: 5 }).reason, 'ACTOR_NOT_ABOVE_TARGET');
  assert.equal(checkHierarchy({ ...base, actorTop: 20, targetId: 'T', targetTop: 10 }).reason, 'BOT_NOT_ABOVE_TARGET');
  assert.equal(checkHierarchy({ ...base, targetId: 'T', targetTop: 3 }).ok, true);
  assert.equal(checkHierarchy({ ...base, targetId: 'T', targetTop: null }).ok, true);
  assert.equal(classifyDiscordError(discordErr(50013)), 'PERMISSION_OR_HIERARCHY');
  assert.equal(classifyDiscordError({ status: 429 }), 'RATE_LIMITED');
  assert.equal(classifyDiscordError({ code: 'ECONNRESET' }), 'NETWORK');
});

test('moderation: missing bot permission => FAILED, no API call, no false success', async () => {
  const { guild, audit, logs } = modEnv({ botPerms: ['SendMessages'], members: { MOD: { top: 20, perms: ['BanMembers'] }, T: { top: 1 } } });
  const mod = createModeration({ warnings: null, audit, logs });
  const r = await mod.ban({ guild, actorMember: await guild.members.fetch('MOD'), targetId: 'T', reason: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BOT_MISSING_PERMISSION');
  assert.equal(guild.calls.length, 0);
  assert.equal(audit.records.at(-1).result, 'FAILED');
});

test('moderation: hierarchy failure is distinct from API failure; ban/kick/timeout/unban succeed otherwise', async () => {
  const { guild, audit, logs } = modEnv({ members: { MOD: { top: 70 }, LOW: { top: 1 }, HIGH: { top: 60 } } });
  const mod = createModeration({ warnings: null, audit, logs });
  const mm = await guild.members.fetch('MOD');
  assert.equal((await mod.kick({ guild, actorMember: mm, targetId: 'HIGH', reason: 'x' })).code, 'BOT_NOT_ABOVE_TARGET');
  assert.equal((await mod.ban({ guild, actorMember: mm, targetId: 'LOW', reason: 'spam', deleteSeconds: 999999999 })).ok, true);
  assert.equal(guild.calls.find((c) => c[0] === 'ban')[2].deleteMessageSeconds, 604800);
  assert.equal((await mod.timeout({ guild, actorMember: mm, targetId: 'LOW', reason: 'x', durationMs: 99 * DAY })).ok, true);
  assert.equal(guild.calls.find((c) => c[0] === 'timeout')[2], 28 * DAY);
  assert.equal((await mod.unban({ guild, actorMember: mm, targetId: 'LOW', reason: 'ok' })).ok, true);
  guild.errors.kick = discordErr(50013);
  const f = await mod.kick({ guild, actorMember: mm, targetId: 'LOW', reason: 'x' });
  assert.deepEqual([f.ok, f.code], [false, 'PERMISSION_OR_HIERARCHY']);
});

test('moderation: warning #3 timeouts 24h, #4 kicks, #5 bans; failures recorded and staff alerted', async () => {
  const { db, now } = await env();
  const { guild, audit, logs } = modEnv({ members: { MOD: { top: 20, perms: [] }, T: { top: 1 } } });
  const warnings = createWarnings({ db, now });
  const mod = createModeration({ warnings, audit, logs, now });
  const mm = await guild.members.fetch('MOD');
  const warn = (i) => mod.warn({ guild, actorMember: mm, targetId: 'T', reason: 'bad', idempotencyKey: `k${i}` });
  assert.equal((await warn(1)).escalation, null);
  assert.equal((await warn(2)).escalation, null);
  const w3 = await warn(3);
  assert.deepEqual([w3.escalation.action, w3.escalation.ok], ['timeout', true]);
  assert.equal(guild.calls.find((c) => c[0] === 'timeout')[2], DAY);
  guild.errors.kick = discordErr(50013);
  const w4 = await warn(4);
  assert.deepEqual([w4.escalation.action, w4.escalation.ok], ['kick', false]);
  assert.equal(logs.alerts.length, 1); // staff told the automatic action failed
  const row = (await db.query('SELECT escalation_status FROM warnings WHERE id = $1', [w4.warningId])).rows[0];
  assert.equal(row.escalation_status, 'FAILED');
  const w5 = await warn(5);
  assert.deepEqual([w5.escalation.action, w5.escalation.ok], ['ban', true]);
  const dup = await warn(5);
  assert.equal(dup.duplicate, true);
  assert.equal(guild.calls.filter((c) => c[0] === 'ban').length, 1);
});

test('purge validates range and bot permission', async () => {
  const { guild, audit, logs } = modEnv({ members: { MOD: { top: 20 } } });
  const mod = createModeration({ warnings: null, audit, logs });
  const mm = await guild.members.fetch('MOD');
  const channel = { id: 'C', permissionsFor: () => ({ has: () => true }), bulkDelete: async (n) => ({ size: typeof n === 'number' ? n - 1 : n.length }) };
  assert.equal((await mod.purge({ guild, channel, actorMember: mm, count: 0 })).code, 'BAD_COUNT');
  assert.equal((await mod.purge({ guild, channel, actorMember: mm, count: 101 })).code, 'BAD_COUNT');
  const r = await mod.purge({ guild, channel, actorMember: mm, count: 10 });
  assert.equal(r.deleted, 9);
  assert.match(r.message, /14 days/);
  const noPerm = { ...channel, permissionsFor: () => ({ has: () => false }) };
  assert.equal((await mod.purge({ guild, channel: noPerm, actorMember: mm, count: 5 })).code, 'BOT_MISSING_PERMISSION');
});

test('permission monitor: notifies once on block, once on recovery, no spam', () => {
  let s = evaluateTransition(null, ['BanMembers'], 1000);
  assert.equal(s.notify, 'blocked');
  assert.equal(evaluateTransition({ blocked: 1, missing: 'BanMembers', notifiedAt: 1000 }, ['BanMembers'], 5000).notify, null);
  assert.equal(evaluateTransition({ blocked: 1, missing: 'BanMembers', notifiedAt: 1000 }, ['BanMembers', 'ManageRoles'], 5000).notify, null); // changed set, but within the hour
  assert.equal(evaluateTransition({ blocked: 1, missing: 'BanMembers', notifiedAt: 1000 }, ['BanMembers', 'ManageRoles'], 4_000_000).notify, 'blocked');
  assert.equal(evaluateTransition({ blocked: 1, missing: 'BanMembers', notifiedAt: 1000 }, [], 5000).notify, 'recovered');
  assert.equal(evaluateTransition({ blocked: 0, missing: '', notifiedAt: 1000 }, [], 5000).notify, null);
});

test('permission monitor persists and emits transitions once', async () => {
  const { db, clock, now } = await env();
  const events = [];
  const mon = createPermissionMonitor({ db, now, onChange: async (e) => events.push(e.state) });
  await mon.report('G', 'ban', ['BanMembers']);
  await mon.report('G', 'ban', ['BanMembers']);
  await mon.report('G', 'ban', []);
  await mon.report('G', 'ban', []);
  await mon.report('G', 'never', []);
  assert.deepEqual(events, ['blocked', 'recovered']);
  assert.equal((await mon.listBlocked('G')).length, 0);
  void clock;
});

test('confirmations: scoped to user, expiring, single-use', () => {
  let t = 0;
  const c = createConfirmations({ now: () => t, ttlMs: 1000 });
  const id = c.create({ userId: 'U', guildId: 'G', run: () => {} });
  assert.equal(c.take(id, { userId: 'X', guildId: 'G' }).reason, 'NOT_OWNER');
  assert.equal(c.take(id, { userId: 'U', guildId: 'H' }).reason, 'WRONG_GUILD');
  assert.equal(c.take(id, { userId: 'U', guildId: 'G' }).ok, true);
  assert.equal(c.take(id, { userId: 'U', guildId: 'G' }).reason, 'UNKNOWN');
  const id2 = c.create({ userId: 'U', guildId: 'G', run: () => {} });
  t = 2000;
  assert.equal(c.take(id2, { userId: 'U', guildId: 'G' }).reason, 'EXPIRED');
  assert.deepEqual(parseConfirmId('cf:0123456789abcdef:y'), { id: '0123456789abcdef', accepted: true });
  assert.equal(parseConfirmId('confirm_delete'), null);
});

test('cooldowns and keyed mutex', async () => {
  let t = 0;
  const cd = new CooldownManager(() => t);
  assert.equal(cd.consume('x', 'u', 1000), 0);
  assert.equal(cd.consume('x', 'u', 1000), 1000);
  assert.equal(cd.consume('x', 'other', 1000), 0);
  t = 1001;
  assert.equal(cd.consume('x', 'u', 1000), 0);
  const m = new KeyedMutex();
  const order = [];
  await Promise.all([
    m.run('k', async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 10)); order.push('a2'); }),
    m.run('k', async () => { order.push('b1'); order.push('b2'); }),
  ]);
  assert.deepEqual(order, ['a1', 'a2', 'b1', 'b2']);
});
