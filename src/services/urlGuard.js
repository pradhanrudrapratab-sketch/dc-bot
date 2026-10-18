'use strict';
const net = require('node:net');
const dns = require('node:dns').promises;

function ipv4ToInt(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + parseInt(o, 10), 0) >>> 0;
}
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

/** True for loopback / private / link-local / reserved / multicast addresses. */
function isPrivateAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some((b) => (n & b.mask) === (b.base & b.mask));
  }
  if (fam === 6) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l);
  }
  return false;
}

class UnsafeUrlError extends Error {
  constructor(message) { super(message); this.name = 'UnsafeUrlError'; }
}

/**
 * Validate a user/owner supplied base URL before the bot sends a request to it.
 *  - https only (http allowed solely when allowPrivate is on)
 *  - no embedded credentials
 *  - hostname must not resolve to a private/loopback/link-local address (unless allowPrivate)
 * Returns the normalised URL string (no trailing slash).
 * `lookup` is injectable for tests.
 */
async function assertSafeHttpUrl(input, { allowPrivate = false, lookup } = {}) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new UnsafeUrlError('Not a valid URL.'); }
  if (!['https:', 'http:'].includes(u.protocol)) throw new UnsafeUrlError('Only http(s) URLs are allowed.');
  if (u.protocol === 'http:' && !allowPrivate) throw new UnsafeUrlError('Use https:// (plain http is disabled).');
  if (u.username || u.password) throw new UnsafeUrlError('URLs with embedded credentials are not allowed.');
  if (u.search || u.hash) throw new UnsafeUrlError('Base URL must not contain a query string or fragment.');

  if (!allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
      throw new UnsafeUrlError('Local hostnames are not allowed.');
    }
    if (net.isIP(host)) {
      if (isPrivateAddress(host)) throw new UnsafeUrlError('Private/loopback addresses are not allowed.');
    } else {
      const resolve = lookup || ((h) => dns.lookup(h, { all: true }));
      let addrs;
      try { addrs = await resolve(host); } catch { throw new UnsafeUrlError('Hostname could not be resolved.'); }
      if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
        throw new UnsafeUrlError('Hostname resolves to a private address.');
      }
    }
  }
  return u.toString().replace(/\/+$/, '');
}

/** Literal-only check (no DNS) for media URLs that Discord, not the bot, will fetch. */
function isSafeHttpsLiteral(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;
  if (net.isIP(host) && isPrivateAddress(host)) return false;
  return true;
}

module.exports = { assertSafeHttpUrl, isSafeHttpsLiteral, isPrivateAddress, UnsafeUrlError };
