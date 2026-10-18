'use strict';
const { parseDuration } = require('../utils/time');

const SNOWFLAKE = /^\d{15,25}$/;

/** Split on whitespace honouring "double quotes". Returns [{text, start}]. */
function tokenize(input) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(input)) !== null) tokens.push({ text: m[1] !== undefined ? m[1] : m[2], start: m.index });
  return tokens;
}

const idFrom = (s, re) => {
  const m = s.match(re);
  if (m) return m[1];
  return SNOWFLAKE.test(s) ? s : null;
};

function parseValue(opt, raw) {
  switch (opt.type) {
    case 'user': return idFrom(raw, /^<@!?(\d+)>$/);
    case 'channel': return idFrom(raw, /^<#(\d+)>$/);
    case 'role': return idFrom(raw, /^<@&(\d+)>$/);
    case 'integer': {
      if (!/^-?\d+$/.test(raw)) return null;
      const n = parseInt(raw, 10);
      if ((opt.min !== undefined && n < opt.min) || (opt.max !== undefined && n > opt.max)) return null;
      return n;
    }
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean': {
      const l = raw.toLowerCase();
      if (['true', 'yes', 'on', '1', 'enable', 'enabled'].includes(l)) return true;
      if (['false', 'no', 'off', '0', 'disable', 'disabled'].includes(l)) return false;
      return null;
    }
    case 'duration': return parseDuration(raw);
    case 'string': {
      if (opt.choices && !opt.choices.some((c) => (c.value ?? c) === raw.toLowerCase())) return null;
      if (opt.maxLength && raw.length > opt.maxLength) return null;
      if (opt.minLength && raw.length < opt.minLength) return null;
      return opt.choices ? raw.toLowerCase() : raw;
    }
    default: return null;
  }
}

function usage(prefix, name, options) {
  const parts = options.map((o) => {
    const label = o.rest ? `${o.name}...` : o.name;
    return o.required ? `<${label}>` : `[${label}]`;
  });
  return `${prefix}${name}${parts.length ? ' ' + parts.join(' ') : ''}`;
}

/**
 * Parse the text after a command name into option values.
 * @returns {{ok:true, values:object}|{ok:false, error:string}}
 */
function parseArgs(options, argString) {
  const tokens = tokenize(argString || '');
  const values = {};
  let i = 0;
  for (const opt of options) {
    if (opt.rest) {
      const rest = i < tokens.length ? argString.slice(tokens[i].start).trim() : '';
      if (!rest) {
        if (opt.required) return { ok: false, error: `Missing **${opt.name}**.` };
        continue;
      }
      const v = parseValue(opt, rest);
      if (v === null || v === undefined) return { ok: false, error: `Invalid **${opt.name}**.` };
      values[opt.name] = v;
      i = tokens.length;
      continue;
    }
    if (i >= tokens.length) {
      if (opt.required) return { ok: false, error: `Missing **${opt.name}**.` };
      continue;
    }
    const v = parseValue(opt, tokens[i].text);
    if (v === null || v === undefined) {
      if (!opt.required) continue; // optional option: token may belong to a later option
      const hint = opt.choices ? ` (one of: ${opt.choices.map((c) => c.value ?? c).join(', ')})` : '';
      return { ok: false, error: `Invalid **${opt.name}**${hint}.` };
    }
    values[opt.name] = v;
    i += 1;
  }
  return { ok: true, values };
}

module.exports = { tokenize, parseArgs, parseValue, usage };
