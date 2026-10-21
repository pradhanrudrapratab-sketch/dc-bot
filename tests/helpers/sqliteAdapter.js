'use strict';
/**
 * TEST-ONLY database adapter on top of node:sqlite (Node >= 22.5) exposing the same
 * interface as src/database/index.js. Production uses PostgreSQL; this lets the SQL we
 * write in a portable subset run in unit tests without a Postgres server.
 * Transactions are serialised (single connection), so it cannot reproduce true
 * multi-connection PostgreSQL races; see tests/pg.integration.test.js for that.
 */
const { DatabaseSync } = require('node:sqlite');

function createSqliteDb(file = ':memory:') {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON');
  let tail = Promise.resolve();

  const toSqlite = (sql) => sql.replace(/\$(\d+)/g, '?$1');
  function exec(text, params = []) {
    const stmt = raw.prepare(toSqlite(text));
    const reads = /^\s*(select|with|pragma)\b/i.test(text) || /\breturning\b/i.test(text);
    if (reads) {
      const rows = stmt.all(...params).map((r) => ({ ...r }));
      return { rows, rowCount: rows.length };
    }
    const r = stmt.run(...params);
    return { rows: [], rowCount: Number(r.changes) };
  }

  async function locked(fn) {
    const prev = tail;
    let release;
    tail = new Promise((r) => { release = r; });
    await prev;
    try { return await fn(); } finally { release(); }
  }

  return {
    dialect: 'sqlite',
    raw,
    query: (text, params) => locked(async () => exec(text, params)),
    tx: (fn) => locked(async () => {
      exec('BEGIN');
      try {
        const out = await fn({ dialect: 'sqlite', query: async (t, p) => exec(t, p) });
        exec('COMMIT');
        return out;
      } catch (err) {
        exec('ROLLBACK');
        throw err;
      }
    }),
    close: async () => raw.close(),
  };
}

module.exports = { createSqliteDb };
