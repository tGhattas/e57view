// Registration: put one cloud on top of another and then measure what is left between them.
import { chromium } from 'playwright';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roomPly } from './room-fixture.mjs';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
const ply = join(tmpdir(), 'e57view-room.ply');
const R = roomPly(ply);
console.log(`FIXTURE a ${R.sx} x ${R.sy} x ${R.sz} m room · ${R.n} points, loaded twice`);

const br = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await br.newContext({ viewport: { width: 1280, height: 840 } })).newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200)); });
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 600000 });
const layers = () => p.evaluate(() => window.__app.entityList());
const named = async (n) => (await layers()).find(l => l.name === n);
const activate = (name) => p.evaluate(nm => window.__app.activateEntity(window.__app.entities.find(x => x.name === nm).id), name);
const rename = (i, name) => p.evaluate(([k, nm]) => { window.__app.entities[k].name = nm; window.__app.renderLayers(); }, [i, name]);
/** The box the registration tools themselves compare: measured the same way for every layer. */
const measured = (name) => p.evaluate(nm => {
  const e = window.__app.entities.find(x => x.name === nm);
  const b = window.__viewer.measuredBox(e);
  return { min: b.min.toArray(), max: b.max.toArray() };
}, name);
const settle = async (n) => { await p.waitForFunction(c => window.__viewer.loadedAll === c, n, { timeout: 120000 }); await p.waitForTimeout(500); };

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { window.showSaveFilePicker = undefined; localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache', 'e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });
await p.setInputFiles('#file-input', ply);
await settle(R.n);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
await p.setInputFiles('#file-add', ply);
await settle(R.n * 2);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
await rename(0, 'Reference'); await rename(1, 'Moving');
console.log('LAYERS', JSON.stringify((await layers()).map(l => ({ n: l.name, pts: l.points }))));
ok('the same room is open twice', (await layers()).length === 2 && (await layers()).every(l => l.points === R.n), `${(await layers()).length} layers`);

// ---------------------------------------------------------------- put the moving copy out of place
const KNOWN = { deg: 2, t: [0.15, -0.08, 0.05] };
await activate('Moving'); await p.waitForTimeout(300);
await p.evaluate((k) => {
  const v = window.__viewer, TH = v.camera.position.constructor;
  const c = v.bounds().getCenter(new TH());
  const M4 = window.__app.fromRowMajor([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).constructor;
  const rot = new M4().makeRotationZ(k.deg * Math.PI / 180);
  const about = new M4().makeTranslation(c.x, c.y, c.z).multiply(rot).multiply(new M4().makeTranslation(-c.x, -c.y, -c.z));
  const m = new M4().makeTranslation(k.t[0], k.t[1], k.t[2]).multiply(about);
  return window.__app.commitTransform(m, 'knock it out of place');
}, KNOWN);
await idle();
const off = await p.evaluate(() => window.__app.transformState());
console.log('KNOCKED', JSON.stringify({ rot: off.rotationDeg, t: off.translation }));
ok('the moving copy is off by a known amount', Math.abs(off.rotationDeg - KNOWN.deg) < 0.01, `${off.rotationDeg.toFixed(3)}°`);

// ---------------------------------------------------------------- coarse: match centres
await p.evaluate(() => window.__app.setReference('Reference'));
const cBefore = await measured('Moving'), refBox = await measured('Reference');
const dBefore = Math.hypot(...[0, 1, 2].map(a => (cBefore.min[a] + cBefore.max[a]) / 2 - (refBox.min[a] + refBox.max[a]) / 2));
await p.click('#k-regcentres'); await idle();
const cAfter = await measured('Moving');
const dAfter = Math.hypot(...[0, 1, 2].map(a => (cAfter.min[a] + cAfter.max[a]) / 2 - (refBox.min[a] + refBox.max[a]) / 2));
console.log('CENTRES', await p.textContent('#v-register'));
ok('Match centres brings the centres together', dAfter < 1e-3 && dBefore > 0.05, `${(dBefore * 1000).toFixed(1)} mm apart, then ${(dAfter * 1000).toFixed(3)} mm`);
const centLabel = await p.evaluate(() => window.__app.hist.peekUndo()?.label ?? '');
ok('and it is one undo step', centLabel.startsWith('Match centres'), centLabel);

// ---------------------------------------------------------------- fine: ICP
const t0 = Date.now();
const icp = await p.evaluate(() => window.__app.runIcp());
await idle();
console.log(`ICP ${((Date.now() - t0) / 1000).toFixed(1)}s ·`, await p.textContent('#v-register'));
console.log('RMS history (mm)', (icp.rmsHistory ?? []).map(v => +(v * 1000).toFixed(2)).join(' -> '));
ok('ICP ran and reported its progress', icp && icp.rmsHistory?.length >= 2 && icp.pairs > 1000, `${icp?.iterations} iterations, ${icp?.pairs} pairs`);
ok('the RMS came down', icp.rms < icp.rmsHistory[0] * 0.2, `${(icp.rmsHistory[0] * 1000).toFixed(2)} mm to ${(icp.rms * 1000).toFixed(2)} mm`);
ok('the final RMS is sub-millimetre', icp.rms < 0.001, `${(icp.rms * 1000).toFixed(3)} mm`);
ok('most of the sample found a pair', icp.overlap > 0.9, `${(icp.overlap * 100).toFixed(0)}% overlap`);
const icpLabel = await p.evaluate(() => window.__app.hist.peekUndo()?.label ?? '');
ok('the label records what it achieved', /^ICP: RMS .* mm, \d+% overlap$/.test(icpLabel), icpLabel);

// the recovered transform has to be the inverse of what was applied: the moving layer's
// matrix should be back to the identity
const finalM = await p.evaluate(() => window.__app.transformState());
const res = (() => {
  const m = finalM.matrix;
  const trans = Math.hypot(m[3], m[7], m[11]);
  const tr = Math.max(-1, Math.min(3, m[0] + m[5] + m[10]));
  const ang = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180 / Math.PI;
  return { trans, ang };
})();
console.log('RESIDUAL', JSON.stringify({ mm: +(res.trans * 1000).toFixed(3), deg: +res.ang.toFixed(4) }));
ok('the recovered matrix inverts the known one', res.trans < 0.001 && res.ang < 0.05,
   `${(res.trans * 1000).toFixed(3)} mm and ${res.ang.toFixed(4)}° from the identity`);
await p.screenshot({ path: 'shots/register-icp.png' });

// ---------------------------------------------------------------- what is left between them
const dist = await p.evaluate(() => window.__app.distanceToReference(false));
await idle();
console.log('DISTANCE ·', await p.textContent('#v-register'));
const sf = await p.evaluate(() => ({ s: window.__app.sfStats, name: document.getElementById('v-sfname').textContent, mode: window.__viewer.knobs.colorMode }));
ok('the distance became a scalar field on the active layer', /^Distance to Reference/.test(sf.name ?? ''), (sf.name ?? '').slice(0, 40));
ok('every point got a value', sf.s && sf.s.n > R.n * 0.97, `${sf.s?.n} of ${R.n}`);
ok('and the two clouds agree to a few mm', sf.s && sf.s.max < 0.004, `worst ${(sf.s.max * 1000).toFixed(2)} mm, median near ${(sf.s.min * 1000).toFixed(2)}`);
ok('the colour ramp switched to it', sf.mode === 5, String(sf.mode));

// signed, and against a deliberately displaced copy, so the sign has something to say
await p.evaluate(() => {
  const cur = window.__app.fromRowMajor(window.__app.transformState().matrix);
  const M4 = cur.constructor;
  return window.__app.commitTransform(new M4().makeTranslation(0, 0, 0.02).multiply(cur), 'lift 20 mm');
});
await idle();
const signed = await p.evaluate(() => window.__app.distanceToReference(true));
await idle();
const sf2 = await p.evaluate(() => window.__app.sfStats);
console.log('SIGNED', JSON.stringify({ min: +(sf2.min * 1000).toFixed(2), max: +(sf2.max * 1000).toFixed(2) }));
ok('a signed distance reports both sides of the surface', sf2.min < -0.005 && sf2.max > 0.005,
   `${(sf2.min * 1000).toFixed(1)} to ${(sf2.max * 1000).toFixed(1)} mm after a 20 mm lift`);
await p.click('#tb-undo'); await idle();

// ---------------------------------------------------------------- Match scales, on its own
// Not in the sequence above: two copies of the same room differ in bounding box as soon as one
// of them is rotated, and matching those boxes would bake in a scale error that a rigid fit
// cannot undo. This is the tool for two clouds in different units.
const sizeOf = async (n) => { const b = await measured(n); return [0, 1, 2].map(a => b.max[a] - b.min[a]); };
await p.evaluate(() => {
  const v = window.__viewer, TH = v.camera.position.constructor;
  const c = v.bounds().getCenter(new TH());
  const cur = window.__app.fromRowMajor(window.__app.transformState().matrix);
  const M4 = cur.constructor;
  const about = new M4().makeTranslation(c.x, c.y, c.z).multiply(new M4().makeScale(1.05, 1.05, 1.05)).multiply(new M4().makeTranslation(-c.x, -c.y, -c.z));
  return window.__app.commitTransform(about.multiply(cur), 'blow it up 5%');
});
await idle();
const big = await sizeOf('Moving'), refSize = await sizeOf('Reference');
ok('the moving copy is 5% too big', Math.abs(big[0] / refSize[0] - 1.05) < 0.01, `${(big[0] / refSize[0]).toFixed(4)}x`);
await p.click('#k-regscales'); await idle();
console.log('SCALES', await p.textContent('#v-register'));
const fixed = await sizeOf('Moving');
ok('Match scales brings it back', [0, 1, 2].every(a => Math.abs(fixed[a] / refSize[a] - 1) < 0.01),
   `${[0, 1, 2].map(a => (fixed[a] / refSize[a]).toFixed(4)).join(', ')}x`);
await p.click('#tb-undo'); await idle();
await p.click('#tb-undo'); await idle();

// ---------------------------------------------------------------- through the agent
const viaAgent = await p.evaluate(async () => {
  document.getElementById('k-agentedits').disabled = false;
  document.getElementById('k-agentedits').checked = true;
  const cur = window.__app.fromRowMajor(window.__app.transformState().matrix);
  const M4 = cur.constructor;
  await window.__app.commitTransform(new M4().makeTranslation(0.05, 0.03, 0).multiply(cur), 'nudge');
  const r = await window.__app.dispatchAgent('register', { op: 'icp', reference: 'Reference' });
  return r.result;
});
await idle();
console.log('AGENT ICP', JSON.stringify({ rmsMm: viaAgent.rmsMm, overlap: viaAgent.overlap, iterations: viaAgent.iterations }));
ok('an agent can run ICP and read the result', viaAgent.rmsMm !== null && viaAgent.rmsMm < 1 && Array.isArray(viaAgent.matrix), `${viaAgent.rmsMm} mm`);
const agentRes = await p.evaluate(() => window.__app.transformState().matrix);
ok('and it lands back on the reference', Math.hypot(agentRes[3], agentRes[7], agentRes[11]) < 0.001,
   `${(Math.hypot(agentRes[3], agentRes[7], agentRes[11]) * 1000).toFixed(3)} mm from the identity`);
const agentList = await p.evaluate(() => window.__app.dispatchAgent('entities', { op: 'list' }));
ok('the agent sees both layers with their transforms', agentList.result.entities.length === 2 && agentList.result.entities.every(e => e.transform.length === 16), `${agentList.result.entities.length} layers`);

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await br.close();
process.exit(fails ? 1 : 0);
