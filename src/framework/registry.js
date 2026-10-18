'use strict';
const fs = require('node:fs');
const path = require('node:path');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.js') && !e.name.startsWith('_') ? [p] : [];
  });
}

/**
 * Load every command module under `dir`. A module exports `{ commands: [...] }` or a single command.
 * Throws on duplicate slash names or duplicate prefix names/aliases (collision guard).
 */
function loadCommands(dir) {
  const all = [];
  for (const file of walk(dir).sort()) {
    const mod = require(file);
    const list = mod.commands ?? (mod.name ? [mod] : []);
    for (const c of list) all.push(Object.assign(Object.create(null), c, { _file: path.relative(dir, file) }));
  }
  const slash = new Map();
  const prefix = new Map();
  for (const c of all) {
    if (c.slash) {
      if (slash.has(c.name)) throw new Error(`Duplicate slash command "${c.name}" (${slash.get(c.name)._file} / ${c._file})`);
      slash.set(c.name, c);
    }
    if (c.prefix) {
      for (const n of c.prefixNames ?? [c.name, ...c.aliases]) {
        if (prefix.has(n)) throw new Error(`Duplicate prefix command "${n}" (${prefix.get(n)._file} / ${c._file})`);
        prefix.set(n, c);
      }
    }
  }
  return { all, slash, prefix };
}

module.exports = { loadCommands };
