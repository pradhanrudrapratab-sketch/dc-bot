'use strict';

const EMOJI_RE = /^<(a)?:(\w{2,32}):(\d{15,25})>$/;
const LIMITS = [50, 100, 150, 250]; // per type (static / animated) by boost tier 0-3
const MAX_BYTES = 256 * 1024;

/** @returns {{id:string,name:string,animated:boolean}|null} */
function parseEmoji(input, nameOverride) {
  const s = String(input || '').trim();
  const m = s.match(EMOJI_RE);
  let parsed = null;
  if (m) parsed = { id: m[3], name: m[2], animated: !!m[1] };
  else if (/^\d{15,25}$/.test(s)) parsed = { id: s, name: 'emoji', animated: false };
  if (!parsed) return null;
  if (nameOverride) parsed.name = nameOverride;
  parsed.name = parsed.name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32);
  if (parsed.name.length < 2) parsed.name = `${parsed.name}_`.padEnd(2, '_');
  return parsed;
}

const cdnUrl = (e) => `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=128`;
const limitFor = (tier) => LIMITS[Math.min(Math.max(tier | 0, 0), 3)];

/**
 * Decide per destination what will happen (pure). Statuses never claim success before the API call.
 * @param dest {guildId,tier,userIsAdmin,botHasPerm,existingNames:Set,staticCount,animatedCount}
 */
function planDestination(emoji, dest) {
  if (!dest.userIsAdmin) return { status: 'SKIPPED_NOT_ADMIN' };
  if (!dest.botHasPerm) return { status: 'PERMISSION_MISSING' };
  if (dest.existingNames.has(emoji.name.toLowerCase())) return { status: 'ALREADY_EXISTS' };
  const used = emoji.animated ? dest.animatedCount : dest.staticCount;
  if (used >= limitFor(dest.tier)) return { status: 'NO_CAPACITY' };
  return { status: 'READY' };
}

module.exports = { parseEmoji, cdnUrl, limitFor, planDestination, MAX_BYTES, LIMITS };
