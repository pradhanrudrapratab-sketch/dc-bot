'use strict';
const crypto = require('node:crypto');

/** AES-256-GCM helper for secrets stored in the database. Format: v1:<iv>:<tag>:<ciphertext> (base64). */
function createSecretBox(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('SecretBox requires a 32-byte key');
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
    },
    decrypt(payload) {
      const [v, iv, tag, ct] = String(payload).split(':');
      if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported secret format');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    },
  };
}

module.exports = { createSecretBox };
