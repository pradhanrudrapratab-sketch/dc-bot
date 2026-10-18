'use strict';
const { registerSecret } = require('../utils/redact');

/**
 * Key/value configuration plus encrypted secrets.
 * The Minecraft API key resolves as: encrypted DB secret (set via /setkey) -> GLOBAL_API_KEY env.
 */
function createSettingsStore({ db, secretBox = null, envApiKey = '', now = () => Date.now() }) {
  if (envApiKey) registerSecret(envApiKey);

  async function get(key) {
    const r = await db.query('SELECT value FROM configuration WHERE key = $1', [key]);
    return r.rows[0]?.value ?? null;
  }
  async function set(key, value) {
    await db.query(
      `INSERT INTO configuration (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value), now()]
    );
  }
  async function getGlobal(key) {
    const r = await db.query('SELECT value FROM global_settings WHERE key = $1', [key]);
    return r.rows[0]?.value ?? null;
  }
  async function setGlobal(key, value) {
    await db.query(
      `INSERT INTO global_settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value), now()]
    );
  }
  async function deleteGlobal(key) {
    await db.query('DELETE FROM global_settings WHERE key = $1', [key]);
  }

  async function setSecret(name, plain) {
    if (!secretBox) {
      const e = new Error('SECRETS_ENCRYPTION_KEY is not configured');
      e.code = 'NO_ENCRYPTION_KEY';
      throw e;
    }
    registerSecret(plain);
    await db.query(
      `INSERT INTO secrets (name, ciphertext, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      [name, secretBox.encrypt(plain), now()]
    );
  }
  async function getSecret(name) {
    if (!secretBox) return null;
    const r = await db.query('SELECT ciphertext FROM secrets WHERE name = $1', [name]);
    if (!r.rows[0]) return null;
    const plain = secretBox.decrypt(r.rows[0].ciphertext);
    registerSecret(plain);
    return plain;
  }

  async function getGlobalApiKey() {
    return (await getSecret('global_api_key')) || envApiKey || '';
  }
  async function setGlobalApiKey(key) {
    await setSecret('global_api_key', key);
  }

  return { get, set, getGlobal, setGlobal, deleteGlobal, setSecret, getSecret, getGlobalApiKey, setGlobalApiKey, canStoreSecrets: !!secretBox };
}

module.exports = { createSettingsStore };
