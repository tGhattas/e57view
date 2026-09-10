// End-to-end: load → measure → crop → export (PLY + E57) → cache → reload from cache → panorama.
import { chromium } from 'playwright';
import { statSync, readFileSync, mkdirSync } from 'node:fs';

const FILE = '/Users/tamer/Downloads/1973-registered.e57';
const URL = process.env.URL || 'http://127.0.0.1:5180/';
const OUT = '/private/tmp/claude-501/-Users-tamer-Developer-playground/d6f1a1ba-ecc2-4157-a520-9812531d0480/scratchpad/exports';
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const ctx = await b.newContext({ viewport: { width: 1500, height: 940 }, acceptDownloads: true });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200)); });

await p.goto(URL, { waitUntil: 'networkidle' });
// force the download fallback so no native save dialog blocks the test
await p.evaluate(() => { window.showSaveFilePicker = undefined; });
const setSel = (id, v) => p.evaluate(([id, v]) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('change')); }, [id, v]);
const stats = () => p.textContent('#v-stats');
const busyGone = (t) => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: t });
const loaded = () => p.waitForFunction(() => /(loaded|from cache) in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 600000 });

// make sure a stale cache from a previous run doesn't skew the first load
await p.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('e57view-cache', { recursive: true }); } catch {}
  try { await root.removeEntry('e57view-export', { recursive: true }); } catch {}
  localStorage.clear();
});

// ---------------------------------------------------------------- load
await p.evaluate(() => { document.getElementById('k-load').value = '1'; });
const tL = Date.now();
await p.setInputFiles('#file-input', FILE);
await loaded();
console.log(`LOAD (decode): ${await p.textContent('#tb-points')}  wall ${((Date.now() - tL) / 1000).toFixed(1)}s`);
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));

// cache prompt appears ~0.6s after done
await p.waitForSelector('#modal:not(.hidden)', { timeout: 15000 });
console.log('CACHE PROMPT:', (await p.textContent('#modal-title')).trim());
await p.click('#modal-btns button:has-text("Not now")');

// ---------------------------------------------------------------- measure
console.log('  pickWorld probe:', await p.evaluate(() => { const w = window.__viewer.pickWorld(600, 480); return w ? w.toArray().map(v => v.toFixed(2)).join(',') : 'null'; }));
await p.keyboard.press('m');
console.log('  tool after M:', await p.evaluate(() => window.__viewer.tool));
await p.mouse.click(600, 480); await p.waitForTimeout(150);
await p.mouse.click(760, 520); await p.waitForTimeout(300);
console.log('MEASURE:', (await p.textContent('#measure-list')).trim(), '| coord:', (await p.textContent('#coord')).trim().slice(0, 60));
await p.screenshot({ path: 'shots/f-measure.png' });
await p.keyboard.press('m');

// ---------------------------------------------------------------- crop
// centre the box on a building-ish point: double-click there, then "centre on orbit point"
await p.mouse.dblclick(640, 500); await p.waitForTimeout(300);
await p.evaluate(() => { document.querySelector('[data-grp="crop"]').classList.remove('closed'); });
await p.click('#k-cropcentre');
await p.evaluate(() => { for (const id of ['k-cropsize','k-cropsy','k-cropsz']) { const s = document.getElementById(id); s.value = '0.22'; s.dispatchEvent(new Event('input')); } });
await p.waitForTimeout(400);
console.log('CROP preview:', await p.textContent('#v-crop'));
await p.screenshot({ path: 'shots/f-crop-preview.png' });
await p.click('#k-cropapply');
await p.waitForSelector('#modal:not(.hidden)');
console.log('CROP MODAL:', (await p.textContent('#modal-body')).replace(/\s+/g, ' ').trim().slice(0, 140));
await p.click('#modal-btns button.danger');
await busyGone(120000);
await p.waitForTimeout(800);
const afterCrop = await p.textContent('#v-loaded');
console.log('CROP applied:', afterCrop, '|', await stats());
await p.screenshot({ path: 'shots/f-crop-applied.png' });
const keptPts = Number(afterCrop.replace(/,/g, '').match(/([\d]+) points in memory/)[1]);

// ---------------------------------------------------------------- export PLY
await p.evaluate(() => { document.querySelector('[data-grp="export"]').classList.remove('closed'); });
await setSel('k-fmt', 'ply');
await setSel('k-expstride', '1');
const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 300000 }), p.click('#k-export')]);
const plyPath = `${OUT}/${dl.suggestedFilename()}`;
await dl.saveAs(plyPath);
await busyGone(300000);
console.log('EXPORT PLY:', await p.textContent('#v-export'));
{
  const buf = readFileSync(plyPath);
  const head = buf.subarray(0, 600).toString('latin1');
  const n = Number(head.match(/element vertex (\d+)/)[1]);
  const hdrLen = head.indexOf('end_header\n') + 11;
  const stride = 24 + 3 + 4 + 12;
  console.log(`  ply: ${statSync(plyPath).size} bytes, header says ${n} vertices, payload/${stride} = ${(buf.length - hdrLen) / stride}, kept=${keptPts} ${n === keptPts && (buf.length - hdrLen) === n * stride ? 'OK' : 'MISMATCH'}`);
  const x = buf.readDoubleLE(hdrLen), y = buf.readDoubleLE(hdrLen + 8), z = buf.readDoubleLE(hdrLen + 16);
  console.log(`  first vertex (absolute): ${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}`);
}

// ---------------------------------------------------------------- export E57
await setSel('k-fmt', 'e57');
const tE = Date.now();
const [dl2] = await Promise.all([p.waitForEvent('download', { timeout: 600000 }), p.click('#k-export')]);
console.log(`  e57 write took ${((Date.now() - tE) / 1000).toFixed(1)}s`);
const e57Path = `${OUT}/${dl2.suggestedFilename()}`;
await dl2.saveAs(e57Path);
await busyGone(600000);
console.log('EXPORT E57:', await p.textContent('#v-export'), `-> ${e57Path} (${(statSync(e57Path).size / 1e6).toFixed(1)} MB)`);

// Reload now warns when there is unsaved history; accept it.
async function reloadNow() {
  await p.click('#k-reload');
  try {
    await p.waitForSelector('#modal:not(.hidden)', { timeout: 2500 });
    const t = (await p.textContent('#modal-title')) || '';
    if (/reload/i.test(t)) await p.click('#modal-btns button.danger');
  } catch {}
  await loaded();
}

// ---------------------------------------------------------------- reload full + cache it
await reloadNow();
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
await p.waitForSelector('#modal:not(.hidden)', { timeout: 15000 });
await p.click('#modal-btns button:has-text("Cache it")');
await busyGone(600000);
console.log('CACHE:', await p.textContent('#v-cache'));

// ---------------------------------------------------------------- reload from cache
const tC = Date.now();
await reloadNow();
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log(`LOAD (cache): ${await p.textContent('#tb-points')}  wall ${((Date.now() - tC) / 1000).toFixed(1)}s | ${await p.textContent('#v-loaded')}`);
await p.waitForTimeout(800);
await p.screenshot({ path: 'shots/f-cached.png' });

// ---------------------------------------------------------------- panorama
// station clicks are ignored while a tool is armed, so leave measure mode first
await p.evaluate(() => document.querySelector('#toolbar [data-tool="orbit"]')?.click());
await p.keyboard.press('Escape');
await p.waitForFunction(() => window.__viewer.tool === 'none', null, { timeout: 5000 });
console.log('STATIONS:', await p.textContent('#v-stations'), '· tool:', await p.evaluate(() => window.__viewer.tool));
const hit = await p.evaluate(() => {
  const v = window.__viewer; const cam = v.camera;
  // pick the station nearest the screen centre
  let best = null;
  v.stations.forEach((s, i) => {
    const sp = v['stationSprites'][i]; const pr = sp.position.clone().project(cam);
    if (pr.z > 1) return;
    const x = (pr.x + 1) / 2 * innerWidth, y = (1 - pr.y) / 2 * innerHeight;
    const d = Math.hypot(x - innerWidth * 0.4, y - innerHeight * 0.5);
    if (!best || d < best.d) best = { i, x, y, d };
  });
  return best;
});
console.log('  clicking station', hit.i, 'at', hit.x.toFixed(0), hit.y.toFixed(0));
await p.mouse.click(hit.x, hit.y);
await p.waitForSelector('#bubble-ui:not(.hidden)', { timeout: 60000 });
await p.waitForTimeout(1200);
console.log('BUBBLE:', await p.textContent('#tb-tool'), '| blend', await p.inputValue('#k-blend'));
await p.screenshot({ path: 'shots/f-bubble.png' });
// photo only, then points only, for alignment check
await p.evaluate(() => { const s = document.getElementById('k-blend'); s.value = '0'; s.dispatchEvent(new Event('input')); });
await p.waitForTimeout(400); await p.screenshot({ path: 'shots/f-bubble-photo.png' });
await p.evaluate(() => { const s = document.getElementById('k-blend'); s.value = '1'; s.dispatchEvent(new Event('input')); });
await p.waitForTimeout(400); await p.screenshot({ path: 'shots/f-bubble-points.png' });
await p.keyboard.press('Escape');
await b.close();
console.log('DONE');
