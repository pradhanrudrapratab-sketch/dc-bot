'use strict';

const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|api[-_]?key|apikey|cookie|^key$)/i;
const PATTERNS = [
  [/[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g, '[REDACTED_DISCORD_TOKEN]'],
  [/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"'`]+/gi, '$1[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+(@)/gi, '$1[REDACTED]$2'],
];

const knownSecrets = new Set();

/** Register an exact secret value so it is scrubbed wherever it appears. */
function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) knownSecrets.add(value);
}

function redactString(str) {
  let out = String(str);
  for (const s of knownSecrets) {
    if (out.includes(s)) out = out.split(s).join('[REDACTED]');
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Deep-redact strings/objects. Never mutates the input. */
function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (depth > 6) return '[DEEP]';
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), code: value.code, status: value.response?.status };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function _clearSecretsForTests() {
  knownSecrets.clear();
}

module.exports = { redact, redactString, registerSecret, _clearSecretsForTests };
