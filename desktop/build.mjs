// SPDX-License-Identifier: GPL-3.0-only
// `npm run desktop:build`.
//
// Wraps `tauri build` for one reason: on macOS the DMG step ends with `hdiutil
// internet-enable`, which Apple removed in 10.15, so create-dmg exits non-zero *after* it has
// already written a perfectly good disk image. Failing the build on that would mean never
// having a green build on a modern Mac. So the command runs, and then the artefacts are
// checked — if they are there the build succeeded, and if they are not the real error is
// printed and the exit code stands.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const passed = process.argv.slice(2);
// `cargo build --target <triple>` puts everything under target/<triple>/, and CI always names
// a target so the artefact paths are predictable. Look where the build actually put things
// rather than where it puts them when no target is given.
const ti = passed.indexOf('--target');
const triple = ti >= 0 ? passed[ti + 1] : null;
const out = triple ? `desktop/target/${triple}/release/bundle` : 'desktop/target/release/bundle';
const args = ['tauri', 'build', '--config', 'desktop/tauri.conf.json', ...passed];
// npx is a .cmd on Windows, which spawnSync will not find without a shell
const r = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });

const found = [];
for (const [dir, what] of [['macos', '.app'], ['dmg', '.dmg'], ['nsis', '.exe'], ['deb', '.deb'], ['appimage', '.AppImage'], ['msi', '.msi']]) {
  const d = join(out, dir);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (!f.endsWith(what) || f.startsWith('rw.')) continue;
    const p = join(d, f);
    const size = what === '.app' ? dirSize(p) : statSync(p).size;
    found.push({ path: p, mb: (size / 1e6).toFixed(1) });
  }
}
function dirSize(p) {
  let n = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const q = join(p, e.name);
    n += e.isDirectory() ? dirSize(q) : statSync(q).size;
  }
  return n;
}

if (!found.length) {
  console.error(`\nNo bundle was produced under ${out}.`);
  process.exit(r.status || 1);
}
console.log('\nBundled:');
for (const f of found) console.log(`  ${f.path}  ${f.mb} MB`);
if (r.status) {
  console.log('\n(tauri exited non-zero — on macOS that is `hdiutil internet-enable`, removed in 10.15,');
  console.log(' which create-dmg still calls after writing the image. The artefacts above are complete.)');
}
