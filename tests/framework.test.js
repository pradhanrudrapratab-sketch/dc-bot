'use strict';
process.removeAllListeners('warning');
const fake = require('./helpers/fakeDiscord');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSqliteDb } = require('./helpers/sqliteAdapter');
const { runMigrations } = require('../src/database/migrate');
const { makeGuild, permsOf } = require('./helpers/fakes');
const { defineCommand } = require('../src/framework/command');
const { loadCommands } = require('../src/framework/registry');
const { buildSlash } = require('../src/framework/slashAdapter');
const { parseArgs, tokenize, usage } = require('../src/framework/optionParser');
const { parsePrefixMessage, prefixContext } = require('../src/framework/prefixAdapter');
const { runCommand } = require('../src/framework/runner');
const { respond } = require('../src/bot/respond');
const { CooldownManager } = require('../src/utils/cooldown');
const { buildConfig } = require('../src/config');
const { buildInviteUrl, BOT_PERMISSIONS } = require('../src/utils/invite');

const registry = loadCommands(path.join(__dirname, '../src/commands'));
const cfg = buildConfig({ DISCORD_TOKEN: 't', CLIENT_ID: '123456789012345678', BOT_OWNER_ID: '123456789012345679', DATABASE_URL: 'postgresql://u:p@h/d', MASTER_SERVER_ID: '123456789012345680' });

test('registry loads, has no collisions, and preserves all 21 original AFK slash commands', () => {
  const original = ['assign', 'status', 'start', 'stop', 'ip', 'port', 'rename', 'jump', 'move', 'sneak', 'ping', 'setkey', 'addslot', 'editslot', 'deleteslot', 'state', 'health', 'userinfo', 'revoke', 'unassign', 'renew'];
  for (const n of original) assert.ok(registry.slash.has(n), `missing /${n}`);
  assert.equal(original.length, 21);
  assert.ok(registry.slash.size <= 100, 'Discord limit: 100 global slash commands');
});

test('every slash command builds with the schema-validating builder and fits Discord limits', () => {
  for (const c of registry.slash.values()) {
    const json = buildSlash(c, fake.SlashCommandBuilder, fake.PermissionFlagsBits).toJSON();
    assert.ok(json.description.length <= 100);
    assert.ok(JSON.stringify(json).length < 8000, `${c.name} payload too large`);
  }
});

test('prefix namespace: moderation kick is /kick + !modkick; playful !kick is a separate prefix-only fun command', () => {
  assert.equal(registry.prefix.get('modkick').name, 'kick');
  assert.equal(registry.prefix.get('modkick').category, 'moderation');
  assert.equal(registry.slash.get('kick').category, 'moderation'); // /kick is moderation only
  const funKick = registry.prefix.get('kick');
  assert.equal(funKick.category, 'fun');
  assert.equal(funKick.slash, false);
  assert.notEqual(funKick, registry.prefix.get('modkick'));
  assert.deepEqual(funKick.userPermissions, []); // the joke command can never kick anyone
  for (const a of ['slap', 'punch', 'hug', 'pat', 'bonk', 'highfive', 'punt', 'poke', 'cuddle']) {
    assert.equal(registry.prefix.get(a).category, 'fun');
    assert.equal(registry.slash.get(a).category, 'fun');
  }
  for (const n of ['ban', 'unban', 'mute', 'unmute', 'warn', 'warnings', 'purge', 'setprefix', 'help', 'steal', 'setannouncement', 'balance', 'bal', 'daily', 'coinflip', 'cf', 'flip', 'give', 'richest', 'log', 'honeypot', 'botaccess', 'antinuke', 'verification', 'invites', 'funset']) {
    assert.ok(registry.prefix.has(n), `missing prefix command ${n}`);
  }
  assert.equal(registry.prefix.has('start'), false); // AFK controls are slash-only
});

test('definition validation catches the classic Discord schema mistakes', () => {
  const base = { name: 'x', description: 'd', execute: async () => {} };
  assert.throws(() => defineCommand({ ...base, name: 'Bad Name' }));
  assert.throws(() => defineCommand({ ...base, description: 'x'.repeat(101) }));
  assert.throws(() => defineCommand({ ...base, options: [{ name: 'a', type: 'string', description: 'd' }, { name: 'b', type: 'string', description: 'd', required: true }] }), /required option after optional/);
  assert.throws(() => defineCommand({ ...base, userPermissions: ['Nope'] }), /unknown permission/);
  assert.throws(() => defineCommand({ ...base, subcommands: { a: { description: 'd', execute: async () => {} } } }), /exactly one/);
  assert.throws(() => defineCommand({ ...base, options: [{ name: 'a', type: 'string', description: 'd', rest: true }, { name: 'b', type: 'string', description: 'd' }] }), /rest/);
  assert.doesNotThrow(() => defineCommand({ ...base, options: [{ name: 'a', type: 'string', description: 'd', rest: true }, { name: 'b', type: 'integer', description: 'd', slashOnly: true }] }));
});

test('option parsing: mentions, ids, durations, quotes, rest text, choices, errors', () => {
  assert.deepEqual(tokenize('a "b c" d').map((t) => t.text), ['a', 'b c', 'd']);
  const opts = [{ name: 'user', type: 'user', required: true }, { name: 'duration', type: 'duration', required: true }, { name: 'reason', type: 'string', rest: true }];
  assert.deepEqual(parseArgs(opts, '<@!123456789012345678> 10m being   loud ').values, { user: '123456789012345678', duration: 600000, reason: 'being   loud' });
  assert.equal(parseArgs(opts, '123456789012345678 nope').ok, false);
  assert.equal(parseArgs(opts, '').ok, false);
  assert.equal(parseArgs([{ name: 'n', type: 'integer', required: true, min: 1, max: 100 }], '101').ok, false);
  assert.equal(parseArgs([{ name: 'm', type: 'string', required: true, choices: ['alert', 'ban'] }], 'BAN').values.m, 'ban');
  assert.equal(parseArgs([{ name: 'm', type: 'string', required: true, choices: ['alert', 'ban'] }], 'kill').ok, false);
  assert.equal(parseArgs([{ name: 'ch', type: 'channel' }, { name: 'create', type: 'boolean' }], 'true').values.create, true); // optional skipped, next option matched
  assert.match(usage('!', 'mute', opts), /^!mute <user> <duration> \[reason\.\.\.\]$/);
});

test('prefix message parsing, subcommands, custom prefixes, safe misses', () => {
  const idx = registry.prefix;
  assert.equal(parsePrefixMessage('hello', '!', idx), null);
  assert.equal(parsePrefixMessage('!nonexistent', '!', idx), null);
  assert.equal(parsePrefixMessage('?ban x', '!', idx), null);
  const p = parsePrefixMessage('?modkick <@123456789012345678> too rude', '?', idx);
  assert.deepEqual([p.command.name, p.options.user, p.options.reason], ['kick', '123456789012345678', 'too rude']);
  const sub = parsePrefixMessage('!honeypot tamper ban', '!', idx);
  assert.deepEqual([sub.subcommand, sub.options.action], ['tamper', 'ban']);
  assert.match(parsePrefixMessage('!honeypot', '!', idx).error, /Usage/);
  assert.match(parsePrefixMessage('!ban', '!', idx).error, /Missing/);
  const set = parsePrefixMessage('!funset message slap {actor} smacks {target}', '!', idx);
  assert.equal(set.options.text, '{actor} smacks {target}');
  assert.equal(parsePrefixMessage('!slap', '!', idx).command.name, 'slap');
});

function fakeInteraction(over = {}) {
  const calls = [];
  const i = { replied: false, deferred: false, calls,
    reply: async (p) => { calls.push(['reply', p]); i.replied = true; },
    editReply: async (p) => { calls.push(['editReply', p]); },
    followUp: async (p) => { calls.push(['followUp', p]); } };
  return Object.assign(i, over);
}

test('respond() picks reply / editReply / followUp from interaction state (fixes reply-after-defer crash)', async () => {
  const i = fakeInteraction();
  await respond(i, { content: 'a', ephemeral: true });
  assert.deepEqual([i.calls[0][0], i.calls[0][1].flags], ['reply', 64]);
  const d = fakeInteraction({ deferred: true });
  await respond(d, { content: 'b', ephemeral: true });
  assert.equal(d.calls[0][0], 'editReply');
  assert.equal(d.calls[0][1].flags, undefined);
  const r = fakeInteraction({ replied: true });
  await respond(r, { content: 'c' });
  assert.equal(r.calls[0][0], 'followUp');
});

function ctxFor(over = {}) {
  const replies = [];
  return { replies, source: 'slash', guild: makeGuild(), guildId: 'G1', user: { id: 'U1', tag: 'u#1' }, member: null, memberPermissions: permsOf([]), subcommand: null, options: {}, deps: {},
    reply: async (p) => { replies.push(p); }, defer: async () => {}, ...over };
}
const env = () => ({ config: cfg, cooldowns: new CooldownManager(), permissionMonitor: null });
const title = (ctx) => ctx.replies.at(-1).embeds[0].toJSON().title;

test('runner pipeline: guild-only, owner-only, user perms, bot perms, cooldown, error containment', async () => {
  let ran = 0;
  const mk = (o) => defineCommand({ name: 'probe', description: 'd', execute: async () => { ran++; }, ...o });
  let c = ctxFor({ guild: null, guildId: null });
  await runCommand(mk({}), c, env());
  assert.match(title(c), /Server Only/);
  c = ctxFor();
  await runCommand(mk({ ownerOnly: true }), c, env());
  assert.match(title(c), /Owner Only/);
  c = ctxFor({ user: { id: cfg.bot.ownerId } });
  await runCommand(mk({ ownerOnly: true }), c, env());
  assert.equal(ran, 1);
  c = ctxFor();
  await runCommand(mk({ userPermissions: ['BanMembers'] }), c, env());
  assert.match(title(c), /Missing Permissions/);
  c = ctxFor({ memberPermissions: permsOf(['BanMembers']), guild: makeGuild({ botPerms: [] }) });
  await runCommand(mk({ userPermissions: ['BanMembers'], botPermissions: ['BanMembers'] }), c, env());
  assert.match(title(c), /Bot Missing Permissions/);
  const e = env();
  const cd = mk({ cooldownMs: 1000 });
  await runCommand(cd, ctxFor(), e);
  c = ctxFor();
  await runCommand(cd, c, e);
  assert.match(title(c), /Slow Down/);
  c = ctxFor();
  const log = console.error; console.error = () => {};
  await runCommand(mk({ execute: async () => { throw new Error('kaboom with key=abc?key=secret123'); } }), c, env());
  console.error = log;
  assert.match(title(c), /Something Went Wrong/);
  assert.ok(!JSON.stringify(c.replies).includes('secret123'));
});

test('end-to-end: prefix !ban and slash-style ban share one behaviour', async () => {
  const guild = makeGuild({ members: { MOD: { top: 20, perms: ['BanMembers'] }, TARGET: { top: 1 } } });
  const audit = { records: [], record: async (r) => audit.records.push(r) };
  const { createModeration } = require('../src/services/moderation');
  const moderation = createModeration({ warnings: null, audit, logs: { alertStaff: async () => {} } });
  const deps = { moderation, config: cfg };
  const mod = await guild.members.fetch('MOD');
  const message = { client: { user: { id: 'BOT' } }, guild, guildId: 'G1', channel: {}, author: { id: 'MOD' }, member: mod, reply: async (p) => { message.sent = p; } };
  const parsed = parsePrefixMessage('!ban <@123456789012345678> spamming links', '!', registry.prefix);
  guild.addMember('123456789012345678', { top: 1 });
  const pctx = prefixContext({ ...message, member: { ...mod, permissions: permsOf(['BanMembers']), id: 'MOD' } }, parsed, deps);
  await runCommand(parsed.command, pctx, env());
  assert.ok(guild.calls.find((c) => c[0] === 'ban' && c[1] === '123456789012345678'));
  assert.deepEqual(message.sent.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(audit.records.at(-1).result, 'SUCCESS');
  // same command, slash-style context
  const sctx = ctxFor({ guild, memberPermissions: permsOf(['BanMembers']), member: mod, options: { user: 'TARGET', reason: 'x', delete_days: 7 }, deps });
  await runCommand(registry.slash.get('ban'), sctx, env());
  assert.equal(guild.calls.find((c) => c[0] === 'ban' && c[1] === 'TARGET')[2].deleteMessageSeconds, 604800);
});

test('invite URL contains the real permission set', () => {
  const url = buildInviteUrl('111', fake.PermissionFlagsBits);
  assert.match(url, /client_id=111&scope=bot%20applications\.commands&permissions=\d+/);
  assert.ok(BOT_PERMISSIONS.includes('ViewAuditLog') && BOT_PERMISSIONS.includes('ManageGuild'));
});

test('composition root wires every service and the schema supports them', async () => {
  const { createContainer } = require('../src/bot/container');
  const db = createSqliteDb();
  await runMigrations(db);
  const c = createContainer({ config: cfg, db, getClient: () => null });
  for (const k of ['afkApi', 'payments', 'moderation', 'honeypot', 'antiNuke', 'botGuard', 'announcements', 'fun', 'economy', 'inviteTracker', 'registry', 'confirmations']) assert.ok(c[k], k);
  assert.equal(c.subs.durationMs, 30 * 86_400_000);
  // smoke: a real flow through the container's own services
  const r = await c.payments.process({ messageId: 'x', senderId: '1', receiverId: cfg.bot.ownerId, amount: cfg.subscription.amount, username: 'u' });
  assert.equal(r.status, 'PROCESSED');
  assert.equal((await c.guildSettings.getPrefix('G')), '!');
});
