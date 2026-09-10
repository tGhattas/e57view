// Round-four features: rotate gizmo, slab + sections, AI heuristic clean, PLY import, agent bridge.
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { writeFileSync, statSync } from 'node:fs';

const E57 = '/Users/tamer/Downloads/1973-registered.e57';
const PLY = '/private/tmp/claude-501/-Users-tamer-Developer-playground/d6f1a1ba-ecc2-4157-a520-9812531d0480/scratchpad/exports/1973-registered-crop.ply';
const URL = process.env.URL || 'http://127.0.0.1:5180/';

// a stand-in for the MCP bridge: same wire protocol as mcp/server.mjs
let app = null; let nextId = 1; const pending = new Map(); const chunks = new Map();
const wss = new WebSocketServer({ host: '127.0.0.1', port: 7337 });
wss.on('connection', ws => { app = ws; ws.on('message', (d, bin) => {
  if (bin) { const b = Buffer.from(d); const id = b.readUInt32LE(0); (chunks.get(id) ?? chunks.set(id, []).get(id)).push(b.subarray(8)); return; }
  const m = JSON.parse(d.toString()); if (m.hello) { console.log('  [bridge] viewer connected'); return; }
  const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); }); });
const call = (cmd, args = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); app.send(JSON.stringify({ id, cmd, args })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + cmd)); } }, 600000); });

const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1500, height: 940 } });
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error' && !/favicon|firestore|Firebase/i.test(m.text())) console.log('  [err]', m.text().slice(0, 200)); });
await p.goto(URL + '?agent=1', { waitUntil: 'networkidle' });
await p.evaluate(() => { localStorage.clear(); });
const loaded = () => p.waitForFunction(() => /(loaded|from cache|streamed) in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 600000 });
const openAll = () => p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
const dismiss = async () => { try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {} };

// ---------------------------------------------------------------- load (1 in 4 for speed)
await p.evaluate(() => { document.getElementById('k-load').value = '4'; });
await p.setInputFiles('#file-input', E57);
await loaded(); await openAll(); await p.waitForTimeout(1200); await dismiss();
console.log('LOAD:', await p.textContent('#tb-points'));

// ---------------------------------------------------------------- crop: rotate + slab
await p.evaluate(() => { const v = window.__viewer; const w = v.pickWorld(640, 520) || v.bounds().getCenter(v.camera.position.clone()); v.controls.target.copy(w); v.controls.update(); });
await p.click('#k-cropcentre'); await p.click('#k-croprotate'); await p.waitForTimeout(400);
const quatBefore = await p.evaluate(() => window.__app.regions.find(r => r.id === 'crop').quat.map(v => +v.toFixed(3)));
const centre = await p.evaluate(() => { const v = window.__viewer; const c = v.regions.find(r => r.id === 'crop').center; const pr = new (v.camera.position.constructor)(...c).project(v.camera); return { x: (pr.x + 1) / 2 * innerWidth, y: (1 - pr.y) / 2 * innerHeight }; });
let ring = null;
for (let ang = 0; ang < 360 && !ring; ang += 8) for (let r = 30; r <= 160 && !ring; r += 6) {
  const x = centre.x + Math.cos(ang * Math.PI / 180) * r, y = centre.y + Math.sin(ang * Math.PI / 180) * r;
  await p.mouse.move(x, y); await p.waitForTimeout(6);
  const ax = await p.evaluate(() => window.__viewer['tc'].axis); if (ax) ring = { x, y, ax };
}
console.log('ROTATE handle:', ring ? ring.ax : 'none');
if (ring) { await p.mouse.down(); for (let i = 1; i <= 10; i++) { await p.mouse.move(ring.x + i * 8, ring.y + i * 10); await p.waitForTimeout(25); } await p.mouse.up(); await p.waitForTimeout(300); }
const quatAfter = await p.evaluate(() => window.__app.regions.find(r => r.id === 'crop').quat.map(v => +v.toFixed(3)));
console.log('  quat', JSON.stringify(quatBefore), '->', JSON.stringify(quatAfter), quatBefore.join() !== quatAfter.join() ? 'ROTATED' : 'unchanged');
await p.screenshot({ path: 'shots/v3-rotate.png' });
await p.evaluate(() => { const s = document.getElementById('k-cropshape'); s.value = 'slab'; s.dispatchEvent(new Event('change')); }); await p.waitForTimeout(300);
console.log('SLAB readout:', await p.textContent('#v-cropsize'), '|', await p.textContent('#v-crop'));
await p.screenshot({ path: 'shots/v3-slab.png' });
await p.evaluate(() => { const s = document.getElementById('k-cropshape'); s.value = 'box'; s.dispatchEvent(new Event('change')); document.getElementById('k-cropon').checked = false; document.getElementById('k-cropon').dispatchEvent(new Event('change')); });

// ---------------------------------------------------------------- sections: two floors, apply
await p.evaluate(() => { const v = window.__viewer; const b = v.bounds(); const c = b.getCenter(v.camera.position.clone()); window.__app.addSection([c.x, c.y, b.min.z + 1.5]); window.__app.addSection([c.x, c.y, b.min.z + 8]); });
await p.waitForTimeout(400);
console.log('SECTIONS:', await p.textContent('#v-sections'), '|', await p.textContent('#v-crop'));
await p.screenshot({ path: 'shots/v3-sections.png' });
const before = await p.evaluate(() => window.__viewer.loaded);
await p.click('#k-cropapply'); await p.waitForSelector('#modal:not(.hidden)'); await p.click('#modal-btns button.danger');
await p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 120000 }); await p.waitForTimeout(600);
console.log('  applied sections:', before, '->', await p.evaluate(() => window.__viewer.loaded), '|', await p.textContent('#v-loaded'));
await p.screenshot({ path: 'shots/v3-sections-applied.png' });

// ---------------------------------------------------------------- reload, AI heuristic
await p.evaluate(() => { document.getElementById('tb-points').textContent = '…'; }); await p.click('#k-reload'); await loaded(); await openAll(); await p.waitForTimeout(1200); await dismiss();
await p.evaluate(() => { const s = document.getElementById('k-aiprov'); s.value = 'heuristic'; s.dispatchEvent(new Event('change')); });
const tA = Date.now();
await p.click('#k-aianalyse');
await p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 120000 }); await p.waitForTimeout(500);
console.log(`AI heuristic (${((Date.now() - tA) / 1000).toFixed(1)}s):`, await p.textContent('#v-ai'));
const sug = await p.evaluate(() => window.__app.suggestions.map(s => ({ label: s.label, half: s.half.map(v => +v.toFixed(1)), c: s.center.map(v => +v.toFixed(1)) })));
console.log('  first suggestions:', JSON.stringify(sug.slice(0, 3)));
await p.screenshot({ path: 'shots/v3-ai-pending.png' });
// accept one via its ✓ label, decline one, approve the rest, apply
const decided = await p.evaluate(() => { const ls = document.querySelectorAll('#labels .slabel'); if (ls.length < 2) return 0; ls[0].querySelector('.y').click(); ls[1].querySelector('.n').click(); return 2; });
console.log('  label buttons used:', decided, '| roles now:', await p.evaluate(() => window.__app.suggestions.map(s => s.role[0]).join('')));
await p.waitForTimeout(300);
await p.click('#k-aiacceptall'); await p.waitForTimeout(300);
await p.screenshot({ path: 'shots/v3-ai-approved.png' });
const beforeAi = await p.evaluate(() => window.__viewer.loaded);
await p.click('#k-aiapply'); await p.waitForSelector('#modal:not(.hidden)'); await p.click('#modal-btns button.danger');
await p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 120000 }); await p.waitForTimeout(500);
console.log('  applied AI clean:', beforeAi, '->', await p.evaluate(() => window.__viewer.loaded), '|', await p.textContent('#v-loaded'));
await p.screenshot({ path: 'shots/v3-ai-applied.png' });

// ---------------------------------------------------------------- agent bridge
console.log('AGENT:', await p.textContent('#v-agent'));
const st = await call('state'); console.log('  state:', st.points, 'pts,', st.cells, 'cells, regions', st.regions.length);
const sh = await call('screenshot', { width: 800 }); console.log('  screenshot bytes:', Math.round(sh.png.length * 0.75));
await call('set_view', { preset: 'top' }); await call('set', { colorMode: 3 });
let m;
try { m = await call('measure', { pxA: [750, 470], pxB: [820, 500] }); }
catch { const bb = st.bounds; m = await call('measure', { a: [bb.min[0] + 5, bb.min[1] + 5, bb.min[2]], b: [bb.max[0] - 5, bb.max[1] - 5, bb.min[2]] }); }
console.log('  measure:', m.dist?.toFixed(3), 'm');
const reg = await call('regions', { op: 'add', region: { kind: 'box', role: 'keep', center: st.bounds ? [(st.bounds.min[0] + st.bounds.max[0]) / 2, (st.bounds.min[1] + st.bounds.max[1]) / 2, (st.bounds.min[2] + st.bounds.max[2]) / 2] : [0, 0, 0], half: [10, 10, 10], quat: [0, 0, 0.3826834, 0.9238795], label: 'agent box' } });
console.log('  region added:', reg.id, 'rotated 45°');
await p.screenshot({ path: 'shots/v3-agent.png' });
await call('set', { colorMode: 0 }); await call('set_view', { preset: 'fit' });

// ---------------------------------------------------------------- PLY import (the earlier cropped export, 1 in 4)
if (statSync(PLY).size > 0) {
  await p.evaluate(() => { document.getElementById('k-load').value = '4'; document.getElementById('tb-points').textContent = '…'; });
  const tP = Date.now();
  await p.setInputFiles('#file-input', PLY);
  await loaded(); await p.waitForTimeout(800); await dismiss();
  console.log(`PLY IMPORT (${((Date.now() - tP) / 1000).toFixed(1)}s):`, await p.textContent('#tb-points'), '|', await p.textContent('#ld-fields'), '|', await p.textContent('#ld-sensor'));
  await p.screenshot({ path: 'shots/v3-ply.png' });
}
await b.close(); wss.close();
console.log('DONE');
