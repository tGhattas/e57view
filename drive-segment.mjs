// A drawn outline is a 3D region, not a one-shot cut. The property that matters: once created,
// what it holds does not depend on where the camera is.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
const PLANE = 120 * 120, BLOB = 40 * 40, FAR = 30 * 30, TOTAL = PLANE + BLOB + FAR;
const ply = join(tmpdir(), 'e57view-seg.ply');
{
  const L = ['ply', 'format ascii 1.0', `element vertex ${TOTAL}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  for (let i = 0; i < 120; i++) for (let j = 0; j < 120; j++)      // a 6 x 6 m floor at z = 20
    L.push(`${(10 + i * 0.05).toFixed(4)} ${(10 + j * 0.05).toFixed(4)} 20.0000 190 180 160`);
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++)        // a 2 x 2 m blob 5 m higher
    L.push(`${(40 + i * 0.05).toFixed(4)} ${(40 + j * 0.05).toFixed(4)} 25.0000 90 190 120`);
  for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++)        // a second blob elsewhere
    L.push(`${(40 + i * 0.05).toFixed(4)} ${(10 + j * 0.05).toFixed(4)} 23.0000 200 140 90`);
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
/** Exact count of the points inside a region, from the records. */
const exact = (id) => p.evaluate(i => {
  const r = window.__app.regions.find(x => x.id === i);
  return r ? window.__viewer.cells.insideExact(r).count : -1;
}, id);

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache','e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });
await p.setInputFiles('#file-input', ply);
await p.waitForFunction(() => /loaded in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 120000 });
await p.waitForTimeout(900);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 3000 }); } catch {}
await p.evaluate(() => { document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')); });
console.log('LOAD:', await p.textContent('#tb-points'));

// aim the orbit centre at the blob's own height, so a drawn outline lands on it
const aim = (z) => p.evaluate(async (zz) => {
  const v = window.__viewer, b = v.bounds();
  v.topDown();
  v.controls.target.set(b.max.x - 1, b.max.y - 1, zz);
  v.camera.position.set(b.max.x - 1, b.max.y - 1, zz + 14);
  v.controls.update(); v.touch(); v.render();
  await new Promise(r => setTimeout(r, 60));
  v.render();
  const r = v.canvas.getBoundingClientRect();
  const P = (x, y, z) => { const q = new (v.camera.position.constructor)(x, y, z).project(v.camera); return [(q.x + 1) / 2 * r.width, (1 - q.y) / 2 * r.height]; };
  const pad = 0.35, zb = b.max.z;
  return {
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    poly: [P(b.max.x - 2 - pad, b.max.y - 2 - pad, zb), P(b.max.x + pad, b.max.y - 2 - pad, zb),
           P(b.max.x + pad, b.max.y + pad, zb), P(b.max.x - 2 - pad, b.max.y + pad, zb)].map(q => q.map(Math.round)),
  };
}, z);

const blobZ = await p.evaluate(() => window.__viewer.bounds().max.z);
const view = await aim(blobZ);
console.log('POLY', JSON.stringify(view.poly));

// ---------------------------------------------------------------- draw, then create a region
await p.keyboard.press('Shift+S');
ok('Shift+S arms the outline tool', await p.evaluate(() => window.__viewer.tool === 'segment'), '');
ok('the bar offers Create region', await p.evaluate(() => !document.getElementById('segbar').classList.contains('hidden') && document.getElementById('seg-region').textContent.trim() === 'Create region'), '');
for (const [x, y] of view.poly) await p.mouse.click(view.rect.x + x, view.rect.y + y);
await p.waitForTimeout(200);
ok('four vertices captured', (await p.textContent('#seg-hint')).includes('4 points'), await p.textContent('#seg-hint'));
ok('Create region is enabled', await p.evaluate(() => !document.getElementById('seg-region').disabled), '');
await p.screenshot({ path: 'shots/segment-drawn.png' });
await p.click('#seg-region'); await p.waitForTimeout(400);

const reg = await p.evaluate(() => {
  const r = window.__app.regions.find(x => x.kind === 'prism');
  return r ? { id: r.id, kind: r.kind, role: r.role, sides: r.poly.length, depth: r.half[2], label: r.label, active: window.__viewer.activeRegion === r.id } : null;
});
console.log('REGION', JSON.stringify(reg));
ok('a prism region now exists', !!reg && reg.kind === 'prism' && reg.role === 'keep', JSON.stringify(reg?.kind));
ok('its outline is simplified to 24 sides or fewer', reg.sides >= 3 && reg.sides <= 24, `${reg.sides} sides`);
ok('it is the active region, with the gizmo on it', reg.active && await p.evaluate(() => window.__viewer.gizmoTarget === 'region'), await p.evaluate(() => window.__viewer.gizmoTarget));
ok('the tool disarmed so the view can be moved', await p.evaluate(() => window.__viewer.tool === 'none' && document.getElementById('segbar').classList.contains('hidden')), '');
ok('nothing was cut', await loaded() === TOTAL, `${await loaded()} points`);
const n0 = await exact(reg.id);
ok('it holds the blob', Math.abs(n0 - BLOB) < 60, `${n0} points inside, expected ${BLOB}`);
ok('the list row describes it', /drawn · \d+ sides/.test(await p.textContent('#sec-list')), (await p.textContent('#sec-list')).slice(0, 90));
await p.screenshot({ path: 'shots/segment-region.png' });

// ------------------------------- the point of the exercise: the camera no longer matters
for (const [name, az, el] of [['90° round', 90, 35], ['from the side', 180, 8], ['from below', 250, -40]]) {
  await p.evaluate(([a, e]) => { window.__viewer.setOrbit(a, e); window.__viewer.render(); }, [az, el]);
  await p.waitForTimeout(250);
  const n = await exact(reg.id);
  ok(`the count is unchanged ${name}`, n === n0, `${n} vs ${n0}`);
}
await p.screenshot({ path: 'shots/segment-orbited.png' });

// ---------------------------------------------------------------- depth excludes the blob
const depth = await p.evaluate(() => {
  const s = document.getElementById('k-prismdepth');
  return { visible: getComputedStyle(s.closest('.row')).display !== 'none', value: s.value };
});
ok('the depth slider is showing for the active prism', depth.visible, JSON.stringify(depth));
// The prism is centred on the depth it was drawn at, which is the blob's own, so shrinking it
// symmetrically keeps the blob. Push the region 2.5 m along its axis first, then the depth
// decides whether the blob is in range — which is the thing the slider controls.
await p.evaluate(() => {
  const v = window.__viewer, r = window.__app.sections.find(x => x.kind === 'prism');
  const q = new (v.camera.quaternion.constructor)(r.quat[0], r.quat[1], r.quat[2], r.quat[3]);
  const ax = new (v.camera.position.constructor)(0, 0, 1).applyQuaternion(q).multiplyScalar(2.5);
  r.center = [r.center[0] + ax.x, r.center[1] + ax.y, r.center[2] + ax.z];
  window.__app.syncRegions(); window.__app.renderSectionList();
});
ok('moved off the blob, full depth still holds it', await exact(reg.id) === n0, `${await exact(reg.id)} vs ${n0}`);
await p.evaluate(() => { const s = document.getElementById('k-prismdepth'); s.value = '0.2'; s.dispatchEvent(new Event('input')); });
await p.waitForTimeout(200);
const nThin = await exact(reg.id);
ok('a shallow depth excludes the blob', nThin < n0 * 0.05, `${nThin} inside at ${await p.evaluate(() => document.getElementById('v-prismdepth').textContent)}`);
await p.evaluate(() => { const s = document.getElementById('k-prismdepth'); s.value = '1'; s.dispatchEvent(new Event('input')); });
await p.waitForTimeout(200);
ok('full depth brings it back', await exact(reg.id) === n0, `${await exact(reg.id)} vs ${n0}`);
await p.evaluate(() => {
  const v = window.__viewer, r = window.__app.sections.find(x => x.kind === 'prism');
  const q = new (v.camera.quaternion.constructor)(r.quat[0], r.quat[1], r.quat[2], r.quat[3]);
  const ax = new (v.camera.position.constructor)(0, 0, 1).applyQuaternion(q).multiplyScalar(-2.5);
  r.center = [r.center[0] + ax.x, r.center[1] + ax.y, r.center[2] + ax.z];
  window.__app.syncRegions();
});

// ---------------------------------------------------------------- Remove, apply, undo
await p.evaluate(() => document.querySelector('#sec-list .rr').click());
await p.waitForTimeout(200);
ok('the row toggles the region to Remove', await p.evaluate(() => window.__app.regions.find(r => r.kind === 'prism').role === 'delete'), '');
await p.click('#k-cropapply'); await p.waitForSelector('#modal:not(.hidden)');
ok('the dialog says it is removing', (await p.textContent('#modal-title')) === 'Remove the points inside?', await p.textContent('#modal-title'));
await p.click('#modal-btns button.danger'); await idle();
ok('applying Remove drops exactly what it held', await loaded() === TOTAL - n0, `${await loaded()} left of ${TOTAL}, region held ${n0}`);
await p.click('#tb-undo'); await idle();
ok('undo restores them', await loaded() === TOTAL, `${await loaded()} points`);

// ---------------------------------------------------------------- Keep, apply, undo
const reg2 = await p.evaluate(() => window.__app.regions.find(r => r.kind === 'prism')?.id ?? null);
ok('the region came back with the undo', !!reg2, String(reg2));
await p.evaluate(() => { const r = window.__app.regions.find(x => x.kind === 'prism'); if (r.role !== 'keep') document.querySelector('#sec-list .rr').click(); });
await p.waitForTimeout(200);
await p.click('#k-cropapply'); await p.waitForSelector('#modal:not(.hidden)');
ok('the dialog says it is cropping', (await p.textContent('#modal-title')) === 'Apply crop?', await p.textContent('#modal-title'));
await p.click('#modal-btns button.danger'); await idle();
ok('applying Keep leaves exactly what it held', Math.abs(await loaded() - n0) <= 1, `${await loaded()} kept, region held ${n0}`);
await p.click('#tb-undo'); await idle();
ok('undo restores everything again', await loaded() === TOTAL, `${await loaded()} points`);

// ---------------------------------------------------------------- two prisms, drawn from two views
await p.evaluate(() => { for (const r of [...window.__app.sections]) window.__app.sections.splice(0, window.__app.sections.length); window.__app.renderSectionList(); });
const a1 = await p.evaluate(async () => {
  const v = window.__viewer, b = v.bounds();
  // straight down on the high blob
  v.camera.up.set(0, 1, 0);
  v.controls.target.set(b.max.x - 1, b.max.y - 1, b.max.z);
  v.camera.position.set(b.max.x - 1, b.max.y - 1, b.max.z + 12);
  v.controls.update(); v.render();
  const r = v.canvas.getBoundingClientRect();
  const P = (x, y, z) => { const q = new (v.camera.position.constructor)(x, y, z).project(v.camera); return [(q.x + 1) / 2 * r.width, (1 - q.y) / 2 * r.height]; };
  const pad = 0.3, z = b.max.z;
  const poly = [P(b.max.x - 2 - pad, b.max.y - 2 - pad, z), P(b.max.x + pad, b.max.y - 2 - pad, z), P(b.max.x + pad, b.max.y + pad, z), P(b.max.x - 2 - pad, b.max.y + pad, z)];
  const reg = await window.__app.dispatchAgent('regions', { op: 'lasso', pixels: poly, width: r.width, height: r.height });
  return reg.result;
});
console.log('AGENT LASSO', JSON.stringify({ kind: a1.region.kind, sides: a1.region.poly.length, inside: a1.pointsInside }));
ok('the agent lasso builds the same kind of region', a1.region.kind === 'prism' && Math.abs(a1.pointsInside - BLOB) < 60, `${a1.pointsInside} inside`);

console.log('LASSO 2 ...');
// find the middle blob in the loaded frame (the importer shifts a PLY to local metres)
const b2 = await p.evaluate(() => {
  const v = window.__viewer, bb = v.bounds();
  const lo = bb.min.z + (bb.max.z - bb.min.z) * 0.4, hi = bb.min.z + (bb.max.z - bb.min.z) * 0.8;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let n = 0;
  for (const { leaf, recs } of v.cells.records()) {
    const xyz = v.cells.transformRecordsInto(recs, leaf.count, leaf, new Float64Array(leaf.count * 3));
    for (let i = 0; i < leaf.count; i++) {
      const z = xyz[i * 3 + 2];
      if (z < lo || z > hi) continue;
      n++;
      for (let a = 0; a < 3; a++) { const q = xyz[i * 3 + a]; if (q < mn[a]) mn[a] = q; if (q > mx[a]) mx[a] = q; }
    }
  }
  return { n, mn, mx, c: mn.map((q, a) => (q + mx[a]) / 2) };
});
console.log('BLOB2', JSON.stringify(b2));
// a genuinely different view: looking along +X at it, so the prism extrudes sideways
const a2 = await p.evaluate(async (bb2) => {
  const v = window.__viewer;
  v.camera.up.set(0, 0, 1);
  v.controls.target.set(bb2.c[0], bb2.c[1], bb2.c[2]);
  v.camera.position.set(bb2.c[0] - 9, bb2.c[1], bb2.c[2]);
  v.controls.update(); v.touch(); v.render();
  await new Promise(r => setTimeout(r, 60));
  v.render();
  const r = v.canvas.getBoundingClientRect();
  const P = (x, y, z) => { const q = new (v.camera.position.constructor)(x, y, z).project(v.camera); return [(q.x + 1) / 2 * r.width, (1 - q.y) / 2 * r.height]; };
  const pad = 0.35, x = bb2.c[0];
  const poly = [P(x, bb2.mn[1] - pad, bb2.mn[2] - pad), P(x, bb2.mx[1] + pad, bb2.mn[2] - pad),
                P(x, bb2.mx[1] + pad, bb2.mx[2] + pad), P(x, bb2.mn[1] - pad, bb2.mx[2] + pad)];
  const reg = await window.__app.dispatchAgent('regions', { op: 'lasso', pixels: poly, width: r.width, height: r.height });
  return reg.result;
}, b2);
console.log('AGENT LASSO 2', JSON.stringify({ sides: a2.region.poly.length, inside: a2.pointsInside }));
const union = await p.evaluate(() => {
  const v = window.__viewer;
  const keeps = window.__app.regions.filter(r => r.role === 'keep');
  // the union, counted exactly, against the renderer's own answer after applying
  return { regions: keeps.length, est: v.cells.estimateKept(keeps) };
});
console.log('UNION', JSON.stringify({ ...union, a1: a1.pointsInside, a2: a2.pointsInside }));
ok('two prisms coexist', union.regions === 2, `${union.regions} keep regions`);
ok('the second one caught the second object', a2.pointsInside > 400, `${a2.pointsInside} inside`);
await p.click('#k-cropapply'); await p.waitForSelector('#modal:not(.hidden)'); await p.click('#modal-btns button.danger'); await idle();
const after = await loaded();
ok('applying two prisms keeps their union', Math.abs(after - (a1.pointsInside + a2.pointsInside)) < 80,
   `${after} kept, the two regions held ${a1.pointsInside} + ${a2.pointsInside} = ${a1.pointsInside + a2.pointsInside}`);
await p.click('#tb-undo'); await idle();
ok('and that undoes too', await loaded() === TOTAL, `${await loaded()} points`);

// ---------------------------------------------------------------- Escape still backs out
await p.keyboard.press('Shift+S');
await p.mouse.click(view.rect.x + view.poly[0][0], view.rect.y + view.poly[0][1]);
await p.keyboard.press('Escape');
const afterEsc = await p.evaluate(() => ({ hint: document.getElementById('seg-hint').textContent, tool: window.__viewer.tool, n: window.__viewer.loaded }));
ok('Escape clears the trace but keeps the tool', /Click to trace/.test(afterEsc.hint) && afterEsc.tool === 'segment', afterEsc.hint);
await p.keyboard.press('Escape');
ok('Escape again disarms', await p.evaluate(n => window.__viewer.tool === 'none' && window.__viewer.loaded === n, TOTAL), '');

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await br.close();
process.exit(fails ? 1 : 0);
