'use strict';
const { DAY } = require('../utils/time');

const ACTIVE_RESET_MS = 30 * DAY;

/** Policy: 1-2 record, 3 = 24h timeout, 4 = kick, 5+ = ban. */
function decideEscalation(activeCount) {
  if (activeCount >= 5) return 'ban';
  if (activeCount === 4) return 'kick';
  if (activeCount === 3) return 'timeout';
  return 'none';
}

/** Active count after applying the 30-day inactivity reset (based on LAST warning time). */
function effectiveActiveCount(state, now) {
  if (!state || !state.last_warning_at || !state.active_count) return 0;
  return now - state.last_warning_at >= ACTIVE_RESET_MS ? 0 : state.active_count;
}

/**
 * Warning persistence. `warnings` rows are immutable history; only `warning_state` is mutable.
 * Keyed by (guild, user) so leaving and re-joining never clears anything.
 */
function createWarnings({ db, now = () => Date.now() }) {
  async function getState(guildId, userId, q = db) {
    const s = (await q.query('SELECT * FROM warning_state WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).rows[0] || null;
    const total = (await q.query('SELECT COUNT(*) AS c FROM warnings WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).rows[0].c;
    return { activeCount: effectiveActiveCount(s, now()), lastWarningAt: s?.last_warning_at ?? null, total };
  }

  /**
   * Record a warning exactly once per idempotencyKey and compute the escalation decision.
   * @returns {{duplicate:boolean, warningId:number, activeCount:number, action:string, resetApplied:boolean}}
   */
  async function add({ guildId, userId, moderatorId, reason, idempotencyKey }) {
    return db.tx(async (t) => {
      const dup = (await t.query('SELECT * FROM warnings WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
      if (dup) return { duplicate: true, warningId: dup.id, activeCount: dup.active_count_after, action: dup.escalation_action || 'none', resetApplied: false };

      const t0 = now();
      const state = (await t.query('SELECT * FROM warning_state WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).rows[0] || null;
      const effective = effectiveActiveCount(state, t0);
      const resetApplied = !!state && state.active_count > 0 && effective === 0;
      const activeCount = effective + 1;
      const action = decideEscalation(activeCount);

      const ins = await t.query(
        `INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at, idempotency_key, active_count_after, escalation_action, escalation_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [guildId, userId, moderatorId, reason, t0, idempotencyKey, activeCount, action === 'none' ? null : action, action === 'none' ? null : 'PENDING']
      );
      if (!ins.rows[0]) {
        const again = (await t.query('SELECT * FROM warnings WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
        return { duplicate: true, warningId: again.id, activeCount: again.active_count_after, action: again.escalation_action || 'none', resetApplied: false };
      }
      await t.query(
        `INSERT INTO warning_state (guild_id, user_id, active_count, last_warning_at, updated_at) VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET active_count = excluded.active_count, last_warning_at = excluded.last_warning_at, updated_at = excluded.updated_at`,
        [guildId, userId, activeCount, t0]
      );
      return { duplicate: false, warningId: ins.rows[0].id, activeCount, action, resetApplied };
    });
  }

  /** Persist the outcome of the automatic action triggered by a warning. */
  async function recordEscalationResult(warningId, status, error = null) {
    await db.query('UPDATE warnings SET escalation_status = $1, escalation_error = $2 WHERE id = $3', [status, error ? String(error).slice(0, 300) : null, warningId]);
  }

  async function history(guildId, userId, limit = 10) {
    return (await db.query('SELECT * FROM warnings WHERE guild_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT $3', [guildId, userId, Math.min(limit, 25)])).rows;
  }

  /** Manual reset of the ACTIVE count only; history rows are untouched. Returns previous count. */
  async function manualReset(guildId, userId) {
    const before = await getState(guildId, userId);
    await db.query('UPDATE warning_state SET active_count = 0, updated_at = $1 WHERE guild_id = $2 AND user_id = $3', [now(), guildId, userId]);
    return before.activeCount;
  }

  /** Scheduled job: zero out active counts whose last warning is older than 30 days. History is kept. */
  async function resetExpired() {
    const r = await db.query(
      `UPDATE warning_state SET active_count = 0, updated_at = $1 WHERE active_count > 0 AND last_warning_at <= $2 RETURNING guild_id, user_id`,
      [now(), now() - ACTIVE_RESET_MS]
    );
    return r.rows;
  }

  return { add, getState, recordEscalationResult, history, manualReset, resetExpired };
}

module.exports = { createWarnings, decideEscalation, effectiveActiveCount, ACTIVE_RESET_MS };
