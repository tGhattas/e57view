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
//
// Read from the lock files, not from node_modules. A lock file lists every package the tree
// resolves to on every platform; node_modules holds the ones this machine needed. npm's
// optional platform binaries are the difference: a Mac installs `@esbuild/darwin-arm64` and
// Linux installs `@esbuild/linux-x64`, so a file generated from the installed tree comes out
// different on every operating system and the "is this up to date" check in CI fails for a
// reason that has nothing to do with the change. Each of those binaries carries its parent
// package's licence, which the lock file records for it directly.
const npmTrees = [
  ['the viewer and its build', '.', true],
  ['the build and test tooling (not shipped)', '.', false],
  ['the Node MCP server', 'mcp', true],
  ['the cloud agent relay (web build only)', 'functions', true],
];
/** A package's licence, from the lock file, falling back to its own package.json for the rare
 *  old package that declares one only in the `licenses` array form. */
function licenceOf(dir, name, entry) {
  const direct = Array.isArray(entry.license) ? entry.license.join(' OR ') : entry.license;
  if (direct) return String(direct);
  try {
    const pj = JSON.parse(readFileSync(`${dir}/node_modules/${name}/package.json`, 'utf8'));
    if (typeof pj.license === 'string') return pj.license;
    if (pj.license?.type) return String(pj.license.type);
    if (Array.isArray(pj.licenses)) return pj.licenses.map(l => l.type ?? l).join(' OR ');
  } catch {}
  return 'UNKNOWN';
}
const npm = [];
for (const [label, cwd, productionOnly] of npmTrees) {
  const lockPath = `${cwd}/package-lock.json`;
  if (!existsSync(lockPath)) continue;
  let lock; try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { continue; }
  const rows = [];
  const seen = new Set();
  for (const [path, v] of Object.entries(lock.packages ?? {})) {
    if (!path || v.link) continue;                 // the project itself, and workspace links
    if (productionOnly && v.dev) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    // one row per package and version: the same version nested under two dependents is one
    // package to license, however many copies npm chose to write to disk
    const key = `${name}@${v.version ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, name, lic: licenceOf(cwd, name, v) });
  }
  // sorted by name and version together, so two versions of the same package keep their order
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const counts = new Map();
  for (const r of rows) {
    if (!counts.has(r.lic)) counts.set(r.lic, []);
    counts.get(r.lic).push(r.name);
  }
  npm.push({ label, counts });
}

// ---------------------------------------------------------------- cargo
const cargoTrees = [
  ['crates/e57-wasm , the decoder, octree and analysis, compiled to WebAssembly', 'crates/e57-wasm'],
  ['desktop , the Tauri shell, the agent bridge and the Rust MCP server', 'desktop'],
];
/** The crate tables already in THIRD_PARTY.md, so a machine without cargo-license regenerates
 *  the npm half without silently deleting the Rust half , which would then fail the "is this
 *  file up to date" check in CI for a reason that has nothing to do with the change. */
function previousCargoTables() {
  if (!existsSync('THIRD_PARTY.md')) return new Map();
  const md = readFileSync('THIRD_PARTY.md', 'utf8');
  const out = new Map();
  for (const m of md.matchAll(/^## Cargo , (.+)\n\n\| Licence \| Packages \| Names \|\n\|---\|---:\|---\|\n((?:\|.*\n)+)/gm)) {
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
// Whenever fresh crate data cannot be had , no cargo, no cargo-license, a network-less
// runner , reuse what is already in the file rather than deleting those tables. Dropping them
// would fail CI's "is this file up to date" check for a reason that has nothing to do with
// the change being reviewed, which is the worst kind of red build.
let kept = null;
const previous = () => (kept ??= previousCargoTables());
for (const [label, cwd] of cargoTrees) {
  const raw = CARGO ? sh(CARGO, ['license'], cwd) : '';
  if (!raw) {
    const old = previous().get(label);
    if (old?.size) {
      console.error(`no fresh crate data for ${cwd} , keeping the table already in THIRD_PARTY.md`);
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
This file is generated by \`node tools/third-party.mjs\` from the lock files in the tree, so it
is what the project resolves to rather than what somebody remembered to write down. It lists
every package in the lock file, including npm's per-platform optional binaries for operating
systems this machine is not, so the same file comes out wherever it is generated. The
generator stops with an error if it meets a licence that is not on its compatible list, which
makes an awkward new dependency a build failure instead of a discovery years later.

A note on the one that matters. **Apache-2.0 is compatible with GPLv3 in one direction only.**
GPLv3 code may incorporate Apache-2.0 code; the reverse is not true. Since this project is
GPLv3, the direction is the right one. (It would *not* be compatible with GPLv2, which is why
the licence here is GPL-3.0-**only**.)

MPL-2.0 dependencies are compatible through MPL's own secondary-licence clause. Dual-licensed
packages such as \`Apache-2.0 OR MIT\` are used under whichever option suits.

`;
for (const { label, counts } of npm) {
  md += `## npm , ${label}\n\n${table(counts, 'npm')}\n`;
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
    md += `## Cargo , ${label}\n\n${t}\n`;
    continue;
  }
  md += `## Cargo , ${label}\n\n${table(counts, 'cargo')}\n`;
}
md += `## Algorithms

Two filters in this project are reimplementations of published algorithms rather than original
work, and the code says so at the top of each function.

| What | Whose | Where ours lives | Licence of the original |
|---|---|---|---|
| Statistical outlier removal (SOR) | \`CCCoreLib::CloudSamplingTools::sorFilter\` and \`applySORFilterAtLevel\`, from [CloudCompare](https://github.com/CloudCompare/CCCoreLib), commit \`dc8c7d80\` | \`Analyzer::sor\` in \`crates/e57-wasm/src/analysis.rs\` | LGPL-2.0-or-later |
| Noise filter | \`CCCoreLib::CloudSamplingTools::noiseFilter\` and \`applyNoiseFilterAtLevel\`, same repository and commit | \`Analyzer::noise_filter\`, same file | LGPL-2.0-or-later |

**No CloudCompare code is copied into this repository.** Both are written in Rust from the
published algorithm, with the intent that the same settings remove the same points, so somebody
moving between the two tools is not surprised. \`crates/e57-wasm/src/bin/anatest.rs\` contains a
brute-force transcription of both algorithms as a test oracle and asserts that our filters agree
with it point for point.

LGPL-2.0-or-later can be combined with GPL-3.0-only: the "or later" lets a recipient take
LGPL-3.0, and LGPL-3.0 is compatible with GPL-3.0. Since nothing is copied, this is a courtesy
note about lineage rather than a licence obligation.

## Things that are not dependencies but are worth naming

| What | Where | Licence |
|---|---|---|
| **IBM Plex Sans / Mono** | Google Fonts, web build only. The desktop build uses the system font stack and loads nothing. | SIL Open Font License 1.1 |
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
