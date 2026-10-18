'use strict';

/**
 * Hourly job: expire due subscriptions, then release ONLY the slots whose owner has no active
 * subscription left. Everything happens in one transaction so state stays consistent.
 * @returns {Promise<{expired:number, released:Array<{slotNumber:number, userId:number, serverId:string}>}>}
 */
async function runExpiry({ db, subs, slots, now = () => Date.now() }) {
  return db.tx(async (t) => {
    const expired = await subs.expireDue(t);
    const orphaned = (await t.query(
      `SELECT sa.slot_id, sa.user_id, sa.server_id, s.slot_number
         FROM slot_assignments sa
         JOIN slots s ON s.id = sa.slot_id
        WHERE sa.released_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM subscriptions sub
                           WHERE sub.user_id = sa.user_id AND sub.status = 'ACTIVE' AND sub.expires_at > $1)`,
      [now()]
    )).rows;
    const released = [];
    for (const r of orphaned) {
      await slots.release(t, r.slot_id, 'SUBSCRIPTION_EXPIRED');
      released.push({ slotNumber: r.slot_number, userId: r.user_id, serverId: r.server_id });
    }
    return { expired: expired.length, released };
  });
}

module.exports = { runExpiry };
