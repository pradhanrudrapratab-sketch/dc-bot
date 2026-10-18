'use strict';
const http = require('node:http');
const logger = require('../utils/logger');

/**
 * Unauthenticated liveness endpoint for uptime monitors (Render/UptimeRobot). Exposes no secrets or counts.
 * 200 only when the Discord gateway is ready AND the database answers.
 */
function startHealthServer({ port, getClient, db }) {
  const bootTime = Date.now();
  const server = http.createServer(async (req, res) => {
    const path = (req.url || '').split('?')[0];
    if (req.method !== 'GET' || (path !== '/health' && path !== '/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'not_found' }));
    }
    const ready = !!getClient()?.isReady?.();
    let dbOk = false;
    try { await db.query('SELECT 1'); dbOk = true; } catch { /* reported below */ }
    const ok = ready && dbOk;
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', discord: ready ? 'ready' : 'starting', database: dbOk ? 'ok' : 'down', uptime_seconds: Math.floor((Date.now() - bootTime) / 1000) }));
  });
  server.on('error', (err) => logger.error('[HEALTH] server error', { error: err }));
  server.listen(port, () => logger.info(`[HEALTH] listening on :${port} (GET /health)`));
  return server;
}

module.exports = { startHealthServer };
