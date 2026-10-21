'use strict';
const { assertSafeHttpUrl, UnsafeUrlError } = require('./urlGuard');
const logger = require('../utils/logger');
const { redactString } = require('../utils/redact');

const TIMEOUT_MS = 8000;
const ENDPOINTS = new Set(['start', 'stop', 'ip', 'port', 'rename', 'jump', 'move', 'sneak', 'ping', 'health']);
const RETRYABLE = new Set(['ping', 'health']); // toggles (jump/move/sneak/start/stop) are NOT idempotent: never auto-retried

function fail(code, error) { return { ok: false, code, error }; }

/** Map transport/HTTP failures to safe, secret-free user messages. */
function normalizeError(err) {
  const status = err.response?.status;
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return fail('TIMEOUT', 'Request timed out. The Minecraft service may be offline.');
  if (err instanceof UnsafeUrlError) return fail('UNSAFE_URL', `Slot URL rejected: ${err.message}`);
  if (!err.response) return fail('NETWORK', 'Could not connect to the Minecraft service.');
  if (status === 401 || status === 403) return fail('AUTH', 'API authentication failed. Contact the bot owner.');
  if (status === 404) return fail('NOT_FOUND', 'Endpoint not found on the Minecraft service.');
  if (status === 429) return fail('RATE_LIMIT', 'Rate limited by the Minecraft service. Try again later.');
  return fail('SERVER', `Minecraft service error (${status || 'unknown'}). Try again later.`);
}

/** Interpret a 2xx payload. A JSON body that says it failed is a failure. */
function interpretPayload(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const explicitFail = data.ok === false || data.success === false || (typeof data.status === 'string' && /^(error|down|failed)$/i.test(data.status));
    if (explicitFail) {
      const msg = typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : 'The service reported a failure.';
      return fail('REJECTED', redactString(msg).slice(0, 200));
    }
  }
  return { ok: true, data };
}

/** Normalise a /ping payload. */
function parsePing(data) {
  const d = data && typeof data === 'object' ? data : {};
  const players = d.players && typeof d.players === 'object' ? d.players : {};
  const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);
  return {
    online: typeof d.online === 'boolean' ? d.online : true,
    current: num(players.online ?? players.current),
    max: num(players.max),
  };
}

/**
 * @param {object} deps
 * @param {() => Promise<string>} deps.getApiKey
 * @param {object} deps.afkConfig  { apiKeyMode, allowPrivateSlotUrls }
 * @param {object} deps.http       axios-compatible instance ({ get })
 * @param {Function} [deps.lookup] DNS lookup override (tests)
 */
function createAfkApi({ getApiKey, afkConfig, http, lookup }) {
  async function once(base, endpoint, params, key, auth) {
    const headers = { Accept: 'application/json' };
    const query = { ...params };
    if (auth) {
      if (afkConfig.apiKeyMode === 'header') headers['x-api-key'] = key;
      else query.key = key;
    }
    const res = await http.get(`${base}/${endpoint}`, {
      params: query,
      headers,
      timeout: TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: 64 * 1024,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return interpretPayload(res.data);
  }

  async function callSlot(slotUrl, endpoint, params = {}, { auth = true } = {}) {
    if (!ENDPOINTS.has(endpoint)) return fail('BAD_ENDPOINT', 'Unsupported endpoint.');
    const key = await getApiKey();
    if (auth && !key) {
      return fail('NO_KEY', 'Global API key not configured. Ask the bot owner to set GLOBAL_API_KEY or run /setkey.');
    }
    let base;
    try {
      base = await assertSafeHttpUrl(slotUrl, { allowPrivate: afkConfig.allowPrivateSlotUrls, lookup });
    } catch (err) {
      return normalizeError(err);
    }

    const attempts = RETRYABLE.has(endpoint) ? 2 : 1;
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        const out = await once(base, endpoint, params, key, auth);
        logger.info(`[AFK-API] ${endpoint} ok`, { slotHost: new URL(base).host });
        return out;
      } catch (err) {
        last = normalizeError(err);
        logger.warn(`[AFK-API] ${endpoint} failed (${last.code})`, { slotHost: new URL(base).host, status: err.response?.status });
        if (!['TIMEOUT', 'NETWORK', 'SERVER'].includes(last.code)) break;
      }
    }
    return last;
  }

  // Slot /health is documented as unauthenticated: do not send the key there.
  const healthCheck = (slotUrl) => callSlot(slotUrl, 'health', {}, { auth: false });

  return { callSlot, healthCheck };
}

module.exports = { createAfkApi, parsePing, interpretPayload, normalizeError, ENDPOINTS };
