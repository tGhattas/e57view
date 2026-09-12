// SPDX-License-Identifier: GPL-3.0-only
// Crop → undo → redo → save, against a tiny generated PLY.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://127.0.0.1:5180/';
const NX = 32, NY = 32, NZ = 8;
const N = NX * NY * NZ;
const ply = join(tmpdir(), 'e57view-undo-test.ply');
const lines = ['ply', 'format ascii 1.0', `element vertex ${N}`, 'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
  lines.push(`${x} ${y} ${z} ${80 + x * 5} ${80 + y * 5} ${80 + z * 20}`);
}
writeFileSync(ply, lines.join('\n'));
mkdirSync('shots', { recursive: true });

const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 400)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 240)); });

async function dismissModal() {
  const m = p.locator('#modal:not(.hidden)');
  if (!(await m.count())) return false;
  const title = ((await p.textContent('#modal-title')) || '').trim();
  console.log('MODAL:', title);
  const notNow = p.locator('#modal-btns button:has-text("Not now")');
  if (await notNow.count()) await notNow.click();
  else await p.locator('#modal-btns button').first().click();
  await p.waitForFunction(() => document.getElementById('modal').classList.contains('hidden'));
  return true;
}

await p.goto(URL, { waitUntil: 'networkidle' });
await p.evaluate(async () => {
  window.showSaveFilePicker = undefined;
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('e57view-cache', { recursive: true }); } catch {}
  try { await root.removeEntry('e57view-undo', { recursive: true }); } catch {}
  localStorage.clear();
});

await p.setInputFiles('#file-input', ply);
await p.waitForFunction(() => /(loaded|from cache) in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 60000 });
// offerCache is scheduled 600ms after decode
await p.waitForTimeout(900);
await dismissModal();
const loaded = await p.evaluate(() => window.__viewer.loaded);
console.log('LOADED', loaded);
if (loaded !== N) throw new Error(`expected ${N} points, got ${loaded}`);
await p.evaluate(() => {
  const v = window.__viewer;
  v.camera.position.set(40, 40, 40); v.controls.target.set(16, 16, 4); v.controls.update(); v.touch();
});
const camBefore = await p.evaluate(() => window.__viewer.camera.position.toArray());
await p.click('#tb-panel');
await p.waitForTimeout(80);
const panelHidden = await p.evaluate(() => document.getElementById('panel').classList.contains('hidden'));
const camAfter = await p.evaluate(() => window.__viewer.camera.position.toArray());
if (!panelHidden) throw new Error('Controls did not hide the panel');
if (camAfter.some((v, i) => Math.abs(v - camBefore[i]) > 0.05)) throw new Error('hiding the panel refit/zoomed the camera');
await p.click('#tb-panel');
console.log('PANEL TOGGLE kept camera');
await p.screenshot({ path: 'shots/controls-panel.png' });

// Escape cancels a crop region
await p.evaluate(() => { document.querySelector('[data-grp="crop"]').classList.remove('closed'); });
await p.click('#k-cropcentre');
const cropOn = await p.evaluate(() => document.getElementById('k-cropon').checked);
if (!cropOn) throw new Error('crop region did not turn on');
await p.keyboard.press('Escape');
const cropOff = await p.evaluate(() => !document.getElementById('k-cropon').checked);
if (!cropOff) throw new Error('Escape did not cancel the crop region');
console.log('CANCEL: Escape hid the crop region');

await p.click('#k-cropcentre');
await p.evaluate(() => { for (const id of ['k-cropsize', 'k-cropsy', 'k-cropsz']) { const s = document.getElementById(id); s.value = '0.35'; s.dispatchEvent(new Event('input')); } });
await p.click('#k-cropapply');
await p.waitForSelector('#modal:not(.hidden)');
console.log('CROP MODAL:', (await p.textContent('#modal-body')).replace(/\s+/g, ' ').trim().slice(0, 160));
await p.click('#modal-btns button.danger');
await p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 30000 });
const afterCrop = await p.evaluate(() => ({ n: window.__viewer.loaded, undo: window.__app.hist.undo.length, redo: window.__app.hist.redo.length, labels: document.querySelectorAll('#labels .slabel').length }));
console.log('CROP', afterCrop);
if (!(afterCrop.n > 0 && afterCrop.n < loaded && afterCrop.undo === 1 && afterCrop.redo === 0)) throw new Error('crop did not record an undo step');
if (afterCrop.labels !== 0) throw new Error('crop left region tags in the view');
await p.screenshot({ path: 'shots/undo-crop.png' });

await dismissModal();
await p.click('#tb-undo');
await p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'));
const afterUndo = await p.evaluate(() => ({ n: window.__viewer.loaded, undo: window.__app.hist.undo.length, redo: window.__app.hist.redo.length }));
console.log('UNDO', afterUndo);
if (afterUndo.n !== loaded || afterUndo.undo !== 0 || afterUndo.redo !== 1) throw new Error('undo did not restore points');
await p.screenshot({ path: 'shots/undo-restored.png' });

await dismissModal();
await p.click('#tb-redo');
await p.waitForFunction((n) => window.__viewer.loaded !== n, afterUndo.n, { timeout: 15000 });
await p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'));
const afterRedo = await p.evaluate(() => ({ n: window.__viewer.loaded, undo: window.__app.hist.undo.length, redo: window.__app.hist.redo.length }));
console.log('REDO', afterRedo);
if (afterRedo.n !== afterCrop.n || afterRedo.undo !== 1) throw new Error('redo did not re-drop points');

const [dl] = await Promise.all([
  p.waitForEvent('download', { timeout: 120000 }),
  (async () => {
    await p.click('#tb-save');
    await p.waitForSelector('#modal:not(.hidden)');
    console.log('SAVE MODAL:', (await p.textContent('#modal-body')).replace(/\s+/g, ' ').trim().slice(0, 200));
    await p.click('#modal-btns button.primary');
  })(),
]);
console.log('DOWNLOAD', dl.suggestedFilename());
await p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 120000 });
const afterSave = await p.evaluate(() => ({ n: window.__viewer.loaded, undo: window.__app.hist.undo.length, redo: window.__app.hist.redo.length, cache: document.getElementById('v-cache').textContent, hist: document.getElementById('v-hist').textContent }));
console.log('SAVE', afterSave);
if (afterSave.undo !== 0 || afterSave.redo !== 0) throw new Error('save did not clear undo/redo');
const cacheEntries = await p.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  try { const d = await root.getDirectoryHandle('e57view-cache'); let n = 0; for await (const _ of d) n++; return n; } catch { return 0; }
});
if (cacheEntries) throw new Error('Save created a cache although the scan was not cached');
if (!/undo cleared/.test(afterSave.cache || '') || /cache updated/.test(afterSave.cache || '')) throw new Error('status after uncached save is wrong: ' + afterSave.cache);
await p.screenshot({ path: 'shots/undo-saved.png' });

// reload from disk (not cache) — Save did not write a cache
await p.evaluate(() => document.getElementById('k-reload').click());
await p.waitForFunction(() => /loaded in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 30000 });
const afterReload = await p.evaluate(() => ({ n: window.__viewer.loaded, undo: window.__app.hist.undo.length }));
console.log('RELOAD FROM DISK', afterReload);
if (afterReload.n !== N || afterReload.undo !== 0) throw new Error(`disk reload expected ${N} pts / undo 0, got ${afterReload.n} / undo ${afterReload.undo}`);

// cache it, crop again, Save → cache must hold the edited points
await p.evaluate(() => window.__app.writeCache());
await p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 30000 });
console.log('CACHE written');
await dismissModal();
await p.click('#k-cropcentre');
await p.evaluate(() => { for (const id of ['k-cropsize', 'k-cropsy', 'k-cropsz']) { const s = document.getElementById(id); s.value = '0.35'; s.dispatchEvent(new Event('input')); } });
await p.click('#k-cropapply');
await p.waitForSelector('#modal:not(.hidden)');
await p.click('#modal-btns button.danger');
await p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 30000 });
const afterCrop2 = await p.evaluate(() => ({ n: window.__viewer.loaded, undo: window.__app.hist.undo.length }));
console.log('CROP2', afterCrop2);
if (!(afterCrop2.n > 0 && afterCrop2.n < N && afterCrop2.undo === 1)) throw new Error('second crop did not record an undo step');

const [dl2] = await Promise.all([
  p.waitForEvent('download', { timeout: 120000 }),
  (async () => {
    await p.click('#tb-save');
    await p.waitForSelector('#modal:not(.hidden)');
    console.log('SAVE2 MODAL:', (await p.textContent('#modal-body')).replace(/\s+/g, ' ').trim().slice(0, 200));
    await p.click('#modal-btns button.primary');
  })(),
]);
console.log('DOWNLOAD2', dl2.suggestedFilename());
await p.waitForFunction(() => window.__app.hist.undo.length === 0, null, { timeout: 120000 });
const afterSave2 = await p.evaluate(() => ({ n: window.__viewer.loaded, undo: window.__app.hist.undo.length, cache: document.getElementById('v-cache').textContent }));
console.log('SAVE2', afterSave2);
if (!/cache updated/.test(afterSave2.cache || '')) throw new Error('status after cached save is wrong: ' + afterSave2.cache);

await p.evaluate(() => document.getElementById('k-reload').click());
await p.waitForFunction(() => /from cache in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 30000 });
await p.waitForFunction(() => window.__viewer.cells.pendingCount === 0, null, { timeout: 30000 });
const afterCacheReload = await p.evaluate(() => window.__viewer.loaded);
console.log('RELOAD FROM CACHE', afterCacheReload);
if (afterCacheReload !== afterCrop2.n) throw new Error(`cache reload expected ${afterCrop2.n}, got ${afterCacheReload}`);

console.log('OK');
await b.close();
