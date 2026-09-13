// SPDX-License-Identifier: GPL-3.0-only
// Cut a release.
//
//   npm run release -- 0.1.0
//
// One version number lives in five files, and a release where they disagree is a support
// thread six months later about which build somebody actually has. This sets all five, checks
// they agree, moves the CHANGELOG's Unreleased section under a dated heading, commits, and
// makes the annotated tag.
//
// It does not push. Pushing a tag starts a release build that publishes binaries with your
// name on them, and that should be a thing you type on purpose. The command is printed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const version = (process.argv[2] || '').replace(/^v/, '');
const dry = process.argv.includes('--dry-run');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: npm run release -- 1.2.3   (semver, optionally with a -pre suffix)');
  process.exit(1);
}
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

// ---------------------------------------------------------------- the tree has to be clean
if (git('status', '--porcelain')) {
  console.error('The working tree has changes. Commit or stash them first:\n');
  console.error(git('status', '--short'));
  process.exit(1);
}
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') console.error(`Note: you are on "${branch}", not main.`);
const tag = `v${version}`;
if (git('tag', '--list', tag)) {
  console.error(`${tag} already exists. Delete it first, or pick another version.`);
  process.exit(1);
}

// ---------------------------------------------------------------- set the version everywhere
const edits = [];
/** package.json and friends: only the ones that already carry a version. */
function bumpJson(path) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  const d = JSON.parse(raw);
  if (d.version === undefined) return;
  if (d.version === version) return;
  d.version = version;
  writeFileSync(path, JSON.stringify(d, null, 2) + '\n');
  edits.push(path);
}
/** A lock file records its own package's version in two places. */
function bumpLock(path) {
  if (!existsSync(path)) return;
  const before = readFileSync(path, 'utf8');
  const d = JSON.parse(before);
  if (d.version === undefined && !d.packages?.['']?.version) return;
  if (d.version !== undefined) d.version = version;
  if (d.packages?.['']?.version !== undefined) d.packages[''].version = version;
  const after = JSON.stringify(d, null, 2) + '\n';
  if (after === before) return;
  writeFileSync(path, after);
  edits.push(path);
}
/** The first `version = "…"` under [package], and nothing else in the file. */
function bumpCargo(path) {
  if (!existsSync(path)) return;
  const s = readFileSync(path, 'utf8');
  const re = /(\[package\][\s\S]*?\nversion = ")[^"]*(")/;
  // "no change" is not "not found": the first release of 0.1.0 bumps 0.1.0 to 0.1.0, and that
  // has to be allowed or you can never cut the version the tree already says.
  if (!re.test(s)) { console.error(`could not find a [package] version in ${path}`); process.exit(1); }
  const out = s.replace(re, `$1${version}$2`);
  if (out !== s) { writeFileSync(path, out); edits.push(path); }
}

bumpJson('package.json'); bumpLock('package-lock.json');
bumpJson('mcp/package.json'); bumpLock('mcp/package-lock.json');
bumpCargo('desktop/Cargo.toml');
bumpCargo('crates/e57-wasm/Cargo.toml');
{
  const p = 'desktop/tauri.conf.json';
  const before = readFileSync(p, 'utf8');
  const d = JSON.parse(before);
  d.version = version;
  const after = JSON.stringify(d, null, 2) + '\n';
  if (after !== before) { writeFileSync(p, after); edits.push(p); }
}
// Cargo.lock records the workspace crate's own version, and cargo rewrites it on any command
// that reads the manifest. Doing it here keeps the commit self-consistent.
for (const dir of ['desktop', 'crates/e57-wasm']) {
  const r = spawnSync('cargo', ['metadata', '--format-version', '1', '--manifest-path', `${dir}/Cargo.toml`],
    { stdio: 'ignore', env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` } });
  if (r.status === 0 && existsSync(`${dir}/Cargo.lock`)) edits.push(`${dir}/Cargo.lock`);
  else if (r.status !== 0) console.error(`Note: cargo did not run, so ${dir}/Cargo.lock may still say the old version.`);
}

// ---------------------------------------------------------------- they must all agree
const found = {
  'package.json': JSON.parse(readFileSync('package.json', 'utf8')).version,
  'mcp/package.json': JSON.parse(readFileSync('mcp/package.json', 'utf8')).version,
  'desktop/tauri.conf.json': JSON.parse(readFileSync('desktop/tauri.conf.json', 'utf8')).version,
  'desktop/Cargo.toml': /\[package\][\s\S]*?\nversion = "([^"]+)"/.exec(readFileSync('desktop/Cargo.toml', 'utf8'))?.[1],
  'crates/e57-wasm/Cargo.toml': /\[package\][\s\S]*?\nversion = "([^"]+)"/.exec(readFileSync('crates/e57-wasm/Cargo.toml', 'utf8'))?.[1],
};
const wrong = Object.entries(found).filter(([, v]) => v !== version);
if (wrong.length) {
  console.error('These files do not say ' + version + ':');
  for (const [f, v] of wrong) console.error(`  ${f}: ${v}`);
  process.exit(1);
}

// ---------------------------------------------------------------- the changelog
const CL = 'CHANGELOG.md';
const cl = readFileSync(CL, 'utf8');
const today = new Date().toISOString().slice(0, 10);
const head = /^## Unreleased\s*$/m.exec(cl);
if (!head) { console.error(`${CL} has no "## Unreleased" heading to move.`); process.exit(1); }
const bodyStart = head.index + head[0].length;
const next = /^## /m.exec(cl.slice(bodyStart));
const body = cl.slice(bodyStart, next ? bodyStart + next.index : cl.length).trim();
if (!body) { console.error(`${CL}'s Unreleased section is empty. There is nothing to release.`); process.exit(1); }
const newCl = cl.slice(0, head.index)
  + `## Unreleased\n\n_Nothing yet._\n\n## ${version} — ${today}\n\n${body}\n\n`
  + cl.slice(next ? bodyStart + next.index : cl.length);
writeFileSync(CL, newCl);
edits.push(CL);

// ---------------------------------------------------------------- commit and tag
const summary = `Release ${tag}\n\n${body.split('\n').slice(0, 400).join('\n')}\n`;
writeFileSync('.git/RELEASE_MSG', summary);
if (dry) {
  console.log(`Dry run. Would commit ${edits.length} files and tag ${tag}:`);
  for (const f of [...new Set(edits)]) console.log('  ' + f);
  console.log('\nRun without --dry-run to do it. Revert with: git checkout -- .');
  process.exit(0);
}
if (!edits.length) { console.error('Nothing to commit, which should not happen: the changelog is always edited.'); process.exit(1); }
execFileSync('git', ['add', ...new Set(edits)], { stdio: 'inherit' });
execFileSync('git', ['commit', '-m', `Release ${tag}`], { stdio: 'inherit' });
execFileSync('git', ['tag', '-a', tag, '-F', '.git/RELEASE_MSG'], { stdio: 'inherit' });

console.log(`
Committed and tagged ${tag}. Nothing has been pushed.

Push when you are ready:

    git push origin main ${tag}

That starts .github/workflows/release.yml, which builds the three desktop installers,
writes SHA256SUMS.txt and publishes a GitHub Release with the ${version} section of
CHANGELOG.md as its notes.

Actions has to be able to run: the repository must be public, or Actions billing enabled
on a private one. The first release is unsigned, so macOS and Windows will warn on first
open. The release notes say so.

To undo before pushing:

    git tag -d ${tag} && git reset --hard HEAD~1
`);
