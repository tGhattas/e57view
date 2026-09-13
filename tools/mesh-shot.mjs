// SPDX-License-Identifier: GPL-3.0-only
// The Mesh group with a mesh actually present, so the controls that only appear then are in
// the picture. Builds one from a small synthetic cloud rather than faking the `has-mesh` class.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
const out = process.argv[2] || 'docs/ui/mesh-after.png';
mkdirSync('docs/ui', { recursive: true });

// a dome, dense enough to reconstruct at a few centimetres
const rows = [];
for (let i = 0; i < 60000; i++) {
  const y = (i / 59999) * 0.95, rad = Math.sqrt(Math.max(0, 1 - y * y));
  const th = Math.PI * (3 - Math.sqrt(5)) * i;
  const n = [Math.cos(th) * rad, y, Math.sin(th) * rad];
  rows.push(`${(10 + n[0]).toFixed(4)} ${(10 + n[1]).toFixed(4)} ${(10 + n[2]).toFixed(4)} ${n[0].toFixed(3)} ${n[1].toFixed(3)} ${n[2].toFixed(3)} 200 190 170`);
}
const ply = join(tmpdir(), 'e57view-meshshot.ply');
writeFileSync(ply, ['ply', 'format ascii 1.0', `element vertex ${rows.length}`,
  'property float x', 'property float y', 'property float z',
  'property float nx', 'property float ny', 'property float nz',
  'property uchar red', 'property uchar green', 'property uchar blue', 'end_header', ...rows].join('\n'));

const br = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await br.newContext({ viewport: { width: 1280, height: 1600 }, deviceScaleFactor: 2 })).newPage();
p.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 180)));
await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(() => localStorage.clear());
await p.setInputFiles('#file-input', ply);
await p.waitForFunction(n => window.__viewer.loaded === n, rows.length, { timeout: 120000 });
await p.waitForTimeout(900);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
await p.evaluate(() => window.__app.buildMesh({ voxel: 4, smooth: 2, trunc: 2, confirm: false }));
await p.waitForTimeout(1200);
await p.evaluate(() => {
  document.querySelectorAll('#panel .grp').forEach(g => g.classList.add('closed'));
  const g = document.querySelector('[data-grp="mesh"]');
  g.classList.remove('closed');
  g.scrollIntoView({ block: 'start' });
});
await p.waitForTimeout(600);
const el = await p.$('[data-grp="mesh"]');
await el.screenshot({ path: out });
const b = await el.boundingBox();
console.log(`${out} · ${Math.round(b.width)} x ${Math.round(b.height)} · ${await p.textContent('#v-mesh')}`);
await br.close();
