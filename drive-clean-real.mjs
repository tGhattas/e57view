// SPDX-License-Identifier: GPL-3.0-only
// The cleaning filters on a real scan, at full resolution, with nothing subsampled.
//
// This is the run the tiling was written for. A 73.8M point cloud does not fit in one
// WebAssembly index, so SOR, the noise filter and duplicate removal are done a spatial tile
// at a time. Each one has to finish, remove a sensible number of points, and say how much
// heap it needed. The numbers printed here are the ones quoted in FINDINGS.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { requireTestFile } from './shared/testfile.mjs';

const FILE = requireTestFile('a large scan');
if (!FILE) process.exit(0);
const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
mkdirSync('shots', { recursive: true });

const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await b.newContext({ viewport: { width: 1500, height: 940 } })).newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200)); });
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 3600000 });

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => {
  window.showSaveFilePicker = undefined;
  localStorage.clear();
  const r = await navigator.storage.getDirectory();
  for (const d of ['e57view-cache', 'e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} }
});
// every point, no stride
await p.evaluate(() => { document.getElementById('k-load').value = '1'; });
const t0 = Date.now();
await p.setInputFiles('#file-input', FILE);
await p.waitForFunction(() => /(loaded|from cache) in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 1800000 });
console.log(`LOAD ${await p.textContent('#tb-points')} · wall ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await p.waitForTimeout(1500);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 8000 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));

const loaded = await p.evaluate(() => window.__viewer.loaded);
const leaves = await p.evaluate(() => window.__viewer.cells.leavesForMask().length);
console.log(`CLOUD ${loaded.toLocaleString('en-GB')} points in ${leaves} leaves`);
ok('the whole scan is loaded, not a subsample', loaded > 20e6, `${loaded.toLocaleString('en-GB')} points`);

const rows = [];
for (const args of [
  { op: 'sor', neighbours: 6, nSigma: 1 },
  { op: 'noise', neighbourhood: 'radius', removeIsolated: false },
  { op: 'duplicates', tolerance: 0.001 },
]) {
  const t = Date.now();
  const r = await p.evaluate(async (a) => {
    try { return await window.__app.agentRun('analysis', a); }
    catch (e) { return { error: String(e?.message ?? e) }; }
  }, args);
  await idle();
  const secs = (Date.now() - t) / 1000;
  const heap = await p.evaluate(() => window.__app.anaHeap);
  ok(`${args.op} finishes on the whole scan`, !r.error, r.error ?? `${secs.toFixed(1)}s`);
  if (!r.error) {
    rows.push({ op: args.op, secs, removed: r.removed, kept: r.kept, tiles: r.tiles ?? 1, heapMB: Math.round(heap / 1048576) });
    console.log(`  ${args.op}: ${secs.toFixed(1)}s · ${r.tiles ?? 1} tiles · removed ${r.removed.toLocaleString('en-GB')} of ${r.of.toLocaleString('en-GB')} · wasm heap ${(heap / 1048576).toFixed(0)} MB`
      + (r.cutOff !== undefined ? ` · mean ${r.meanNeighbourDistance} m, cut ${r.cutOff} m` : ''));
    ok(`${args.op} removed something but not everything`, r.removed > 0 && r.kept > loaded * 0.5,
       `${r.removed.toLocaleString('en-GB')} removed, ${r.kept.toLocaleString('en-GB')} kept`);
    ok(`${args.op} was tiled`, (r.tiles ?? 1) > 1, `${r.tiles ?? 1} tiles`);
  }
  await p.evaluate(() => window.__app.undoEdit());
  await p.waitForTimeout(2000);
  await idle();
}
console.log('\nFINDINGS ROWS');
for (const r of rows) console.log(`  ${r.op} · ${r.secs.toFixed(0)} s · ${r.tiles} tiles · ${r.removed.toLocaleString('en-GB')} removed · ${r.heapMB} MB wasm heap`);
await p.screenshot({ path: 'shots/clean-real.png' });
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(fails ? 1 : 0);
