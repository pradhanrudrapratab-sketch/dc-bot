'use strict';
const http = require('node:http');
const logger = require('../utils/logger');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function formatUptime(sec) {
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  return [d ? `${d}d` : '', h || d ? `${h}h` : '', m || h || d ? `${m}m` : '', `${s}s`].filter(Boolean).join(' ');
}

/** Pure HTML renderer (no secrets, no counts). The keywords ONLINE / DEGRADED are what an uptime monitor can match. */
function renderHealthPage(s) {
  const ok = s.discord.ready && s.db.ok;
  const card = (title, good, headline, detail) => `
    <div class="card ${good ? 'good' : 'bad'}">
      <div class="label">${esc(title)}</div>
      <div class="value">${good ? '🟢' : '🔴'} ${esc(headline)}</div>
      <div class="detail">${esc(detail)}</div>
    </div>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>DC Bot • ${ok ? 'ONLINE' : 'DEGRADED'}</title>
<style>
  :root{color-scheme:dark}*{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f0a1e;color:#ece8f7;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
  main{width:100%;max-width:560px}
  h1{margin:0 0 4px;font-size:22px;color:#a78bfa}
  .sub{color:#8d84a8;margin-bottom:20px;font-size:14px}
  .banner{padding:18px 20px;border-radius:14px;font-weight:700;font-size:20px;margin-bottom:16px;border:1px solid}
  .banner.good{background:#0d2a21;border-color:#10b981;color:#6ee7b7}
  .banner.bad{background:#2d1015;border-color:#ef4444;color:#fca5a5}
  .grid{display:grid;gap:12px}
  .card{background:#1a1230;border:1px solid #2e2250;border-radius:14px;padding:16px 18px}
  .card.good{border-left:4px solid #10b981}.card.bad{border-left:4px solid #ef4444}
  .label{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8d84a8}
  .value{font-size:19px;font-weight:600;margin:2px 0}.detail{color:#b8afd4;font-size:14px}
  footer{margin-top:18px;color:#6f6690;font-size:12px;text-align:center}
</style></head>
<body><main>
  <h1>DC Bot status</h1>
  <div class="sub">Auto-refreshes every 30 seconds</div>
  <div class="banner ${ok ? 'good' : 'bad'}">${ok ? '✅ ALL SYSTEMS ONLINE' : '⚠️ DEGRADED: something is not connected'}</div>
  <div class="grid">
    ${card('Discord', s.discord.ready, s.discord.ready ? 'Logged in' : 'NOT logged in', s.discord.ready ? `${s.discord.tag}${s.discord.pingMs >= 0 ? ` · gateway ping ${s.discord.pingMs} ms` : ''}` : 'The bot has not completed its Discord login. Check the token, intents and host logs.')}
    ${card('Database', s.db.ok, s.db.ok ? 'Connected' : 'NOT connected', s.db.ok ? `PostgreSQL answered in ${s.db.latencyMs} ms` : 'The database did not answer a test query.')}
    <div class="card good"><div class="label">Uptime</div><div class="value">⏱️ ${esc(formatUptime(s.uptimeSeconds))}</div><div class="detail">since the process started</div></div>
  </div>
  <footer>Checked ${esc(s.checkedAt)} · DC Bot</footer>
</main></body></html>`;
}

async function collectState({ getClient, db, bootTime, now = Date.now }) {
  const client = getClient();
  const ready = !!client?.isReady?.();
  let dbOk = false; let latencyMs = -1;
  const t0 = now();
  try { await db.query('SELECT 1'); dbOk = true; latencyMs = now() - t0; } catch { /* reported as not connected */ }
  return {
    discord: { ready, tag: ready ? client.user.tag : null, pingMs: ready ? Math.round(client.ws?.ping ?? -1) : -1 },
    db: { ok: dbOk, latencyMs },
    uptimeSeconds: Math.floor((now() - bootTime) / 1000),
    checkedAt: new Date(now()).toISOString(),
  };
}

/**
 * Public status page for uptime monitors.
 *   GET|HEAD /  or /health        -> HTML page (200 when Discord AND database are up, else 503)
 *   GET|HEAD /health.json         -> same data as JSON
 * HEAD is supported because UptimeRobot's default HTTP monitor uses it. No secrets or counts are exposed.
 */
function startHealthServer({ port, getClient, db }) {
  const bootTime = Date.now();
  const server = http.createServer(async (req, res) => {
    const path = (req.url || '').split('?')[0];
    const isHead = req.method === 'HEAD';
    if ((req.method !== 'GET' && !isHead) || !['/', '/health', '/health.json'].includes(path)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(isHead ? undefined : 'Not found');
    }
    try {
      const state = await collectState({ getClient, db, bootTime });
      const ok = state.discord.ready && state.db.ok;
      const json = path === '/health.json';
      const body = json
        ? JSON.stringify({ status: ok ? 'ok' : 'degraded', discord: state.discord.ready ? 'ready' : 'not_connected', database: state.db.ok ? 'ok' : 'down', uptime_seconds: state.uptimeSeconds })
        : renderHealthPage(state);
      res.writeHead(ok ? 200 : 503, { 'Content-Type': json ? 'application/json' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      return res.end(isHead ? undefined : body);
    } catch (err) {
      logger.error('[HEALTH] render failed', { error: err });
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(isHead ? undefined : 'Health check error');
    }
  });
  server.on('error', (err) => logger.error('[HEALTH] server error', { error: err }));
  server.listen(port, () => logger.info(`[HEALTH] status page on :${port} (GET /health)`));
  return server;
}

module.exports = { startHealthServer, renderHealthPage, collectState, formatUptime };
