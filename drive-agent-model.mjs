// What an agent needs to model from a scan, driven the way an agent drives it: over HTTP,
// through the session mailbox, against the deployed viewer. Every check asks whether a number
// an agent would rely on is actually right, not whether a command returned something.
import { chromium } from 'playwright';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roomPly } from './room-fixture.mjs';

const URL_ = process.env.URL || 'https://opensketch.web.app/';
const ORIGIN = new URL(URL_).origin;
const ply = join(tmpdir(), 'e57view-room.ply');
const R = roomPly(ply);                      // a 6 x 4 x 3 m room, points on its inside faces
console.log(`FIXTURE a ${R.sx} x ${R.sy} x ${R.sz} m room · ${R.n} points at ${R.step} m`);

const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 200)));
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const near = (a, w, tol) => Math.abs(a - w) <= tol;

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(() => localStorage.clear());
await p.setInputFiles('#file-input', ply);
await p.waitForFunction(() => /loaded in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 90000 });
await p.waitForTimeout(900);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 3000 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
await p.bringToFront();
await p.click('#k-agenturl');
await p.waitForFunction(() => /copied with its token/.test(document.getElementById('v-agenturl')?.textContent || ''), null, { timeout: 25000 });
// the Allow edits box only unlocks once a session exists; surface build needs it
await p.click('#k-agentedits');
await p.waitForTimeout(1500);
const blob = await p.evaluate(() => navigator.clipboard.readText());
const sid = blob.match(/"session":"([a-z0-9]+)"/)[1];
const token = blob.match(/Bearer ([a-f0-9]+)/)[1];
console.log(`SESSION ${sid}`);

async function call(cmd, args = {}) {
  const post = () => fetch(`${ORIGIN}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ session: sid, cmd, args }),
  });
  let r = await post();
  let j = await r.json().catch(() => ({}));
  // a slow command answers 202 and is collected by number
  for (let i = 0; r.status === 202 && j.pending && i < 40; i++) {
    await new Promise(s => setTimeout(s, 3000));
    r = await fetch(`${ORIGIN}/agent?s=${sid}&n=${j.pending}`, { headers: { Authorization: `Bearer ${token}` } });
    const k = await r.json().catch(() => ({}));
    if (r.status === 200) { j = k; break; }
  }
  if (j.ok === false) throw new Error(`${cmd}: ${j.error}`);
  if (r.status !== 200) throw new Error(`${cmd}: http ${r.status} ${(j && Object.keys(j).length ? JSON.stringify(j) : await r.text().catch(() => '')).slice(0, 400)}`);
  return j;
}

// ---------------------------------------------------------------- state
const st = (await call('state')).result;
console.log('STATE', JSON.stringify({ points: st.points, spacing: st.medianSpacing, normals: st.hasNormals, source: st.recommendedSource.source, size: st.bounds.local.size }));
const size = st.bounds.local.size, lo = st.bounds.local.min, hi = st.bounds.local.max;
ok('units are declared', st.units === 'm', st.units);
ok('bounds match the room', near(size[0], R.sx, 0.03) && near(size[1], R.sy, 0.03) && near(size[2], R.sz, 0.03), size.map(v => v.toFixed(3)).join(' x '));
ok('global bounds are local plus the shift', st.bounds.global.min.every((v, i) => near(v, lo[i] + st.translation[i], 1e-6)), JSON.stringify(st.translation));
ok('median spacing is the scan resolution', st.medianSpacing > 0.005 && st.medianSpacing < 0.2, `${st.medianSpacing} m`);
ok('every point carries a normal', st.hasNormals > 0.99, String(st.hasNormals));
ok('with no surface it recommends the points', st.recommendedSource.source === 'points', st.recommendedSource.reason.slice(0, 70));

// ---------------------------------------------------------------- a calibrated view
const v = await call('view', { preset: 'top', width: 800 });
const map = v.result.mapping;
console.log('VIEW', JSON.stringify({ ortho: v.result.ortho, w: map.width, h: map.height, mpp: map.metresPerPixel, axes: [map.rightAxis, map.upAxis, map.viewAxis] }), `shot ${(v.shot || '').length} chars`);
ok('the top view is orthographic', v.result.ortho === true && v.result.camera.projection === 'orthographic', v.result.camera.projection);
ok('it comes with an exact mapping', map.metresPerPixel > 0 && map.rightAxis === '+x' && map.upAxis === '+y' && map.viewAxis === '-z', `${map.metresPerPixel.toFixed(5)} m/px`);
ok('the extent covers the room', near(map.extentX, size[0], size[0] * 0.1) && map.extentX >= size[0], `${map.extentX.toFixed(3)} vs ${size[0].toFixed(3)} m`);
ok('an image came back with it', (v.shot || '').length > 5000 && v.result.image.parts === 1, `${v.result.image.chars} chars`);

// ---------------------------------------------------------------- probe against the mapping
const cx = Math.round(map.width / 2), cy = Math.round(map.height / 2), dx = 100;
const pr = (await call('probe', { pixels: [[cx, cy], [cx + dx, cy], [cx, cy + dx]] })).result;
const [a0, a1, a2] = pr.points;
ok('probe returns world points for those pixels', !!a0 && !!a1 && !!a2, JSON.stringify(a0?.local));
const measured = Math.hypot(a1.local[0] - a0.local[0], a1.local[1] - a0.local[1]);
const predicted = dx * map.metresPerPixel;
ok('100 px across is metresPerPixel x 100', near(measured, predicted, 0.002), `${measured.toFixed(4)} m measured, ${predicted.toFixed(4)} predicted`);
const down = Math.hypot(a2.local[0] - a0.local[0], a2.local[1] - a0.local[1]);
ok('and 100 px down the image is the same distance', near(down, predicted, 0.002), `${down.toFixed(4)} m`);
ok('the top view hits the ceiling', near(a0.local[2], hi[2], 0.05), `z ${a0.local[2].toFixed(3)} of ${hi[2].toFixed(3)}`);
ok('probe also gives global coordinates', a0.global.every((g, i) => near(g, a0.local[i] + st.translation[i], 1e-5)), a0.global.map(n => n.toFixed(3)).join(', '));
// the mapping read the other way must agree with the probe
const fromMap = [map.originX + (cx + 0.5) * map.metresPerPixel, map.originY + (map.height - 0.5 - cy) * map.metresPerPixel];
ok('originX/originY agree with the probe', near(fromMap[0], a0.local[0], 0.01) && near(fromMap[1], a0.local[1], 0.01),
   `${fromMap.map(n => n.toFixed(3))} vs ${a0.local.slice(0, 2).map(n => n.toFixed(3))}`);

// ---------------------------------------------------------------- section and contour
const mid = (lo[2] + hi[2]) / 2;
const sec = (await call('section', { axis: 'z', at: mid, thickness: 0.3, width: 700 })).result;
console.log('SECTION', JSON.stringify({ axis: sec.axis, at: sec.at, thickness: sec.thickness, mpp: sec.mapping.metresPerPixel }));
ok('the section is orthographic too', sec.camera.projection === 'orthographic' && sec.mapping.viewAxis === '-z', sec.mapping.viewAxis);
ok('it echoes the slab it drew', near(sec.at, mid, 1e-3) && near(sec.thickness, 0.3, 1e-6), `${sec.at} +/- ${sec.thickness / 2}`);
const con = (await call('contour', { z: mid, thickness: 0.3, resolution: 300 })).result;
console.log('CONTOUR', JSON.stringify({ inSlab: con.inSlab, polylines: con.polylines.length, vertices: con.vertices, closed: con.closedPolylines, bounds: con.bounds }));
ok('the slab was traced into closed polylines', con.polylines.length >= 1 && con.closedPolylines >= 1 && con.vertices >= 4, `${con.polylines.length} polylines, ${con.vertices} vertices`);
ok('the footprint matches the room within a few cm',
   near(con.bounds.min[0], lo[0], 0.08) && near(con.bounds.min[1], lo[1], 0.08) &&
   near(con.bounds.max[0], hi[0], 0.08) && near(con.bounds.max[1], hi[1], 0.08),
   `${con.bounds.min.map(n => n.toFixed(3))} … ${con.bounds.max.map(n => n.toFixed(3))} vs 0,0 … ${hi.slice(0, 2).map(n => n.toFixed(3))}`);
ok('and it is metres, not pixels', con.frame.includes('local metres'), con.frame);

// ---------------------------------------------------------------- planes
const wall = (await call('fitplane', { box: { center: [lo[0], (lo[1] + hi[1]) / 2, mid], half: [0.06, (hi[1] - lo[1]) / 2 - 0.3, (hi[2] - lo[2]) / 2 - 0.5] } })).result;
console.log('FITPLANE wall', JSON.stringify({ normal: wall.normal, rms: wall.rms, dip: wall.dipDeg, n: wall.points }));
ok('a wall fits a vertical plane', Math.abs(wall.normal[2]) < 0.02 && wall.orientation === 'vertical', `normal ${wall.normal.map(n => n.toFixed(3))}`);
ok('and it is flat to under 5 mm', wall.rms < 0.005 && wall.points > 500, `rms ${(wall.rms * 1000).toFixed(2)} mm over ${wall.points} points`);
ok('dip is 90 degrees on a wall', near(wall.dipDeg, 90, 0.5), `${wall.dipDeg.toFixed(2)}°`);
const floor = (await call('fitplane', { box: { center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2] + 0.01], half: [(hi[0] - lo[0]) / 2 - 0.3, (hi[1] - lo[1]) / 2 - 0.3, 0.03] } })).result;
ok('a floor fits a horizontal plane', Math.abs(floor.normal[2]) > 0.999 && floor.orientation === 'horizontal' && floor.rms < 0.005,
   `normal ${floor.normal.map(n => n.toFixed(3))} rms ${(floor.rms * 1000).toFixed(2)} mm`);

// ---------------------------------------------------------------- rasters and counts
const hm = (await call('heightmap', { resolution: 240 })).result;
console.log('HEIGHTMAP', JSON.stringify({ w: hm.mapping.width, h: hm.mapping.height, mpp: hm.mapping.metresPerPixel, zMin: hm.zMin, zMax: hm.zMax, filled: hm.filledCells }));
ok('the height model spans the room height', near(hm.zMin, lo[2], 0.05) && near(hm.zMax, hi[2], 0.05), `${hm.zMin.toFixed(3)} … ${hm.zMax.toFixed(3)} m`);
ok('its mapping covers the plan extent', near(hm.mapping.extentX, size[0], 0.1) && near(hm.mapping.originX, lo[0], 0.01), `${hm.mapping.extentX.toFixed(3)} m wide from ${hm.mapping.originX}`);
ok('and a PNG came with it', (hm.shot || '').length > 0 || (await call('heightmap', { resolution: 240 })).shot.length > 1000, `${hm.image.chars} chars, ${hm.image.mime}`);

const ins = (await call('inside', { box: { center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2] + 0.01], half: [4, 3, 0.03] } })).result;
const wantFloor = Math.round(R.sx / R.step + 1) * Math.round(R.sy / R.step + 1);
ok('inside counts the floor exactly', ins.exact === true && near(ins.count, wantFloor, wantFloor * 0.05), `${ins.count} of ${st.points}, floor grid is ${wantFloor}`);
const di = (await call('distance', { a: lo, b: hi })).result;
ok('distance is euclidean with its height difference', near(di.distance, Math.hypot(...size), 0.01) && near(di.dz, size[2], 0.01), `${di.distance.toFixed(3)} m, dz ${di.dz.toFixed(3)}`);

// ---------------------------------------------------------------- the surface, and which to trust
const bs = (await call('surface', { op: 'build', voxelCm: 6, smooth: 1, fillGaps: 2 })).result;
console.log('BUILD', JSON.stringify({ triangles: bs.triangles, holeRatio: bs.surface?.holeRatio, fromNormals: bs.surface?.fromNormals }));
ok('a surface was built from the normals', bs.triangles > 5000 && bs.surface.fromNormals === true, `${bs.triangles} triangles`);
ok('and it is nearly closed', bs.surface.holeRatio < 0.2, `hole ratio ${bs.surface.holeRatio} (${bs.surface.boundaryEdges} boundary edges)`);
const st2 = (await call('state')).result;
ok('recommendedSource flips to the mesh', st2.recommendedSource.source === 'mesh', st2.recommendedSource.reason.slice(0, 90));

const ex0 = (await call('surface', { op: 'export', format: 'ply', part: 0 })).result;
console.log('EXPORT', JSON.stringify({ bytes: ex0.bytes, parts: ex0.parts, chars: ex0.chars }));
ok('a big export is paged, not dropped', ex0.parts > 1 && ex0.data.length > 1000, `${ex0.parts} parts of <= ${ex0.chars} chars`);
let all = ex0.data;
for (let i = 1; i < ex0.parts; i++) {
  const part = (await call('surface', { op: 'export', format: 'ply', part: i })).result;
  if (part.part !== i) { ok(`part ${i} is the part asked for`, false, `got ${part.part}`); break; }
  all += part.data;
}
const buf = Buffer.from(all, 'base64');
const head = buf.subarray(0, 400).toString('latin1');
const verts = Number(/element vertex (\d+)/.exec(head)?.[1] ?? 0);
const faces = Number(/element face (\d+)/.exec(head)?.[1] ?? 0);
console.log('PLY', JSON.stringify({ bytes: buf.length, verts, faces }));
ok('the parts reassemble into the file', buf.length === ex0.bytes, `${buf.length} of ${ex0.bytes} bytes`);
ok('and it is a valid PLY of that surface', head.startsWith('ply\n') && verts === bs.surface.vertices && faces === bs.surface.triangles, `${verts} verts, ${faces} faces`);

// the surface export bakes the global shift, so its coordinates are absolute
const hdrEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
const first = [0, 1, 2].map(i => buf.readDoubleLE(hdrEnd + i * 8));
ok('its coordinates are global', first.every((c, i) => c > st.translation[i] - 1 && c < st.translation[i] + Math.max(...size) + 1), first.map(n => n.toFixed(3)).join(', '));

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(fails ? 1 : 0);
