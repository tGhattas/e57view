// SPDX-License-Identifier: GPL-3.0-only
// Surface reconstruction in the browser, against a shape whose true surface is known.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
const R = 2.0, C = [5, 5, 5];
const N = 300_000;
const ply = join(tmpdir(), 'e57view-sphere.ply');
{
  const L = ['ply', 'format ascii 1.0', `element vertex ${N}`,
    'property float x', 'property float y', 'property float z',
    'property float nx', 'property float ny', 'property float nz',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2, rad = Math.sqrt(Math.max(0, 1 - y * y)), th = ga * i;
    const d = [Math.cos(th) * rad, y, Math.sin(th) * rad];
    // a little radial noise, so smoothing has something to do
    const j = 1 + (Math.sin(i * 12.9898) * 0.5) * 0.004;
    L.push(`${(C[0] + d[0] * R * j).toFixed(5)} ${(C[1] + d[1] * R * j).toFixed(5)} ${(C[2] + d[2] * R * j).toFixed(5)} ${d[0].toFixed(5)} ${d[1].toFixed(5)} ${d[2].toFixed(5)} 210 130 70`);
  }
  writeFileSync(ply, L.join('\n'));
}
mkdirSync('shots', { recursive: true });

const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const ctx = await b.newContext({ viewport: { width: 1300, height: 860 }, acceptDownloads: true });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200)); });
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { window.showSaveFilePicker = undefined; localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache','e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });
await p.setInputFiles('#file-input', ply);
await p.waitForFunction(() => /loaded in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 120000 });
await p.waitForTimeout(1000);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 3000 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('LOAD:', await p.textContent('#tb-points'));
console.log('default Detail:', await p.textContent('#v-mvox'), '(from the scan\'s own point spacing)');

const t0 = Date.now();
const st = await p.evaluate(() => window.__app.buildMesh({ voxel: 5, smooth: 2, trunc: 2, confirm: false }));
console.log(`BUILD ${((Date.now() - t0) / 1000).toFixed(1)}s ·`, await p.textContent('#v-mesh'));

// The build result belongs to one line. It used to be printed under Build and again above
// Import, a few centimetres apart, which reads as two facts and is one.
const lines = await p.evaluate(() => ({
  build: document.getElementById('v-mesh').textContent.trim(),
  info: document.getElementById('v-meshinfo').textContent.trim(),
  infoHidden: document.getElementById('v-meshinfo').classList.contains('hidden'),
}));
ok('the build result is on the line under Build', /triangles/.test(lines.build), lines.build);
ok('and is not repeated further down', lines.info === '' && lines.infoHidden,
   lines.info || '(empty and hidden)');
// a mesh operation does have something of its own to say, and saying it shows the line
await p.evaluate(() => window.__app.measureActiveMesh());
await p.waitForTimeout(200);
const after = await p.evaluate(() => ({
  info: document.getElementById('v-meshinfo').textContent.trim(),
  hidden: document.getElementById('v-meshinfo').classList.contains('hidden'),
}));
ok('a measurement writes that line and shows it', /area/.test(after.info) && !after.hidden,
   after.info.slice(0, 70));

ok('surface built', st && st.triangles > 5000, `${st?.triangles?.toLocaleString()} triangles`);
ok('reconstructed from normals', st && st.oriented > st.unoriented, `${st?.oriented?.toLocaleString()} oriented points`);

// The viewer re-bases coordinates to a local frame, so compare there, not in file space.
const tr = await p.evaluate(() => window.__app.meta?.scans?.[0]?.translation ?? [0, 0, 0]);
console.log('local frame translation:', tr.map(v => +v.toFixed(3)).join(', '));
const LC = [C[0] - tr[0], C[1] - tr[1], C[2] - tr[2]];
const g = await p.evaluate(([cx, cy, cz, r]) => {
  const m = window.__app.meshData; const n = m.pos.length / 3;
  let sum = 0, worst = 0, outward = 0;
  for (let v = 0; v < n; v++) {
    const dx = m.pos[v*3]-cx, dy = m.pos[v*3+1]-cy, dz = m.pos[v*3+2]-cz;
    const d = Math.hypot(dx, dy, dz), e = Math.abs(d - r);
    sum += e; if (e > worst) worst = e;
    if (dx*m.nrm[v*3] + dy*m.nrm[v*3+1] + dz*m.nrm[v*3+2] > 0) outward++;
  }
  return { n, mean: sum / n, worst, outward: outward / n };
}, [...LC, R]);
ok('vertices sit on the sphere', g.mean < 0.01 && g.worst < 0.06, `mean ${g.mean.toFixed(4)} m, worst ${g.worst.toFixed(4)} m`);
ok('normals face outward', g.outward > 0.99, `${(g.outward * 100).toFixed(1)}%`);

const disp = await p.evaluate(() => window.__viewer.display);
ok('view switched to the surface', disp === 'mesh', disp);
await p.waitForTimeout(600); await p.screenshot({ path: 'shots/mesh-surface.png' });
await p.evaluate(() => document.getElementById('k-dispboth').click());
await p.waitForTimeout(600); await p.screenshot({ path: 'shots/mesh-both.png' });
await p.evaluate(() => document.getElementById('k-mflat').click());
await p.evaluate(() => document.getElementById('k-dispmesh').click());
await p.waitForTimeout(600); await p.screenshot({ path: 'shots/mesh-flat.png' });

// points must be untouched by meshing
const pts = await p.evaluate(() => window.__viewer.loaded);
ok('points untouched', pts === 300000, `${pts.toLocaleString()} still in memory`);

// export
const [dl] = await Promise.all([
  p.waitForEvent('download', { timeout: 120000 }),
  // one export control now: the Mesh group's format select and Export mesh button
  p.evaluate(() => { document.getElementById('k-meshfmt').value = 'ply'; document.getElementById('k-meshsave').click(); }),
]);
const out = join(tmpdir(), 'surface-out.ply');
await dl.saveAs(out);
const size = statSync(out).size;
console.log('SAVED', dl.suggestedFilename(), (size / 1e6).toFixed(2), 'MB');
ok('surface exported', size > 1000, `${(size / 1e6).toFixed(2)} MB`);
const head = (await import('node:fs')).readFileSync(out).subarray(0, 400).toString('latin1');
const nv = +(head.match(/element vertex (\d+)/) || [])[1];
const nf = +(head.match(/element face (\d+)/) || [])[1];
ok('PLY header matches the mesh', nv === g.n && nf === st.triangles, `${nv} verts, ${nf} faces`);

// discard
await p.evaluate(() => document.getElementById('k-mclear').click());
ok('surface discarded', await p.evaluate(() => window.__viewer.mesh.triangles === 0 && window.__viewer.display === 'points'), '');
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(fails ? 1 : 0);
