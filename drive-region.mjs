// SPDX-License-Identifier: GPL-3.0-only
// Placing a region and making it big enough: the gesture the tool is actually for.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
const PLANE = 120 * 120, BLOB = 40 * 40, TOTAL = PLANE + BLOB;
const ply = join(tmpdir(), 'e57view-region.ply');
{
  const L = ['ply', 'format ascii 1.0', `element vertex ${TOTAL}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  for (let i = 0; i < 120; i++) for (let j = 0; j < 120; j++)      // 6 x 6 m floor
    L.push(`${(10 + i * 0.05).toFixed(4)} ${(10 + j * 0.05).toFixed(4)} 20.0000 190 180 160`);
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++)        // a 2 x 2 m blob, 5 m up
    L.push(`${(40 + i * 0.05).toFixed(4)} ${(40 + j * 0.05).toFixed(4)} 25.0000 90 190 120`);
  writeFileSync(ply, L.join('\n'));
}
mkdirSync('shots', { recursive: true });
const br = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await br.newContext({ viewport: { width: 1200, height: 820 } })).newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 120000 });
const loaded = () => p.evaluate(() => window.__viewer.loaded);
const regions = () => p.evaluate(() => window.__app.sections.map(r => ({ id: r.id, kind: r.kind, role: r.role, center: r.center, half: r.half, radius: r.radius })));
const inside = (id) => p.evaluate(i => { const r = window.__app.regions.find(x => x.id === i); return r ? window.__viewer.cells.insideExact(r) : null; }, id);

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache', 'e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });
await p.setInputFiles('#file-input', ply);
await p.waitForFunction(() => /loaded in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 120000 });
await p.waitForTimeout(900);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('LOAD:', await p.textContent('#tb-points'));

// look straight down on the blob so a click lands on it
const aim = await p.evaluate(async () => {
  const v = window.__viewer, b = v.bounds();
  v.camera.up.set(0, 1, 0);
  v.controls.target.set(b.max.x - 1, b.max.y - 1, b.max.z);
  v.camera.position.set(b.max.x - 1, b.max.y - 1, b.max.z + 10);
  v.controls.update(); v.touch(); v.render();
  await new Promise(r => setTimeout(r, 120));
  v.render();
  const r = v.canvas.getBoundingClientRect();
  const px = [Math.round(r.width / 2), Math.round(r.height / 2)];
  const w = v.pickWorld(px[0], px[1]);
  return { rect: { x: r.x, y: r.y }, px, world: w ? w.toArray() : null, blobZ: b.max.z };
});
console.log('AIM', JSON.stringify(aim));
ok('the centre pixel is on the blob', !!aim.world && Math.abs(aim.world[2] - aim.blobZ) < 0.05, JSON.stringify(aim.world?.map(v => +v.toFixed(3))));

// ---------------------------------------------------------------- place by clicking
await p.evaluate(() => { document.getElementById('k-newshape').value = 'sphere'; });
await p.keyboard.press('s');
ok('S enters placement mode', await p.evaluate(() => window.__viewer.tool === 'place'), await p.evaluate(() => window.__viewer.tool));
ok('the hint bar says what to do', /Click a point to place a sphere/.test(await p.textContent('#place-hint')), await p.textContent('#place-hint'));
ok('the cursor is a crosshair', await p.evaluate(() => document.getElementById('gl').classList.contains('place')), '');
await p.mouse.click(aim.rect.x + aim.px[0], aim.rect.y + aim.px[1]);
await p.waitForTimeout(400);
let rs = await regions();
console.log('PLACED', JSON.stringify(rs));
ok('one click makes a region', rs.length === 1 && rs[0].kind === 'sphere' && rs[0].role === 'keep', JSON.stringify(rs.length));
ok('centred within 2 cm of the picked point',
   Math.hypot(...rs[0].center.map((v, i) => v - aim.world[i])) < 0.02,
   `${Math.hypot(...rs[0].center.map((v, i) => v - aim.world[i])).toFixed(4)} m off`);
const start = await p.evaluate(() => window.__app.startSize());
const span = await p.evaluate(() => { const s = window.__viewer.bounds().getSize(new (window.__viewer.camera.position.constructor)()); return Math.max(s.x, s.y, s.z); });
ok('it starts small', Math.abs(rs[0].radius * 2 - start) < 1e-6 && start < span * 0.1, `${(rs[0].radius * 2).toFixed(3)} m across, cloud is ${span.toFixed(1)} m`);
ok('it is active, with the gizmo in Resize', await p.evaluate(() => window.__viewer.activeRegion !== null && window.__viewer.gizmoMode === 'scale'), await p.evaluate(() => window.__viewer.gizmoMode));
ok('placement mode ended', await p.evaluate(() => window.__viewer.tool === 'none'), '');
ok('nothing was cut', await loaded() === TOTAL, `${await loaded()}`);
await p.screenshot({ path: 'shots/region-placed.png' });

// ---------------------------------------------------------------- grow and shrink
const r0 = (await regions())[0].radius;
await p.click('#k-grow'); await p.waitForTimeout(150);
ok('Grow multiplies by 1.5', Math.abs((await regions())[0].radius / r0 - 1.5) < 1e-6, `${((await regions())[0].radius / r0).toFixed(4)}x`);
await p.click('#k-shrink'); await p.waitForTimeout(150);
ok('Shrink divides by 1.5', Math.abs((await regions())[0].radius - r0) < 1e-9, `${(await regions())[0].radius.toFixed(5)} vs ${r0.toFixed(5)}`);
const beforeWheel = (await regions())[0].radius;
await p.mouse.move(aim.rect.x + aim.px[0], aim.rect.y + aim.px[1]);
await p.keyboard.down('Alt');
await p.mouse.wheel(0, -120);
await p.keyboard.up('Alt');
await p.waitForTimeout(250);
const afterWheel = (await regions())[0].radius;
ok('Alt and the wheel scale the region', afterWheel > beforeWheel * 1.05, `${beforeWheel.toFixed(4)} to ${afterWheel.toFixed(4)} m`);
const camBefore = await p.evaluate(() => window.__viewer.camera.position.toArray());
await p.mouse.move(aim.rect.x + aim.px[0], aim.rect.y + aim.px[1]);
await p.keyboard.down('Alt'); await p.mouse.wheel(0, -120); await p.keyboard.up('Alt');
await p.waitForTimeout(250);
const camAfter = await p.evaluate(() => window.__viewer.camera.position.toArray());
ok('and the camera does not move with it', Math.hypot(...camAfter.map((v, i) => v - camBefore[i])) < 1e-6, `${Math.hypot(...camAfter.map((v, i) => v - camBefore[i])).toFixed(6)} m`);

// ---------------------------------------------------------------- fit to contents
await p.evaluate(() => { const r = window.__app.sections[0]; r.radius = 0.2; r.half = [0.2, 0.2, 0.2]; window.__app.syncRegions(); });
await p.click('#k-fitcontents'); await idle(); await p.waitForTimeout(300);
rs = await regions();
const got = await inside(rs[0].id);
console.log('FITTED', JSON.stringify({ radius: +rs[0].radius.toFixed(3), inside: got.count }));
// the blob is 1.95 x 1.95 m, so the sphere that holds it has radius ~1.38 m plus a margin
ok('Fit to contents grows onto the blob', Math.abs(got.count - BLOB) < BLOB * 0.05, `${got.count} of ${BLOB} blob points`);
ok('and stops at its extent', Math.abs(rs[0].radius - 1.379) < 1.379 * 0.05, `radius ${rs[0].radius.toFixed(3)} m, blob half-diagonal 1.379 m`);

ok('without swallowing the floor', got.count < BLOB * 1.05, `${got.count} points`);
await p.screenshot({ path: 'shots/region-fitted.png' });

// ---------------------------------------------------------------- a second region, and the union
const second = await p.evaluate(() => {
  const v = window.__viewer, b = v.bounds();
  const at = new (v.camera.position.constructor)(b.min.x + 1, b.min.y + 1, b.min.z);
  const r = window.__app.placeRegion(at, 'box');
  return { id: r.id };
});
await p.evaluate(() => window.__app.scaleRegion(4));
await p.waitForTimeout(200);
rs = await regions();
ok('Create adds another rather than replacing', rs.length === 2 && rs[1].kind === 'box', `${rs.length} regions`);
const n1 = (await inside(rs[0].id)).count, n2 = (await inside(rs[1].id)).count;
await p.click('#k-cropapply'); await p.waitForSelector('#modal:not(.hidden)');
ok('the dialog crops rather than removes', (await p.textContent('#modal-title')) === 'Apply crop?', await p.textContent('#modal-title'));
await p.click('#modal-btns button.danger'); await idle();
const keptBoth = await loaded();
console.log('UNION', JSON.stringify({ n1, n2, keptBoth }));
ok('applying keeps their union', Math.abs(keptBoth - (n1 + n2)) < 5, `${keptBoth} kept, regions held ${n1} + ${n2}`);
await p.click('#tb-undo'); await idle();
ok('undo restores everything', await loaded() === TOTAL, `${await loaded()}`);

// ---------------------------------------------------------------- Remove, through a row toggle
await p.evaluate(() => { document.querySelectorAll('#sec-list .rr')[1].click(); document.querySelectorAll('#sec-list .rr')[0].click(); });
await p.waitForTimeout(200);
ok('both rows now say Remove', (await regions()).every(r => r.role === 'delete'), (await regions()).map(r => r.role).join(','));
await p.click('#k-cropapply'); await p.waitForSelector('#modal:not(.hidden)');
ok('and the dialog agrees', (await p.textContent('#modal-title')) === 'Remove the points inside?', await p.textContent('#modal-title'));
await p.click('#modal-btns button.danger'); await idle();
ok('removing drops exactly the union', Math.abs(await loaded() - (TOTAL - n1 - n2)) < 5, `${await loaded()} left of ${TOTAL}`);
await p.click('#tb-undo'); await idle();
ok('and that undoes too', await loaded() === TOTAL, `${await loaded()}`);

// ---------------------------------------------------------------- the agent does the same thing
// undo refits the camera, so aim at the blob again before asking for a pixel pick
const aim2 = await p.evaluate(async () => {
  const v = window.__viewer, b = v.bounds();
  v.camera.up.set(0, 1, 0);
  v.controls.target.set(b.max.x - 1, b.max.y - 1, b.max.z);
  v.camera.position.set(b.max.x - 1, b.max.y - 1, b.max.z + 10);
  v.controls.update(); v.touch(); v.render();
  await new Promise(r => setTimeout(r, 120));
  v.render();
  const r = v.canvas.getBoundingClientRect();
  const px = [Math.round(r.width / 2), Math.round(r.height / 2)];
  const w = v.pickWorld(px[0], px[1]);
  return { px, world: w ? w.toArray() : null };
});
ok('the camera is back on the blob', !!aim2.world, JSON.stringify(aim2.world?.map(v => +v.toFixed(2))));
const agent = await p.evaluate(async (px) => {
  const v = window.__viewer;
  const before = window.__app.sections.length;
  const placed = await window.__app.dispatchAgent('regions', { op: 'place', pixel: px, kind: 'sphere' });
  const grown = await window.__app.dispatchAgent('regions', { op: 'grow', factor: 2 });
  return { before, placed: placed.result, grown: grown.result, after: window.__app.sections.length };
}, aim2.px);
console.log('AGENT', JSON.stringify({ kind: agent.placed.region.kind, centre: agent.placed.region.center.map(v => +v.toFixed(3)), grew: +agent.grown.region.radius.toFixed(4) }));
ok('an agent can place at a pixel', agent.after === agent.before + 1 && Math.hypot(...agent.placed.region.center.map((v, i) => v - aim2.world[i])) < 0.02,
   `${Math.hypot(...agent.placed.region.center.map((v, i) => v - aim2.world[i])).toFixed(4)} m from the picked point`);
ok('and grow it by a factor', Math.abs(agent.grown.region.radius / agent.placed.region.radius - 2) < 1e-6, `${(agent.grown.region.radius / agent.placed.region.radius).toFixed(3)}x`);

// ---------------------------------------------------------------- the outline tool is still there
await p.keyboard.press('Shift+S');
ok('Shift+S still arms the outline tool', await p.evaluate(() => window.__viewer.tool === 'segment'), await p.evaluate(() => window.__viewer.tool));
await p.keyboard.press('Escape');
ok('Escape leaves it', await p.evaluate(() => window.__viewer.tool === 'none'), '');

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await br.close();
process.exit(fails ? 1 : 0);
