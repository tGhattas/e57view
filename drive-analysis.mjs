// SPDX-License-Identifier: GPL-3.0-only
// Neighbourhood analysis in the browser, on a fixture whose right answers are known.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
// A flat plane, some specks floating above it, and a separate blob far away.
// Deliberately NO normals in the file, so normal computation has something to do.
const PLANE = 120 * 120, SPECK = 150, BLOB = 40 * 40;
const ply = join(tmpdir(), 'e57view-analysis.ply');
{
  const L = ['ply', 'format ascii 1.0', `element vertex ${PLANE + SPECK + BLOB}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  for (let i = 0; i < 120; i++) for (let j = 0; j < 120; j++)
    L.push(`${(10 + i * 0.05).toFixed(4)} ${(10 + j * 0.05).toFixed(4)} 20.0000 190 180 160`);
  for (let i = 0; i < SPECK; i++)
    L.push(`${(10 + (i % 12) * 0.45).toFixed(4)} ${(10 + ((i / 12) | 0) * 0.45).toFixed(4)} ${(21.4 + (i % 5) * 0.3).toFixed(4)} 230 90 90`);
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++)
    L.push(`${(40 + i * 0.05).toFixed(4)} ${(40 + j * 0.05).toFixed(4)} 25.0000 90 190 120`);
  writeFileSync(ply, L.join('\n'));
}
mkdirSync('shots', { recursive: true });
const TOTAL = PLANE + SPECK + BLOB;

const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await b.newContext({ viewport: { width: 1340, height: 880 } })).newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200)); });
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 300000 });

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { window.showSaveFilePicker = undefined; localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache','e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });
await p.setInputFiles('#file-input', ply);
await p.waitForFunction(() => /loaded in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 120000 });
await p.waitForTimeout(900);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 3000 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('LOAD:', await p.textContent('#tb-points'));

// ---- the file has no normals, so the surface tool must fall back to density
let st = await p.evaluate(() => window.__app.buildMesh({ voxel: 5, smooth: 1, trunc: 2, confirm: false }));
ok('before normals, surface uses density', st.unoriented > st.oriented, `${st.oriented} oriented, ${st.unoriented} not`);
await p.evaluate(() => document.getElementById('k-mclear').click());

// ---- compute + orient normals
let t = Date.now();
await p.evaluate(() => window.__app.analysis('normals', { k: 16, orient: true }, 'normals'));
await idle();
console.log(`NORMALS ${((Date.now() - t) / 1000).toFixed(1)}s ·`, await p.textContent('#v-analysis'));
const nrm = await p.evaluate(() => {
  let withN = 0, n = 0, up = 0;
  for (const l of window.__viewer.cells.leavesForMask()) {
    const recs = l.readback(window.__viewer.cells.gl2);
    for (let i = 0; i < l.count; i++) {
      const o = i * 14, nx = (recs[o+10]<<24>>24), ny = (recs[o+11]<<24>>24), nz = (recs[o+12]<<24>>24);
      n++;
      if (!(nx === 0 && ny === 0 && nz === 127)) withN++;
      if (Math.abs(nz) > 120) up++;
    }
  }
  return { n, withN, up };
});
ok('every point now carries a normal', nrm.withN > nrm.n * 0.99, `${nrm.withN}/${nrm.n}`);
ok('plane normals are vertical', nrm.up > PLANE * 0.95, `${nrm.up} with |nz|>0.94`);

// ---- the surface tool should now use them
st = await p.evaluate(() => window.__app.buildMesh({ voxel: 5, smooth: 1, trunc: 2, confirm: false }));
ok('surface now reconstructs from normals', st.oriented > st.unoriented * 10, `${st.oriented} oriented`);
await p.evaluate(() => document.getElementById('k-mclear').click());

// ---- computed normals are an undoable edit, and the cache is flagged as behind
const histAfterNormals = await p.evaluate(() => ({ steps: window.__app.hist.steps, label: window.__app.hist.peekUndo()?.label, kind: window.__app.hist.peekUndo()?.kind }));
ok('normals pushed an undo step', histAfterNormals.kind === 'normals' && histAfterNormals.steps.undo >= 1, `${histAfterNormals.steps.undo} undo · ${histAfterNormals.label}`);
const markers = () => p.evaluate(() => {
  let placeholder = 0, real = 0;
  for (const l of window.__viewer.cells.leavesForMask()) {
    const recs = l.readback(window.__viewer.cells.gl2);
    for (let i = 0; i < l.count; i++) {
      const o = i * 14, nx = (recs[o+10]<<24>>24), ny = (recs[o+11]<<24>>24), nz = (recs[o+12]<<24>>24);
      if (nx === 0 && ny === 0 && nz === 127) placeholder++; else real++;
    }
  }
  return { placeholder, real };
});
await p.click('#tb-undo'); await idle();
let mk = await markers();
ok('undo brings back the (0,0,127) marker', mk.placeholder > TOTAL * 0.99 && mk.real < TOTAL * 0.01, `${mk.placeholder} placeholders, ${mk.real} normals`);
await p.click('#tb-redo'); await idle();
mk = await markers();
ok('redo puts the normals back', mk.real > TOTAL * 0.99 && mk.placeholder < TOTAL * 0.01, `${mk.real} normals, ${mk.placeholder} placeholders`);

// ---- a geometric feature becomes a scalar field
t = Date.now();
await p.evaluate(() => window.__app.analysis('feature', { name: 'planarity', k: 16, radius: 0.1 }, 'Planarity'));
await idle();
const sf = await p.evaluate(() => ({ s: window.__app.sfStats, mode: window.__viewer.knobs.colorMode, shown: document.body.classList.contains('has-sf'), label: document.getElementById('v-sfname').textContent }));
console.log(`FEATURE ${((Date.now() - t) / 1000).toFixed(1)}s ·`, sf.label);
ok('field produced for every point', sf.s && sf.s.n > TOTAL * 0.97, `${sf.s?.n} values`);
ok('planarity is high on a plane', sf.s && sf.s.max > 0.9, `max ${sf.s?.max.toFixed(3)}`);
ok('colouring switched to the field', sf.mode === 5 && sf.shown, `colorMode ${sf.mode}`);
await p.waitForTimeout(500); await p.screenshot({ path: 'shots/analysis-field.png' });

// ---- the field must survive a crop, still lined up with its points
const beforeCrop = await p.evaluate(() => window.__viewer.loaded);
await p.evaluate(() => {
  const v = window.__viewer;
  // the fixture's bounding-box centre is empty air between the plane and the far blob,
  // so aim at the plane itself: 3 m in from the minimum corner
  const b = v.bounds();
  v.controls.target.set(b.min.x + 3, b.min.y + 3, b.min.z); v.controls.update();
  document.getElementById('k-cropcentre').click();
  for (const id of ['k-cropsize','k-cropsy','k-cropsz']) { const s = document.getElementById(id); s.value = '0.35'; s.dispatchEvent(new Event('input')); }
});
await p.click('#k-cropapply'); await p.waitForSelector('#modal:not(.hidden)'); await p.click('#modal-btns button.danger'); await idle();
const afterCrop = await p.evaluate(() => {
  const v = window.__viewer; let pts = 0, finite = 0;
  for (const l of v.cells.leavesForMask()) { pts += l.count; if (l.sf) for (let i = 0; i < l.count; i++) if (Number.isFinite(l.sf[i])) finite++; }
  return { pts, finite, loaded: v.loaded };
});
ok('crop kept the field aligned', afterCrop.pts === afterCrop.loaded && afterCrop.finite > afterCrop.pts * 0.9 && afterCrop.pts < beforeCrop,
   `${afterCrop.pts} points, ${afterCrop.finite} field values`);
await p.click('#tb-undo'); await idle();
const restored = await p.evaluate(() => { const v = window.__viewer; let finite = 0, pts = 0; for (const l of v.cells.leavesForMask()) { pts += l.count; if (l.sf) for (let i = 0; i < l.count; i++) if (Number.isFinite(l.sf[i])) finite++; } return { pts, finite }; });
ok('undo restored points and their field', restored.pts === beforeCrop && restored.finite > beforeCrop * 0.9, `${restored.pts} points, ${restored.finite} values`);
await p.evaluate(() => document.getElementById('k-sfclear').click());

// ---- outlier removal
t = Date.now();
const sor = p.evaluate(() => window.__app.maskTool('sor', { k: 16, sigma: 1.0 }, 'Remove outliers', '<p>{n} of {k}</p>'));
await p.waitForSelector('#modal:not(.hidden)', { timeout: 300000 });
const dlg = (await p.textContent('#modal-body')).replace(/\s+/g, ' ').trim();
await p.click('#modal-btns button.danger'); await sor; await idle();
const afterSor = await p.evaluate(() => window.__viewer.loaded);
console.log(`SOR ${((Date.now() - t) / 1000).toFixed(1)}s · ${dlg.slice(0, 90)}`);
ok('outliers removed, surface kept', TOTAL - afterSor >= SPECK * 0.9 && TOTAL - afterSor < SPECK * 2.5, `${TOTAL - afterSor} removed of ${SPECK} planted`);
await p.click('#tb-undo'); await idle();
ok('undo restores the removal', await p.evaluate(() => window.__viewer.loaded) === TOTAL, '');

// ---- connected components
await p.evaluate(() => window.__app.analysis('components', { radius: 0.12, minPts: 16 }, 'Connected components'));
await idle();
const cc = await p.textContent('#v-analysis');
console.log('COMPONENTS ·', cc);
ok('two clusters found', /\b2 clusters\b/.test(cc), cc);

// ---- thinning
await p.evaluate(() => document.getElementById('k-sfclear').click());
const before = await p.evaluate(() => window.__viewer.loaded);
const thin = p.evaluate(() => window.__app.maskTool('subsample', { spacing: 0.2 }, 'Thin', '<p>{n} of {k}</p>'));
await p.waitForSelector('#modal:not(.hidden)', { timeout: 300000 });
await p.click('#modal-btns button.danger'); await thin; await idle();
const after = await p.evaluate(() => window.__viewer.loaded);
ok('thinning keeps roughly one point per cube', after < before / 3 && after > 100, `${before} to ${after}`);

// ---- a scalar field must stay lined up when applyRegions is asked not to record an undo.
// `mask` used to be allocated only for the undo path, so with record=false every kept value
// landed at the wrong index. Unique per-point values make any misordering visible.
await p.evaluate(() => window.__app.analysis('feature', { name: 'neighbours', k: 16, radius: 0.1 }, 'Neighbours'));
await idle();
const align = await p.evaluate(() => {
  const v = window.__viewer, REC = 14;
  const gl = v.cells.gl2;
  // a unique value per point, so a shift of one is detectable
  let tag = 0;
  for (const l of v.cells.leavesForMask()) {
    const a = new Float32Array(l.count);
    for (let i = 0; i < l.count; i++) a[i] = ++tag;
    l.setScalar(gl, a);
  }
  const read = () => {
    const out = [];
    for (const l of v.cells.leavesForMask()) {
      const recs = l.readback(gl);
      const u16 = new Uint16Array(recs.buffer, recs.byteOffset, (l.count * REC) >> 1);
      const k = l.size / 65536;
      for (let i = 0; i < l.count; i++) {
        const b = i * 7;
        out.push([l.origin.x + u16[b] * k, l.origin.y + u16[b + 1] * k, l.origin.z + u16[b + 2] * k, l.sf ? l.sf[i] : NaN]);
      }
    }
    return out;
  };
  const key = q => q[0].toFixed(4) + ',' + q[1].toFixed(4) + ',' + q[2].toFixed(4);
  const before = read();
  const bnd = v.bounds();
  const c = [bnd.min.x + 2.5, bnd.min.y + 2.5, bnd.min.z + 0.5];
  const half = [1.7, 1.7, 1.2];
  const region = { id: 'align', kind: 'box', role: 'keep', center: c, half, radius: half[0], quat: [0, 0, 0, 1] };
  // which points a CPU test says survive
  const want = new Map();
  for (const q of before) {
    if (Math.abs(q[0] - c[0]) <= half[0] && Math.abs(q[1] - c[1]) <= half[1] && Math.abs(q[2] - c[2]) <= half[2]) want.set(key(q), q[3]);
  }
  v.applyRegions([region], false);          // the path that carried the bug
  const after = read();
  let wrong = 0, unexpected = 0;
  for (const q of after) {
    const w = want.get(key(q));
    if (w === undefined) unexpected++;
    else if (Math.abs(w - q[3]) > 1e-6) wrong++;
  }
  return { want: want.size, kept: after.length, wrong, unexpected, total: before.length };
});
console.log('ALIGN', JSON.stringify(align));
ok('record=false keeps the field lined up',
   align.want > 100 && align.kept === align.want && align.wrong === 0 && align.unexpected === 0,
   `${align.kept} kept of ${align.total} (CPU said ${align.want}) · ${align.wrong} values misplaced, ${align.unexpected} unexpected`);

await p.waitForTimeout(400); await p.screenshot({ path: 'shots/analysis-done.png' });
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(fails ? 1 : 0);
