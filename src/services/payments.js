'use strict';

// Example OwO message: 💳 | <@123> sent 25,000,000 cowoncy to <@456>!
const OWO_PAYMENT_REGEX = /💳\s*\|\s*<@!?(\d+)>\s+sent\s+([\d,]+)\s+cowoncy\s+to\s+<@!?(\d+)>!/i;

function parseOwoPayment(content) {
  const m = String(content || '').match(OWO_PAYMENT_REGEX);
  if (!m) return null;
  const amount = parseInt(m[2].replace(/,/g, ''), 10);
  if (!Number.isSafeInteger(amount)) return null;
  return { senderId: m[1], receiverId: m[3], amount };
}

/**
 * Validate a parsed payment against policy. Pure.
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
function validatePayment(p, { ownerId, amount }) {
  if (p.receiverId !== ownerId) return { ok: false, reason: 'RECEIVER_NOT_OWNER' };
  if (p.amount !== amount) return { ok: false, reason: 'AMOUNT_MISMATCH' };
  return { ok: true };
}

/**
 * Idempotent, recoverable payment processing.
 *  1. The payment row is inserted PENDING (unique on message id) before anything else.
 *  2. User upsert + subscription grant + marking PROCESSED happen in ONE transaction.
 *  3. A failed attempt leaves the row FAILED/PENDING; reconcile() retries it. Nothing is lost.
 *  4. A duplicate/concurrent message can never grant twice: the PROCESSED flip is conditional.
 */
function createPaymentProcessor({ db, users, subs, now = () => Date.now() }) {
  async function process({ messageId, senderId, receiverId, amount, username, placeholderName = false }) {
    const t0 = now();
    const ins = await db.query(
      `INSERT INTO payments (payment_message_id, sender_id, receiver_id, amount, status, attempts, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'PENDING', 0, $5, $5) ON CONFLICT (payment_message_id) DO NOTHING RETURNING id`,
      [messageId, senderId, receiverId, amount, t0]
    );
    let paymentId = ins.rows[0]?.id;
    if (!paymentId) {
      const ex = (await db.query('SELECT id, status FROM payments WHERE payment_message_id = $1', [messageId])).rows[0];
      if (ex.status === 'PROCESSED') return { status: 'DUPLICATE' };
      paymentId = ex.id; // PENDING/FAILED: finish it (recovery path)
    }
    return finish(paymentId, { senderId, username: username || `user_${senderId}`, placeholderName });
  }

  async function finish(paymentId, { senderId, username, placeholderName }) {
    try {
      return await db.tx(async (t) => {
        const claim = await t.query(`UPDATE payments SET attempts = attempts + 1, updated_at = $1 WHERE id = $2 AND status <> 'PROCESSED' RETURNING id`, [now(), paymentId]);
        if (!claim.rows[0]) return { status: 'DUPLICATE' };
        const user = await users.upsert(t, senderId, username, { placeholder: placeholderName });
        await users.validate(t, senderId);
        const { subscription, renewed } = await subs.grant(t, user.id);
        const ts = now();
        await t.query(
          `UPDATE payments SET status = 'PROCESSED', subscription_id = $1, processed_at = $2, updated_at = $2, last_error = NULL WHERE id = $3`,
          [subscription.id, ts, paymentId]
        );
        return { status: 'PROCESSED', renewed, userId: user.id, expiresAt: subscription.expires_at, paymentId };
      });
    } catch (err) {
      await db.query(`UPDATE payments SET status = 'FAILED', last_error = $1, updated_at = $2 WHERE id = $3 AND status <> 'PROCESSED'`, [String(err.message).slice(0, 300), now(), paymentId]);
      return { status: 'FAILED', error: err.message, paymentId };
    }
  }

  /** Retry unfinished payments (called on startup and periodically). */
  async function reconcile({ maxAttempts = 10, minAgeMs = 60_000 } = {}) {
    const rows = (await db.query(
      `SELECT id, sender_id FROM payments WHERE status IN ('PENDING', 'FAILED') AND attempts < $1 AND updated_at <= $2 ORDER BY id ASC LIMIT 50`,
      [maxAttempts, now() - minAgeMs]
    )).rows;
    const out = [];
    for (const r of rows) out.push({ paymentId: r.id, ...(await finish(r.id, { senderId: r.sender_id, username: `user_${r.sender_id}`, placeholderName: true })) });
    return out;
  }

  return { process, reconcile };
}

module.exports = { parseOwoPayment, validatePayment, createPaymentProcessor, OWO_PAYMENT_REGEX };
