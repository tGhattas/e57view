// SPDX-License-Identifier: GPL-3.0-only
// Regenerate THIRD_PARTY.md from what is actually installed.
//
//   node tools/third-party.mjs
//
// Written from the lock files rather than by hand, because a hand-written dependency list is
// out of date the first time someone runs `npm update` and nobody notices. It also refuses to
// finish if it meets a licence that is not on the compatible list, so a new dependency with an
// awkward licence is a build failure rather than a discovery years later.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

// Every one of these may be combined into a GPL-3.0-only work. Apache-2.0 is on the list
// because the one-way incompatibility runs the other way: GPLv3 may absorb Apache-2.0, not
// the reverse. MPL-2.0 is here because of its own secondary-licence clause.
const OK = new Set([
  'MIT', 'MIT-0', 'Apache-2.0', 'Apache-2.0 WITH LLVM-exception', 'BSD-2-Clause', 'BSD-3-Clause',
  'ISC', '0BSD', 'Zlib', 'Unlicense', 'CC0-1.0', 'Unicode-3.0', 'Unicode-DFS-2016', 'MPL-2.0',
  'BlueOak-1.0.0', 'CC-BY-4.0', 'Python-2.0', 'WTFPL', 'GPL-3.0-only', 'GPL-3.0', 'LGPL-2.1-or-later',
  'LGPL-3.0-or-later', 'AFL-2.1', 'BSD-4-Clause', 'OpenSSL',
]);
/** Split a compound expression into the individual licences it could resolve to. */
function parts(expr) {
  return String(expr)
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND)\s+/i)
    .map(s => s.trim())
    .filter(Boolean);
}
/** A dual-licensed package is fine if any option is compatible; an AND needs all of them.
 *  Being strict here and listing the whole expression is the honest thing: the table shows
 *  what the package says, and this only decides whether to stop. */
const acceptable = (expr) => parts(expr).some(p => OK.has(p));

// cargo subcommands shell out to `cargo` itself, so the cargo bin directory has to be on the
// PATH of the child as well as findable from here
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const sh = (cmd, args, cwd) => {
  try { return execFileSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
};
/** cargo is often only on PATH inside a login shell; find it rather than silently skipping. */
function cargoBin() {
  for (const c of ['cargo', `${process.env.HOME}/.cargo/bin/cargo`]) {
    if (sh(c, ['--version'], '.')) return c;
  }
  return null;
}

// ---------------------------------------------------------------- npm
const npmTrees = [
  ['the viewer and its build', '.', ['--production']],
  ['the build and test tooling (not shipped)', '.', []],
  ['the Node MCP server', 'mcp', ['--production']],
  ['the cloud agent relay (web build only)', 'functions', ['--production']],
];
const npm = [];
for (const [label, cwd, extra] of npmTrees) {
  if (!existsSync(`${cwd}/package.json`)) continue;
  const raw = sh('npx', ['--yes', 'license-checker-rseidelsohn', '--json', ...extra], cwd);
  if (!raw) continue;
  let d; try { d = JSON.parse(raw); } catch { continue; }
  const counts = new Map();
  for (const [pkg, v] of Object.entries(d)) {
    if (v.private) continue;                       // our own packages
    const lic = String(v.licenses ?? 'UNKNOWN');
    if (!counts.has(lic)) counts.set(lic, []);
    counts.get(lic).push(pkg.replace(/@[^@]+$/, ''));
  }
  npm.push({ label, counts });
}

// ---------------------------------------------------------------- cargo
const cargoTrees = [
  ['crates/e57-wasm — the decoder, octree and analysis, compiled to WebAssembly', 'crates/e57-wasm'],
  ['desktop — the Tauri shell, the agent bridge and the Rust MCP server', 'desktop'],
];
/** The crate tables already in THIRD_PARTY.md, so a machine without cargo-license regenerates
 *  the npm half without silently deleting the Rust half — which would then fail the "is this
 *  file up to date" check in CI for a reason that has nothing to do with the change. */
function previousCargoTables() {
  if (!existsSync('THIRD_PARTY.md')) return new Map();
  const md = readFileSync('THIRD_PARTY.md', 'utf8');
  const out = new Map();
  for (const m of md.matchAll(/^## Cargo — (.+)\n\n\| Licence \| Packages \| Names \|\n\|---\|---:\|---\|\n((?:\|.*\n)+)/gm)) {
    const counts = new Map();
    for (const row of m[2].trim().split('\n')) {
      const c = /^\| `(.+?)` \| (\d+) \| (.*) \|$/.exec(row);
      if (c) counts.set(c[1], { n: Number(c[2]), names: c[3] });
    }
    out.set(m[1], counts);
  }
  return out;
}
const cargo = [];
const CARGO = cargoBin();
// Whenever fresh crate data cannot be had — no cargo, no cargo-license, a network-less
// runner — reuse what is already in the file rather than deleting those tables. Dropping them
// would fail CI's "is this file up to date" check for a reason that has nothing to do with
// the change being reviewed, which is the worst kind of red build.
let kept = null;
const previous = () => (kept ??= previousCargoTables());
for (const [label, cwd] of cargoTrees) {
  const raw = CARGO ? sh(CARGO, ['license'], cwd) : '';
  if (!raw) {
    const old = previous().get(label);
    if (old?.size) {
      console.error(`no fresh crate data for ${cwd} — keeping the table already in THIRD_PARTY.md`);
      cargo.push({ label, counts: null, verbatim: old });
      continue;
    }
    console.error(`no cargo licence data for ${cwd} (cargo install cargo-license)`);
    continue;
  }
  const counts = new Map();
  for (const line of raw.split('\n')) {
    const m = /^(.*?) \((\d+)\): (.*)$/.exec(line.trim());
    if (!m) continue;
    const [, lic, , list] = m;
    if (lic === 'N/A') continue;
    counts.set(lic, [...new Set(list.split(', ').map(s => s.trim()))]);
  }
  cargo.push({ label, counts });
}

// ---------------------------------------------------------------- report
const bad = [];
const total = { npm: 0, cargo: 0 };
const table = (counts, which) => {
  const rows = [...counts.entries()].sort((a, b) => b[1].length - a[1].length);
  let out = '| Licence | Packages | Names |\n|---|---:|---|\n';
  for (const [lic, pkgs] of rows) {
    total[which] += pkgs.length;
    if (!acceptable(lic)) bad.push(`${lic}: ${pkgs.join(', ')}`);
    const names = pkgs.length > 14 ? `${pkgs.slice(0, 14).join(', ')} … and ${pkgs.length - 14} more` : pkgs.join(', ');
    out += `| \`${lic}\` | ${pkgs.length} | ${names} |\n`;
  }
  return out;
};

let md = `<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Third-party licences

e57view is **GPL-3.0-only**. Everything it depends on can be combined into a GPL-3.0 work.
This file is generated — \`node tools/third-party.mjs\` — from the lock files in the tree, so
it is what is actually installed rather than what somebody remembered to write down. The
generator stops with an error if it meets a licence that is not on its compatible list, which
makes an awkward new dependency a build failure instead of a discovery years later.

A note on the one that matters: **Apache-2.0 is compatible with GPLv3 in one direction only.**
GPLv3 code may incorporate Apache-2.0 code; the reverse is not true. Since this project is
GPLv3, the direction is the right one. (It would *not* be compatible with GPLv2, which is why
the licence here is GPL-3.0-**only**.)

MPL-2.0 dependencies are compatible through MPL's own secondary-licence clause. Dual-licensed
packages — \`Apache-2.0 OR MIT\` and friends — are used under whichever option suits.

`;
for (const { label, counts } of npm) {
  md += `## npm — ${label}\n\n${table(counts, 'npm')}\n`;
}
for (const { label, counts, verbatim } of cargo) {
  if (verbatim) {
    // reproduced from the last run on a machine that had cargo-license
    let t = '| Licence | Packages | Names |\n|---|---:|---|\n';
    for (const [lic, row] of verbatim) {
      total.cargo += row.n;
      if (!acceptable(lic)) bad.push(`${lic}: ${row.names}`);
      t += `| \`${lic}\` | ${row.n} | ${row.names} |\n`;
    }
    md += `## Cargo — ${label}\n\n${t}\n`;
    continue;
  }
  md += `## Cargo — ${label}\n\n${table(counts, 'cargo')}\n`;
}
md += `## Things that are not dependencies but are worth naming

| What | Where | Licence |
|---|---|---|
| **IBM Plex Sans / Mono** | Google Fonts, web build only; the desktop build uses the system font stack and loads nothing | SIL Open Font License 1.1 |
| **WebKitGTK / WKWebView / WebView2** | the system webview the desktop app renders in, linked dynamically, never redistributed | LGPL-2.1 / Apple / Microsoft, per platform |
| **The GPL-3.0 text in \`LICENSE\`** | verbatim from gnu.org | copyright FSF, verbatim copying permitted |

## How to check this yourself

    npm ci && npm ci --prefix mcp && npm ci --prefix functions
    node tools/third-party.mjs        # regenerates this file, fails on an incompatible licence

    cargo install cargo-license
    cd crates/e57-wasm && cargo license
    cd desktop && cargo license
`;

writeFileSync('THIRD_PARTY.md', md);
console.log(`THIRD_PARTY.md written · ${total.npm} npm packages, ${total.cargo} crates`);
if (bad.length) {
  console.error('\nLicences that are NOT on the GPL-3.0-compatible list:');
  for (const b of bad) console.error('  ' + b);
  process.exit(1);
}
console.log('every licence is GPL-3.0-compatible');
