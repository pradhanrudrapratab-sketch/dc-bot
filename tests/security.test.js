'use strict';
process.removeAllListeners('warning');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { assertSafeHttpUrl, isPrivateAddress, isSafeHttpsLiteral } = require('../src/services/urlGuard');
const { createAfkApi, parsePing, interpretPayload } = require('../src/services/afkApi');
const { createSecretBox } = require('../src/services/secretBox');
const { createSettingsStore } = require('../src/services/settingsStore');
const { redactString, redact, registerSecret, _clearSecretsForTests } = require('../src/utils/redact');
const { buildConfig, ConfigError } = require('../src/config');
const { parseDuration, formatDuration } = require('../src/utils/time');
const { validateServerAddress, validatePort, validateMinecraftName } = require('../src/services/validators');
const { createSqliteDb } = require('./helpers/sqliteAdapter');
const { runMigrations } = require('../src/database/migrate');

const pub = async () => [{ address: '93.184.216.34' }];

test('private address detection', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('slot URL guard blocks SSRF vectors', async () => {
  const bad = ['http://slot.example.com', 'https://localhost', 'https://127.0.0.1', 'https://169.254.169.254/latest', 'ftp://x.com', 'https://user:pw@x.com', 'https://x.com/?a=1', 'not a url'];
  for (const u of bad) await assert.rejects(assertSafeHttpUrl(u, { lookup: pub }), u);
  await assert.rejects(assertSafeHttpUrl('https://evil.example.com', { lookup: async () => [{ address: '10.0.0.5' }] }));
  assert.equal(await assertSafeHttpUrl('https://slot1.example.com/', { lookup: pub }), 'https://slot1.example.com');
  assert.equal(await assertSafeHttpUrl('http://10.0.0.5:3000', { allowPrivate: true }), 'http://10.0.0.5:3000');
});

test('media literal guard', () => {
  assert.equal(isSafeHttpsLiteral('https://media.tenor.com/a.gif'), true);
  assert.equal(isSafeHttpsLiteral('http://media.tenor.com/a.gif'), false);
  assert.equal(isSafeHttpsLiteral('https://192.168.1.1/a.gif'), false);
});

function fakeHttp(handler) {
  const calls = [];
  return { calls, get: async (url, opts) => { calls.push({ url, opts }); return handler(url, opts, calls.length); } };
}
const afkCfg = { apiKeyMode: 'query', allowPrivateSlotUrls: false };

test('AFK API: key goes in query by default, header in header mode, never for /health', async () => {
  const http = fakeHttp(async () => ({ status: 200, data: { ok: true } }));
  const api = createAfkApi({ getApiKey: async () => 'SECRETKEY', afkConfig: afkCfg, http, lookup: pub });
  await api.callSlot('https://s.example.com', 'start');
  assert.equal(http.calls[0].opts.params.key, 'SECRETKEY');
  const h = createAfkApi({ getApiKey: async () => 'SECRETKEY', afkConfig: { ...afkCfg, apiKeyMode: 'header' }, http, lookup: pub });
  await h.callSlot('https://s.example.com', 'start');
  assert.equal(http.calls[1].opts.headers['x-api-key'], 'SECRETKEY');
  assert.equal(http.calls[1].opts.params.key, undefined);
  await api.healthCheck('https://s.example.com');
  assert.equal(http.calls[2].opts.params.key, undefined);
  assert.equal(http.calls[2].opts.maxRedirects, 0);
});

test('AFK API: error normalisation never leaks the key; toggles are not retried; ping is', async () => {
  const mk = (err) => fakeHttp(async () => { throw err; });
  const net = Object.assign(new Error('connect ECONNREFUSED https://s.example.com/start?key=SECRETKEY'), { code: 'ECONNREFUSED' });
  let http = mk(net);
  let api = createAfkApi({ getApiKey: async () => 'SECRETKEY', afkConfig: afkCfg, http, lookup: pub });
  let r = await api.callSlot('https://s.example.com', 'jump');
  assert.equal(r.code, 'NETWORK');
  assert.ok(!JSON.stringify(r).includes('SECRETKEY'));
  assert.equal(http.calls.length, 1);
  http = mk(net);
  api = createAfkApi({ getApiKey: async () => 'SECRETKEY', afkConfig: afkCfg, http, lookup: pub });
  await api.callSlot('https://s.example.com', 'ping');
  assert.equal(http.calls.length, 2);
  for (const [status, code] of [[401, 'AUTH'], [404, 'NOT_FOUND'], [429, 'RATE_LIMIT'], [500, 'SERVER']]) {
    api = createAfkApi({ getApiKey: async () => 'k', afkConfig: afkCfg, http: mk(Object.assign(new Error('x'), { response: { status } })), lookup: pub });
    assert.equal((await api.callSlot('https://s.example.com', 'start')).code, code);
  }
});

test('AFK API: missing key, unsafe URL, bad endpoint, rejected payload', async () => {
  const http = fakeHttp(async () => ({ status: 200, data: { success: false, message: 'bot offline' } }));
  let api = createAfkApi({ getApiKey: async () => '', afkConfig: afkCfg, http, lookup: pub });
  assert.equal((await api.callSlot('https://s.example.com', 'start')).code, 'NO_KEY');
  api = createAfkApi({ getApiKey: async () => 'k', afkConfig: afkCfg, http, lookup: pub });
  assert.equal((await api.callSlot('https://127.0.0.1', 'start')).code, 'UNSAFE_URL');
  assert.equal((await api.callSlot('https://s.example.com', '../admin')).code, 'BAD_ENDPOINT');
  const r = await api.callSlot('https://s.example.com', 'start');
  assert.deepEqual([r.ok, r.code, r.error], [false, 'REJECTED', 'bot offline']);
  assert.equal(interpretPayload('<html>').ok, true);
  assert.deepEqual(parsePing({ online: true, players: { online: 3, max: 20 } }), { online: true, current: 3, max: 20 });
  assert.deepEqual(parsePing(null), { online: true, current: null, max: null });
});

test('secret redaction', () => {
  _clearSecretsForTests();
  registerSecret('SUPERSECRETVALUE');
  assert.ok(!redactString('x SUPERSECRETVALUE y').includes('SUPERSECRETVALUE'));
  assert.ok(!redactString('GET https://a.com/start?key=abc123&x=1').includes('abc123'));
  assert.ok(!redactString('Authorization: Bearer abc.def.ghi').includes('abc.def'));
  assert.ok(!redactString('postgresql://u:hunter2@host/db').includes('hunter2'));
  const tok = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.' + 'x'.repeat(30);
  assert.ok(!redactString(`token ${tok}`).includes(tok));
  const o = redact({ apiKey: 'zzz', nested: { password: 'p', ok: 'fine' }, err: new Error('key=abc?key=qwerty') });
  assert.equal(o.apiKey, '[REDACTED]');
  assert.equal(o.nested.password, '[REDACTED]');
  assert.equal(o.nested.ok, 'fine');
  assert.ok(!JSON.stringify(o).includes('qwerty'));
});

test('secret box + settings store (encrypted at rest, env fallback)', async () => {
  const key = crypto.randomBytes(32);
  const box = createSecretBox(key);
  const ct = box.encrypt('hello');
  assert.notEqual(ct, 'hello');
  assert.equal(box.decrypt(ct), 'hello');
  assert.throws(() => createSecretBox(crypto.randomBytes(8)));
  assert.throws(() => createSecretBox(key).decrypt(ct.replace(/.$/, 'A') + 'x'));
  const db = createSqliteDb();
  await runMigrations(db);
  const s = createSettingsStore({ db, secretBox: box, envApiKey: 'ENVKEY1234' });
  assert.equal(await s.getGlobalApiKey(), 'ENVKEY1234');
  await s.setGlobalApiKey('DBKEY-5678');
  assert.equal(await s.getGlobalApiKey(), 'DBKEY-5678');
  const raw = (await db.query("SELECT ciphertext FROM secrets WHERE name='global_api_key'")).rows[0].ciphertext;
  assert.ok(!raw.includes('DBKEY-5678'));
  const noBox = createSettingsStore({ db, secretBox: null });
  await assert.rejects(noBox.setGlobalApiKey('x'), (e) => e.code === 'NO_ENCRYPTION_KEY');
});

const goodEnv = {
  DISCORD_TOKEN: 't', CLIENT_ID: '123456789012345678', BOT_OWNER_ID: '123456789012345679',
  DATABASE_URL: 'postgresql://u:p@h:5432/d', MASTER_SERVER_ID: '123456789012345680',
};

test('config validation', () => {
  const c = buildConfig(goodEnv);
  assert.equal(c.subscription.days, 30);
  assert.equal(c.subscription.amount, 25000000);
  assert.ok(c.bot.superAdmins.has(goodEnv.BOT_OWNER_ID));
  assert.throws(() => buildConfig({}), (e) => e instanceof ConfigError && e.problems.length >= 5);
  assert.throws(() => buildConfig({ ...goodEnv, DATABASE_URL: './data/bot.db' }), /PostgreSQL/);
  assert.throws(() => buildConfig({ ...goodEnv, SUBSCRIPTION_DAYS: 'abc' }), /SUBSCRIPTION_DAYS/);
  assert.throws(() => buildConfig({ ...goodEnv, SECRETS_ENCRYPTION_KEY: 'short' }), /32 bytes/);
  assert.throws(() => buildConfig({ ...goodEnv, GIF_PROVIDER: 'giphy' }), /GIF_API_KEY/);
  assert.equal(buildConfig({ ...goodEnv, SECRETS_ENCRYPTION_KEY: 'a'.repeat(64) }).afk.encryptionKey.length, 32);
  assert.equal(buildConfig({ ...goodEnv, PORT: '10000' }).http.port, 10000);
  assert.deepEqual({ ...buildConfig(goodEnv).antinuke }, { threshold: 3, windowMs: 60000 });
  assert.equal(buildConfig({ ...goodEnv, ANTINUKE_THRESHOLD: '5', ANTINUKE_WINDOW_SECONDS: '30' }).antinuke.windowMs, 30000);
  assert.throws(() => buildConfig({ ...goodEnv, ANTINUKE_WINDOW_SECONDS: '1' }), /ANTINUKE_WINDOW_SECONDS/);
});

test('durations and validators', () => {
  assert.equal(parseDuration('10m'), 600000);
  assert.equal(parseDuration('1h30m'), 5400000);
  assert.equal(parseDuration('2d'), 172800000);
  for (const bad of ['', 'abc', '10', '10x', '-5m', '0m']) assert.equal(parseDuration(bad), null, bad);
  assert.equal(formatDuration(90061000), '1d 1h 1m 1s');
  assert.equal(validatePort(25565).ok, true);
  assert.equal(validatePort(70000).ok, false);
  assert.equal(validateServerAddress('play.example.com').ok, true);
  assert.equal(validateServerAddress('bad host; rm').ok, false);
  assert.equal(validateMinecraftName('Steve_1').ok, true);
  assert.equal(validateMinecraftName('way_too_long_name_x').ok, false);
});
