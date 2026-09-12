// SPDX-License-Identifier: GPL-3.0-only
// Take the screenshot at the top of the README.
//
//   E57VIEW_TEST_FILE=/path/to/scan.e57 node tools/hero.mjs
//
// Deliberately an oblique overview rather than anything recognisable: the picture is there to
// show what tens of millions of points look like under eye-dome lighting, not to publish
// somebody's building.
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { requireTestFile } from '../shared/testfile.mjs';

const FILE = requireTestFile('a large scan to photograph');
if (!FILE) process.exit(0);
mkdirSync('docs', { recursive: true });

const br = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await br.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })).newPage();
await p.goto(process.env.URL || 'http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
await p.evaluate(() => { document.getElementById('k-load').value = '2'; });
await p.setInputFiles('#file-input', FILE);
await p.waitForFunction(() => /(loaded|from cache) in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 600000 });
await p.waitForTimeout(2500);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 3000 }); } catch {} 

// An oblique three-quarter view of the whole site: wide enough that nothing in it is
// identifiable, close enough that the point density is the subject. Station markers off —
// they are a real feature but they cover the middle of the picture.
await p.evaluate(() => {
  const v = window.__viewer;
  v.setStationsVisible(false);
  const el = document.getElementById('k-stations');
  if (el) el.checked = false;
  v.fit();
  const TH = v.camera.position.constructor;
  const b = v.visibleBounds();
  const c = b.getCenter(new TH());
  const s = b.getSize(new TH());
  const d = Math.max(s.x, s.y, s.z);
  v.setView({ p: [c.x + d * 0.40, c.y - d * 0.52, c.z + d * 0.34], t: [c.x, c.y, c.z - d * 0.04] });
  v.knobs.edl = true; v.knobs.edlStrength = 0.45; v.knobs.budget = 24e6; v.knobs.density = 2.6;
  v.knobs.bright = 1.12;
  v.setKnobs(v.knobs);
  v.touch();
});
// show a panel that says what the thing does, rather than the first group that happens to be open
await p.evaluate(() => {
  document.querySelectorAll('#panel .grp').forEach(g => g.classList.add('closed'));
  for (const n of ['layers', 'analysis', 'fit', 'mesh']) {
    document.querySelector(`[data-grp="${n}"]`)?.classList.remove('closed');
  }
  document.getElementById('panel').scrollTop = 0;
});
await p.waitForTimeout(4500);
// the panel and the top bar stay: the README should show the actual application
await p.screenshot({ path: 'docs/hero.png' });
// 3200px of PNG is two megabytes in a README; 2000px of JPEG is a fifteenth of that and
// indistinguishable on a point cloud
spawnSync('sips', ['-Z', '2000', 'docs/hero.png', '--out', 'docs/hero.png'], { stdio: 'ignore' });
spawnSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', 'docs/hero.png', '--out', 'docs/hero.jpg'], { stdio: 'ignore' });
rmSync('docs/hero.png', { force: true });
console.log('docs/hero.jpg ·', await p.textContent('#tb-points'));
await br.close();
