'use strict';

/**
 * Plan a verification lockdown (pure). Only channels that @everyone can currently see are touched:
 * @everyone loses View Channel, the verified role gains it. Already-private channels are skipped so the
 * verified role never gains access to staff-only channels. The verification channel (and optional
 * honeypot) stay visible to everyone.
 * @param {Array<{id:string,name:string,everyoneCanView:boolean,everyoneOverwrite:'allow'|'deny'|null,verifiedOverwrite:'allow'|'deny'|null}>} channels
 */
function planLockdown({ channels, exemptChannelIds = [] }) {
  const exempt = new Set(exemptChannelIds.filter(Boolean));
  const ops = [];
  const skipped = [];
  for (const c of channels) {
    if (exempt.has(c.id)) { skipped.push({ id: c.id, reason: 'EXEMPT' }); continue; }
    if (!c.everyoneCanView) { skipped.push({ id: c.id, reason: 'ALREADY_PRIVATE' }); continue; }
    ops.push({ channelId: c.id, priorEveryone: c.everyoneOverwrite, priorVerified: c.verifiedOverwrite });
  }
  return { ops, skipped };
}

/** Serialise what we changed so unlock can restore exactly that and nothing else. */
const serializeLockdown = (plan) => JSON.stringify({ at: Date.now(), ops: plan.ops });
function parseLockdown(json) {
  if (!json) return null;
  try { const v = JSON.parse(json); return Array.isArray(v.ops) ? v : null; } catch { return null; }
}

const overwriteState = (channel, roleId, flag = 'ViewChannel') => {
  const ow = channel.permissionOverwrites?.cache?.get(roleId);
  if (!ow) return null;
  if (ow.allow.has(flag)) return 'allow';
  if (ow.deny.has(flag)) return 'deny';
  return null;
};
const stateToValue = (s) => (s === 'allow' ? true : s === 'deny' ? false : null);

/**
 * Verify-button decision (pure): can we grant the role?
 * @returns {{ok:true}|{ok:false, code:string, message:string}}
 */
function canGrantRole({ settings, role, botTop, botHasManageRoles, alreadyHas }) {
  if (!settings.verification_enabled) return { ok: false, code: 'DISABLED', message: 'Verification is currently disabled.' };
  if (!settings.verification_role_id || !role) return { ok: false, code: 'ROLE_MISSING', message: 'The verified role no longer exists. Ask an administrator to run `/verification repair`.' };
  if (alreadyHas) return { ok: false, code: 'ALREADY', message: 'You are already verified.' };
  if (!botHasManageRoles) return { ok: false, code: 'NO_PERMISSION', message: 'I am missing the **Manage Roles** permission. Please tell an administrator.' };
  if (role.managed || role.position >= botTop) return { ok: false, code: 'HIERARCHY', message: 'The verified role is above my highest role. Please tell an administrator.' };
  return { ok: true };
}

module.exports = { planLockdown, serializeLockdown, parseLockdown, overwriteState, stateToValue, canGrantRole };
