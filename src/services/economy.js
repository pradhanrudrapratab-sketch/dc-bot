'use strict';
const crypto = require('node:crypto');

const HOUR = 3_600_000;
const DAILY_COOLDOWN_MS = 24 * HOUR;
const STREAK_GRACE_MS = 48 * HOUR; // claim again within 48h of the last claim to keep the streak
const STREAK_BONUS = 50; // extra DE per consecutive day
const STREAK_BONUS_DAYS = 6; // bonus caps after 6 extra days (7-day streak)

const DEFAULTS = { dailyAmount: 500, coinflipMaxBet: 50_000, coinflipLossEvery: 7 };

/** Daily reward for a given streak day (1-based). Pure. */
const dailyReward = (base, streak) => base + Math.min(Math.max(streak - 1, 0), STREAK_BONUS_DAYS) * STREAK_BONUS;

/**
 * DarkEssence (DE) ledger + games. Balances change only inside a transaction; debits are conditional UPDATEs so
 * balances cannot go negative or be double-spent; `refKey` makes retries idempotent.
 * `rng(n)` returns an integer in [0, n) and is injectable for tests.
 */
function createEconomy({ db, now = () => Date.now(), settings = {}, rng = (n) => crypto.randomInt(n) }) {
  const cfg = { ...DEFAULTS, ...settings };
  const CURRENCY = { name: 'DarkEssence', code: 'DE' };

  async function ensure(q, userId) {
    const t = now();
    await q.query('INSERT INTO economy_accounts (user_id, balance, created_at, updated_at) VALUES ($1, 0, $2, $2) ON CONFLICT (user_id) DO NOTHING', [userId, t]);
  }
  async function ensureState(q, userId) {
    await q.query('INSERT INTO economy_state (user_id, updated_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [userId, now()]);
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

  /**
   * Claim the daily reward: once per 24 h (rolling, from the last claim). Claiming within 48 h keeps the streak,
   * each extra streak day adds +50 DE (max +300). The claim is one conditional UPDATE, so two simultaneous
   * /daily requests can never both succeed.
   * @returns {{ok:true, amount:number, streak:number, balance:number}|{ok:false, reason:'COOLDOWN', retryAt:number}}
   */
  async function daily(userId) {
    return db.tx(async (t) => {
      await ensure(t, userId);
      await ensureState(t, userId);
      const ts = now();
      const claim = await t.query(
        `UPDATE economy_state
            SET daily_streak = CASE WHEN last_daily_at IS NOT NULL AND $2 - last_daily_at <= $4 THEN daily_streak + 1 ELSE 1 END,
                last_daily_at = $2, updated_at = $2
          WHERE user_id = $1 AND (last_daily_at IS NULL OR $2 - last_daily_at >= $3)
        RETURNING daily_streak`,
        [userId, ts, DAILY_COOLDOWN_MS, STREAK_GRACE_MS]);
      if (!claim.rows[0]) {
        const last = (await t.query('SELECT last_daily_at FROM economy_state WHERE user_id = $1', [userId])).rows[0].last_daily_at;
        return { ok: false, reason: 'COOLDOWN', retryAt: last + DAILY_COOLDOWN_MS };
      }
      const streak = claim.rows[0].daily_streak;
      const amount = dailyReward(cfg.dailyAmount, streak);
      const r = await applyDelta(t, userId, amount, `daily (streak ${streak})`, `daily:${userId}:${ts}`);
      return { ok: true, amount, streak, balance: r.balance };
    });
  }

  /**
   * Coin flip against the house. Every Nth flip of a user (default 7th) is a guaranteed loss, tracked per user in
   * the database so it survives restarts. A flip that fails for insufficient funds does NOT consume the counter.
   * @returns {{ok:true, won:boolean, forcedLoss:boolean, result:'heads'|'tails', flipNumber:number, inCycle:number, every:number, delta:number, balance:number}
   *          |{ok:false, reason:string, balance?:number}}
   */
  async function coinflip(userId, bet, side) {
    if (!validAmount(bet)) return { ok: false, reason: 'BAD_AMOUNT' };
    if (bet > cfg.coinflipMaxBet) return { ok: false, reason: 'OVER_MAX_BET', max: cfg.coinflipMaxBet };
    if (side !== 'heads' && side !== 'tails') return { ok: false, reason: 'BAD_SIDE' };
    return db.tx(async (t) => {
      await ensure(t, userId);
      await ensureState(t, userId);
      const bal = (await t.query('SELECT balance FROM economy_accounts WHERE user_id = $1', [userId])).rows[0].balance;
      if (bal < bet) return { ok: false, reason: 'INSUFFICIENT_FUNDS', balance: bal };
      const n = (await t.query('UPDATE economy_state SET coinflip_count = coinflip_count + 1, updated_at = $2 WHERE user_id = $1 RETURNING coinflip_count', [userId, now()])).rows[0].coinflip_count;
      const every = cfg.coinflipLossEvery;
      const forcedLoss = n % every === 0;
      const opposite = side === 'heads' ? 'tails' : 'heads';
      const result = forcedLoss ? opposite : (rng(2) === 0 ? 'heads' : 'tails');
      const won = result === side;
      const delta = won ? bet : -bet;
      const r = await applyDelta(t, userId, delta, `coinflip ${won ? 'win' : 'loss'}${forcedLoss ? ' (house round)' : ''}`, null);
      return { ok: true, won, forcedLoss, result, flipNumber: n, inCycle: ((n - 1) % every) + 1, every, delta, balance: r.balance };
    });
  }

  async function leaderboard(limit = 10) {
    return (await db.query('SELECT user_id, balance FROM economy_accounts WHERE balance > 0 ORDER BY balance DESC, user_id ASC LIMIT $1', [Math.min(limit, 25)])).rows;
  }

  return { CURRENCY, balance, credit, debit, transfer, daily, coinflip, leaderboard, settings: cfg };
}

module.exports = { createEconomy, dailyReward, DAILY_COOLDOWN_MS };
