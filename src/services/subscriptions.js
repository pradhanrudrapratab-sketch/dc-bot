'use strict';

/**
 * Subscription logic. All time arithmetic uses epoch-ms numbers (no ISO/SQL datetime mixing).
 * `durationMs` comes from validated config (SUBSCRIPTION_DAYS), never hard-coded.
 */
function createSubscriptions({ durationMs, now = () => Date.now() }) {
  const getActive = async (q, userId) =>
    (await q.query(
      `SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'ACTIVE' AND expires_at > $2 ORDER BY expires_at DESC LIMIT 1`,
      [userId, now()]
    )).rows[0] || null;

  const getLatest = async (q, userId) =>
    (await q.query('SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [userId])).rows[0] || null;

  /** Flip ACTIVE rows whose time has passed. Returns the affected rows. */
  async function expireDue(q, userId = null) {
    const t = now();
    const r = userId == null
      ? await q.query(`UPDATE subscriptions SET status = 'EXPIRED', updated_at = $1 WHERE status = 'ACTIVE' AND expires_at <= $1 RETURNING id, user_id`, [t])
      : await q.query(`UPDATE subscriptions SET status = 'EXPIRED', updated_at = $1 WHERE status = 'ACTIVE' AND expires_at <= $1 AND user_id = $2 RETURNING id, user_id`, [t, userId]);
    return r.rows;
  }

  /**
   * Create or extend a subscription. Renewal extends from the current expiry when still active,
   * otherwise starts now. Run inside a transaction when combined with other writes.
   * @returns {{subscription: object, renewed: boolean}}
   */
  async function grant(q, userId) {
    const t = now();
    await expireDue(q, userId); // clear stale ACTIVE rows so the one-active unique index holds
    const active = await getActive(q, userId);
    if (active) {
      const newExpiry = active.expires_at + durationMs;
      await q.query('UPDATE subscriptions SET expires_at = $1, updated_at = $2 WHERE id = $3', [newExpiry, t, active.id]);
      return { subscription: { ...active, expires_at: newExpiry }, renewed: true };
    }
    const r = await q.query(
      `INSERT INTO subscriptions (user_id, status, started_at, expires_at, created_at, updated_at)
       VALUES ($1, 'ACTIVE', $2, $3, $2, $2) RETURNING *`,
      [userId, t, t + durationMs]
    );
    return { subscription: r.rows[0], renewed: false };
  }

  async function revoke(q, userId) {
    const r = await q.query(`UPDATE subscriptions SET status = 'REVOKED', updated_at = $1 WHERE user_id = $2 AND status = 'ACTIVE'`, [now(), userId]);
    return r.rowCount;
  }

  return { getActive, getLatest, expireDue, grant, revoke, durationMs };
}

module.exports = { createSubscriptions };
