'use strict';

/**
 * DarkEssence (DE) ledger. Balances change only inside a transaction; the debit is a conditional UPDATE so
 * balances cannot go negative or be double-spent; `refKey` makes retries idempotent. Independent of AFK payments.
 */
function createEconomy({ db, now = () => Date.now() }) {
  const CURRENCY = { name: 'DarkEssence', code: 'DE' };

  async function ensure(q, userId) {
    const t = now();
    await q.query('INSERT INTO economy_accounts (user_id, balance, created_at, updated_at) VALUES ($1, 0, $2, $2) ON CONFLICT (user_id) DO NOTHING', [userId, t]);
  }

  async function balance(userId, q = db) {
    return (await q.query('SELECT balance FROM economy_accounts WHERE user_id = $1', [userId])).rows[0]?.balance ?? 0;
  }

  async function applyDelta(t, userId, delta, reason, refKey) {
    await ensure(t, userId);
    if (refKey) {
      const dup = (await t.query('SELECT balance_after FROM economy_transactions WHERE ref_key = $1', [refKey])).rows[0];
      if (dup) return { ok: true, duplicate: true, balance: dup.balance_after };
    }
    const r = await t.query(
      `UPDATE economy_accounts SET balance = balance + $1, updated_at = $2 WHERE user_id = $3 AND balance + $1 >= 0 RETURNING balance`,
      [delta, now(), userId]);
    if (!r.rows[0]) return { ok: false, reason: 'INSUFFICIENT_FUNDS' };
    await t.query(`INSERT INTO economy_transactions (user_id, delta, balance_after, reason, ref_key, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [userId, delta, r.rows[0].balance, reason, refKey ?? null, now()]);
    return { ok: true, duplicate: false, balance: r.rows[0].balance };
  }

  const validAmount = (n) => Number.isSafeInteger(n) && n > 0;

  async function credit(userId, amount, reason, refKey = null) {
    if (!validAmount(amount)) return { ok: false, reason: 'BAD_AMOUNT' };
    return db.tx((t) => applyDelta(t, userId, amount, reason, refKey));
  }
  async function debit(userId, amount, reason, refKey = null) {
    if (!validAmount(amount)) return { ok: false, reason: 'BAD_AMOUNT' };
    return db.tx((t) => applyDelta(t, userId, -amount, reason, refKey));
  }
  /** Atomic transfer: both legs commit together or neither does. */
  async function transfer(fromId, toId, amount, refKey = null) {
    if (!validAmount(amount)) return { ok: false, reason: 'BAD_AMOUNT' };
    if (fromId === toId) return { ok: false, reason: 'SAME_ACCOUNT' };
    return db.tx(async (t) => {
      const out = await applyDelta(t, fromId, -amount, `transfer to ${toId}`, refKey ? `${refKey}:out` : null);
      if (!out.ok || out.duplicate) return out;
      const inn = await applyDelta(t, toId, amount, `transfer from ${fromId}`, refKey ? `${refKey}:in` : null);
      return { ok: true, duplicate: false, balance: out.balance, toBalance: inn.balance };
    });
  }

  return { CURRENCY, balance, credit, debit, transfer };
}

module.exports = { createEconomy };
