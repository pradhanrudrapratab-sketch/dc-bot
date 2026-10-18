'use strict';
const { PERMISSION_NAMES } = require('./permissionNames');

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const OPTION_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'user', 'channel', 'role', 'duration']);

function validateOptions(owner, options = []) {
  if (options.length > 25) throw new Error(`${owner}: more than 25 options`);
  let sawOptional = false;
  const seen = new Set();
  for (const o of options) {
    if (!NAME_RE.test(o.name)) throw new Error(`${owner}: invalid option name "${o.name}"`);
    if (seen.has(o.name)) throw new Error(`${owner}: duplicate option "${o.name}"`);
    seen.add(o.name);
    if (!OPTION_TYPES.has(o.type)) throw new Error(`${owner}: unknown option type "${o.type}"`);
    if (!o.description || o.description.length > 100) throw new Error(`${owner}.${o.name}: description must be 1-100 chars`);
    // Discord rejects commands where a required option follows an optional one.
    if (o.required && sawOptional) throw new Error(`${owner}.${o.name}: required option after optional option`);
    if (!o.required) sawOptional = true;
  }
  const prefixOpts = options.filter((o) => !o.slashOnly);
  const restIdx = prefixOpts.findIndex((o) => o.rest);
  if (restIdx !== -1 && restIdx !== prefixOpts.length - 1) throw new Error(`${owner}: "rest" option must be last`);
}

function validatePerms(owner, list = []) {
  for (const p of list) if (!PERMISSION_NAMES.has(p)) throw new Error(`${owner}: unknown permission "${p}"`);
}

/**
 * Define a command that is exposed as a slash command, a prefix command, or both.
 * One definition = one behaviour, so the two interfaces can never drift apart.
 */
function defineCommand(spec) {
  const c = {
    category: 'utility', slash: true, prefix: true, aliases: [], guildOnly: true, ownerOnly: false,
    userPermissions: [], botPermissions: [], cooldownMs: 0, options: [], ...spec,
  };
  if (!NAME_RE.test(c.name)) throw new Error(`Invalid command name "${c.name}"`);
  if (!c.description || c.description.length > 100) throw new Error(`${c.name}: description must be 1-100 chars`);
  const hasSubs = c.subcommands && Object.keys(c.subcommands).length > 0;
  if (hasSubs === (typeof c.execute === 'function')) throw new Error(`${c.name}: define exactly one of execute or subcommands`);
  validatePerms(c.name, c.userPermissions);
  validatePerms(c.name, c.botPermissions);
  for (const a of [...c.aliases, ...(c.prefixNames || [])]) if (!NAME_RE.test(a)) throw new Error(`${c.name}: invalid alias "${a}"`);
  if (hasSubs) {
    if (c.options.length) throw new Error(`${c.name}: top-level options not allowed with subcommands`);
    if (Object.keys(c.subcommands).length > 25) throw new Error(`${c.name}: more than 25 subcommands`);
    for (const [sn, sub] of Object.entries(c.subcommands)) {
      if (!NAME_RE.test(sn)) throw new Error(`${c.name}: invalid subcommand "${sn}"`);
      if (!sub.description || sub.description.length > 100) throw new Error(`${c.name} ${sn}: description must be 1-100 chars`);
      if (typeof sub.execute !== 'function') throw new Error(`${c.name} ${sn}: missing execute`);
      sub.options = sub.options || [];
      sub.userPermissions = sub.userPermissions || [];
      validatePerms(`${c.name} ${sn}`, sub.userPermissions);
      validateOptions(`${c.name} ${sn}`, sub.options);
    }
  } else {
    validateOptions(c.name, c.options);
  }
  if (!c.slash && !c.prefix) throw new Error(`${c.name}: must be available as slash or prefix`);
  return Object.freeze(c);
}

module.exports = { defineCommand, NAME_RE };
