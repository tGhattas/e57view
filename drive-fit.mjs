// Fitting primitives to what a region holds, and finding shapes without being told where.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
mkdirSync('shots', { recursive: true });
// a room: floor and two walls, with a 0.5 m ball sitting in it and a pipe along one wall
const rows = [];
const add = (x, y, z, n) => rows.push(`${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} ${n[0].toFixed(3)} ${n[1].toFixed(3)} ${n[2].toFixed(3)} 190 180 160`);
const S = 0.05;
for (let i = 0; i <= 120; i++) for (let j = 0; j <= 80; j++) add(10 + i * S, 20 + j * S, 30, [0, 0, 1]);          // floor 6 x 4
for (let i = 0; i <= 120; i++) for (let k = 1; k <= 50; k++) add(10 + i * S, 20, 30 + k * S, [0, 1, 0]);          // wall y=20
for (let j = 1; j <= 80; j++) for (let k = 1; k <= 50; k++) add(10, 20 + j * S, 30 + k * S, [1, 0, 0]);           // wall x=10
const BALL = { c: [13, 22.5, 30.8], r: 0.5 };
let ballN = 0;
for (let i = 0; i < 12000; i++) {
  const y = 1 - (i / 11999) * 2, rad = Math.sqrt(Math.max(0, 1 - y * y)), th = Math.PI * (3 - Math.sqrt(5)) * i;
  const d = [Math.cos(th) * rad, y, Math.sin(th) * rad];
  add(BALL.c[0] + d[0] * BALL.r, BALL.c[1] + d[1] * BALL.r, BALL.c[2] + d[2] * BALL.r, d); ballN++;
}
const PIPE = { c: [14.5, 23.2, 31.2], r: 0.15, len: 2.4 };
let pipeN = 0;
for (let i = 0; i <= 160; i++) for (let k = 0; k < 40; k++) {
  const t = -PIPE.len / 2 + PIPE.len * (i / 160), a = 2 * Math.PI * (k / 40);
  const n = [Math.cos(a), 0, Math.sin(a)];
  add(PIPE.c[0] + n[0] * PIPE.r, PIPE.c[1] + t, PIPE.c[2] + n[2] * PIPE.r, n); pipeN++;
}
// A scattering of noise for the detector to leave alone, kept clear of every planted shape:
// a fit over a region that also contains noise *should* report a worse residual, so mixing
// them would be testing the wrong thing.
let NOISE = 0;
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
// the three boxes the fits below use, so the noise never lands inside one of them
const FIT_BOXES = [
  { c: [13, 22, 30], h: [2.5, 1.8, 0.02] },
  { c: BALL.c, h: [0.62, 0.62, 0.62] },
  { c: PIPE.c, h: [0.25, 1.4, 0.25] },
];
const inBox = (q, b) => [0, 1, 2].every(a => Math.abs(q[a] - b.c[a]) <= b.h[a] + 0.05);
while (NOISE < 2000) {
  const q = [11 + rnd() * 4, 21 + rnd() * 2.5, 30.6 + rnd() * 1.6];
  if (FIT_BOXES.some(b => inBox(q, b))) continue;
  add(q[0], q[1], q[2], [0, 0, 1]); NOISE++;
}
const TOTAL = rows.length;
const ply = join(tmpdir(), 'e57view-fit.ply');
writeFileSync(ply, ['ply', 'format ascii 1.0', `element vertex ${TOTAL}`,
  'property float x', 'property float y', 'property float z',
  'property float nx', 'property float ny', 'property float nz',
  'property uchar red', 'property uchar green', 'property uchar blue', 'end_header', ...rows].join('\n'));

const br = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await br.newContext({ viewport: { width: 1200, height: 820 } })).newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200)); });
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 300000 });
const loaded = () => p.evaluate(() => window.__viewer.loaded);
/** Put a region over a world box, so a fit sees only what is inside it. */
const region = (centre, half) => p.evaluate(([c, h]) => {
  for (const s of [...window.__app.sections]) window.__app.sections.splice(0, window.__app.sections.length);
  const v = window.__viewer, TH = v.camera.position.constructor;
  const r = window.__app.placeRegion(new TH(c[0], c[1], c[2]), 'box');
  r.half = h; window.__app.syncRegions(); window.__app.renderSectionList();
  return window.__viewer.cells.insideExact(r).count;
}, [centre, half]);
const local = (g) => p.evaluate(w => { const t = window.__app.meta.scans[0].translation; return w.map((v, i) => v - t[i]); }, g);

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache', 'e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });
await p.setInputFiles('#file-input', ply);
await p.waitForFunction(c => window.__viewer.loaded === c, TOTAL, { timeout: 120000 });
await p.waitForTimeout(900);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('LOAD:', await p.textContent('#tb-points'), `· ${TOTAL} points`);

// ---------------------------------------------------------------- plane
const floorC = await local([13, 22, 30]);
const n0 = await region(floorC, [2.5, 1.8, 0.02]);
ok('a region over the floor holds it', n0 > 5000, `${n0} points of the floor's 9,801`);
let r = await p.evaluate(() => window.__app.fitShape('plane'));
await idle();
console.log('PLANE', await p.textContent('#v-fit'));
ok('the floor fits a horizontal plane', Math.abs(Math.abs(r.normal[2]) - 1) < 1e-4, `normal ${r.normal.map(v => v.toFixed(4))}`);
ok('and it is flat to well under a millimetre', r.rms < 0.0005, `RMS ${(r.rms * 1000).toFixed(4)} mm over ${r.points} points`);
ok('the fitted shape is drawn', await p.evaluate(() => window.__viewer.hasPrimitive), '');
await p.screenshot({ path: 'shots/fit-plane.png' });

// ---------------------------------------------------------------- sphere
const ballC = await local(BALL.c);
const nb = await region(ballC, [0.62, 0.62, 0.62]);
ok('a region over the ball holds it', Math.abs(nb - ballN) < ballN * 0.05, `${nb} of ${ballN} ball points`);
r = await p.evaluate(() => window.__app.fitShape('sphere'));
await idle();
console.log('SPHERE', await p.textContent('#v-fit'));
ok('the ball fits a sphere of the right radius', Math.abs(r.radius - BALL.r) < 0.001, `r ${r.radius.toFixed(5)} m against ${BALL.r}`);
ok('and at the right centre', Math.hypot(...r.centre.map((v, i) => v - ballC[i])) < 0.001, `${(Math.hypot(...r.centre.map((v, i) => v - ballC[i])) * 1000).toFixed(3)} mm off`);
ok('with a sub-millimetre residual', r.rms < 0.001, `RMS ${(r.rms * 1000).toFixed(3)} mm`);

// ---------------------------------------------------------------- cylinder
const pipeC = await local(PIPE.c);
const np = await region(pipeC, [0.25, 1.4, 0.25]);
ok('a region over the pipe holds it', Math.abs(np - pipeN) < pipeN * 0.05, `${np} of ${pipeN} pipe points`);
r = await p.evaluate(() => window.__app.fitShape('cylinder'));
await idle();
console.log('CYLINDER', await p.textContent('#v-fit'));
const axDot = Math.abs(r.axis[1]);
ok('the pipe fits a cylinder along Y', Math.acos(Math.min(1, axDot)) * 180 / Math.PI < 0.1, `${(Math.acos(Math.min(1, axDot)) * 180 / Math.PI).toFixed(4)}° off the Y axis`);
ok('with the right radius', Math.abs(r.radius - PIPE.r) < 0.001, `r ${r.radius.toFixed(5)} m against ${PIPE.r}`);
ok('and the right length', Math.abs(r.length - PIPE.len) < 0.05, `${r.length.toFixed(3)} m against ${PIPE.len}`);
await p.screenshot({ path: 'shots/fit-cylinder.png' });

// ---------------------------------------------------------------- a bad fit says so
r = await p.evaluate(() => window.__app.fitShape('sphere'));
await idle();
ok('a sphere fitted to a pipe is reported as a bad fit', !r || r.rms > 0.01, r ? `RMS ${(r.rms * 1000).toFixed(1)} mm, against 0.4 mm for the right shape` : 'refused');

// ---------------------------------------------------------------- detect
await p.evaluate(() => { window.__app.sections.splice(0, window.__app.sections.length); window.__app.syncRegions(); window.__app.renderSectionList(); window.__viewer.setActiveRegion(null); });
const det = await p.evaluate(() => window.__app.detectShapes({ tol: 0.006, minPts: 3000, kinds: 'plane,sphere,cylinder' }));
await idle();
console.log('DETECT', await p.textContent('#v-fit'));
for (const s of det) console.log(`   ${s.shape} · ${s.points} pts · RMS ${(s.rms * 1000).toFixed(2)} mm`);
ok('it finds the three planes', det.filter(s => s.shape === 'plane').length >= 3, `${det.filter(s => s.shape === 'plane').length} planes of ${det.length} shapes`);
const ball = det.find(s => s.shape === 'sphere');
ok('and the ball', !!ball && Math.abs(ball.radius - BALL.r) < 0.01, ball ? `r ${ball.radius.toFixed(4)} m` : 'not found');
ok('the ball it found is where the ball is', !!ball && Math.hypot(...ball.centre.map((v, i) => v - ballC[i])) < 0.01,
   ball ? `${(Math.hypot(...ball.centre.map((v, i) => v - ballC[i])) * 1000).toFixed(1)} mm off` : '');
const cyl = det.find(s => s.shape === 'cylinder');
ok('and the pipe', !!cyl && Math.abs(cyl.radius - PIPE.r) < 0.02, cyl ? `r ${cyl.radius.toFixed(4)} m against ${PIPE.r}` : 'not found');
const sf = await p.evaluate(() => ({ name: document.getElementById('v-sfname').textContent, s: window.__app.sfStats, mode: window.__viewer.knobs.colorMode }));
ok('every inlier got a shape index, and the noise none', /^Shape/.test(sf.name ?? '') && sf.s && sf.s.n > (TOTAL - NOISE) * 0.97 && sf.s.n < TOTAL - NOISE * 0.5,
   `${sf.s?.n} labelled of ${TOTAL - NOISE} real points, with ${NOISE} noise points present`);
ok('the rows list what was found', (await p.evaluate(() => document.querySelectorAll('#det-list li').length)) === det.length, `${await p.evaluate(() => document.querySelectorAll('#det-list li').length)} rows`);
await p.screenshot({ path: 'shots/fit-detected.png' });

// ---------------------------------------------------------------- keep and remove inliers
const before = await loaded();
// the mask asks for confirmation, so the call cannot be awaited before the dialog is answered
const masking = p.evaluate(() => window.__app.applyShapeMask(false));
await p.waitForSelector('#modal:not(.hidden)'); await p.click('#modal-btns button.danger'); await masking; await idle();
const afterRemove = await loaded();
ok('removing the inliers leaves the noise behind', afterRemove > NOISE * 0.5 && afterRemove < NOISE * 1.5, `${afterRemove} left of ${before}, against ${NOISE} noise points`);
await p.click('#tb-undo'); await idle();
ok('and it undoes', await loaded() === before, `${await loaded()}`);

// ---------------------------------------------------------------- the agent
const viaAgent = await p.evaluate(async () => {
  const t = window.__app.meta.scans[0].translation;
  const c = [13 - t[0], 22 - t[1], 30 - t[2]];
  const r = await window.__app.dispatchAgent('fit', { shape: 'plane', box: { center: c, half: [2.5, 1.8, 0.02] } });
  return r.result;
});
ok('an agent can fit inside a box it gives', Math.abs(Math.abs(viaAgent.normal[2]) - 1) < 1e-4 && viaAgent.rms < 0.0005,
   `normal ${viaAgent.normal.map(v => v.toFixed(3))} RMS ${(viaAgent.rms * 1000).toFixed(4)} mm`);

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await br.close();
process.exit(fails ? 1 : 0);
