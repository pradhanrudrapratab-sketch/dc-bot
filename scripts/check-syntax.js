'use strict';
// Runs `node --check` on every .js file in src/, tests/ and scripts/.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

let failed = 0;
const files = ['src', 'tests', 'scripts'].flatMap((d) => (fs.existsSync(d) ? walk(d) : []));
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`SYNTAX ERROR in ${f}\n${err.stderr}`);
  }
}
console.log(`${files.length} files checked, ${failed} failed`);
process.exit(failed ? 1 : 0);
