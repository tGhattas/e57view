// SPDX-License-Identifier: GPL-3.0-only
// Surface reconstruction on the real NavVis scan, at a few levels of detail.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { requireTestFile } from './shared/testfile.mjs';
const FILE = requireTestFile();
if (!FILE) process.exit(0);
const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
mkdirSync('shots', { recursive: true });
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await b.newContext({ viewport: { width: 1500, height: 940 } })).newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async (st) => { localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache','e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } document.getElementById('k-load').value = st; }, process.env.STRIDE || '4');
await p.setInputFiles('#file-input', FILE);
await p.waitForFunction(() => /loaded in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 900000 });
await p.waitForTimeout(1200);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 4000 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('LOAD:', await p.textContent('#tb-points'));
console.log('point spacing default:', await p.textContent('#v-mvox'));
for (const vox of (process.env.VOX || '10,5,3').split(',').map(Number)) {
  const t0 = Date.now();
  const st = await p.evaluate(v => window.__app.buildMesh({ voxel: v, smooth: 2, trunc: 2, confirm: false }), vox);
  const heap = await p.evaluate(() => (performance).memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(0) : -1);
  console.log(`VOXEL ${vox} cm → ${st.triangles.toLocaleString()} tris, ${st.vertices.toLocaleString()} verts · ${((Date.now()-t0)/1000).toFixed(1)}s · oriented ${(st.oriented/1e6).toFixed(1)}M · heap ${heap} MB`);
  await p.evaluate(() => document.getElementById('k-dispmesh').click());
  await p.waitForTimeout(900);
  await p.screenshot({ path: `shots/mesh-real-${vox}cm.png` });
  const fps = await p.evaluate(() => { const v = window.__viewer; let n = 0; const t = performance.now(); while (performance.now() - t < 700) { v.dirty = true; v.render(); n++; } return Math.round(n / 0.7); });
  console.log(`  draw ${fps} fps at ${vox} cm`);
}
await p.evaluate(() => document.getElementById('k-dispboth').click());
await p.waitForTimeout(800); await p.screenshot({ path: 'shots/mesh-real-both.png' });
console.log('points still in memory:', (await p.evaluate(() => window.__viewer.loaded)).toLocaleString());
await b.close();
