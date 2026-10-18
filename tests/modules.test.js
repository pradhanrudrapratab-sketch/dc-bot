'use strict';
process.removeAllListeners('warning');
require('./helpers/fakeDiscord');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSqliteDb } = require('./helpers/sqliteAdapter');
const { runMigrations } = require('../src/database/migrate');
const { makeGuild, stubLogs, stubAudit, discordErr } = require('./helpers/fakes');
const { createModeration } = require('../src/services/moderation');
const { attributeJoin, createInviteRepo, createInviteTracker } = require('../src/services/invites');
const { createHoneypot, shouldTrigger, planHoneypotOverwrites, buildDm } = require('../src/services/honeypot');
const { createAntiNuke } = require('../src/services/antinuke');
const { createBotGuard, decideBotAdd } = require('../src/services/botguard');
const { createAnnouncements } = require('../src/services/announcements');
const { createSettingsStore } = require('../src/services/settingsStore');
const { createFun, validateTemplate, renderTemplate, validateMediaUrl, FUN_ACTIONS } = require('../src/services/fun');
const { createEconomy } = require('../src/services/economy');
const { parseEmoji, planDestination, limitFor } = require('../src/services/emoji');
const { planLockdown, canGrantRole, parseLockdown, serializeLockdown } = require('../src/services/verification');

async function env() {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const db = createSqliteDb();
  await runMigrations(db);
  return { db, clock, now };
}
const inv = (uses, maxUses = 0, inviterId = 'I1') => ({ uses, maxUses, inviterId });

/* ───── invites ───── */
test('invite attribution: single increment, ambiguity, exhausted invite, vanity, no match', () => {
  const before = new Map([['a', inv(1)], ['b', inv(0, 0, 'I2')]]);
  assert.deepEqual(attributeJoin(before, new Map([['a', inv(2)], ['b', inv(0, 0, 'I2')]])), { attribution: 'KNOWN', code: 'a', inviterId: 'I1' });
  assert.equal(attributeJoin(before, new Map([['a', inv(2)], ['b', inv(1, 0, 'I2')]])).attribution, 'UNKNOWN'); // simultaneous: ambiguous
  assert.equal(attributeJoin(before, new Map([['a', inv(1)], ['b', inv(0, 0, 'I2')]])).reason, 'NO_MATCH');
  const ex = new Map([['x', inv(4, 5, 'I9')]]);
  assert.equal(attributeJoin(ex, new Map()).inviterId, 'I9'); // max-uses invite vanished
  assert.equal(attributeJoin(new Map([['x', { ...inv(4, 5), deletedAt: 0 }]]), new Map(), { now: 60_000 }).attribution, 'UNKNOWN'); // stale manual delete
  assert.equal(attributeJoin(new Map(), new Map(), { vanityBefore: 3, vanityAfter: 4 }).attribution, 'VANITY');
  assert.equal(attributeJoin(new Map(), new Map([['n', inv(1)]])).code, 'n'); // invite created and used between snapshots
});

test('invite tracking: active count decrements on leave, history stays, duplicates ignored, rejoin needs fresh attribution', async () => {
  const { db, clock, now } = await env();
  const repo = createInviteRepo({ db, now });
  let live = [{ code: 'a', uses: 0, maxUses: 0, inviterId: 'I1' }];
  const guild = { id: 'G', invites: { fetch: async () => new Map(live.map((i) => [i.code, i])) } };
  const tracker = createInviteTracker({ repo, now });
  await tracker.refresh(guild);
  const join = async (id) => tracker.handleJoin({ id, guild, user: { createdTimestamp: 5 } });
  live = [{ code: 'a', uses: 1, maxUses: 0, inviterId: 'I1' }];
  assert.equal((await join('M1')).inviterId, 'I1');
  assert.equal((await join('M1')).recorded, false); // duplicate join event: no double count
  live = [{ code: 'a', uses: 2, maxUses: 0, inviterId: 'I1' }];
  await join('M2');
  assert.deepEqual(await repo.stats('G', 'I1'), { total: 2, active: 2, departed: 0 });
  assert.equal((await tracker.handleLeave('G', 'M1')).inviter_id, 'I1');
  assert.equal(await tracker.handleLeave('G', 'M1'), null); // duplicate leave: no double decrement
  assert.deepEqual(await repo.stats('G', 'I1'), { total: 2, active: 1, departed: 1 });
  // M1 rejoins but attribution is not reliable -> Unknown, nobody gets credit
  const r = await join('M1');
  assert.equal(r.attribution, 'UNKNOWN');
  assert.deepEqual(await repo.stats('G', 'I1'), { total: 2, active: 1, departed: 1 });
  assert.deepEqual((await repo.leaderboard('G'))[0], { inviterId: 'I1', total: 2, active: 1, departed: 1 });
  void clock;
});

test('invite tracking: simultaneous joins are serialised per guild', async () => {
  const { db, now } = await env();
  const repo = createInviteRepo({ db, now });
  let live = [{ code: 'a', uses: 0, maxUses: 0, inviterId: 'I1' }, { code: 'b', uses: 0, maxUses: 0, inviterId: 'I2' }];
  let calls = 0;
  const guild = { id: 'G', invites: { fetch: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return new Map(live.map((i) => [i.code, { ...i }])); } } };
  const tracker = createInviteTracker({ repo, now });
  await tracker.refresh(guild);
  live = [{ ...live[0], uses: 1 }, live[1]];
  const p1 = tracker.handleJoin({ id: 'M1', guild, user: {} });
  const p2 = tracker.handleJoin({ id: 'M2', guild, user: {} }); // real second join happens after the first diff
  const r1 = await p1;
  live = [live[0], { ...live[1], uses: 1 }];
  const r2 = await p2;
  assert.equal(r1.inviterId, 'I1');
  assert.equal(r2.inviterId, 'I2');
  void calls;
});

/* ───── honeypot ───── */
const hpSettings = { honeypot_enabled: 1, honeypot_channel_id: 'HP', honeypot_tamper_action: 'alert' };
const msg = (o = {}) => ({ id: 'm1', channelId: 'HP', authorId: 'SPAM', authorIsBot: false, webhookId: null, system: false, ...o });

test('honeypot trigger decision ignores self, bots, webhooks, other channels, disabled', () => {
  const s = hpSettings;
  assert.equal(shouldTrigger({ message: msg(), settings: s, botId: 'BOT' }).trigger, true);
  assert.equal(shouldTrigger({ message: msg({ authorId: 'BOT' }), settings: s, botId: 'BOT' }).reason, 'SELF');
  assert.equal(shouldTrigger({ message: msg({ authorIsBot: true }), settings: s, botId: 'BOT' }).reason, 'OTHER_BOT');
  assert.equal(shouldTrigger({ message: msg({ webhookId: '1' }), settings: s, botId: 'BOT' }).reason, 'WEBHOOK');
  assert.equal(shouldTrigger({ message: msg({ channelId: 'X' }), settings: s, botId: 'BOT' }).reason, 'OTHER_CHANNEL');
  assert.equal(shouldTrigger({ message: msg(), settings: { ...s, honeypot_enabled: 0 }, botId: 'BOT' }).reason, 'DISABLED');
  assert.match(buildDm('Cool Server'), /Cool Server/);
});

test('honeypot: bans with 7-day deletion, DMs, audits, no recursion, burst dedupe', async () => {
  const guild = makeGuild({ members: { SPAM: { top: 1 } } });
  const audit = stubAudit(); const logs = stubLogs();
  const moderation = createModeration({ warnings: null, audit, logs });
  const hp = createHoneypot({ moderation, audit, logs });
  const o = await hp.handleMessage({ message: msg(), guild, settings: hpSettings });
  assert.deepEqual([o.banned, o.dmSent, o.deletionRequested], [true, true, true]);
  assert.equal(guild.calls.find((c) => c[0] === 'ban')[2].deleteMessageSeconds, 604800);
  assert.equal(guild.sent[0][0], 'dm');
  assert.equal(audit.security[0].eventType, 'honeypot_trigger');
  assert.equal((await hp.handleMessage({ message: msg({ id: 'm2' }), guild, settings: hpSettings })).reason, 'DEDUPED');
  assert.equal((await hp.handleMessage({ message: msg({ authorId: 'BOT' }), guild, settings: hpSettings })).handled, false);
  assert.equal(guild.calls.filter((c) => c[0] === 'ban').length, 1);
});

test('honeypot: DM failure does not undo the ban; ban failure is reported as failure', async () => {
  const guild = makeGuild({ members: { SPAM: { top: 1 }, ADM: { top: 99 } } });
  guild.errors.dm = discordErr(50007);
  const audit = stubAudit(); const logs = stubLogs();
  const hp = createHoneypot({ moderation: createModeration({ warnings: null, audit, logs }), audit, logs });
  const o = await hp.handleMessage({ message: msg(), guild, settings: hpSettings });
  assert.deepEqual([o.banned, o.dmSent], [true, false]);
  const o2 = await hp.handleMessage({ message: msg({ authorId: 'ADM' }), guild, settings: hpSettings });
  assert.equal(o2.banned, false); // higher role than the bot
  assert.equal(logs.alerts.at(-1).severity, 'error');
  assert.match(o2.errors.join(), /ban:BOT_NOT_ABOVE_TARGET/);
});

test('honeypot deletion: no guessed actor; recreate; ban only unauthorized when configured', async () => {
  const guild = makeGuild({ members: { EVIL: { top: 1 } } });
  const audit = stubAudit(); const logs = stubLogs();
  const hp = createHoneypot({ moderation: createModeration({ warnings: null, audit, logs }), audit, logs });
  const common = { guild, authorizedIds: new Set(['OWNER']), createChannel: async () => ({ id: 'NEW' }), onRecreated: async () => {} };
  const unknown = await hp.handleChannelDeleted({ ...common, settings: { ...hpSettings, honeypot_tamper_action: 'ban' }, executorId: null });
  assert.deepEqual([unknown.recreated, unknown.banned, unknown.authorized], [true, false, null]);
  assert.equal(guild.calls.some((c) => c[0] === 'ban'), false);
  const alertOnly = await hp.handleChannelDeleted({ ...common, settings: hpSettings, executorId: 'EVIL' });
  assert.equal(alertOnly.banned, false);
  const banned = await hp.handleChannelDeleted({ ...common, settings: { ...hpSettings, honeypot_tamper_action: 'ban' }, executorId: 'EVIL' });
  assert.equal(banned.banned, true);
  const auth = await hp.handleChannelDeleted({ ...common, settings: { ...hpSettings, honeypot_tamper_action: 'ban' }, executorId: 'OWNER' });
  assert.equal(auth.banned, false);
  assert.equal((await hp.handleChannelDeleted({ ...common, settings: hpSettings, executorId: 'BOT' })).reason, 'SELF');
  const failing = await hp.handleChannelDeleted({ ...common, createChannel: async () => { throw discordErr(50013); }, settings: hpSettings, executorId: 'OWNER' });
  assert.equal(failing.recreated, false);
  assert.equal(logs.alerts.at(-1).severity, 'error');
});

test('honeypot overwrites hide the trap from verified members', () => {
  const o = planHoneypotOverwrites({ everyoneId: 'E', verifiedRoleId: 'V', botId: 'B' });
  assert.deepEqual(o.find((x) => x.id === 'V').deny, ['ViewChannel']);
  assert.ok(o.find((x) => x.id === 'E').allow.includes('SendMessages'));
});

/* ───── anti-nuke ───── */
async function nukeEnv(extra = {}) {
  const { db, clock, now } = await env();
  const guild = makeGuild({ members: { NUKER: { top: 1 }, FRIEND: { top: 1 } } });
  const audit = stubAudit(); const logs = stubLogs();
  const moderation = createModeration({ warnings: null, audit, logs });
  const an = createAntiNuke({ db, moderation, audit, logs, superAdmins: new Set(['SA']), now, ...extra });
  return { db, clock, guild, audit, logs, an };
}
const S = { antinuke_enabled: 1 };

test('anti-nuke: >3 channel deletions in 60s bans actor, 3 do not; window slides', async () => {
  const { clock, guild, an } = await nukeEnv();
  const del = (id) => an.handleEntry({ guild, settings: S, action: 'channel_delete', executorId: 'NUKER', targetId: id });
  for (const i of [1, 2, 3]) assert.equal((await del(`c${i}`)).handled, false);
  clock.t += 61_000;
  assert.equal((await del('c4')).handled, false); // first three aged out
  for (const i of [5, 6]) await del(`c${i}`);
  const r = await del('c7');
  assert.equal(r.handled, true);
  assert.equal(r.banned, true);
  assert.equal(guild.calls.filter((c) => c[0] === 'ban').length, 1);
});

test('anti-nuke: kick+ban pool together; channel deletes and role deletes are separate buckets', async () => {
  const { guild, an } = await nukeEnv();
  const e = (action, i) => an.handleEntry({ guild, settings: S, action, executorId: 'NUKER', targetId: `t${i}` });
  await e('member_kick', 1); await e('member_ban', 2); await e('member_kick', 3);
  assert.equal((await e('member_ban', 4)).handled, true);
  const second = await nukeEnv();
  for (let i = 0; i < 3; i++) await second.an.handleEntry({ guild: second.guild, settings: S, action: 'channel_delete', executorId: 'NUKER', targetId: `c${i}` });
  for (let i = 0; i < 3; i++) assert.equal((await second.an.handleEntry({ guild: second.guild, settings: S, action: 'role_delete', executorId: 'NUKER', targetId: `r${i}` })).handled, false);
});

test('anti-nuke: ignores self, owner, super admins, allowlist, unknown executor, disabled', async () => {
  const { guild, an } = await nukeEnv();
  await an.addAllowlist('G1', 'FRIEND', 'OWNER');
  for (const [who, reason] of [['BOT', 'SELF'], ['OWNER', 'TRUSTED'], ['SA', 'TRUSTED'], ['FRIEND', 'ALLOWLISTED'], [null, 'NO_EXECUTOR']]) {
    for (let i = 0; i < 6; i++) var r = await an.handleEntry({ guild, settings: S, action: 'channel_delete', executorId: who, targetId: `c${i}` });
    assert.equal(r.reason, reason, String(who));
  }
  assert.equal((await an.handleEntry({ guild, settings: { antinuke_enabled: 0 }, action: 'channel_delete', executorId: 'NUKER', targetId: 'x' })).reason, 'DISABLED');
  assert.equal(guild.calls.length, 0);
  assert.equal(await an.removeAllowlist('G1', 'FRIEND'), true);
});

test('anti-nuke: ban failure alerts staff + super admins; deleted channels restored best-effort', async () => {
  const { guild, an, logs, audit } = await nukeEnv();
  guild.errors.ban = discordErr(50013);
  for (let i = 0; i < 4; i++) {
    an.rememberDeleted('channel', { id: `c${i}`, name: `chan${i}`, type: 0, parentId: null, permissionOverwrites: { cache: new Map() } });
  }
  let r;
  for (let i = 0; i < 4; i++) r = await an.handleEntry({ guild, settings: S, action: 'channel_delete', executorId: 'NUKER', targetId: `c${i}` });
  assert.equal(r.banned, false);
  assert.equal(r.restored.length, 4);
  assert.equal(guild.calls.filter((c) => c[0] === 'channels.create').length, 4);
  assert.equal(logs.alerts.at(-1).severity, 'error');
  assert.equal(audit.security[0].eventType, 'antinuke_trigger');
  const again = await an.handleEntry({ guild, settings: S, action: 'channel_delete', executorId: 'NUKER', targetId: 'c9' });
  assert.equal(again.reason, 'ALREADY_TRIGGERED');
});

/* ───── bot allowlist ───── */
test('bot add decision matrix: allowlist AND administrator required', () => {
  const base = { botId: 'B', targetId: 'NEWBOT', executorId: 'U', guildOwnerId: 'O', superAdmins: new Set(['SA']), allowlisted: false, executorIsAdmin: false };
  assert.equal(decideBotAdd({ ...base, allowlisted: true, executorIsAdmin: true }).action, 'AUTHORIZED');
  assert.equal(decideBotAdd({ ...base, allowlisted: true }).reason, 'NOT_ADMIN');
  assert.equal(decideBotAdd({ ...base, executorIsAdmin: true }).reason, 'NOT_ALLOWLISTED');
  assert.equal(decideBotAdd({ ...base, executorId: 'O' }).action, 'AUTHORIZED');
  assert.equal(decideBotAdd({ ...base, executorId: 'SA' }).action, 'AUTHORIZED');
  assert.equal(decideBotAdd({ ...base, executorId: null }).action, 'UNATTRIBUTED');
  assert.equal(decideBotAdd({ ...base, targetId: 'B' }).action, 'IGNORE');
});

test('bot guard: unauthorized add -> bot kicked + adder banned + logged; unknown adder is never guessed', async () => {
  const { db, now } = await env();
  const guild = makeGuild({ members: { RANDO: { top: 1, perms: ['Administrator'] }, GOOD: { top: 1, perms: ['Administrator'] } } });
  const audit = stubAudit(); const logs = stubLogs();
  const moderation = createModeration({ warnings: null, audit, logs });
  const bg = createBotGuard({ db, moderation, audit, logs, superAdmins: new Set(['SA']), now });
  const s = { botguard_enabled: 1, botguard_fallback: 'alert' };
  await bg.add('G1', 'GOOD', 'OWNER');
  const bad = await bg.handleBotAdded({ guild, settings: s, botUserId: 'EVILBOT', executorId: 'RANDO' });
  assert.deepEqual([bad.botKicked, bad.executorBanned], [true, true]);
  assert.ok(guild.calls.some((c) => c[0] === 'ban' && c[1] === 'RANDO'));
  const ok = await bg.handleBotAdded({ guild, settings: s, botUserId: 'GOODBOT', executorId: 'GOOD' });
  assert.equal(ok.handled, false);
  const before = guild.calls.length;
  const unk = await bg.handleBotAdded({ guild, settings: s, botUserId: 'MYSTERY', executorId: null });
  assert.equal(unk.executorBanned, false);
  assert.equal(guild.calls.length, before); // fallback "alert": nothing touched, staff told
  assert.match(logs.alerts.at(-1).description, /unknown/);
  const kicker = await bg.handleBotAdded({ guild, settings: { ...s, botguard_fallback: 'kick_bot' }, botUserId: 'MYSTERY', executorId: null });
  assert.equal(kicker.botKicked, true);
  assert.deepEqual((await bg.list('G1')).map((r) => r.user_id), ['GOOD']);
  assert.equal(await bg.remove('G1', 'GOOD'), true);
});

/* ───── announcements ───── */
test('announcement relay: eligibility, idempotency, no loop, failures isolated, mentions disabled', async () => {
  const { db, now } = await env();
  const settings = createSettingsStore({ db, now });
  const ann = createAnnouncements({ db, settings, now });
  await ann.setSource('MASTER', 'MCH');
  const src = await ann.getSource();
  const m = { id: 'S1', guildId: 'MASTER', channelId: 'MCH', authorId: 'HUMAN', content: '@everyone hello', attachments: [{ url: 'u', name: 'a.png', size: 10 }, { url: 'big', name: 'b.mp4', size: 9_000_000 }], embeds: [] };
  assert.equal(ann.isEligible(m, src, 'BOT'), true);
  assert.equal(ann.isEligible({ ...m, authorId: 'BOT' }, src, 'BOT'), false);
  assert.equal(ann.isEligible({ ...m, channelId: 'OTHER' }, src, 'BOT'), false);
  assert.equal(ann.isEligible({ ...m, guildId: 'X' }, src, 'BOT'), false);
  assert.equal(ann.isEligible({ ...m, webhookId: '1' }, src, 'BOT'), false);
  for (const g of ['D1', 'D2', 'D3']) await db.query('INSERT INTO guild_settings (guild_id, announcement_channel_id, created_at, updated_at) VALUES ($1, $2, 1, 1)', [g, `ch-${g}`]);
  const sent = [];
  const send = async (g, c, p) => { if (g === 'D2') throw discordErr(50013); sent.push([g, c, p]); };
  const r1 = await ann.relay(m, send);
  assert.deepEqual(r1.map((r) => r.status), ['SENT', 'FAILED', 'SENT']);
  assert.deepEqual(sent[0][2].allowedMentions, { parse: [] });
  assert.equal(sent[0][2].files.length, 1);
  assert.match(sent[0][2].content, /big/); // oversize attachment degraded to a link
  const r2 = await ann.relay(m, async (g, c, p) => { sent.push([g, c, p]); });
  assert.deepEqual(r2.map((r) => r.status), ['SKIPPED_DUPLICATE', 'SENT', 'SKIPPED_DUPLICATE']); // only the failed one retries
  assert.equal(sent.length, 3);
  await ann.clearSource();
  assert.equal(ann.isEligible(m, await ann.getSource(), 'BOT'), false);
});

/* ───── fun ───── */
test('fun templates: placeholders validated, rendered safely', () => {
  assert.equal(validateTemplate('{actor} slaps {target}!').ok, true);
  assert.equal(validateTemplate('{actor.constructor}').ok, false);
  assert.equal(validateTemplate('${process.env.X}').ok, false);
  assert.equal(validateTemplate('{evil}').ok, false);
  assert.equal(validateTemplate('x'.repeat(301)).ok, false);
  assert.equal(validateTemplate('').ok, false);
  assert.equal(renderTemplate('{actor} -> {target} @ {guild}', { actor: 'A', target: 'T', guild: 'G' }), 'A -> T @ G');
});

test('fun media URL validation', () => {
  assert.equal(validateMediaUrl('https://example.com/slap.gif').ok, true);
  assert.equal(validateMediaUrl('https://media.tenor.com/abc/xyz').ok, true);
  for (const bad of ['http://example.com/a.gif', 'https://example.com/page.html', 'https://127.0.0.1/a.gif', 'javascript:alert(1)', 'https://u:p@example.com/a.gif', 'nope']) assert.equal(validateMediaUrl(bad).ok, false, bad);
});

test('fun config: per-action independence, guild override over global, reset, fallback on broken media/provider', async () => {
  const { db, now } = await env();
  const provider = { fetchGif: async () => { throw new Error('provider down'); } };
  const fun = createFun({ db, provider, now });
  const c = (action, guildId = 'G') => fun.compose({ guildId, guildName: 'Guild', action, actorMention: '<@1>', targetMention: '<@2>' });
  assert.equal((await c('slap')).text, '<@1> slaps <@2>!');
  await fun.upsert('G', 'slap', { message_template: 'SLAP {target}', media_url: 'https://example.com/s.gif' }, 'U');
  assert.equal((await c('hug')).text, '<@1> hugs <@2>!'); // hug untouched
  const slap = await c('slap');
  assert.deepEqual([slap.text, slap.imageUrl], ['SLAP <@2>', 'https://example.com/s.gif']);
  await fun.upsert('*', 'pat', { media_url: 'https://example.com/pat.gif' }, 'OWNER');
  assert.equal((await c('pat', 'ANYGUILD')).imageUrl, 'https://example.com/pat.gif'); // global default
  await fun.upsert('G', 'pat', { message_template: 'custom pat' }, 'U');
  const pat = await c('pat'); // guild text override + global media inherited
  assert.deepEqual([pat.text, pat.imageUrl], ['custom pat', 'https://example.com/pat.gif']);
  await fun.upsert('G', 'bonk', { source: 'provider' }, 'U');
  const bonk = await c('bonk'); // provider throws -> text fallback, no crash
  assert.deepEqual([bonk.imageUrl, bonk.degraded], [null, true]);
  await db.query("UPDATE fun_responses SET media_url = 'http://bad/x' WHERE guild_id = 'G' AND action = 'slap'");
  assert.equal((await c('slap')).degraded, true);
  assert.equal(await fun.reset('G', 'slap'), true);
  assert.equal((await c('slap')).text, '<@1> slaps <@2>!');
  await assert.rejects(fun.upsert('G', 'nonexistent', { message_template: 'x' }, 'U'));
  assert.ok(Object.keys(FUN_ACTIONS).length >= 6);
});

/* ───── economy ───── */
test('economy: no negative balance, atomic transfer, idempotent refKey, concurrent spends', async () => {
  const { db, now } = await env();
  const eco = createEconomy({ db, now });
  assert.equal((await eco.credit('A', 100, 'seed', 'seed-1')).balance, 100);
  assert.equal((await eco.credit('A', 100, 'seed', 'seed-1')).duplicate, true);
  assert.equal(await eco.balance('A'), 100);
  assert.equal((await eco.debit('A', 101, 'x')).reason, 'INSUFFICIENT_FUNDS');
  assert.equal((await eco.debit('A', -5, 'x')).reason, 'BAD_AMOUNT');
  assert.equal((await eco.debit('A', 1.5, 'x')).reason, 'BAD_AMOUNT');
  const results = await Promise.all(Array.from({ length: 5 }, () => eco.debit('A', 30, 'spend')));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(await eco.balance('A'), 10);
  assert.equal((await eco.transfer('A', 'B', 50)).reason, 'INSUFFICIENT_FUNDS');
  assert.equal(await eco.balance('B'), 0); // failed transfer moved nothing
  const t = await eco.transfer('A', 'B', 10, 'tx1');
  assert.deepEqual([t.ok, t.balance, t.toBalance], [true, 0, 10]);
  assert.equal((await eco.transfer('A', 'A', 1)).reason, 'SAME_ACCOUNT');
  const sum = (await db.query('SELECT SUM(balance) AS s FROM economy_accounts')).rows[0].s;
  assert.equal(sum, 10);
});

/* ───── emoji + verification ───── */
test('emoji parsing and per-destination planning', () => {
  assert.deepEqual(parseEmoji('<a:party:123456789012345678>'), { id: '123456789012345678', name: 'party', animated: true });
  assert.equal(parseEmoji('<:x:1>'), null);
  assert.equal(parseEmoji('hello'), null);
  assert.equal(parseEmoji('<:cool:123456789012345678>', 'new name!').name, 'new_name_');
  const base = { userIsAdmin: true, botHasPerm: true, tier: 0, existingNames: new Set(), staticCount: 0, animatedCount: 0 };
  const e = { name: 'Cool', animated: false };
  assert.equal(planDestination(e, base).status, 'READY');
  assert.equal(planDestination(e, { ...base, userIsAdmin: false }).status, 'SKIPPED_NOT_ADMIN');
  assert.equal(planDestination(e, { ...base, botHasPerm: false }).status, 'PERMISSION_MISSING');
  assert.equal(planDestination(e, { ...base, existingNames: new Set(['cool']) }).status, 'ALREADY_EXISTS');
  assert.equal(planDestination(e, { ...base, staticCount: 50 }).status, 'NO_CAPACITY');
  assert.equal(planDestination({ ...e, animated: true }, { ...base, staticCount: 50 }).status, 'READY');
  assert.equal(limitFor(3), 250);
});

test('verification lockdown plan only touches publicly visible channels and is reversible', () => {
  const channels = [
    { id: 'gen', everyoneCanView: true, everyoneOverwrite: null, verifiedOverwrite: null },
    { id: 'staff', everyoneCanView: false, everyoneOverwrite: 'deny', verifiedOverwrite: null },
    { id: 'verify', everyoneCanView: true, everyoneOverwrite: 'allow', verifiedOverwrite: null },
    { id: 'honey', everyoneCanView: true, everyoneOverwrite: 'allow', verifiedOverwrite: null },
    { id: 'rules', everyoneCanView: true, everyoneOverwrite: 'allow', verifiedOverwrite: 'deny' },
  ];
  const plan = planLockdown({ channels, exemptChannelIds: ['verify', 'honey'] });
  assert.deepEqual(plan.ops.map((o) => o.channelId), ['gen', 'rules']);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ['ALREADY_PRIVATE', 'EXEMPT', 'EXEMPT']);
  const back = parseLockdown(serializeLockdown(plan));
  assert.equal(back.ops[1].priorVerified, 'deny'); // exact prior state kept for unlock
  assert.equal(parseLockdown('garbage'), null);
});

test('verify button decision covers disabled/missing/duplicate/permission/hierarchy', () => {
  const s = { verification_enabled: 1, verification_role_id: 'R' };
  const role = { position: 5, managed: false };
  const ok = { settings: s, role, botTop: 10, botHasManageRoles: true, alreadyHas: false };
  assert.equal(canGrantRole(ok).ok, true);
  assert.equal(canGrantRole({ ...ok, settings: { ...s, verification_enabled: 0 } }).code, 'DISABLED');
  assert.equal(canGrantRole({ ...ok, role: null }).code, 'ROLE_MISSING');
  assert.equal(canGrantRole({ ...ok, alreadyHas: true }).code, 'ALREADY');
  assert.equal(canGrantRole({ ...ok, botHasManageRoles: false }).code, 'NO_PERMISSION');
  assert.equal(canGrantRole({ ...ok, role: { position: 10, managed: false } }).code, 'HIERARCHY');
});
