// SPDX-License-Identifier: GPL-3.0-only
// One-shot: take the maintainer's own scan path out of the drivers.
//
// The drivers that need a real multi-gigabyte scan cannot ship one — the file is 3.2 GB of
// somebody's building — so they read E57VIEW_TEST_FILE and say so clearly when it is not set.
// Run with --check in CI to fail if an absolute home path creeps back in.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const check = process.argv.includes('--check');
const BAD = /(['"`])(\/Users\/[^'"`\n]+|\/home\/[^'"`\n]+|\/private\/tmp\/claude-[^'"`\n]+)\1/g;
const files = [
  ...readdirSync('.').filter(f => /^drive.*\.mjs$/.test(f)),
  ...readdirSync('prototype').filter(f => f.endsWith('.mjs')).map(f => `prototype/${f}`),
];
let hits = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const found = [...src.matchAll(BAD)];
  if (!found.length) continue;
  hits += found.length;
  if (check) { console.log(`${f}: ${found.map(m => m[2]).join(', ')}`); continue; }
  console.log(`${f}: ${found.length} path${found.length > 1 ? 's' : ''}`);
}
if (check) {
  console.log(hits ? `\n${hits} absolute path(s) that should be an env var` : 'no hard-coded home paths');
  process.exit(hits ? 1 : 0);
}
