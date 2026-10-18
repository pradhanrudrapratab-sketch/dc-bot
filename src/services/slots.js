'use strict';

const isUniqueViolation = (err) => err && (err.code === '23505' || /UNIQUE constraint failed/i.test(err.message || ''));

/**
 * Slot inventory and assignment. Design points:
 *  - `status` is AVAILABLE | ASSIGNED | RETIRED; `health` is UNKNOWN | HEALTHY | UNHEALTHY and is
 *    independent, so a health probe can never free an assigned slot.
 *  - claim() uses a conditional UPDATE plus partial unique indexes: two servers cannot hold one slot,
 *    one user/server cannot hold two slots, even under concurrent transactions.
 *  - Slots with history are RETIRED rather than deleted so assignment history survives.
 */
function createSlots({ now = () => Date.now() }) {
  const getAll = async (q) => (await q.query('SELECT * FROM slots WHERE retired_at IS NULL ORDER BY slot_number ASC')).rows;
  const getByNumber = async (q, n) => (await q.query('SELECT * FROM slots WHERE slot_number = $1 AND retired_at IS NULL', [n])).rows[0] || null;
  const getById = async (q, id) => (await q.query('SELECT * FROM slots WHERE id = $1', [id])).rows[0] || null;

  async function add(q, url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const max = (await q.query('SELECT COALESCE(MAX(slot_number), 0) AS m FROM slots')).rows[0].m; // includes retired: numbers are never reused
      const t = now();
      try {
        await q.query(`INSERT INTO slots (slot_number, url, status, health, created_at, updated_at) VALUES ($1, $2, 'AVAILABLE', 'UNKNOWN', $3, $3)`, [max + 1, url, t]);
        return max + 1;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // concurrent add: retry with fresh MAX
      }
    }
    throw new Error('Could not allocate a slot number');
  }

  async function updateUrl(q, slotNumber, url) {
    return (await q.query('UPDATE slots SET url = $1, updated_at = $2 WHERE slot_number = $3 AND retired_at IS NULL', [url, now(), slotNumber])).rowCount;
  }

  /** Record a health result. Never touches `status`. */
  async function setHealth(q, slotNumber, healthy) {
    const t = now();
    return (await q.query(`UPDATE slots SET health = $1, last_health_at = $2, updated_at = $2 WHERE slot_number = $3 AND retired_at IS NULL`, [healthy ? 'HEALTHY' : 'UNHEALTHY', t, slotNumber])).rowCount;
  }

  async function getActiveAssignmentBySlot(q, slotId) {
    return (await q.query(
      `SELECT sa.*, u.discord_user_id, u.username, s.url, s.slot_number
         FROM slot_assignments sa JOIN users u ON u.id = sa.user_id JOIN slots s ON s.id = sa.slot_id
        WHERE sa.slot_id = $1 AND sa.released_at IS NULL`, [slotId])).rows[0] || null;
  }
  async function getActiveAssignmentByServer(q, serverId) {
    return (await q.query(
      `SELECT sa.*, u.discord_user_id, s.url, s.slot_number, s.health
         FROM slot_assignments sa JOIN users u ON u.id = sa.user_id JOIN slots s ON s.id = sa.slot_id
        WHERE sa.server_id = $1 AND sa.released_at IS NULL`, [serverId])).rows[0] || null;
  }
  async function getActiveAssignmentByUser(q, userId) {
    return (await q.query(
      `SELECT sa.*, s.url, s.slot_number, s.health
         FROM slot_assignments sa JOIN slots s ON s.id = sa.slot_id
        WHERE sa.user_id = $1 AND sa.released_at IS NULL`, [userId])).rows[0] || null;
  }

  /**
   * Atomically claim a free slot for (user, server).
   * @returns {{ok:true, slot:object}|{ok:false, reason:'USER_HAS_SLOT'|'SERVER_HAS_SLOT'|'NO_SLOT', existing?:object}}
   */
  async function claim(db, { userId, serverId, serverName }) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await db.tx(async (t) => {
          const byUser = await getActiveAssignmentByUser(t, userId);
          if (byUser) return { ok: false, reason: 'USER_HAS_SLOT', existing: byUser };
          const byServer = await getActiveAssignmentByServer(t, serverId);
          if (byServer) return { ok: false, reason: 'SERVER_HAS_SLOT', existing: byServer };

          const ts = now();
          const claimed = await t.query(
            `UPDATE slots SET status = 'ASSIGNED', updated_at = $1
              WHERE status = 'AVAILABLE' AND retired_at IS NULL AND health <> 'UNHEALTHY'
                AND id = (SELECT id FROM slots WHERE status = 'AVAILABLE' AND retired_at IS NULL AND health <> 'UNHEALTHY'
                           ORDER BY slot_number ASC LIMIT 1)
            RETURNING *`, [ts]);
          if (!claimed.rows[0]) return { ok: false, reason: 'NO_SLOT' };
          const slot = claimed.rows[0];
          await t.query(
            `INSERT INTO slot_assignments (slot_id, user_id, server_id, server_name, assigned_at) VALUES ($1, $2, $3, $4, $5)`,
            [slot.id, userId, serverId, serverName || '', ts]);
          return { ok: true, slot };
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // lost a race: retry from scratch (state is re-read)
      }
    }
    return { ok: false, reason: 'NO_SLOT' };
  }

  /** Release the active assignment on a slot (idempotent). Returns true if something was released. */
  async function release(q, slotId, reason = 'RELEASED') {
    const t = now();
    const r = await q.query(`UPDATE slot_assignments SET released_at = $1, release_reason = $2 WHERE slot_id = $3 AND released_at IS NULL`, [t, reason, slotId]);
    await q.query(`UPDATE slots SET status = 'AVAILABLE', updated_at = $1 WHERE id = $2 AND status = 'ASSIGNED' AND retired_at IS NULL`, [t, slotId]);
    return r.rowCount > 0;
  }

  async function releaseByUser(q, userId, reason) {
    const a = await getActiveAssignmentByUser(q, userId);
    return a ? release(q, a.slot_id, reason) : false;
  }

  /**
   * Delete or retire a slot. Releases any active assignment first. Slots that ever had an
   * assignment are retired (history preserved, FK intact); never-used slots are deleted.
   */
  async function retire(db, slotNumber) {
    return db.tx(async (t) => {
      const slot = await getByNumber(t, slotNumber);
      if (!slot) return { ok: false, reason: 'NOT_FOUND' };
      const released = await release(t, slot.id, 'SLOT_REMOVED');
      const history = (await t.query('SELECT COUNT(*) AS c FROM slot_assignments WHERE slot_id = $1', [slot.id])).rows[0].c;
      if (history > 0) {
        const ts = now();
        await t.query(`UPDATE slots SET status = 'RETIRED', retired_at = $1, updated_at = $1 WHERE id = $2`, [ts, slot.id]);
        return { ok: true, mode: 'RETIRED', released };
      }
      await t.query('DELETE FROM slots WHERE id = $1', [slot.id]);
      return { ok: true, mode: 'DELETED', released };
    });
  }

  async function stats(q) {
    const one = async (sql) => (await q.query(sql)).rows[0].c;
    return {
      total: await one(`SELECT COUNT(*) AS c FROM slots WHERE retired_at IS NULL`),
      available: await one(`SELECT COUNT(*) AS c FROM slots WHERE retired_at IS NULL AND status = 'AVAILABLE' AND health <> 'UNHEALTHY'`),
      assigned: await one(`SELECT COUNT(*) AS c FROM slots WHERE retired_at IS NULL AND status = 'ASSIGNED'`),
      inactive: await one(`SELECT COUNT(*) AS c FROM slots WHERE retired_at IS NULL AND health = 'UNHEALTHY'`),
    };
  }

  return {
    getAll, getByNumber, getById, add, updateUrl, setHealth, claim, release, releaseByUser, retire, stats,
    getActiveAssignmentBySlot, getActiveAssignmentByServer, getActiveAssignmentByUser,
  };
}

module.exports = { createSlots, isUniqueViolation };
