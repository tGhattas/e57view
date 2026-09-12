// SPDX-License-Identifier: GPL-3.0-only
// Opening another scan, and the one guard in front of it. The point of the guard is that it
// names what would be lost, so the checks are about the wording as much as the behaviour.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
function ply(path, n, x0, z) {
  const L = ['ply', 'format ascii 1.0', `element vertex ${n * n}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
    L.push(`${(x0 + i * 0.05).toFixed(4)} ${(10 + j * 0.05).toFixed(4)} ${z.toFixed(4)} 190 180 160`);
  writeFileSync(path, L.join('\n'));
  return n * n;
}
const A = join(tmpdir(), 'e57view-open-a.ply'), B = join(tmpdir(), 'e57view-open-b.ply');
const NA = ply(A, 110, 10, 20), NB = ply(B, 60, 10, 20);
mkdirSync('shots', { recursive: true });

const br = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const ctx = await br.newContext({ viewport: { width: 1280, height: 840 }, acceptDownloads: true });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200)); });
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 300000 });
const modalOpen = () => p.evaluate(() => !document.getElementById('modal').classList.contains('hidden'));
const modalTitle = () => p.textContent('#modal-title');
const modalBody = () => p.textContent('#modal-body').then(t => t.replace(/\s+/g, ' ').trim());
const loaded = () => p.evaluate(() => window.__viewer.loaded);
const dirty = () => p.evaluate(() => window.__app.dirtyList());

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => {
  // no native pickers in a test: the save path falls back to a download, the open path no-ops
  window.showSaveFilePicker = undefined;
  window.showOpenFilePicker = () => Promise.reject(new Error('no picker in the driver'));
  localStorage.clear();
  const r = await navigator.storage.getDirectory();
  for (const d of ['e57view-cache', 'e57view-undo', 'e57view-export']) { try { await r.removeEntry(d, { recursive: true }); } catch {} }
});
async function setFile(path) { await p.setInputFiles('#file-input', []); await p.setInputFiles('#file-input', path); }
async function waitLoad(n) {
  await p.waitForFunction(c => window.__viewer.loaded === c, n, { timeout: 120000 });
  await p.waitForTimeout(600);
  try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
}
await setFile(A); await waitLoad(NA);
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('LOAD A:', await p.textContent('#tb-points'));

// ---------------------------------------------------------------- nothing dirty: no dialog
ok('a freshly loaded scan is not dirty', (await dirty()).length === 0, JSON.stringify(await dirty()));
await setFile(B); await waitLoad(NB);
ok('opening with nothing dirty asks nothing', !(await modalOpen()), 'no modal');
ok('and the other scan is loaded', await loaded() === NB, `${await loaded()} points`);
await setFile(A); await waitLoad(NA);

// ---------------------------------------------------------------- make every kind of mess
await p.evaluate(() => window.__app.analysis('normals', { k: 16, orient: true }, 'normals')); await idle();
await p.evaluate(() => window.__app.analysis('feature', { name: 'planarity', k: 16, radius: 0.1 }, 'Planarity')); await idle();
await p.evaluate(() => window.__app.buildMesh({ voxel: 10, smooth: 1, trunc: 2, confirm: false })); await idle();
await p.evaluate(() => window.__app.commitTransform(window.__app.fromRowMajor([0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 'Rotate 90')); await idle();
await p.evaluate(() => {
  const v = window.__viewer, b = v.bounds();
  v.controls.target.set(b.min.x + 2, b.min.y + 2, b.min.z); v.controls.update();
  document.getElementById('k-cropcentre').click();
  for (const id of ['k-cropsize', 'k-cropsy', 'k-cropsz']) { const s = document.getElementById(id); s.value = '0.5'; s.dispatchEvent(new Event('input')); }
});
await p.click('#k-cropapply'); await p.waitForSelector('#modal:not(.hidden)'); await p.click('#modal-btns button.danger'); await idle();
const list = await dirty();
console.log('DIRTY', JSON.stringify(list));
ok('the edit is counted', list.some(s => /^1 edit$/.test(s)), list.join(' · '));
ok('the normals are named', list.includes('computed normals'), '');
ok('the field is named with its own name', list.some(s => /^a scalar field \(Planarity\)$/.test(s)), '');
ok('the surface is named with its size', list.some(s => /^a [\d.KM,]+-triangle surface$/.test(s)), list.find(s => /triangle/.test(s)) ?? '');
ok('the transform is named', list.includes('a transform'), '');

// ---------------------------------------------------------------- Cancel keeps this scan
const beforeCancel = await loaded();
await setFile(B);
await p.waitForSelector('#modal:not(.hidden)', { timeout: 5000 });
ok('the guard asks before replacing the scan', (await modalTitle()) === 'Open another scan?', await modalTitle());
const body = await modalBody();
console.log('MODAL', body.slice(0, 190));
ok('the dialog lists every unsaved thing', list.every(s => body.includes(s)), '');
ok('and offers three ways out', await p.evaluate(() => Array.from(document.querySelectorAll('#modal-btns button')).map(b => b.textContent).join('|')) === 'Cancel|Save as… first|Open anyway', await p.evaluate(() => Array.from(document.querySelectorAll('#modal-btns button')).map(b => b.textContent).join('|')));
await p.click('#modal-btns button:has-text("Cancel")');
await p.waitForTimeout(500);
ok('Cancel keeps the loaded scan', await loaded() === beforeCancel && (await p.textContent('#tb-name')).includes('open-a'), `${await loaded()} points · ${await p.textContent('#tb-name')}`);
ok('and keeps the unsaved work', (await dirty()).length === list.length, JSON.stringify(await dirty()));

// ---------------------------------------------------------------- Save as… first, then open
await setFile(B);
await p.waitForSelector('#modal:not(.hidden)', { timeout: 5000 });
const dl = p.waitForEvent('download', { timeout: 60000 });
await p.click('#modal-btns button:has-text("Save as… first")');
await p.waitForSelector('#modal:not(.hidden)', { timeout: 5000 });
ok('Save as… first opens the save dialog', (await modalTitle()) === 'Save as…', await modalTitle());
await p.click('#modal-btns button:has-text("Choose location…")');
const file = await dl;
console.log('SAVED', file.suggestedFilename());
await waitLoad(NB);
ok('the save wrote a file', /open-a.*\.ply$/.test(file.suggestedFilename()), file.suggestedFilename());
ok('and then the other scan opened', await loaded() === NB && (await p.textContent('#tb-name')).includes('open-b'), `${await loaded()} points · ${await p.textContent('#tb-name')}`);
ok('opening cleared the unsaved work', (await dirty()).length === 0, JSON.stringify(await dirty()));

// ---------------------------------------------------------------- Open anyway discards
await setFile(A); await waitLoad(NA);
await p.evaluate(() => window.__app.commitTransform(window.__app.fromRowMajor([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 'Move')); await idle();
ok('a transform alone makes it dirty', (await dirty()).join(',') === 'a transform', JSON.stringify(await dirty()));
await setFile(B);
await p.waitForSelector('#modal:not(.hidden)', { timeout: 5000 });
await p.click('#modal-btns button:has-text("Open anyway")');
await waitLoad(NB);
ok('Open anyway loads the other scan', await loaded() === NB && (await p.textContent('#tb-name')).includes('open-b'), `${await loaded()} points`);
ok('and clears dirty', (await dirty()).length === 0, JSON.stringify(await dirty()));
ok('and the transform went with the old scan', await p.evaluate(() => window.__app.transformState().identity), '');

// ---------------------------------------------------------------- the three routes to the picker
for (const [name, act] of [
  ['the top bar button', () => p.click('#tb-open')],
  ['the panel button', () => p.click('#k-open')],
  ['⌘O', async () => { await p.click('#gl', { position: { x: 60, y: 400 } }); await p.keyboard.press('Meta+o'); }],
]) {
  await p.evaluate(() => window.__app.commitTransform(window.__app.fromRowMajor([1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 'Move')); await idle();
  await act();
  let asked = false;
  try { await p.waitForSelector('#modal:not(.hidden)', { timeout: 4000 }); asked = (await modalTitle()) === 'Open another scan?'; } catch {}
  ok(`${name} goes through the guard`, asked, asked ? '' : 'no dialog');
  if (asked) await p.click('#modal-btns button:has-text("Cancel")');
  await p.click('#tb-undo'); await idle();          // back to clean
  await p.waitForTimeout(200);
}
ok('undoing the transform leaves nothing dirty', (await dirty()).length === 0, JSON.stringify(await dirty()));
await p.click('#tb-open');
await p.waitForTimeout(1200);
ok('with nothing dirty the button asks nothing', !(await modalOpen()), 'no modal');

await p.screenshot({ path: 'shots/open-guard.png' });
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await br.close();
process.exit(fails ? 1 : 0);
