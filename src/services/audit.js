'use strict';
const { redact } = require('../utils/redact');
const logger = require('../utils/logger');

/** Log-channel categories an admin can configure via /log. */
const LOG_CATEGORIES = Object.freeze(['message', 'voice', 'member', 'channel', 'role', 'security', 'moderation']);
// Audit-table categories that are not log channels map onto one that is.
const ROUTE = { config: 'security', invite: 'member', economy: 'security', announcement: 'security', emoji: 'security' };

/**
 * Append-only audit trail (database) with optional fan-out to the configured log channel.
 * `sink(guildId, logCategory, entry)` is best-effort: sink failures never break the caller.
 */
function createAudit({ db, now = () => Date.now(), sink = null }) {
  async function record({ guildId = null, category, action, actorId = null, targetId = null, result = 'SUCCESS', details = null }) {
    const entry = {
      guildId, category, action, actorId, targetId, result, details: details ? redact(details) : null, at: now(),
    };
    await db.query(
      `INSERT INTO audit_logs (guild_id, category, action, actor_id, target_id, result, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [guildId, category, action, actorId, targetId, result, entry.details ? JSON.stringify(entry.details) : null, entry.at]
    );
    if (sink && guildId) {
      try {
        await sink(guildId, ROUTE[category] || category, entry);
      } catch (err) {
        logger.warn('[AUDIT] log sink failed', { error: err, guildId, category });
      }
    }
    return entry;
  }

  async function recent(guildId, { category = null, limit = 10 } = {}) {
    const lim = Math.min(Math.max(limit, 1), 50);
    return category
      ? (await db.query('SELECT * FROM audit_logs WHERE guild_id = $1 AND category = $2 ORDER BY id DESC LIMIT $3', [guildId, category, lim])).rows
      : (await db.query('SELECT * FROM audit_logs WHERE guild_id = $1 ORDER BY id DESC LIMIT $2', [guildId, lim])).rows;
  }

  async function recordSecurityEvent({ guildId, eventType, actorId = null, targetId = null, evidence = null, actionTaken = null, outcome = null }) {
    await db.query(
      `INSERT INTO security_events (guild_id, event_type, actor_id, target_id, evidence, action_taken, outcome, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [guildId, eventType, actorId, targetId, evidence ? JSON.stringify(redact(evidence)) : null, actionTaken, outcome, now()]
    );
  }

  return { record, recent, recordSecurityEvent };
}

module.exports = { createAudit, LOG_CATEGORIES };
