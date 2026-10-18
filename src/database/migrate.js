'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'migrations');

const DIALECT_TOKENS = {
  postgres: { '{{PK}}': 'BIGSERIAL PRIMARY KEY' },
  sqlite: { '{{PK}}': 'INTEGER PRIMARY KEY AUTOINCREMENT' }, // used only by the test adapter
};

/** Split a migration file into statements. Files must not contain ';' inside string literals. */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function render(sql, dialect) {
  const tokens = DIALECT_TOKENS[dialect];
  if (!tokens) throw new Error(`Unknown dialect: ${dialect}`);
  let out = sql;
  for (const [k, v] of Object.entries(tokens)) out = out.split(k).join(v);
  return out;
}

function listMigrations(dir = DIR) {
  return fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
}

/**
 * Apply pending migrations. Each file runs in its own transaction and is recorded in
 * schema_migrations. On PostgreSQL a transaction-level advisory lock prevents two
 * instances migrating concurrently.
 * @returns {Promise<string[]>} versions applied during this call
 */
async function runMigrations(db, { dir = DIR, log = () => {} } = {}) {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)'
  );
  const applied = [];
  for (const file of listMigrations(dir)) {
    await db.tx(async (t) => {
      if (db.dialect === 'postgres') await t.query('SELECT pg_advisory_xact_lock(727274)');
      const done = await t.query('SELECT version FROM schema_migrations WHERE version = $1', [file]);
      if (done.rows.length) return;
      const sql = render(fs.readFileSync(path.join(dir, file), 'utf8'), db.dialect);
      for (const stmt of splitStatements(sql)) await t.query(stmt);
      await t.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [file, Date.now()]);
      applied.push(file);
      log(`applied ${file}`);
    });
  }
  return applied;
}

module.exports = { runMigrations, splitStatements, render, listMigrations };

if (require.main === module) {
  (async () => {
    const { getConfig } = require('../config');
    const { createDatabase } = require('./index');
    const db = createDatabase(getConfig().database);
    try {
      const applied = await runMigrations(db, { log: (m) => console.log(`[MIGRATE] ${m}`) });
      console.log(`[MIGRATE] done (${applied.length} applied)`);
    } finally {
      await db.close();
    }
  })().catch((e) => {
    console.error('[MIGRATE] failed:', e.message);
    process.exit(1);
  });
}
