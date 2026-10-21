'use strict';
process.removeAllListeners('warning');
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createSqliteDb } = require('./helpers/sqliteAdapter');
const { runMigrations } = require('../src/database/migrate');
const { importLegacy, parseTime } = require('../src/database/importLegacySqlite');
const { createSecretBox } = require('../src/services/secretBox');

function legacyDb() {
  const file = path.join(os.tmpdir(), `legacy-${crypto.randomUUID()}.db`);
  const d = new DatabaseSync(file);
  d.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, discord_user_id TEXT NOT NULL UNIQUE, username TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0, validated_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', started_at TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE slots (id INTEGER PRIMARY KEY AUTOINCREMENT, slot_number INTEGER NOT NULL UNIQUE, url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'AVAILABLE', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE slot_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, slot_id INTEGER NOT NULL, user_id INTEGER NOT NULL, server_id TEXT NOT NULL, server_name TEXT, assigned_at TEXT NOT NULL DEFAULT (datetime('now')), released_at TEXT);
  CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_message_id TEXT NOT NULL UNIQUE, sender_id TEXT NOT NULL, receiver_id TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'VALID', processed_at TEXT NOT NULL DEFAULT (datetime('now')), created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE configuration (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO users (id, discord_user_id, username, validated, validated_at, created_at, updated_at) VALUES (1,'111','alice',1,'2026-01-01 10:00:00','2026-01-01 10:00:00','2026-01-01 10:00:00'),(2,'222','bob',1,'2026-01-02 10:00:00','2026-01-02 10:00:00','2026-01-02 10:00:00');
  INSERT INTO subscriptions (id,user_id,status,started_at,expires_at) VALUES (1,1,'ACTIVE','2026-01-01 10:00:00','2026-01-31 10:00:00'),(2,1,'ACTIVE','2026-01-05T10:00:00.000Z','2026-02-04T10:00:00.000Z'),(3,2,'EXPIRED','2025-12-01 00:00:00','2025-12-31 00:00:00');
  INSERT INTO slots (id,slot_number,url,status) VALUES (1,1,'https://a.example.com','ASSIGNED'),(2,2,'https://b.example.com','INACTIVE'),(3,3,'https://c.example.com','AVAILABLE');
  INSERT INTO slot_assignments (id,slot_id,user_id,server_id,server_name,released_at) VALUES (1,1,1,'S1','one',NULL),(2,3,1,'S9','dup-user',NULL),(3,2,2,'S2','old','2026-01-03 00:00:00');
  INSERT INTO payments (id,payment_message_id,sender_id,receiver_id,amount,status) VALUES (1,'m1','111','999',25000000,'VALID');
  INSERT INTO configuration (key,value) VALUES ('global_api_key','PLAINTEXTKEY'),('motd','hello');`);
  d.close();
  return file;
}

test('timestamp conversion handles SQLite datetime() text and ISO strings', () => {
  assert.equal(parseTime('2026-01-01 10:00:00'), Date.UTC(2026, 0, 1, 10));
  assert.equal(parseTime('2026-01-05T10:00:00.000Z'), Date.UTC(2026, 0, 5, 10));
  assert.equal(parseTime(null, 7), 7);
  assert.equal(parseTime('garbage', 9), 9);
});

test('legacy import: converts, resolves conflicts, never copies the plaintext API key, refuses non-empty targets', async () => {
  const file = legacyDb();
  const db = createSqliteDb();
  await runMigrations(db);
  const r = await importLegacy({ sourcePath: file, db });
  assert.deepEqual([r.users, r.subscriptions, r.slots, r.assignments, r.payments], [2, 3, 3, 3, 1]);
  assert.ok(r.warnings.some((w) => /duplicate ACTIVE/.test(w)));
  assert.ok(r.warnings.some((w) => /conflicts with a newer open assignment/.test(w)));
  assert.ok(r.warnings.some((w) => /global_api_key.*NOT imported/.test(w)));
  const act = (await db.query("SELECT id FROM subscriptions WHERE status='ACTIVE'")).rows;
  assert.deepEqual(act.map((x) => x.id), [2]); // latest expiry kept
  const slots = (await db.query('SELECT slot_number, status, health FROM slots ORDER BY id')).rows;
  assert.deepEqual(slots.map((s) => [s.status, s.health]), [['AVAILABLE', 'UNKNOWN'], ['AVAILABLE', 'UNHEALTHY'], ['ASSIGNED', 'UNKNOWN']]); // newest open assignment (id 2 -> slot 3) wins
  const open = (await db.query('SELECT COUNT(*) AS c FROM slot_assignments WHERE released_at IS NULL')).rows[0].c;
  assert.equal(open, 1);
  assert.equal((await db.query('SELECT status FROM payments')).rows[0].status, 'PROCESSED');
  const cfg = (await db.query('SELECT key FROM configuration')).rows.map((x) => x.key);
  assert.deepEqual(cfg, ['motd']);
  assert.equal((await db.query('SELECT COUNT(*) AS c FROM secrets')).rows[0].c, 0);
  await assert.rejects(importLegacy({ sourcePath: file, db }), /non-empty/);
  fs.unlinkSync(file);
});

test('legacy import: --dry-run writes nothing; --import-key stores the key encrypted', async () => {
  const file = legacyDb();
  let db = createSqliteDb();
  await runMigrations(db);
  const dry = await importLegacy({ sourcePath: file, db, dryRun: true });
  assert.equal(dry.users, 2);
  assert.equal((await db.query('SELECT COUNT(*) AS c FROM users')).rows[0].c, 0);
  db = createSqliteDb();
  await runMigrations(db);
  const box = createSecretBox(crypto.randomBytes(32));
  const r = await importLegacy({ sourcePath: file, db, secretBox: box, importKey: true });
  assert.equal(r.config, 2);
  const ct = (await db.query("SELECT ciphertext FROM secrets WHERE name='global_api_key'")).rows[0].ciphertext;
  assert.ok(!ct.includes('PLAINTEXTKEY'));
  assert.equal(box.decrypt(ct), 'PLAINTEXTKEY');
  fs.unlinkSync(file);
});
