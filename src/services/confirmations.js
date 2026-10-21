'use strict';
const crypto = require('node:crypto');

/**
 * Message-scoped, expiring, single-use confirmations for destructive actions.
 * customId format: `cf:<id>:y|n`. The stored `run` closure must re-check permissions at action time.
 */
function createConfirmations({ now = () => Date.now(), ttlMs = 60_000 } = {}) {
  const items = new Map();

  function sweep() {
    const t = now();
    for (const [k, v] of items) if (v.expiresAt <= t) items.delete(k);
  }

  /** @returns {string} id */
  function create({ userId, guildId, run, description = '' }) {
    sweep();
    const id = crypto.randomBytes(8).toString('hex');
    items.set(id, { userId, guildId, run, description, expiresAt: now() + ttlMs });
    return id;
  }

  /**
   * Validate and consume a confirmation. Always single-use.
   * @returns {{ok:true, entry:object}|{ok:false, reason:'UNKNOWN'|'EXPIRED'|'NOT_OWNER'|'WRONG_GUILD'}}
   */
  function take(id, { userId, guildId }) {
    const entry = items.get(id);
    if (!entry) return { ok: false, reason: 'UNKNOWN' };
    if (entry.expiresAt <= now()) { items.delete(id); return { ok: false, reason: 'EXPIRED' }; }
    if (entry.userId !== userId) return { ok: false, reason: 'NOT_OWNER' }; // does not consume: owner can still confirm
    if (entry.guildId && entry.guildId !== guildId) return { ok: false, reason: 'WRONG_GUILD' };
    items.delete(id);
    return { ok: true, entry };
  }

  const cancel = (id) => items.delete(id);

  return { create, take, cancel, _size: () => items.size };
}

const parseConfirmId = (customId) => {
  const m = /^cf:([0-9a-f]{16}):(y|n)$/.exec(customId || '');
  return m ? { id: m[1], accepted: m[2] === 'y' } : null;
};

module.exports = { createConfirmations, parseConfirmId };
