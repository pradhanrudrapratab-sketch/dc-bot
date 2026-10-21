'use strict';
process.removeAllListeners('warning');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startHealthServer, renderHealthPage, formatUptime } = require('../src/services/healthServer');

const readyClient = { isReady: () => true, user: { tag: 'Bot#0001' }, ws: { ping: 42 } };
const okDb = { query: async () => ({ rows: [] }) };
const badDb = { query: async () => { throw new Error('down'); } };

function request(port, method, path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, method, path, host: '127.0.0.1' }, (res) => {
      let body = ''; res.on('data', (d) => (body += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject); r.end();
  });
}
async function withServer(opts, fn) {
  const server = startHealthServer({ port: 0, ...opts });
  await new Promise((r) => server.on('listening', r));
  try { await fn(server.address().port); } finally { await new Promise((r) => server.close(r)); }
}

test('all up: HTML page, 200, shows ONLINE + logged in + db connected (GET and HEAD)', async () => {
  await withServer({ getClient: () => readyClient, db: okDb }, async (port) => {
    const g = await request(port, 'GET', '/health');
    assert.equal(g.status, 200);
    assert.match(g.headers['content-type'], /text\/html/);
    for (const s of ['ALL SYSTEMS ONLINE', 'Logged in', 'Bot#0001', 'Connected', 'gateway ping 42 ms']) assert.ok(g.body.includes(s), s);
    const h = await request(port, 'HEAD', '/health'); // UptimeRobot default method
    assert.equal(h.status, 200);
    assert.equal(h.body, '');
    assert.equal((await request(port, 'GET', '/')).status, 200);
  });
});

test('Discord not logged in -> 503 and says so; DB down -> 503 and says so', async () => {
  await withServer({ getClient: () => ({ isReady: () => false }), db: okDb }, async (port) => {
    const r = await request(port, 'GET', '/health');
    assert.equal(r.status, 503);
    assert.ok(r.body.includes('NOT logged in') && r.body.includes('DEGRADED'));
    assert.ok(r.body.includes('Connected')); // DB still shown as fine
    assert.equal((await request(port, 'HEAD', '/health')).status, 503);
  });
  await withServer({ getClient: () => readyClient, db: badDb }, async (port) => {
    const r = await request(port, 'GET', '/health');
    assert.equal(r.status, 503);
    assert.ok(r.body.includes('NOT connected'));
    assert.ok(r.body.includes('Logged in'));
  });
});

test('JSON endpoint, unknown paths and methods, no secret leakage, HTML escaping', async () => {
  await withServer({ getClient: () => readyClient, db: okDb }, async (port) => {
    const j = JSON.parse((await request(port, 'GET', '/health.json')).body);
    assert.deepEqual([j.status, j.discord, j.database], ['ok', 'ready', 'ok']);
    assert.equal((await request(port, 'GET', '/admin')).status, 404);
    assert.equal((await request(port, 'POST', '/health')).status, 404);
  });
  const html = renderHealthPage({ discord: { ready: true, tag: '<script>alert(1)</script>#1', pingMs: 1 }, db: { ok: true, latencyMs: 1 }, uptimeSeconds: 5, checkedAt: 'x' });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(formatUptime(90061), '1d 1h 1m 1s');
  assert.equal(formatUptime(5), '5s');
});
