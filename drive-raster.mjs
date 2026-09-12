// SPDX-License-Identifier: GPL-3.0-only
// Rasters, contours and volumes, against terrain whose volume is known by arithmetic.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
mkdirSync('shots', { recursive: true });
const S = 0.05;                     // point spacing
const BASE = 12;                    // the plateau the shapes sit on, in metres
// a square pyramid: base 6 x 6, height 3 -> volume a^2 h / 3 = 36 m^3
const PYR = { a: 6, h: 3, x0: 10, y0: 20 };
// a half-cylinder mound: radius 1.5, length 8 -> pi r^2 L / 2 = 28.274 m^3
const MOUND = { r: 1.5, len: 8, x0: 22, y0: 20 };
function terrain(path) {
  const rows = [];
  const add = (x, y, z) => rows.push(`${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} 190 180 160`);
  const n = Math.round(PYR.a / S);
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const x = i * S, y = j * S;
    // a pyramid is linear in the Chebyshev distance from its centre
    const t = Math.max(Math.abs(x - PYR.a / 2), Math.abs(y - PYR.a / 2)) / (PYR.a / 2);
    add(PYR.x0 + x, PYR.y0 + y, BASE + PYR.h * (1 - t));
  }
  const nl = Math.round(MOUND.len / S), nr = Math.round((2 * MOUND.r) / S);
  for (let i = 0; i <= nl; i++) for (let j = 0; j <= nr; j++) {
    const y = i * S, u = -MOUND.r + j * S;
    add(MOUND.x0 + u, MOUND.y0 + y, BASE + Math.sqrt(Math.max(0, MOUND.r * MOUND.r - u * u)));
  }
  writeFileSync(path, ['ply', 'format ascii 1.0', `element vertex ${rows.length}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header', ...rows].join('\n'));
  return rows.length;
}
// the same ground with no shapes on it, as the reference layer for a volume
function flat(path) {
  const rows = [];
  for (let x = 9; x <= 31; x += 0.1) for (let y = 19; y <= 29; y += 0.1)
    rows.push(`${x.toFixed(4)} ${y.toFixed(4)} ${BASE.toFixed(4)} 120 140 120`);
  writeFileSync(path, ['ply', 'format ascii 1.0', `element vertex ${rows.length}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header', ...rows].join('\n'));
  return rows.length;
}
const terr = join(tmpdir(), 'e57view-terrain.ply'), base = join(tmpdir(), 'e57view-flat.ply');
const NT = terrain(terr), NF = flat(base);
const PYR_V = PYR.a * PYR.a * PYR.h / 3, MOUND_V = Math.PI * MOUND.r * MOUND.r * MOUND.len / 2;
console.log(`FIXTURE pyramid ${PYR_V.toFixed(3)} m³ + half-cylinder ${MOUND_V.toFixed(3)} m³ = ${(PYR_V + MOUND_V).toFixed(3)} m³ · ${NT} points`);

const br = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const ctx = await br.newContext({ viewport: { width: 1200, height: 820 }, acceptDownloads: true });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200)); });
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 300000 });

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { window.showSaveFilePicker = undefined; localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache', 'e57view-undo', 'e57view-export']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });
await p.setInputFiles('#file-input', terr);
await p.waitForFunction(c => window.__viewer.loaded === c, NT, { timeout: 120000 });
await p.waitForTimeout(800);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('LOAD:', await p.textContent('#tb-points'));

// ---------------------------------------------------------------- rasterize
await p.evaluate(() => { const s = document.getElementById('k-rcell'); s.value = '0.1'; s.dispatchEvent(new Event('input')); });
const r = await p.evaluate(() => window.__app.rasterize());
await idle();
console.log('RASTER', await p.textContent('#v-raster'));
ok('a height raster covers the ground', r && r.w > 100 && r.h > 50 && r.filled > 5000, `${r?.w} x ${r?.h}, ${r?.filled} filled`);
ok('its range is the terrain height', Math.abs(r.hi - r.lo - 3) < 0.05, `${r.lo.toFixed(3)} to ${r.hi.toFixed(3)} m`);
ok('the draped grid is drawn', await p.evaluate(() => window.__viewer.hasRaster), '');
await p.evaluate(() => { window.__viewer.topDown(); window.__viewer.touch(); window.__viewer.render(); });
await p.waitForTimeout(400);
await p.screenshot({ path: 'shots/raster-draped.png' });

// hole filling
const holes = await p.evaluate(() => {
  const b = window.__app.buildRaster(window.__viewer.active, { cell: 0.1, stat: 'max', axis: 'z', fill: 'none' });
  const f = window.__app.buildRaster(window.__viewer.active, { cell: 0.1, stat: 'max', axis: 'z', fill: 'idw' });
  const count = (g) => { let n = 0; for (const v of g.grid) if (isFinite(v)) n++; return n; };
  return { none: count(b), filled: count(f), cells: b.grid.length };
});
console.log('FILL', JSON.stringify(holes));
// the two shapes are 4.5 m apart, further than the fill is allowed to reach — which is the
// point of capping it: a hole in a car park should not be filled from the far side of a site
ok('filling empty cells fills the ones near data', holes.filled > holes.none * 1.3 && holes.filled < holes.cells,
   `${holes.none} to ${holes.filled} of ${holes.cells}, the rest being beyond the fill's reach`);

// ---------------------------------------------------------------- contours
const cs = await p.evaluate(() => window.__app.drawContours(0.5));
await idle();
console.log('CONTOURS', await p.textContent('#v-contours'));
const levels = new Set(cs.map(c => +c.z.toFixed(3)));
ok('contours come out at the interval asked for', levels.size >= 5 && cs.length >= 5, `${cs.length} polylines over ${levels.size} levels`);
ok('and they are drawn', await p.evaluate(() => window.__viewer.hasContours), '');
// a contour of a pyramid at height t is a square of side a(1 - t/h)
const pyrLevel = cs.filter(c => Math.abs(c.z - 1.5) < 1e-6);
if (pyrLevel.length) {
  const xs = pyrLevel.flatMap(c => c.pts.map(q => q[0])), ys = pyrLevel.flatMap(c => c.pts.map(q => q[1]));
  const side = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  ok('the pyramid contour is the right size', Math.abs(side - 3) < 0.15, `${side.toFixed(3)} m across at half height, expected 3.000`);
}
await p.screenshot({ path: 'shots/raster-contours.png' });
const dxf = await p.evaluate(() => window.__app.contoursDxf());
ok('the DXF is a polyline file', /^0\nSECTION\n2\nENTITIES/.test(dxf) && (dxf.match(/LWPOLYLINE/g) || []).length === cs.length && /\nEOF\n$/.test(dxf),
   `${(dxf.match(/LWPOLYLINE/g) || []).length} LWPOLYLINEs, ${(dxf.length / 1024).toFixed(0)} KB`);
const gj = JSON.parse(await p.evaluate(() => window.__app.contoursGeoJson()));
const t = await p.evaluate(() => window.__app.meta.scans[0].translation);
ok('the GeoJSON is in the global frame', gj.type === 'FeatureCollection' && gj.features.length === cs.length
   && Math.abs(gj.features[0].geometry.coordinates[0][0] - (cs[0].pts[0][0] + t[0])) < 0.001,
   `${gj.features.length} features, first x ${gj.features[0].geometry.coordinates[0][0].toFixed(3)}`);
ok('and it carries the elevation', gj.features.every(f => typeof f.properties.elevation === 'number'), `first at ${gj.features[0].properties.elevation}`);

// ---------------------------------------------------------------- volume against a plane
const zBase = await p.evaluate(b => b - window.__app.meta.scans[0].translation[2], BASE);
const vp = await p.evaluate(z => window.__app.measureVolume({ cell: 0.05, reference: 'plane', plane: z }), zBase);
console.log('VOLUME vs plane', JSON.stringify({ added: +vp.added.toFixed(3), removed: +vp.removed.toFixed(3) }), '·', await p.textContent('#v-volume'));
const want = PYR_V + MOUND_V;
ok('the volume above the plane is the two shapes', Math.abs(vp.added - want) < want * 0.01,
   `${vp.added.toFixed(3)} m³ against ${want.toFixed(3)} m³ (${((vp.added / want - 1) * 100).toFixed(2)}%)`);
ok('and nothing was cut', vp.removed < want * 0.005, `${vp.removed.toFixed(4)} m³ removed`);

// ---------------------------------------------------------------- volume against a layer
await p.setInputFiles('#file-add', base);
await p.waitForFunction(c => window.__viewer.loadedAll === c, NT + NF, { timeout: 120000 });
await p.waitForTimeout(700);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2000 }); } catch {}
await p.evaluate(() => { window.__app.entities[1].name = 'Ground'; window.__app.activateEntity(window.__app.entities[0].id); });
await p.waitForTimeout(400);
const vl = await p.evaluate(() => {
  const ref = window.__app.entities.find(e => e.name === 'Ground');
  return window.__app.measureVolume({ cell: 0.05, reference: ref.id });
});
console.log('VOLUME vs layer', JSON.stringify({ added: +vl.added.toFixed(3), removed: +vl.removed.toFixed(3), ref: vl.reference }));
ok('the same volume comes out against a reference layer', Math.abs(vl.added - want) < want * 0.01,
   `${vl.added.toFixed(3)} m³ against ${want.toFixed(3)} m³ (${((vl.added / want - 1) * 100).toFixed(2)}%)`);
ok('and it names what it measured against', vl.reference === 'Ground', vl.reference);
ok('the difference raster is drawn', await p.evaluate(() => window.__viewer.hasRaster), '');
await p.screenshot({ path: 'shots/raster-volume.png' });

// ---------------------------------------------------------------- the PNG and its world file
const out = await p.evaluate(async () => {
  const r = window.__app.raster;
  const { png, pgw } = window.__app.rasterPng(r);
  const buf = new Uint8Array(await png.arrayBuffer());
  return { bytes: buf.length, magic: Array.from(buf.subarray(0, 4)), pgw: pgw.trim().split('\n').map(Number), w: r.w, h: r.h, cell: r.cell, ox: r.ox, oy: r.oy };
});
console.log('PNG', JSON.stringify({ bytes: out.bytes, pgw: out.pgw }));
ok('the PNG is a PNG', out.magic.join(',') === '137,80,78,71' && out.bytes > 200, `${out.bytes} bytes`);
ok('the world file has the cell size and no rotation', Math.abs(out.pgw[0] - out.cell) < 1e-9 && out.pgw[1] === 0 && out.pgw[2] === 0 && Math.abs(out.pgw[3] + out.cell) < 1e-9,
   out.pgw.slice(0, 4).join(', '));
ok('and places the top-left pixel in the global frame', Math.abs(out.pgw[4] - (out.ox + t[0] + out.cell / 2)) < 1e-4,
   `${out.pgw[4].toFixed(3)} against ${(out.ox + t[0] + out.cell / 2).toFixed(3)}`);

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await br.close();
process.exit(fails ? 1 : 0);
