'use strict';
process.removeAllListeners('warning');
require('./helpers/fakeDiscord');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSqliteDb } = require('./helpers/sqliteAdapter');
const { runMigrations } = require('../src/database/migrate');
const { createEconomy, dailyReward } = require('../src/services/economy');
const { createFun, FUN_ACTIONS } = require('../src/services/fun');

const HOUR = 3_600_000;
async function env(settings = {}, rng) {
  const clock = { t: 1_000_000_000 };
  const db = createSqliteDb();
  await runMigrations(db);
  const make = (r = rng) => createEconomy({ db, now: () => clock.t, settings, rng: r });
  return { db, clock, eco: make(), make };
}
const alwaysHeads = () => 0; // rigged RNG: the pick "heads" would win EVERY normal flip

test('daily: reward math, 24h rolling cooldown, streak grows within 48h and resets after', async () => {
  const { eco, clock } = await env({ dailyAmount: 500 });
  assert.deepEqual([dailyReward(500, 1), dailyReward(500, 2), dailyReward(500, 7), dailyReward(500, 30)], [500, 550, 800, 800]);
  const d1 = await eco.daily('U');
  assert.deepEqual([d1.ok, d1.amount, d1.streak, d1.balance], [true, 500, 1, 500]);
  clock.t += 23 * HOUR;
  const early = await eco.daily('U');
  assert.equal(early.ok, false);
  assert.equal(early.retryAt, 1_000_000_000 + 24 * HOUR);
  clock.t += 1 * HOUR; // exactly 24h after the first claim
  const d2 = await eco.daily('U');
  assert.deepEqual([d2.amount, d2.streak, d2.balance], [550, 2, 1050]);
  clock.t += 47 * HOUR;
  assert.equal((await eco.daily('U')).streak, 3);
  clock.t += 49 * HOUR; // missed a day: streak resets
  const reset = await eco.daily('U');
  assert.deepEqual([reset.streak, reset.amount], [1, 500]);
});

test('daily: users are independent and simultaneous claims succeed only once', async () => {
  const { eco } = await env();
  const r = await Promise.all([eco.daily('A'), eco.daily('A'), eco.daily('A')]);
  assert.equal(r.filter((x) => x.ok).length, 1);
  assert.equal(await eco.balance('A'), 500);
  assert.equal((await eco.daily('B')).ok, true);
});

test('coinflip: EVERY 7th flip is a guaranteed loss, even with an RNG that always wins', async () => {
  const { eco } = await env({}, alwaysHeads);
  await eco.credit('U', 1000, 'seed');
  const outcomes = [];
  for (let i = 1; i <= 14; i++) {
    const r = await eco.coinflip('U', 10, 'heads');
    assert.equal(r.ok, true);
    assert.equal(r.flipNumber, i);
    outcomes.push(r.won);
    assert.equal(r.forcedLoss, i % 7 === 0);
  }
  assert.deepEqual(outcomes, [true, true, true, true, true, true, false, true, true, true, true, true, true, false]);
  assert.equal(await eco.balance('U'), 1000 + 12 * 10 - 2 * 10);
});

test('coinflip: forced loss shows the opposite side; counter survives a restart; counters are per user', async () => {
  const { eco, make } = await env({}, alwaysHeads);
  await eco.credit('A', 1000, 'seed'); await eco.credit('B', 1000, 'seed');
  for (let i = 0; i < 6; i++) await eco.coinflip('A', 1, 'heads');
  const restarted = make(); // new service instance = process restart; state is in the database
  const seventh = await restarted.coinflip('A', 1, 'heads');
  assert.deepEqual([seventh.won, seventh.forcedLoss, seventh.result], [false, true, 'tails']);
  const tails = await restarted.coinflip('B', 1, 'tails'); // B's first flip: rigged RNG gives heads, so tails pick loses naturally
  assert.deepEqual([tails.flipNumber, tails.forcedLoss, tails.won], [1, false, false]);
  assert.equal((await restarted.coinflip('A', 1, 'tails')).flipNumber, 8);
});

test('coinflip: insufficient funds / over max / bad input never consume the counter or move money', async () => {
  const { eco } = await env({ coinflipMaxBet: 100 }, alwaysHeads);
  await eco.credit('U', 50, 'seed');
  assert.equal((await eco.coinflip('U', 51, 'heads')).reason, 'INSUFFICIENT_FUNDS');
  assert.equal((await eco.coinflip('U', 101, 'heads')).reason, 'OVER_MAX_BET');
  assert.equal((await eco.coinflip('U', 0, 'heads')).reason, 'BAD_AMOUNT');
  assert.equal((await eco.coinflip('U', 1.5, 'heads')).reason, 'BAD_AMOUNT');
  assert.equal((await eco.coinflip('U', 5, 'edge')).reason, 'BAD_SIDE');
  assert.equal(await eco.balance('U'), 50);
  assert.equal((await eco.coinflip('U', 5, 'heads')).flipNumber, 1); // none of the rejects counted
});

test('coinflip: configurable cycle length; concurrent flips never overdraw', async () => {
  const { eco } = await env({ coinflipLossEvery: 3 }, alwaysHeads);
  await eco.credit('U', 30, 'seed');
  const first = [];
  for (let i = 0; i < 3; i++) first.push((await eco.coinflip('U', 1, 'heads')).won);
  assert.deepEqual(first, [true, true, false]);
  const racer = (await env({}, alwaysHeads)).eco;
  await racer.credit('R', 100, 'seed');
  const res = await Promise.all(Array.from({ length: 10 }, () => racer.coinflip('R', 60, 'heads')));
  assert.ok(await racer.balance('R') >= 0);
  assert.ok(res.filter((r) => r.ok).length >= 1);
  assert.ok(res.filter((r) => !r.ok).every((r) => r.reason === 'INSUFFICIENT_FUNDS'));
});

test('coinflip is a fair coin when not a forced round (rng is used, both sides occur)', async () => {
  const seq = [0, 1, 1, 0, 1, 0];
  let i = 0;
  const { eco } = await env({}, () => seq[i++ % seq.length]);
  await eco.credit('U', 1000, 'seed');
  const results = [];
  for (let k = 0; k < 6; k++) results.push((await eco.coinflip('U', 1, 'heads')).result);
  assert.deepEqual(results, ['heads', 'tails', 'tails', 'heads', 'tails', 'heads']);
});

test('leaderboard and give still behave', async () => {
  const { eco } = await env();
  await eco.credit('A', 300, 's'); await eco.credit('B', 100, 's');
  assert.deepEqual((await eco.leaderboard(5)).map((r) => r.user_id), ['A', 'B']);
  const t = await eco.transfer('A', 'B', 250);
  assert.deepEqual([t.balance, t.toBalance], [50, 350]);
  assert.deepEqual((await eco.leaderboard(5)).map((r) => r.user_id), ['B', 'A']);
});

test('fun: kick/punch/poke/cuddle exist; with a GIF provider the DEFAULT is a GIF with attribution data', async () => {
  for (const a of ['slap', 'kick', 'punch', 'hug', 'pat', 'bonk', 'highfive', 'punt', 'poke', 'cuddle']) assert.ok(FUN_ACTIONS[a], a);
  assert.equal(FUN_ACTIONS.kick.slash, false);
  const { db } = await env();
  const asked = [];
  const provider = { name: 'giphy', fetchGif: async (q) => { asked.push(q); return 'https://media.giphy.com/x/giphy.gif'; } };
  const fun = createFun({ db, provider });
  const c = await fun.compose({ guildId: 'G', guildName: 'g', action: 'punch', actorMention: '<@1>', targetMention: '<@2>' });
  assert.deepEqual([c.text, c.imageUrl, c.viaProvider, c.degraded], ['<@1> punches <@2>!', 'https://media.giphy.com/x/giphy.gif', 'giphy', false]);
  assert.deepEqual(asked, ['anime punch']);
  await fun.upsert('G', 'punch', { source: 'direct', media_url: 'https://example.com/p.gif' }, 'U'); // owner override still wins
  const d = await fun.compose({ guildId: 'G', guildName: 'g', action: 'punch', actorMention: '<@1>', targetMention: '<@2>' });
  assert.deepEqual([d.imageUrl, d.viaProvider], ['https://example.com/p.gif', null]);
  const noProv = createFun({ db, provider: null });
  const n = await noProv.compose({ guildId: 'G2', guildName: 'g', action: 'kick', actorMention: '<@1>', targetMention: '<@2>' });
  assert.deepEqual([n.imageUrl, n.degraded], [null, false]); // no provider, no media: clean text-only, not an error
  const failing = createFun({ db, provider: { name: 'giphy', fetchGif: async () => { throw new Error('quota'); } } });
  const f = await failing.compose({ guildId: 'G3', guildName: 'g', action: 'hug', actorMention: '<@1>', targetMention: '<@2>' });
  assert.deepEqual([f.text, f.imageUrl, f.degraded], ['<@1> hugs <@2>!', null, true]);
});
