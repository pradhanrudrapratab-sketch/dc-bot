'use strict';

const MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const DAY = MS.d;
const MAX_TIMEOUT_MS = 28 * DAY; // Discord's hard limit for member timeouts

/** Parse "30s", "10m", "2h", "1d", "1w", or combined "1h30m". Returns ms or null. */
function parseDuration(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const re = /(\d+)([smhdw])/g;
  let total = 0;
  let consumed = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    total += parseInt(m[1], 10) * MS[m[2]];
    consumed += m[0].length;
  }
  if (consumed !== s.length) return null;
  return total > 0 ? total : null;
}

function formatDuration(ms) {
  if (ms <= 0) return '0s';
  const parts = [];
  let rest = ms;
  for (const [unit, size] of [['d', DAY], ['h', MS.h], ['m', MS.m], ['s', MS.s]]) {
    const n = Math.floor(rest / size);
    if (n) { parts.push(`${n}${unit}`); rest -= n * size; }
  }
  return parts.join(' ') || '0s';
}

/** Discord relative timestamp markup. */
function discordTime(ms, style = 'R') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

module.exports = { parseDuration, formatDuration, discordTime, DAY, MAX_TIMEOUT_MS, MS };
