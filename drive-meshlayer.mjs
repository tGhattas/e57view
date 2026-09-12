// Meshes as layers: import, measure, edit, sample, and measure a cloud against one.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
mkdirSync('shots', { recursive: true });
const T = [12, 8, 20];                         // where the fixtures sit, far enough to matter

// ---------------------------------------------------------------- fixtures
/** A unit cube as OBJ: area 6.000 m², volume 1.000 m³, closed. */
const CUBE = join(tmpdir(), 'e57view-cube.obj');
{
  const v = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const f = [[1,3,2],[1,4,3],[5,6,7],[5,7,8],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,4,8],[3,8,7],[4,1,5],[4,5,8]];
  writeFileSync(CUBE, '# unit cube\n'
    + v.map(q => `v ${(q[0] + T[0]).toFixed(6)} ${(q[1] + T[1]).toFixed(6)} ${(q[2] + T[2]).toFixed(6)}`).join('\n') + '\n'
    + f.map(t => `f ${t.join(' ')}`).join('\n') + '\n');
}
/** One open quad as ASCII PLY: area 4 m², four boundary edges. */
const QUAD = join(tmpdir(), 'e57view-quad.ply');
{
  const v = [[0,0,0],[2,0,0],[2,2,0],[0,2,0]].map(q => [q[0] + T[0] + 5, q[1] + T[1], q[2] + T[2]]);
  writeFileSync(QUAD, ['ply','format ascii 1.0','element vertex 4',
    'property float x','property float y','property float z','element face 2',
    'property list uchar int vertex_indices','end_header',
    ...v.map(q => q.map(n => n.toFixed(4)).join(' ')), '3 0 1 2', '3 0 2 3'].join('\n'));
}
/** A UV sphere, fine enough that faceting is under a millimetre on a 1 m radius. */
const SPH = { c: [T[0] + 3, T[1] + 3, T[2] + 3], r: 1.0, nu: 128, nv: 64 };
const SPHERE = join(tmpdir(), 'e57view-sphere.ply');
let sphereTris = 0;
{
  const verts = [], faces = [];
  for (let j = 0; j <= SPH.nv; j++) {
    const th = Math.PI * (j / SPH.nv);
    for (let i = 0; i < SPH.nu; i++) {
      const ph = 2 * Math.PI * (i / SPH.nu);
      verts.push([SPH.c[0] + SPH.r * Math.sin(th) * Math.cos(ph), SPH.c[1] + SPH.r * Math.sin(th) * Math.sin(ph), SPH.c[2] + SPH.r * Math.cos(th)]);
    }
  }
  const at = (j, i) => j * SPH.nu + (i % SPH.nu);
  for (let j = 0; j < SPH.nv; j++) for (let i = 0; i < SPH.nu; i++) {
    const a = at(j, i), b = at(j, i + 1), c = at(j + 1, i + 1), d = at(j + 1, i);
    faces.push([a, b, c], [a, c, d]);
  }
  sphereTris = faces.length;
  writeFileSync(SPHERE, ['ply','format ascii 1.0',`element vertex ${verts.length}`,
    'property float x','property float y','property float z',`element face ${faces.length}`,
    'property list uchar int vertex_indices','end_header',
    ...verts.map(q => q.map(n => n.toFixed(5)).join(' ')),
    ...faces.map(t => '3 ' + t.join(' '))].join('\n'));
}
/** A shell of points a known 25 cm outside that sphere. */
const OFFSET = 0.25, NPTS = 30000;
const SHELL = join(tmpdir(), 'e57view-shell.ply');
{
  const rows = [];
  for (let i = 0; i < NPTS; i++) {
    const y = 1 - (i / (NPTS - 1)) * 2, rad = Math.sqrt(Math.max(0, 1 - y * y)), th = Math.PI * (3 - Math.sqrt(5)) * i;
    const d = [Math.cos(th) * rad, y, Math.sin(th) * rad];
    const R = SPH.r + OFFSET;
    rows.push(`${(SPH.c[0] + d[0] * R).toFixed(5)} ${(SPH.c[1] + d[1] * R).toFixed(5)} ${(SPH.c[2] + d[2] * R).toFixed(5)} 200 190 170`);
  }
  writeFileSync(SHELL, ['ply','format ascii 1.0',`element vertex ${rows.length}`,
    'property float x','property float y','property float z',
    'property uchar red','property uchar green','property uchar blue','end_header', ...rows].join('\n'));
}

const br = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await br.newContext({ viewport: { width: 1200, height: 820 } })).newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200)); });
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 300000 });
const layers = () => p.evaluate(() => window.__app.entityList());
/** Setting the same path twice fires no change event, so clear the input first. */
const feed = async (sel, path) => { await p.setInputFiles(sel, []); await p.setInputFiles(sel, path); };

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache', 'e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });

// ---------------------------------------------------------------- a cube is a layer
await feed('#file-input', CUBE);
await p.waitForFunction(() => window.__viewer.anyMesh, null, { timeout: 60000 });
await idle();
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('IMPORT:', await p.textContent('#v-meshinfo'));
let L = await layers();
ok('the cube opened as a layer', L.length === 1 && L[0].kind === 'mesh', `${L.length} layer(s), kind ${L[0]?.kind}`);
ok('with twelve triangles', L[0].surface?.triangles === 12, `${L[0].surface?.triangles} triangles`);
ok('and the viewport is showing them', (await p.evaluate(() => window.__viewer.meshTris)) === 12, `${await p.evaluate(() => window.__viewer.meshTris)} drawn`);

let m = await p.evaluate(() => window.__app.measureActiveMesh());
console.log('MEASURE:', await p.textContent('#v-meshinfo'));
ok('a unit cube measures 6.000 m² of surface', Math.abs(m.area - 6) < 1e-4, `${m.area.toFixed(4)} m²`);
ok('and 1.000 m³ of volume', Math.abs(m.volume - 1) < 1e-4, `${m.volume.toFixed(4)} m³`);
ok('and reports itself closed', m.closed && m.boundaryEdges === 0, `${m.boundaryEdges} boundary edges, ${m.nonManifoldEdges} non-manifold`);
await p.screenshot({ path: 'shots/mesh-cube.png' });

// the transform tools move a mesh layer like they move a cloud, and the area rides along
const scaled = await p.evaluate(() => {
  const TH = window.__viewer.camera.position.constructor;
  const M = window.__viewer.cells.model.clone();
  window.__viewer.setModel(M.multiply(new (window.__viewer.cells.model.constructor)().makeScale(2, 2, 2)));
  return window.__app.measureActiveMesh();
});
ok('doubling the layer quadruples the area', Math.abs(scaled.area - 24) < 1e-3, `${scaled.area.toFixed(4)} m² against 24`);
ok('and multiplies the volume by eight', Math.abs(scaled.volume - 8) < 1e-3, `${scaled.volume.toFixed(4)} m³ against 8`);
await p.evaluate(() => window.__viewer.setModel(new (window.__viewer.cells.model.constructor)()));

// ---------------------------------------------------------------- an open mesh says so
await feed('#file-add', QUAD);
await p.waitForFunction(() => window.__app.entityList().length === 2, null, { timeout: 60000 });
await idle();
m = await p.evaluate(() => window.__app.measureActiveMesh());
ok('an open quad measures 4.000 m²', Math.abs(m.area - 4) < 1e-4, `${m.area.toFixed(4)} m²`);
ok('and reports its four boundary edges', !m.closed && m.boundaryEdges === 4, `${m.boundaryEdges} boundary edges`);
ok('both mesh layers draw at once', (await p.evaluate(() => window.__viewer.meshTris)) === 14, `${await p.evaluate(() => window.__viewer.meshTris)} triangles drawn, 12 + 2 expected`);

// ---------------------------------------------------------------- flip
const before = await p.evaluate(() => Array.from(window.__app.meshData.idx.slice(0, 3)));
await p.evaluate(() => window.__app.replaceMesh(window.__app.flipMesh(window.__app.meshData)));
const after = await p.evaluate(() => Array.from(window.__app.meshData.idx.slice(0, 3)));
ok('flipping reverses the winding', after[0] === before[0] && after[1] === before[2] && after[2] === before[1], `${before} → ${after}`);
m = await p.evaluate(() => window.__app.measureActiveMesh());
ok('and leaves the area alone', Math.abs(m.area - 4) < 1e-4, `${m.area.toFixed(4)} m²`);

// ---------------------------------------------------------------- the sphere
await feed('#file-add', SPHERE);
await p.waitForFunction(n => window.__app.entityList().length === 3 && window.__viewer.mesh.triangles === n, sphereTris, { timeout: 120000 });
await idle();
console.log('SPHERE:', await p.textContent('#v-meshinfo'));
m = await p.evaluate(() => window.__app.measureActiveMesh());
const trueArea = 4 * Math.PI * SPH.r ** 2, trueVol = (4 / 3) * Math.PI * SPH.r ** 3;
ok('a fine sphere mesh measures 4πr²', Math.abs(m.area - trueArea) / trueArea < 0.001, `${m.area.toFixed(4)} m² against ${trueArea.toFixed(4)}`);
ok('and 4/3πr³', Math.abs(m.volume - trueVol) / trueVol < 0.002, `${m.volume.toFixed(4)} m³ against ${trueVol.toFixed(4)}`);
const sphereId = await p.evaluate(() => window.__viewer.activeId);

// ---------------------------------------------------------------- sampling
const samp = await p.evaluate(() => window.__app.sampleMeshPoints({ count: 120000 }));
await idle();
console.log('SAMPLE:', await p.textContent('#v-meshinfo'));
ok('sampling makes a point layer of the size asked for', samp.points === 120000, `${samp.points} points`);
ok('and the density is the count over the real area', Math.abs(samp.density - 120000 / trueArea) / (120000 / trueArea) < 0.002,
   `${samp.density.toFixed(1)} per m² against ${(120000 / trueArea).toFixed(1)}`);
const box = await p.evaluate(() => { const b = window.__viewer.cells.bounds; return [b.min.toArray(), b.max.toArray()]; });
const span = box[1].map((v, i) => v - box[0][i]);
ok('the sampled points fill the sphere they came from', span.every(v => Math.abs(v - 2 * SPH.r) < 0.02), `${span.map(v => v.toFixed(3)).join(' × ')} m against ${(2 * SPH.r).toFixed(3)} cubed`);
const sampledRadii = await p.evaluate(c => {
  let mn = Infinity, mx = 0;
  const t = window.__app.meta.scans[0].translation;
  for (const { leaf, recs } of window.__viewer.cells.records()) {
    const u16 = new Uint16Array(recs.buffer, recs.byteOffset, (leaf.count * 14) >> 1), k = leaf.size / 65536;
    for (let i = 0; i < leaf.count; i += 7) {
      const b = i * 7;
      const d = Math.hypot(leaf.origin.x + u16[b] * k - (c[0] - t[0]), leaf.origin.y + u16[b + 1] * k - (c[1] - t[1]), leaf.origin.z + u16[b + 2] * k - (c[2] - t[2]));
      if (d < mn) mn = d; if (d > mx) mx = d;
    }
  }
  return [mn, mx];
}, SPH.c);
ok('and every one of them sits on the surface', Math.abs(sampledRadii[0] - SPH.r) < 0.002 && Math.abs(sampledRadii[1] - SPH.r) < 0.002,
   `radii ${sampledRadii[0].toFixed(4)} to ${sampledRadii[1].toFixed(4)} m against ${SPH.r}`);
await p.screenshot({ path: 'shots/mesh-sampled.png' });

// ---------------------------------------------------------------- cloud to mesh distance
await feed('#file-add', SHELL);
await p.waitForFunction(n => window.__viewer.loaded === n, NPTS, { timeout: 120000 });
await idle();
const dist = await p.evaluate(id => window.__app.distanceToMesh({ mesh: id }), sphereId);
await idle();
console.log('DISTANCE:', await p.textContent('#v-meshinfo'));
ok('the shell measures the offset it was built with', Math.abs(dist.stats.min - OFFSET) < 0.001 && Math.abs(dist.stats.max - OFFSET) < 0.003,
   `${(dist.stats.min * 1000).toFixed(2)} to ${(dist.stats.max * 1000).toFixed(2)} mm against ${OFFSET * 1000}`);
ok('every point got a value', dist.stats.values === NPTS, `${dist.stats.values} of ${NPTS}`);
ok('and it landed as a scalar field', /Distance to/.test(await p.textContent('#v-sfname')), await p.textContent('#v-sfname'));
await p.screenshot({ path: 'shots/mesh-distance.png' });

// ---------------------------------------------------------------- smooth and decimate
await p.evaluate(id => window.__app.activateEntity(id), sphereId);
await idle();
const sm = await p.evaluate(() => window.__app.smoothActiveMesh({ iterations: 10, taubin: true }));
console.log('SMOOTH:', await p.textContent('#v-meshinfo'));
ok('Taubin smoothing keeps the volume', Math.abs(sm.volumeChangePct) < 1.0, `${sm.volumeChangePct.toFixed(3)}% change over 10 passes`);
const lap = await p.evaluate(() => window.__app.smoothActiveMesh({ iterations: 10, taubin: false }));
ok('plain Laplacian shrinks it, which is why Taubin is the default', lap.volumeChangePct < -1.0, `${lap.volumeChangePct.toFixed(3)}% change over 10 passes`);

// reload a clean sphere for the decimation numbers
await feed('#file-add', SPHERE);
await p.waitForFunction(n => window.__viewer.mesh.triangles === n, sphereTris, { timeout: 120000 });
await idle();
const dec = await p.evaluate(() => window.__app.decimateActiveMesh({ cellCm: 20 }));
console.log('DECIMATE:', await p.textContent('#v-meshinfo'));
ok('decimation cuts the triangle count hard', dec.triangles < dec.before * 0.2, `${dec.before} → ${dec.triangles} triangles`);
ok('and holds the area to a few per cent', Math.abs(dec.area - trueArea) / trueArea < 0.06, `${dec.area.toFixed(4)} m² against ${trueArea.toFixed(4)}`);
await p.screenshot({ path: 'shots/mesh-decimated.png' });

// ---------------------------------------------------------------- writing files
await p.evaluate(() => { const l = window.__app.entityList().find(e => e.surface && e.surface.triangles === 12); window.__app.activateEntity(l.id); });
await idle();
for (const f of ['ply', 'obj', 'stl']) {
  const b64 = await p.evaluate(async fmt => {
    const blob = window.__app.meshBlob(fmt);
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192));
    return btoa(s);
  }, f);
  const out = join(tmpdir(), `e57view-out.${f}`);
  writeFileSync(out, Buffer.from(b64, 'base64'));
  const size = readFileSync(out).length;
  if (f === 'stl') ok('STL is the right size for twelve triangles', size === 84 + 12 * 50, `${size} bytes`);
  // read it back in and check it is still a unit cube in the same place
  await feed('#file-add', out);
  await p.waitForFunction(() => window.__viewer.mesh.triangles === 12, null, { timeout: 60000 });
  await idle();
  const rt = await p.evaluate(() => window.__app.measureActiveMesh());
  ok(`a cube written as ${f.toUpperCase()} reads back the same`, Math.abs(rt.area - 6) < 1e-3 && Math.abs(rt.volume - 1) < 1e-3,
     `area ${rt.area.toFixed(4)} m², volume ${rt.volume.toFixed(4)} m³, ${size} bytes`);
  const at = await p.evaluate(() => window.__app.measureActiveMesh().bbox);
  ok(`and in the place it was written from`, Math.abs(at.min[0] - T[0]) < 1e-3 && Math.abs(at.min[2] - T[2]) < 1e-3,
     `min ${at.min.map(v => v.toFixed(3)).join(', ')} against ${T.join(', ')}`);
}

// ---------------------------------------------------------------- the agent surface
const ag = await p.evaluate(() => window.__app.agentRun('mesh', { op: 'measure' }));
ok('an agent can measure the active mesh', Math.abs(ag.area - 6) < 1e-3 && ag.closed, `area ${ag.area} m², volume ${ag.volume} m³, closed ${ag.closed}`);
const agl = await p.evaluate(() => window.__app.agentRun('mesh', { op: 'list' }));
ok('and list the mesh layers', agl.meshes.length >= 3, `${agl.meshes.length} mesh layers`);
const agst = await p.evaluate(() => window.__app.agentRun('state', {}));
ok('state reports which layers are meshes', agst.entities.some(e => e.kind === 'mesh'), `${agst.entities.filter(e => e.kind === 'mesh').length} of ${agst.entities.length} layers`);

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
await br.close();
process.exit(fails === 0 ? 0 : 1);
