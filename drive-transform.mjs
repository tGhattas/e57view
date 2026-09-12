// Cloud transforms. The points are never rewritten — the cloud carries a 4x4 matrix that
// the shader, the region tests, the lasso, the analyser and the exporters all apply — so
// every check here is really asking "does this consumer read the matrix?".
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
const PLANE = 120 * 120, BLOB = 40 * 40, TOTAL = PLANE + BLOB;

// flat fixture: a 6 x 6 m plane at z = 20 and a 2 x 2 m blob at z = 25
const flat = join(tmpdir(), 'e57view-xform-flat.ply');
{
  const L = ['ply', 'format ascii 1.0', `element vertex ${TOTAL}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  for (let i = 0; i < 120; i++) for (let j = 0; j < 120; j++)
    L.push(`${(10 + i * 0.05).toFixed(4)} ${(10 + j * 0.05).toFixed(4)} 20.0000 190 180 160`);
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++)
    L.push(`${(40 + i * 0.05).toFixed(4)} ${(40 + j * 0.05).toFixed(4)} 25.0000 90 190 120`);
  writeFileSync(flat, L.join('\n'));
}
// tilted fixture: the same plane rotated 15 degrees about X through its own centre
const TILT = 15;
const tilt = join(tmpdir(), 'e57view-xform-tilt.ply');
{
  const a = TILT * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
  const cy = 13, cz = 20;
  const L = ['ply', 'format ascii 1.0', `element vertex ${PLANE}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  for (let i = 0; i < 120; i++) for (let j = 0; j < 120; j++) {
    const x = 10 + i * 0.05, y = 10 + j * 0.05 - cy, z = 0;
    L.push(`${x.toFixed(4)} ${(cy + c * y - s * z).toFixed(4)} ${(cz + s * y + c * z).toFixed(4)} 190 180 160`);
  }
  writeFileSync(tilt, L.join('\n'));
}
mkdirSync('shots', { recursive: true });

const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 840 } })).newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200)); });
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 300000 });
const bounds = () => p.evaluate(() => { const b = window.__viewer.bounds(); return { min: b.min.toArray(), max: b.max.toArray() }; });
const matrix = () => p.evaluate(() => window.__app.transformState().matrix);
const near = (a, want, tol = 2e-4) => Math.abs(a - want) <= tol;
const nearv = (a, want, tol = 2e-4) => a.every((v, i) => near(v, want[i], tol));

async function open(file, expect = '(loaded|from cache) in') {
  // clearing first matters: setting the same path twice fires no change event
  await p.setInputFiles('#file-input', []);
  await p.setInputFiles('#file-input', file);
  // a loaded scan with unsaved history asks before being replaced
  try { await p.click('#modal-btns button.danger', { timeout: 2000 }); } catch {}
  await p.waitForFunction(re => new RegExp(re).test(document.getElementById('tb-points')?.textContent || ''), expect, { timeout: 120000 });
  await p.waitForTimeout(700);
  try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
  await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
}

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { window.showSaveFilePicker = undefined; localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache', 'e57view-undo', 'e57view-export']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });
await open(flat);
console.log('LOAD:', await p.textContent('#tb-points'));
ok('a fresh cloud has no transform', (await matrix()).join(',') === '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1', await p.textContent('#v-transform'));

// The importer shifts a PLY into a local frame (the shift comes back on export), so the
// fixture's own coordinates are not the ones in memory. Measure the blob instead of assuming.
const box = (filter) => p.evaluate((f) => {
  const v = window.__viewer;
  const hi = eval(f);
  let n = 0; const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const { leaf, recs } of v.cells.records()) {
    const xyz = v.cells.transformRecordsInto(recs, leaf.count, leaf, new Float64Array(leaf.count * 3));
    for (let i = 0; i < leaf.count; i++) {
      if (!hi(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2])) continue;
      n++;
      for (let a = 0; a < 3; a++) { const q = xyz[i * 3 + a]; if (q < mn[a]) mn[a] = q; if (q > mx[a]) mx[a] = q; }
    }
  }
  return { n, mn, mx, c: mn.map((q, a) => (q + mx[a]) / 2) };
}, filter);
const all0 = await box('(x,y,z)=>true');
const mid0 = (all0.mn[2] + all0.mx[2]) / 2;
const blob0 = await box(`(x,y,z)=>z>${mid0}`);
console.log('LOCAL', JSON.stringify({ all: all0.mn.map(v => +v.toFixed(2)), blob: blob0.mn.map(v => +v.toFixed(2)), n: blob0.n }));
ok('the blob is the high 1,600 points', blob0.n === BLOB, `${blob0.n} above z ${mid0.toFixed(2)}`);

// ---------------------------------------------------------------- translate
// measure the framing box from the points, so the checks below compare like with like
// (the loader's own box is a percentile estimate from the preview pass)
await p.evaluate(() => window.__viewer.retightenBounds());
const b0 = await bounds();
await p.evaluate(() => { for (const [id, v] of [['k-tx', '1'], ['k-ty', '2'], ['k-tz', '3']]) document.getElementById(id).value = v; });
await p.click('#k-tmove'); await idle();
let b1 = await bounds();
ok('bounds moved by exactly (1,2,3)',
   nearv(b1.min, b0.min.map((v, i) => v + [1, 2, 3][i])) && nearv(b1.max, b0.max.map((v, i) => v + [1, 2, 3][i])),
   `min ${b1.min.map(v => v.toFixed(3))}`);
ok('no point was rewritten', await p.evaluate(n => window.__viewer.loaded === n, TOTAL), `${await p.evaluate(() => window.__viewer.loaded)} points`);
ok('the status line says so', /shift 1\.000, 2\.000, 3\.000/.test(await p.textContent('#v-transform')), await p.textContent('#v-transform'));

// ---------------------------------------------------------------- undo / redo
const mMoved = await matrix();
await p.click('#tb-undo'); await idle();
ok('undo restores the matrix', (await matrix()).join(',') === '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1', (await matrix()).slice(0, 4).join(' '));
ok('undo restores the bounds', nearv((await bounds()).min, b0.min), '');
await p.click('#tb-redo'); await idle();
ok('redo puts it back', (await matrix()).join(',') === mMoved.join(','), '');
ok('redo restores the bounds', nearv((await bounds()).min, b1.min), '');
await p.click('#k-treset'); await idle();
ok('reset clears the transform', (await matrix()).join(',') === '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1', '');

// ---------------------------------------------------------------- rotate about the origin
await p.evaluate(() => {
  document.getElementById('k-taxis').value = 'z';
  document.getElementById('k-tdeg').value = '90';
  document.getElementById('k-tabout').value = 'origin';
});
await p.click('#k-trot'); await idle();
const bR = await bounds();
// 90 degrees about Z maps (x,y) -> (-y,x), so the box's x range comes from the old y range
ok('a 90° Z rotation maps the bounds exactly',
   near(bR.min[0], -b0.max[1]) && near(bR.max[0], -b0.min[1]) &&
   near(bR.min[1], b0.min[0]) && near(bR.max[1], b0.max[0]) &&
   near(bR.min[2], b0.min[2]) && near(bR.max[2], b0.max[2]),
   `x ${bR.min[0].toFixed(2)}…${bR.max[0].toFixed(2)} (was y ${b0.min[1].toFixed(2)}…${b0.max[1].toFixed(2)})`);
ok('the rotation summary reads 90°', /rotate 90\.00°/.test(await p.textContent('#v-transform')), await p.textContent('#v-transform'));

// the blob's own points must land where the matrix says: (x,y) -> (-y,x)
const blob = await box(`(x,y,z)=>z>${mid0}`);
const wantMn = [-blob0.mx[1], blob0.mn[0], blob0.mn[2]];
const wantMx = [-blob0.mn[1], blob0.mx[0], blob0.mx[2]];
ok('the blob rotated to the right place',
   blob.n === BLOB && nearv(blob.mn, wantMn, 0.01) && nearv(blob.mx, wantMx, 0.01),
   `${blob.n} points at ${blob.mn.map(v => v.toFixed(2))} … ${blob.mx.map(v => v.toFixed(2))}, expected ${wantMn.map(v => v.toFixed(2))} … ${wantMx.map(v => v.toFixed(2))}`);

// ---------------------------------------------------------------- pickWorld reads transformed depth
const pick = await p.evaluate(async (c) => {
  const v = window.__viewer;
  v.setView({ p: [c[0], c[1], c[2] + 8], t: [c[0], c[1], c[2]] });
  v.knobs.budget = 8e6; v.setKnobs(v.knobs);
  for (let i = 0; i < 12; i++) { v.touch(); v.render(); await new Promise(r => setTimeout(r, 40)); }
  const r = v.canvas.getBoundingClientRect();
  const w = v.pickWorld(r.width / 2, r.height / 2);
  return w ? w.toArray() : null;
}, blob.c);
ok('pickWorld returns transformed coordinates',
   !!pick && nearv(pick, blob.c, 0.15),
   `${pick ? pick.map(v => v.toFixed(3)).join(', ') : 'nothing picked'} vs ${blob.c.map(v => v.toFixed(3)).join(', ')}`);
await p.screenshot({ path: 'shots/transform-rotated.png' });

// ---------------------------------------------------------------- lasso, after the rotation
const lasso = await p.evaluate((bb) => {
  const v = window.__viewer;
  v.topDown(); v.touch(); v.render();
  const r = v.canvas.getBoundingClientRect();
  const P = (x, y, z) => { const q = new (v.camera.position.constructor)(x, y, z).project(v.camera); return [(q.x + 1) / 2 * r.width, (1 - q.y) / 2 * r.height]; };
  const pad = 0.4, z = bb.mx[2];
  const poly = [P(bb.mn[0] - pad, bb.mn[1] - pad, z), P(bb.mx[0] + pad, bb.mn[1] - pad, z), P(bb.mx[0] + pad, bb.mx[1] + pad, z), P(bb.mn[0] - pad, bb.mx[1] + pad, z)];
  const inside = v.polygonMask(poly, true, r.width, r.height).reduce((a, m) => a + m.reduce((s, x) => s + x, 0), 0);
  const outside = v.polygonMask(poly, false, r.width, r.height).reduce((a, m) => a + m.reduce((s, x) => s + x, 0), 0);
  return { inside, outside, total: v.loaded };
}, blob);
ok('the lasso still finds the blob after a rotation', Math.abs(lasso.inside - BLOB) < 60, `${lasso.inside} inside, expected ${BLOB}`);
ok('inside and outside are complementary', lasso.inside + lasso.outside === lasso.total, `${lasso.inside} + ${lasso.outside} = ${lasso.total}`);

// ------------------------------------------- a surface stays glued to the points it came from
const meshBox = () => p.evaluate(() => {
  const v = window.__viewer, m = window.__app.meshData;
  if (!m) return null;
  const blob = v.mesh.toPly(m, [0, 0, 0]);
  return blob.arrayBuffer().then(ab => {
    const buf = new Uint8Array(ab);
    const head = new TextDecoder().decode(buf.subarray(0, 3000));
    const at = head.indexOf('end_header\n') + 'end_header\n'.length;
    const n = Number(/element vertex (\d+)/.exec(head)[1]);
    const stride = 8 * 3 + 4 * 3 + 3;
    const dv = new DataView(buf.buffer, buf.byteOffset + at);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
      const q = dv.getFloat64(i * stride + a * 8, true);
      if (q < mn[a]) mn[a] = q; if (q > mx[a]) mx[a] = q;
    }
    return { n, mn, mx };
  });
});
await p.evaluate(() => window.__app.buildMesh({ voxel: 12, smooth: 1, trunc: 2, confirm: false })); await idle();
const mesh0 = await meshBox();
ok('a surface built on a rotated cloud exports where the points are',
   !!mesh0 && mesh0.n > 100 && mesh0.mn[0] < 0 && near(mesh0.mx[2], blob.mx[2], 0.3),
   mesh0 ? `${mesh0.n} verts, ${mesh0.mn.map(v => v.toFixed(2))} … ${mesh0.mx.map(v => v.toFixed(2))}` : 'no mesh');
// rotate another 90 degrees: the surface must follow, not stay behind or move twice
await p.click('#k-trot'); await idle();
const mesh1 = await meshBox();
ok('and it follows a later rotation exactly',
   !!mesh1 && near(mesh1.mn[0], -mesh0.mx[1], 0.02) && near(mesh1.mx[0], -mesh0.mn[1], 0.02) &&
   near(mesh1.mn[1], mesh0.mn[0], 0.02) && near(mesh1.mx[1], mesh0.mx[0], 0.02),
   mesh1 ? `${mesh1.mn.map(v => v.toFixed(2))} … ${mesh1.mx.map(v => v.toFixed(2))}` : 'no mesh');
await p.click('#tb-undo'); await idle();        // back to the single 90 degree rotation
await p.evaluate(() => document.getElementById('k-mclear').click());

// ---------------------------------------------------------------- export bakes the matrix
const exp = await p.evaluate(async () => {
  const r = await window.__app.runExport('ply', 1);
  const buf = new Uint8Array(await r.file.arrayBuffer());
  const head = new TextDecoder().decode(buf.subarray(0, 4000));
  const at = head.indexOf('end_header\n') + 'end_header\n'.length;
  const sizes = { double: 8, float: 4, uchar: 1, uint: 4, int: 4 };
  let stride = 0;
  for (const l of head.slice(0, at).split('\n')) if (l.startsWith('property ')) stride += sizes[l.split(' ')[1]] ?? 0;
  const n = Number(/element vertex (\d+)/.exec(head)[1]);
  const dv = new DataView(buf.buffer, buf.byteOffset + at);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
    const v = dv.getFloat64(i * stride + a * 8, true);
    if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v;
  }
  const first = [0, 1, 2].map(a => dv.getFloat64(a * 8, true));
  return { n, stride, first, mn, mx, t: window.__app.meta.scans[0].translation, name: r.name };
});
console.log('EXPORT', exp.name, exp.n, 'verts ·', exp.stride, 'byte stride');
ok('PLY header counts the points in memory', exp.n === await p.evaluate(() => window.__viewer.loaded), `${exp.n} vertices`);
// the transformed records, measured in the page, plus the scan's global shift
const allR = await box('(x,y,z)=>true');
const wantExpMn = allR.mn.map((v, i) => v + exp.t[i]), wantExpMx = allR.mx.map((v, i) => v + exp.t[i]);
ok('exported coordinates are model × local + shift',
   nearv(exp.mn, wantExpMn, 0.002) && nearv(exp.mx, wantExpMx, 0.002),
   `file ${exp.mn.map(v => v.toFixed(3))} … ${exp.mx.map(v => v.toFixed(3))}; model×local+shift ${wantExpMn.map(v => v.toFixed(3))} … ${wantExpMx.map(v => v.toFixed(3))}`);
ok('the first vertex is inside that box',
   exp.first.every((v, i) => v >= exp.mn[i] - 1e-6 && v <= exp.mx[i] + 1e-6), exp.first.map(v => v.toFixed(3)).join(', '));

// ---------------------------------------------------------------- cache round-trip
const cachedM = await matrix();
await p.evaluate(() => window.__app.writeCache()); await idle();
ok('caching a transformed scan reports the cache', /cached/.test(await p.textContent('#v-cache')), await p.textContent('#v-cache'));
await open(flat, 'from cache in');
ok('the reopened scan came from the cache', /from cache/.test(await p.textContent('#tb-points')), await p.textContent('#tb-points'));
ok('the cache kept the matrix', (await matrix()).join(',') === cachedM.join(','), (await matrix()).slice(0, 4).join(' '));
// the leaves arrive through the upload queue and the framing box is measured once they land
await p.waitForFunction(() => window.__viewer.cells.pendingCount === 0, null, { timeout: 30000 });
await p.waitForTimeout(600);
const bCache = await bounds();
ok('and the bounds it implies', nearv(bCache.min, bR.min, 0.02) && nearv(bCache.max, bR.max, 0.02),
   `${bCache.min.map(v => v.toFixed(3))} … ${bCache.max.map(v => v.toFixed(3))} vs ${bR.min.map(v => v.toFixed(3))} … ${bR.max.map(v => v.toFixed(3))}`);

// ------------------------------------------- a scalar field still lines up after a transform
const align = await p.evaluate((bb) => {
  const v = window.__viewer, gl = v.cells.gl2;
  let tag = 0;
  for (const l of v.cells.leavesForMask()) { const a = new Float32Array(l.count); for (let i = 0; i < l.count; i++) a[i] = ++tag; l.setScalar(gl, a); }
  const read = () => {
    const out = [];
    for (const l of v.cells.leavesForMask()) {
      const recs = l.readback(gl);
      const xyz = v.cells.transformRecordsInto(recs, l.count, l, new Float64Array(l.count * 3));
      for (let i = 0; i < l.count; i++) out.push([xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2], l.sf ? l.sf[i] : NaN]);
    }
    return out;
  };
  const key = q => q[0].toFixed(4) + ',' + q[1].toFixed(4) + ',' + q[2].toFixed(4);
  const before = read();
  // a keep box in the transformed frame: the region test has to apply the matrix too
  const c = bb.c, half = [1.2, 1.2, 1.0];
  const want = new Map();
  for (const q of before) if (Math.abs(q[0] - c[0]) <= half[0] && Math.abs(q[1] - c[1]) <= half[1] && Math.abs(q[2] - c[2]) <= half[2]) want.set(key(q), q[3]);
  v.applyRegions([{ id: 'a', kind: 'box', role: 'keep', center: c, half, radius: half[0], quat: [0, 0, 0, 1] }], false);
  const after = read();
  let wrong = 0, unexpected = 0;
  for (const q of after) { const w = want.get(key(q)); if (w === undefined) unexpected++; else if (Math.abs(w - q[3]) > 1e-6) wrong++; }
  return { want: want.size, kept: after.length, wrong, unexpected, total: before.length };
}, blob);
console.log('ALIGN', JSON.stringify(align));
ok('a crop in the transformed frame keeps the field aligned',
   align.want > 100 && align.kept === align.want && align.wrong === 0 && align.unexpected === 0,
   `${align.kept} kept of ${align.total} (CPU said ${align.want}), ${align.wrong} misplaced, ${align.unexpected} unexpected`);
await p.evaluate(() => document.getElementById('k-sfclear').click());

// ---------------------------------------------------------------- level a tilted plane
await p.evaluate(async () => { const r = await navigator.storage.getDirectory(); try { await r.removeEntry('e57view-cache', { recursive: true }); } catch {} });
await open(tilt);
const zBefore = await bounds().then(b => b.max[2] - b.min[2]);
const vert = async () => p.evaluate(async () => {
  await window.__app.analysis('feature', { name: 'verticality', k: 16, radius: 0.1 }, 'Verticality');
  const s = window.__app.sfStats;
  let sum = 0, n = 0;
  for (const l of window.__viewer.cells.leavesForMask()) if (l.sf) for (let i = 0; i < l.count; i++) if (Number.isFinite(l.sf[i])) { sum += l.sf[i]; n++; }
  document.getElementById('k-sfclear').click();
  return { mean: n ? sum / n : NaN, max: s?.max ?? NaN };
});
const vBefore = await vert(); await idle();
await p.click('#k-tlevel'); await idle();
const zAfter = await bounds().then(b => b.max[2] - b.min[2]);
const vAfter = await vert(); await idle();
console.log(`LEVEL · ${await p.textContent('#v-transform')}`);
ok('the tilted plane was 15° off', near(vBefore.mean, 1 - Math.cos(TILT * Math.PI / 180), 0.01), `verticality mean ${vBefore.mean.toFixed(4)}, 1-cos(15°) = ${(1 - Math.cos(TILT * Math.PI / 180)).toFixed(4)}`);
ok('levelling flattens its height range', zBefore > 1.4 && zAfter < 0.02, `${zBefore.toFixed(3)} m → ${zAfter.toFixed(3)} m`);
ok('and the analyser now reads it flat', vAfter.mean < 0.005, `verticality mean ${vAfter.mean.toFixed(5)}`);
ok('the label names the tilt it removed', /Level · 1[45]\.\d+°/.test(await p.evaluate(() => window.__app.hist.peekUndo()?.label ?? '')), await p.evaluate(() => window.__app.hist.peekUndo()?.label ?? ''));
await p.screenshot({ path: 'shots/transform-levelled.png' });
await p.click('#tb-undo'); await idle();
ok('undo tips it back', (await bounds().then(b => b.max[2] - b.min[2])) > 1.4, `${(await bounds().then(b => b.max[2] - b.min[2])).toFixed(3)} m`);

// ---------------------------------------------------------------- the gizmo is shared, not fought over
await p.click('#tb-redo'); await idle();
const gizmo = await p.evaluate(() => {
  const out = {};
  document.getElementById('k-tdrag').click();
  out.cloud = window.__viewer.gizmoTarget;
  document.getElementById('k-cropon').click();
  out.afterCrop = window.__viewer.gizmoTarget;
  out.checkbox = document.getElementById('k-tdrag').checked;
  document.getElementById('k-tdrag').click();
  out.backToCloud = window.__viewer.gizmoTarget;
  document.getElementById('k-tdrag').click();
  return out;
});
ok('the drag toggle attaches the cloud gizmo', gizmo.cloud === 'cloud', gizmo.cloud);
ok('showing the crop region takes it back', gizmo.afterCrop === 'region' && gizmo.checkbox === false, `${gizmo.afterCrop}, checkbox ${gizmo.checkbox}`);
ok('and the toggle takes it again', gizmo.backToCloud === 'cloud', gizmo.backToCloud);

// ---------------------------------------------------------------- a typed matrix
await p.evaluate(() => window.__app.commitTransform(window.__app.fromRowMajor([2, 0, 0, 5, 0, 2, 0, 6, 0, 0, 2, 7, 0, 0, 0, 1]), 'Apply matrix'));
await idle();
const scaled = await p.evaluate(() => window.__app.transformState());
ok('a matrix with scale reads back as scale',
   scaled.scale.every(v => near(v, 2, 1e-3)) && nearv(scaled.translation, [5, 6, 7], 1e-3),
   `scale ${scaled.scale.join('/')} · translation ${scaled.translation.join(', ')}`);
ok('the matrix round-trips row-major', scaled.matrix.join(',') === '2,0,0,5,0,2,0,6,0,0,2,7,0,0,0,1', scaled.matrix.join(','));

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(fails ? 1 : 0);
