'use strict';

/**
 * PostgreSQL access layer. Exposes a tiny interface used everywhere:
 *   db.query(text, params) -> { rows, rowCount }
 *   db.tx(async (t) => ...) -> runs fn inside BEGIN/COMMIT (t.query has the same shape)
 *   db.dialect, db.close()
 * Placeholders are $1, $2, ... Timestamps are BIGINT epoch milliseconds.
 */
function createDatabase({ url, ssl = 'auto', poolMax = 10 }) {
  const { Pool, types } = require('pg');
  // BIGINT / COUNT(*) come back as strings by default. Epoch-ms and counts fit in 2^53.
  types.setTypeParser(20, (v) => parseInt(v, 10));

  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const isLocal = ['localhost', '127.0.0.1', '::1', ''].includes(host);
  const useSsl = ssl === 'true' || (ssl === 'auto' && !isLocal);

  const pool = new Pool({
    connectionString: url,
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined, // managed hosts commonly use self-signed certs
  });
  pool.on('error', (err) => require('../utils/logger').error('[DB] idle client error', err));

  const normalize = (r) => ({ rows: r.rows, rowCount: r.rowCount ?? r.rows.length });

  return {
    dialect: 'postgres',
    async query(text, params = []) {
      return normalize(await pool.query(text, params));
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const t = { dialect: 'postgres', query: async (text, params = []) => normalize(await client.query(text, params)) };
        const out = await fn(t);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createDatabase };
