// SPDX-License-Identifier: GPL-3.0-only
// The old address keeps working.
//
// opensketch.web.app was the public URL before e57view.web.app, and it is named in install
// lines people have already copied into their agents. It is now a second Hosting site in the
// same Firebase project whose only job is to 301 every path to the new one. This checks that
// it does, with the path and the query intact, and that the documented `curl -fsSL` follows
// it — the L in those flags is doing real work now.
import { writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OLD = process.env.E57VIEW_OLD_ORIGIN || 'https://opensketch.web.app';
const NEW = process.env.URL || 'https://e57view.web.app';
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };

/** One request, no redirect following, so the response itself can be looked at. */
async function head(url) {
  const r = await fetch(url, { redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location') };
}

const cases = [
  ['the bare root', '/', `${NEW}/`],
  ['the root with a query', '/?x=1', `${NEW}/?x=1`],
  ['a file', '/llms.txt', `${NEW}/llms.txt`],
  ['the MCP server', '/mcp.mjs', `${NEW}/mcp.mjs`],
  ['a deep path with a query', '/some/deep/path?a=1&b=2', `${NEW}/some/deep/path?a=1&b=2`],
  ['a path that never existed', '/nope', `${NEW}/nope`],
];
for (const [what, path, want] of cases) {
  const r = await head(OLD + path);
  ok(`${what} redirects permanently`, r.status === 301, `HTTP ${r.status}`);
  ok(`  and keeps the path and query`, r.location === want, `${r.location} against ${want}`);
}

// the new address itself must not redirect anywhere
const direct = await head(`${NEW}/`);
ok('the new address serves the app directly', direct.status === 200, `HTTP ${direct.status}`);

// the install line in every doc and in the panel
const out = join(tmpdir(), 'e57view-redirect-mcp.mjs');
const r = await fetch(`${OLD}/mcp.mjs`);          // fetch follows a 301 for GET, as curl -L does
ok('curl -fsSL follows the redirect for GET', r.ok && r.url === `${NEW}/mcp.mjs`, `${r.status} at ${r.url}`);
const body = await r.text();
writeFileSync(out, body);
ok('and the file that arrives is the MCP server', body.startsWith('#!/usr/bin/env node') && body.includes('viewer_state'),
   `${(statSync(out).size / 1024).toFixed(0)} KB`);
rmSync(out, { force: true });

// and the same file is served from the new address
const fresh = await fetch(`${NEW}/mcp.mjs`);
const freshBody = await fresh.text();
ok('the two addresses serve the same server', freshBody.length === body.length,
   `${(body.length / 1024).toFixed(0)} KB against ${(freshBody.length / 1024).toFixed(0)} KB`);

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
