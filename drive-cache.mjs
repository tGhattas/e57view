// SPDX-License-Identifier: GPL-3.0-only
import { chromium } from 'playwright';
import { requireTestFile } from './shared/testfile.mjs';
const FILE = requireTestFile();
if (!FILE) process.exit(0);
const b = await chromium.launch({ channel: 'chrome', headless: false });
const p = await b.newPage({ viewport: { width: 1500, height: 940 } });
p.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 240)); });
await p.goto(process.env.URL || 'http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
await p.evaluate(async () => { const root = await navigator.storage.getDirectory(); try { await root.removeEntry('e57view-cache', { recursive: true }); } catch {} localStorage.clear(); });
const state = () => p.evaluate(() => ({
  busy: document.getElementById('busy').classList.contains('hidden') ? '' : document.getElementById('busy-text').textContent,
  err: document.getElementById('err').classList.contains('hidden') ? '' : document.getElementById('err').textContent,
  cache: document.getElementById('v-cache').textContent, tb: document.getElementById('tb-points').textContent }));
const loaded = () => p.waitForFunction(() => /(loaded|from cache) in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 300000 });

await p.evaluate(st => { document.getElementById('k-load').value = st; }, process.env.STRIDE || '10');
await p.setInputFiles('#file-input', FILE);
await loaded();
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('loaded:', (await state()).tb);
await p.waitForSelector('#modal:not(.hidden)', { timeout: 15000 });
await p.click('#modal-btns button:has-text("Cache it")');
for (let i = 0; i < 120; i++) {
  await p.waitForTimeout(500);
  const s = await state();
  if (i % 4 === 0) console.log(`  t+${i / 2}s busy="${s.busy}" err="${s.err}" cache="${s.cache}"`);
  if (!s.busy) { console.log(`  finished: err="${s.err}" cache="${s.cache}"`); break; }
}
// reload: reset the topbar text so we really wait for the new load
await p.evaluate(() => { document.getElementById('tb-points').textContent = '…'; });
const t0 = Date.now();
await p.click('#k-reload');
await loaded();
console.log(`RELOAD: ${(await state()).tb}  wall ${((Date.now() - t0) / 1000).toFixed(2)}s  err="${(await state()).err}"`);
await p.waitForTimeout(800);
console.log('cached list on entry (via worker):', await p.evaluate(async () => { const r = await new Promise(res => { const w = window.__app; res('n/a'); }); return r; }));
// station click
const hit = await p.evaluate(() => { const v = window.__viewer, cam = v.camera; let best = null; v.stations.forEach((s, i) => { const pr = v['stationSprites'][i].position.clone().project(cam); if (pr.z > 1) return; const x = (pr.x + 1) / 2 * innerWidth, y = (1 - pr.y) / 2 * innerHeight; const d = Math.hypot(x - innerWidth * 0.4, y - innerHeight * 0.5); if (!best || d < best.d) best = { i, x, y, d }; }); return best; });
console.log('tool:', await p.evaluate(() => window.__viewer.tool), '| clicking station', hit.i, 'at', hit.x.toFixed(0), hit.y.toFixed(0));
await p.mouse.click(hit.x, hit.y);
for (let i = 0; i < 40; i++) {
  await p.waitForTimeout(500);
  const s = await state(); const inB = await p.evaluate(() => !!window.__viewer.bubble);
  if (inB) { console.log(`  in bubble after ${i / 2}s`); break; }
  if (i % 4 === 0) console.log(`  t+${i / 2}s busy="${s.busy}" err="${s.err}"`);
}
await p.waitForTimeout(600);
await p.screenshot({ path: 'shots/f-bubble.png' });
await p.evaluate(() => { const s = document.getElementById('k-blend'); s.value = '0.5'; s.dispatchEvent(new Event('input')); }); await p.waitForTimeout(400);
await p.screenshot({ path: 'shots/f-bubble-blend.png' });
await b.close();
