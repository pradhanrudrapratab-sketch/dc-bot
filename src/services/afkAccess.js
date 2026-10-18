'use strict';

/**
 * Permission -> subscription -> slot pipeline for Minecraft controls. Pure data in/out: it never talks to
 * Discord, so callers choose the right response method for their interaction state (fixes reply-after-defer).
 * @returns {Promise<{ok:true, slot:object, assignment:object}|{ok:false, title:string, description:string}>}
 */
async function checkMinecraftAccess({ db, subs, slots }, { guildId, isAdmin }) {
  if (!isAdmin) return { ok: false, title: 'Restricted', description: 'Only server administrators can use this command.' };
  const assignment = guildId ? await slots.getActiveAssignmentByServer(db, guildId) : null;
  if (!assignment) {
    return { ok: false, title: 'Subscription Required', description: 'This server does not have an active subscription.\n\nPlease subscribe through the **Master Discord Server**.' };
  }
  if (!(await subs.getActive(db, assignment.user_id))) {
    return { ok: false, title: 'Subscription Expired', description: 'The subscription for this server has expired.\n\nPlease renew in the **Master Discord Server**.' };
  }
  const slot = await slots.getById(db, assignment.slot_id);
  if (!slot || slot.retired_at || !slot.url) {
    return { ok: false, title: 'Configuration Error', description: 'No valid API URL found for this slot. Contact the bot owner.' };
  }
  return { ok: true, slot, assignment };
}

module.exports = { checkMinecraftAccess };
