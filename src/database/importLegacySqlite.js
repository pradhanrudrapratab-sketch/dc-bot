'use strict';
/**
 * One-off importer: legacy SQLite (discord-afk-bot) -> PostgreSQL.
 *   node src/database/importLegacySqlite.js ./data/bot.db [--dry-run] [--import-key]
 * Needs Node >= 22.5 (uses the built-in node:sqlite to READ the old file; the file is opened read-only).
 *
 * Conversions: text timestamps -> epoch ms; payment status VALID -> PROCESSED; slot INACTIVE -> health UNHEALTHY;
 * conflicting duplicate "active" rows are resolved deterministically and reported. The plaintext API key from the
 * old `configuration` table is NEVER copied into the plain configuration table (see --import-key).
 */
const SECRET_KEY = /(key|token|secret|password)/i;

function parseTime(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const s = String(v).trim();
  const iso = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
}

class ImportAbort extends Error {}

async function importLegacy({ sourcePath, db, secretBox = null, dryRun = false, importKey = false, DatabaseSync }) {
  const SQLite = DatabaseSync || require('node:sqlite').DatabaseSync;
  const src = new SQLite(sourcePath, { readOnly: true });
  const all = (sql) => src.prepare(sql).all().map((r) => ({ ...r }));
  const report = { users: 0, subscriptions: 0, slots: 0, assignments: 0, payments: 0, config: 0, warnings: [], dryRun };
  const now = Date.now();

  try {
    const existing = (await db.query('SELECT COUNT(*) AS c FROM users')).rows[0].c + (await db.query('SELECT COUNT(*) AS c FROM slots')).rows[0].c;
    if (existing > 0) throw new Error('Target database already has users/slots. Refusing to import into a non-empty database.');

    const users = all('SELECT * FROM users ORDER BY id');
    const subs = all('SELECT * FROM subscriptions ORDER BY id');
    const slots = all('SELECT * FROM slots ORDER BY id');
    const assigns = all('SELECT * FROM slot_assignments ORDER BY id');
    const payments = all('SELECT * FROM payments ORDER BY id');
    let config = [];
    try { config = all('SELECT * FROM configuration'); } catch { /* table absent */ }

    await db.tx(async (t) => {
      for (const u of users) {
        await t.query('INSERT INTO users (id, discord_user_id, username, validated, validated_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [u.id, u.discord_user_id, u.username, u.validated ? 1 : 0, parseTime(u.validated_at), parseTime(u.created_at, now), parseTime(u.updated_at, now)]);
        report.users += 1;
      }

      // The new schema allows one ACTIVE subscription per user. Keep the latest expiry; demote the rest.
      const activeByUser = new Map();
      for (const s of subs.filter((x) => x.status === 'ACTIVE')) {
        const cur = activeByUser.get(s.user_id);
        if (!cur || parseTime(s.expires_at, 0) > parseTime(cur.expires_at, 0)) activeByUser.set(s.user_id, s);
      }
      for (const s of subs) {
        let status = s.status;
        if (s.status === 'ACTIVE' && activeByUser.get(s.user_id)?.id !== s.id) {
          status = 'EXPIRED';
          report.warnings.push(`subscription ${s.id}: duplicate ACTIVE for user ${s.user_id}, demoted to EXPIRED`);
        }
        await t.query('INSERT INTO subscriptions (id, user_id, status, started_at, expires_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [s.id, s.user_id, status, parseTime(s.started_at, now), parseTime(s.expires_at, now), parseTime(s.created_at, now), parseTime(s.updated_at, now)]);
        report.subscriptions += 1;
      }

      // Resolve assignment conflicts: at most one open row per slot, per server and per user (latest wins).
      const open = assigns.filter((a) => !a.released_at).sort((a, b) => b.id - a.id);
      const keep = new Set();
      const seen = { slot: new Set(), server: new Set(), user: new Set() };
      for (const a of open) {
        if (seen.slot.has(a.slot_id) || seen.server.has(a.server_id) || seen.user.has(a.user_id)) {
          report.warnings.push(`assignment ${a.id}: conflicts with a newer open assignment, closed as IMPORT_CONFLICT`);
          continue;
        }
        seen.slot.add(a.slot_id); seen.server.add(a.server_id); seen.user.add(a.user_id); keep.add(a.id);
      }
      const assignedSlots = new Set(open.filter((a) => keep.has(a.id)).map((a) => a.slot_id));

      for (const s of slots) {
        const status = assignedSlots.has(s.id) ? 'ASSIGNED' : 'AVAILABLE';
        await t.query('INSERT INTO slots (id, slot_number, url, status, health, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [s.id, s.slot_number, s.url, status, s.status === 'INACTIVE' ? 'UNHEALTHY' : 'UNKNOWN', parseTime(s.created_at, now), parseTime(s.updated_at, now)]);
        report.slots += 1;
      }
      for (const a of assigns) {
        const wasOpen = !a.released_at;
        const closedByImport = wasOpen && !keep.has(a.id);
        await t.query('INSERT INTO slot_assignments (id, slot_id, user_id, server_id, server_name, assigned_at, released_at, release_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [a.id, a.slot_id, a.user_id, a.server_id, a.server_name, parseTime(a.assigned_at, now),
            wasOpen ? (closedByImport ? now : null) : parseTime(a.released_at, now), closedByImport ? 'IMPORT_CONFLICT' : wasOpen ? null : 'LEGACY']);
        report.assignments += 1;
      }
      for (const p of payments) {
        await t.query('INSERT INTO payments (id, payment_message_id, sender_id, receiver_id, amount, status, attempts, created_at, processed_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$8)',
          [p.id, p.payment_message_id, p.sender_id, p.receiver_id, p.amount, p.status === 'VALID' ? 'PROCESSED' : p.status, parseTime(p.created_at, now), parseTime(p.processed_at, now)]);
        report.payments += 1;
      }

      for (const c of config) {
        if (SECRET_KEY.test(c.key)) {
          if (importKey && secretBox && c.key === 'global_api_key') {
            await t.query('INSERT INTO secrets (name, ciphertext, updated_at) VALUES ($1,$2,$3)', ['global_api_key', secretBox.encrypt(c.value), now]);
            report.config += 1;
          } else {
            report.warnings.push(`configuration "${c.key}" NOT imported (secret). Set GLOBAL_API_KEY in the environment, or re-run with --import-key and SECRETS_ENCRYPTION_KEY set.`);
          }
          continue;
        }
        await t.query('INSERT INTO configuration (key, value, updated_at) VALUES ($1,$2,$3)', [c.key, c.value, parseTime(c.updated_at, now)]);
        report.config += 1;
      }

      if (db.dialect === 'postgres') {
        for (const table of ['users', 'subscriptions', 'slots', 'slot_assignments', 'payments']) {
          await t.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT COUNT(*) > 0 FROM ${table}))`);
        }
      }
      if (dryRun) throw new ImportAbort('dry run');
    });
  } catch (err) {
    if (!(err instanceof ImportAbort)) throw err;
  } finally {
    src.close();
  }
  return report;
}

module.exports = { importLegacy, parseTime };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith('--'));
    if (!file) { console.error('Usage: node src/database/importLegacySqlite.js <path-to-bot.db> [--dry-run] [--import-key]'); process.exit(1); }
    const { getConfig } = require('../config');
    const { createDatabase } = require('./index');
    const { runMigrations } = require('./migrate');
    const { createSecretBox } = require('../services/secretBox');
    const config = getConfig();
    const db = createDatabase(config.database);
    try {
      await runMigrations(db);
      const box = config.afk.encryptionKey ? createSecretBox(config.afk.encryptionKey) : null;
      const r = await importLegacy({ sourcePath: file, db, secretBox: box, dryRun: args.includes('--dry-run'), importKey: args.includes('--import-key') });
      console.log(JSON.stringify({ ...r, warnings: r.warnings.length ? r.warnings : undefined }, null, 2));
      console.log(r.dryRun ? '\nDRY RUN: nothing was written.' : '\nImport committed.');
    } finally { await db.close(); }
  })().catch((e) => { console.error('[IMPORT] failed:', e.message); process.exit(1); });
}
