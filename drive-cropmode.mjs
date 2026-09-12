// The crop region cuts both ways: keep what is inside it, or remove it. The two must be exact
// complements of each other over the same box, and both must undo.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
const N = 110, TOTAL = N * N;
const ply = join(tmpdir(), 'e57view-cropmode.ply');
{
  const L = ['ply', 'format ascii 1.0', `element vertex ${TOTAL}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++)
    L.push(`${(10 + i * 0.05).toFixed(4)} ${(10 + j * 0.05).toFixed(4)} 20.0000 190 180 160`);
  writeFileSync(ply, L.join('\n'));
}
mkdirSync('shots', { recursive: true });

const br = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await br.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 120000 });
const loaded = () => p.evaluate(() => window.__viewer.loaded);

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { window.showSaveFilePicker = undefined; localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache', 'e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });
await p.setInputFiles('#file-input', ply);
await p.waitForFunction(() => /loaded in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 120000 });
await p.waitForTimeout(900);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('LOAD:', await p.textContent('#tb-points'));

// put the region on a known part of the plane and count, on the CPU, what is inside it
const place = () => p.evaluate(() => {
  const v = window.__viewer, b = v.bounds();
  v.controls.target.set(b.min.x + 1.5, b.min.y + 1.5, b.min.z); v.controls.update();
  document.getElementById('k-cropcentre').click();
  for (const id of ['k-cropsize', 'k-cropsy', 'k-cropsz']) { const s = document.getElementById(id); s.value = '0.4'; s.dispatchEvent(new Event('input')); }
  // the exact answer, from the points themselves
  const r = window.__app.cropState;
  let inside = 0, total = 0;
  for (const { leaf, recs } of v.cells.records()) {
    const xyz = v.cells.transformRecordsInto(recs, leaf.count, leaf, new Float64Array(leaf.count * 3));
    for (let i = 0; i < leaf.count; i++) {
      total++;
      if (Math.abs(xyz[i * 3] - r.center[0]) <= r.half[0] && Math.abs(xyz[i * 3 + 1] - r.center[1]) <= r.half[1] && Math.abs(xyz[i * 3 + 2] - r.center[2]) <= r.half[2]) inside++;
    }
  }
  return { inside, total, role: r.role, center: r.center, half: r.half };
});
const box = await place();
console.log('BOX', JSON.stringify(box));
ok('the region covers part of the plane', box.inside > 200 && box.inside < box.total - 200, `${box.inside} of ${box.total} inside`);
ok('the crop starts as Keep inside', box.role === 'keep' && await p.evaluate(() => document.getElementById('k-cropkeep').classList.contains('on')), box.role);

// ---------------------------------------------------------------- remove inside
await p.click('#k-cropdel');
await p.waitForTimeout(200);
ok('Remove inside is selected', await p.evaluate(() => window.__app.cropState.role === 'delete' && document.getElementById('k-cropdel').classList.contains('on')), '');
ok('the Apply button renames itself', (await p.textContent('#k-cropapply')).trim() === 'Remove inside…', await p.textContent('#k-cropapply'));
const readout = await p.textContent('#v-crop');
console.log('READOUT', readout);
ok('the readout counts what goes and what stays', /removed · .* kept/.test(readout), readout);

await p.click('#k-cropapply');
await p.waitForSelector('#modal:not(.hidden)');
const dlg = (await p.textContent('#modal-title')) + ' — ' + (await p.textContent('#modal-body')).replace(/\s+/g, ' ').slice(0, 150);
console.log('DIALOG', dlg);
ok('the dialog says it is removing', /Remove the points inside\?/.test(dlg) && /points removed/.test(dlg), dlg.slice(0, 60));
ok('and the confirm button says how many', /^Remove [\d,]+$/.test((await p.textContent('#modal-btns button.danger')).trim()), await p.textContent('#modal-btns button.danger'));
await p.click('#modal-btns button.danger'); await idle();
const afterDel = await loaded();
ok('the points inside are gone, the rest remain', afterDel === box.total - box.inside, `${afterDel} left, expected ${box.total - box.inside}`);
const gone = await p.evaluate((r) => {
  const v = window.__viewer;
  let stillInside = 0;
  for (const { leaf, recs } of v.cells.records()) {
    const xyz = v.cells.transformRecordsInto(recs, leaf.count, leaf, new Float64Array(leaf.count * 3));
    for (let i = 0; i < leaf.count; i++) {
      if (Math.abs(xyz[i * 3] - r.center[0]) <= r.half[0] && Math.abs(xyz[i * 3 + 1] - r.center[1]) <= r.half[1] && Math.abs(xyz[i * 3 + 2] - r.center[2]) <= r.half[2]) stillInside++;
    }
  }
  return stillInside;
}, box);
ok('not one point inside the box survived', gone === 0, `${gone} still inside`);
ok('it is one undo step', await p.evaluate(() => window.__app.hist.steps.undo) === 1, `${await p.evaluate(() => window.__app.hist.steps.undo)} steps`);
await p.screenshot({ path: 'shots/cropmode-removed.png' });

await p.click('#tb-undo'); await idle();
ok('undo puts them back', await loaded() === box.total, `${await loaded()} points`);

// ---------------------------------------------------------------- keep inside, the complement
const box2 = await place();
await p.click('#k-cropkeep');
await p.waitForTimeout(200);
ok('Keep inside is selected again', await p.evaluate(() => window.__app.cropState.role === 'keep'), '');
ok('and the Apply button changes back', (await p.textContent('#k-cropapply')).trim() === 'Apply crop…', await p.textContent('#k-cropapply'));
await p.click('#k-cropapply');
await p.waitForSelector('#modal:not(.hidden)');
ok('the dialog says it is cropping', (await p.textContent('#modal-title')) === 'Apply crop?', await p.textContent('#modal-title'));
await p.click('#modal-btns button.danger'); await idle();
const afterKeep = await loaded();
ok('keeping inside is the exact complement', afterKeep === box2.inside && afterKeep + afterDel === box.total,
   `${afterKeep} kept + ${afterDel} removed = ${afterKeep + afterDel} of ${box.total}`);
await p.click('#tb-undo'); await idle();
ok('undo puts those back too', await loaded() === box.total, `${await loaded()} points`);

// ---------------------------------------------------------------- an agent can set the mode
const agentMode = await p.evaluate(() => window.__app.dispatchAgent('regions', { op: 'mode', role: 'delete' }));
ok('the agent can switch the crop to Remove inside', agentMode.result.crop.role === 'delete' && agentMode.result.mode === 'remove inside', JSON.stringify(agentMode.result.mode));
const agentBack = await p.evaluate(() => window.__app.dispatchAgent('regions', { op: 'mode', role: 'keep' }));
ok('and back to Keep inside', agentBack.result.crop.role === 'keep', JSON.stringify(agentBack.result.mode));

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await br.close();
process.exit(fails ? 1 : 0);
