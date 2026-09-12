// SPDX-License-Identifier: GPL-3.0-only
// Two clouds open at once: what is drawn, what the tools act on, and what merging preserves.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
function grid(path, n, x0, y0, z) {
  const L = ['ply', 'format ascii 1.0', `element vertex ${n * n}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
    L.push(`${(x0 + i * 0.05).toFixed(4)} ${(y0 + j * 0.05).toFixed(4)} ${z.toFixed(4)} 190 180 160`);
  writeFileSync(path, L.join('\n'));
  return n * n;
}
const A = join(tmpdir(), 'e57view-ent-a.ply'), B = join(tmpdir(), 'e57view-ent-b.ply');
const NA = grid(A, 90, 10, 10, 20), NB = grid(B, 50, 30, 10, 20);
mkdirSync('shots', { recursive: true });

const br = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await br.newContext({ viewport: { width: 1280, height: 840 } })).newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200)); });
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 300000 });
const layers = () => p.evaluate(() => window.__app.entityList());
const loaded = () => p.evaluate(() => window.__viewer.loaded);
const loadedAll = () => p.evaluate(() => window.__viewer.loadedAll);
const settle = async (n) => { await p.waitForFunction(c => window.__viewer.loadedAll === c, n, { timeout: 120000 }); await p.waitForTimeout(500); };

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { window.showSaveFilePicker = undefined; localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache', 'e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });
await p.setInputFiles('#file-input', A);
await settle(NA);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('LOAD A:', await p.textContent('#tb-points'));
ok('one layer to begin with', (await layers()).length === 1 && (await layers())[0].active, JSON.stringify((await layers()).map(l => l.name)));

// ---------------------------------------------------------------- add a second scan
await p.setInputFiles('#file-add', B);
await settle(NA + NB);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
let ls = await layers();
console.log('LAYERS', JSON.stringify(ls.map(l => ({ n: l.name, pts: l.points, act: l.active, vis: l.visible }))));
ok('Add file… adds a layer instead of replacing', ls.length === 2 && ls[0].points === NA && ls[1].points === NB, `${ls.length} layers`);
ok('the new one is active', ls[1].active && !ls[0].active, ls.find(l => l.active)?.name);
ok('no dialog was needed', !(await p.evaluate(() => !document.getElementById('modal').classList.contains('hidden'))), '');
ok('tools see only the active layer', await loaded() === NB, `${await loaded()} of ${await loadedAll()}`);
ok('the top bar names the active layer', !(await p.evaluate(() => document.getElementById('tb-layer').classList.contains('hidden'))), await p.textContent('#tb-layer'));

// both are drawn into the same frame
await p.evaluate(() => { window.__viewer.fit(); window.__viewer.touch(); window.__viewer.render(); });
await p.waitForTimeout(400);
const stats = await p.evaluate(() => { window.__viewer.dirty = true; window.__viewer.render(); return { ...window.__viewer.stats }; });
console.log('FRAME', JSON.stringify(stats));
ok('one frame draws both layers', stats.pointsTotal === NA + NB && stats.pointsDrawn > (NA + NB) * 0.5, `${stats.pointsDrawn} of ${stats.pointsTotal} drawn`);
const fitBox = await p.evaluate(() => { const b = window.__viewer.visibleBounds(); return { min: b.min.toArray(), max: b.max.toArray() }; });
ok('fitting spans both', fitBox.max[0] - fitBox.min[0] > 20, `${(fitBox.max[0] - fitBox.min[0]).toFixed(2)} m wide`);
await p.screenshot({ path: 'shots/entities-two.png' });

// ---------------------------------------------------------------- visibility
await p.evaluate(() => document.querySelector('#layer-list li .eye').click());
await p.waitForTimeout(300);
ls = await layers();
ok('the eye hides a layer', !ls[0].visible && (await p.evaluate(() => window.__viewer.visibleEntities.length)) === 1, JSON.stringify(ls.map(l => l.visible)));
const hiddenStats = await p.evaluate(() => { window.__viewer.dirty = true; window.__viewer.render(); return { ...window.__viewer.stats }; });
ok('a hidden layer is not drawn', hiddenStats.pointsTotal === NB, `${hiddenStats.pointsTotal} points in the frame`);
ok('but its points are still in memory', (await layers())[0].points === NA, `${(await layers())[0].points}`);
await p.evaluate(() => document.querySelector('#layer-list li .eye').click());
await p.waitForTimeout(300);

// ---------------------------------------------------------------- activate, rename
await p.evaluate(() => document.querySelectorAll('#layer-list li .nm')[0].click());
await p.waitForTimeout(400);
ok('clicking a name makes it active', await loaded() === NA && (await layers())[0].active, `${await loaded()} points active`);
const ren = await p.evaluate(() => window.__app.dispatchAgent('entities', { op: 'rename', id: window.__app.entities[1].id, name: 'Second pass' }));
ok('an agent can rename a layer', ren.result.entities[1].name === 'Second pass', ren.result.entities.map(e => e.name).join(', '));

// ---------------------------------------------------------------- clone
await p.evaluate(() => document.getElementById('k-layerclone').click());
await p.waitForTimeout(600);
ls = await layers();
console.log('AFTER CLONE', JSON.stringify(ls.map(l => ({ n: l.name, pts: l.points, act: l.active }))));
ok('Clone makes a third layer with the same points', ls.length === 3 && ls[2].points === NA && ls[2].active, `${ls.length} layers, clone has ${ls[2]?.points}`);
ok('the clone is tinted so it can be told apart', !!ls[2].tint, String(ls[2].tint));
ok('and the original is untouched', ls[0].points === NA, `${ls[0].points}`);
let refused = '';
try { await p.evaluate(() => window.__app.dispatchAgent('entities', { op: 'remove', id: window.__app.entities[2].id })); }
catch (e) { refused = String(e.message ?? e); }
ok('removing a layer needs Allow edits', /read-only/.test(refused), refused.slice(0, 60));
await p.evaluate(() => window.__app.removeLayer(window.__app.entities[2], false));
await p.waitForTimeout(400);
ok('and then it goes', (await layers()).length === 2, `${(await layers()).length} layers`);

// ---------------------------------------------------------------- tint
await p.evaluate(() => {
  document.getElementById('k-layercolor').value = '#ff3366';
  document.getElementById('k-layercolor').dispatchEvent(new Event('input'));
  document.getElementById('k-layertint').checked = true;
  document.getElementById('k-layertint').dispatchEvent(new Event('change'));
});
await p.waitForTimeout(300);
ok('a tint is recorded on the active layer', (await layers()).find(l => l.active).tint === '#ff3366', String((await layers()).find(l => l.active).tint));
await p.screenshot({ path: 'shots/entities-tinted.png' });

// ---------------------------------------------------------------- history belongs to a layer
const activate = (name) => p.evaluate(nm => {
  const e = window.__app.entities.find(x => x.name === nm);
  window.__app.activateEntity(e.id);
}, name);
/** Compose a translation onto the active layer's own matrix, rather than replacing it. */
const moveActive = (dx, dy, dz, label) => p.evaluate(([x, y, z, l]) => {
  const cur = window.__app.fromRowMajor(window.__app.transformState().matrix);
  const m = new (cur.constructor)().makeTranslation(x, y, z).multiply(cur);
  return window.__app.commitTransform(m, l);
}, [dx, dy, dz, label]);
const named = async (n) => (await layers()).find(l => l.name === n);
const cellBox = () => p.evaluate(() => window.__app.entities.map(e => ({ name: e.name, min: e.cells.bounds.min.toArray(), max: e.cells.bounds.max.toArray() })));

await activate('Scan 1'); await p.waitForTimeout(300);
ok('activating by name works', (await named('Scan 1')).active, (await layers()).find(l => l.active)?.name);
const otherBefore = (await named('Second pass')).transform.slice();
await moveActive(3, 0, 0, 'Move A'); await idle();
ok('a transform applies to the active layer only',
   Math.abs((await named('Scan 1')).transform[3] - 3) < 1e-5 && (await named('Second pass')).transform.every((v, i) => Math.abs(v - otherBefore[i]) < 1e-9),
   `A tx ${(await named('Scan 1')).transform[3]}, B tx ${(await named('Second pass')).transform[3]}`);
await activate('Second pass'); await p.waitForTimeout(300);
ok('switched to the other layer', await loaded() === NB, `${await loaded()}`);
await p.click('#tb-undo'); await idle();
ok('undo went back to the layer the step belongs to', (await named('Scan 1')).active, (await layers()).find(l => l.active)?.name);
ok('and undid it there', Math.abs((await named('Scan 1')).transform[3]) < 1e-6, String((await named('Scan 1')).transform[3]));

// ---------------------------------------------------------------- dirty covers every layer
await activate('Second pass'); await p.waitForTimeout(300);
await p.evaluate(() => window.__app.analysis('feature', { name: 'planarity', k: 16, radius: 0.1 }, 'Planarity'));
await idle();
await activate('Scan 1'); await p.waitForTimeout(400);
const dirty = await p.evaluate(() => window.__app.dirtyList());
console.log('DIRTY', JSON.stringify(dirty));
ok('unsaved work on another layer is still reported', dirty.some(s => /scalar field \(Planarity\) on /.test(s)), dirty.join(' · '));
ok('and the active layer has no field of its own', !(await p.evaluate(() => window.__viewer.cells.hasScalarField)), '');

// ---------------------------------------------------------------- merge
await activate('Second pass'); await p.waitForTimeout(300);
await moveActive(0, 0, 4, 'Lift B'); await idle();
const boxes = await cellBox();
console.log('BEFORE MERGE', JSON.stringify(boxes.map(b => ({ n: b.name, min: b.min.map(v => +v.toFixed(2)), max: b.max.map(v => +v.toFixed(2)) }))));
await activate('Scan 1'); await p.waitForTimeout(400);
const before = await loaded();
const merged = await p.evaluate(() => window.__app.mergeIntoActive(false));
await idle(); await p.waitForTimeout(500);
ls = await layers();
console.log('MERGED', JSON.stringify({ ...merged, layers: ls.length }));
ok('merge folds the other layers in', ls.length === 1 && ls[0].points === NA + NB, `${ls.length} layer, ${ls[0].points} points (was ${before})`);
const after = (await cellBox())[0];
const want = [0, 1, 2].map(a => [Math.min(boxes[0].min[a], boxes[1].min[a]), Math.max(boxes[0].max[a], boxes[1].max[a])]);
console.log('BOX', JSON.stringify({ merged: after.min.map(v => +v.toFixed(2)).concat(after.max.map(v => +v.toFixed(2))), want }));
ok('the merged geometry is the union of what was on screen',
   [0, 1, 2].every(a => Math.abs(after.min[a] - want[a][0]) < 0.02 && Math.abs(after.max[a] - want[a][1]) < 0.02),
   `${after.min.map(v => v.toFixed(2))} … ${after.max.map(v => v.toFixed(2))}`);
ok('the second layer kept its own placement and lift', want[0][1] > 20 && Math.abs(after.max[2] - 4) < 0.02,
   `x to ${after.max[0].toFixed(2)} m, z to ${after.max[2].toFixed(2)} m`);
ok('the field was dropped, and said so', /fields dropped/.test(await p.textContent('#v-layers')), (await p.textContent('#v-layers')).slice(-40));
ok('and a merge counts as unsaved work', (await p.evaluate(() => window.__app.dirtyList())).some(s => /merge/.test(s)), JSON.stringify(await p.evaluate(() => window.__app.dirtyList())));
await p.screenshot({ path: 'shots/entities-merged.png' });

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await br.close();
process.exit(fails ? 1 : 0);
