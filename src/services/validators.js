'use strict';

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const MC_NAME = /^[A-Za-z0-9_]{1,16}$/;

function validateServerAddress(v) {
  const s = String(v ?? '').trim();
  return HOSTNAME.test(s) ? { ok: true, value: s } : { ok: false, error: 'Enter a hostname or IPv4 address (letters, digits, dots, hyphens).' };
}
function validatePort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? { ok: true, value: n } : { ok: false, error: 'Port must be 1-65535.' };
}
function validateMinecraftName(v) {
  const s = String(v ?? '').trim();
  return MC_NAME.test(s) ? { ok: true, value: s } : { ok: false, error: 'Minecraft names are 1-16 characters: letters, digits, underscore.' };
}

module.exports = { validateServerAddress, validatePort, validateMinecraftName };
