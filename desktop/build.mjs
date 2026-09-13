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
import { existsSync, readdirSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
// ---------------------------------------------------------------- macOS signing
//
// Why this exists: the linker gives every Mach-O an automatic ad-hoc signature, but that
// covers the binary alone. Info.plist is not bound to it and the bundle has no sealed
// resources, and a bundle in that state fails Gatekeeper's seal check. macOS then says the
// app "is damaged and can't be opened" and offers the Bin, instead of the unidentified
// developer dialog that has an Open Anyway in it. Signing the bundle ad-hoc fixes the seal;
// it does not make the app trusted, and it is not meant to. That is notarisation, which needs
// a paid Apple account.
//
// Tauri's bundler signs when it is given a real identity. 2.11 does nothing for the ad-hoc
// identity "-", with `signingIdentity` in the config or `APPLE_SIGNING_IDENTITY` in the
// environment, so it is done here. The bundler also rebuilds the .app while making the DMG,
// so signing the bundle first is not enough on its own: the image has to be reopened and the
// copy inside it signed as well. That is a convert to read-write, a mount, a signature and a
// convert back, which keeps the bundler's own window layout and Applications symlink.
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
function adhocSign(app) {
  const sign = run('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app]);
  if (!sign.ok) { console.error(`\ncodesign failed on ${app}:\n${sign.out}`); process.exit(1); }
  const check = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const show = run('codesign', ['-dv', '--verbose=2', app]).out;
  const sealed = /Sealed Resources version/.test(show) && /Info\.plist entries/.test(show);
  if (!check.ok || !sealed) {
    console.error(`\n${app} is not properly signed after codesign:\n${check.out}\n${show}`);
    process.exit(1);
  }
}
/** Sign the copy of the app that is inside a disk image, in place. */
function signInsideDmg(dmg) {
  const work = mkdtempSync(join(tmpdir(), 'e57view-dmg-'));
  const rw = join(work, 'rw.dmg');
  const mnt = join(work, 'mnt');
  const out = join(work, 'signed.dmg');
  try {
    const mb = Math.max(64, Math.ceil(statSync(dmg).size / 1e6) * 4);
    for (const step of [
      ['hdiutil', ['convert', dmg, '-format', 'UDRW', '-o', rw]],
      ['hdiutil', ['resize', '-size', `${mb}m`, rw]],
      ['hdiutil', ['attach', rw, '-nobrowse', '-noverify', '-mountpoint', mnt]],
    ]) {
      const r = run(step[0], step[1]);
      if (!r.ok) { console.error(`\n${step[1][0]} failed for ${dmg}:\n${r.out}`); process.exit(1); }
    }
    try {
      for (const f of readdirSync(mnt)) if (f.endsWith('.app')) adhocSign(join(mnt, f));
    } finally {
      run('hdiutil', ['detach', mnt]);
    }
    const back = run('hdiutil', ['convert', rw, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', out]);
    if (!back.ok) { console.error(`\nrebuilding ${dmg} failed:\n${back.out}`); process.exit(1); }
    const move = run('cp', [out, dmg]);
    if (!move.ok) { console.error(`\ncould not replace ${dmg}:\n${move.out}`); process.exit(1); }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
if (process.platform === 'darwin' && !process.env.APPLE_SIGNING_IDENTITY) {
  for (const f of found) {
    if (f.path.endsWith('.app')) adhocSign(f.path);
    else if (f.path.endsWith('.dmg')) signInsideDmg(f.path);
  }
  // the sizes above were taken before signing
  for (const f of found) {
    if (f.path.endsWith('.dmg')) f.mb = (statSync(f.path).size / 1e6).toFixed(1);
  }
  console.log('\nSigned ad-hoc: the bundle seal is valid, the app is not notarised.');
}

console.log('\nBundled:');
for (const f of found) console.log(`  ${f.path}  ${f.mb} MB`);
if (r.status) {
  console.log('\n(tauri exited non-zero — on macOS that is `hdiutil internet-enable`, removed in 10.15,');
  console.log(' which create-dmg still calls after writing the image. The artefacts above are complete.)');
}
