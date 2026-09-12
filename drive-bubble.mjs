// SPDX-License-Identifier: GPL-3.0-only
// Panorama alignment: photo-only vs points-only from the same station must show the same scene.
import { chromium } from 'playwright';
import { requireTestFile } from './shared/testfile.mjs';
const FILE = requireTestFile();
if (!FILE) process.exit(0);
const b = await chromium.launch({ channel: 'chrome', headless: false });
const p = await b.newPage({ viewport: { width: 1500, height: 940 } });
p.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 300)));
await p.goto(process.env.URL || 'http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
await p.evaluate(() => { document.getElementById('k-load').value = '4'; });
await p.setInputFiles('#file-input', FILE);
await p.waitForFunction(() => /(loaded|from cache) in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 300000 });
await p.waitForTimeout(1200);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 3000 }); } catch {}
// enter a bubble programmatically: pick station nearest the site centre
const idx = await p.evaluate(() => { const v = window.__viewer; const c = v.bounds().getCenter(v.camera.position.clone()); let best = 0, bd = 1e9; v['stationSprites'].forEach((s, i) => { const d = s.position.distanceTo(c); if (d < bd) { bd = d; best = i; } }); return best; });
await p.evaluate(i => window.__viewer.onStationClick(i), idx);
await p.waitForFunction(() => !!window.__viewer.bubble, null, { timeout: 60000 });
await p.waitForTimeout(800);
console.log('in bubble at station', idx, '| pill:', await p.textContent('#tb-tool'));
// look horizontally along +X so the comparison is easy to read
await p.evaluate(() => { const v = window.__viewer; const cam = v.camera; v.controls.target.copy(cam.position).add(new cam.position.constructor(0.02, 0, 0)); v.controls.update(); v.touch(); });
await p.waitForTimeout(400);
const shot = async (alpha, name) => { await p.evaluate(a => { const s = document.getElementById('k-blend'); s.value = String(a); s.dispatchEvent(new Event('input')); }, alpha); await p.waitForTimeout(500); await p.screenshot({ path: `shots/${name}.png` }); };
await shot(0, 'b-photo');
await shot(1, 'b-points');
await shot(0.5, 'b-blend');
// walk off the station: the photo must fade and let go
await p.evaluate(() => { const v = window.__viewer; v.camera.position.x += 3; v.controls.target.x += 3; v.controls.update(); v.touch(); });
await p.waitForTimeout(600);
console.log('bubble after walking 3 m away:', await p.evaluate(() => !!window.__viewer.bubble), '| pill hidden:', await p.evaluate(() => document.getElementById('tb-tool').classList.contains('hidden')));
await b.close();
