// Undo / redo / save on the real scan: spill to disk, timings, cache rules.
import { chromium } from 'playwright';
const FILE = process.env.FILE || '/Users/tamer/Downloads/1973-registered.e57';
const URL = process.env.URL || 'http://127.0.0.1:5180/';
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.text())) console.log('  [err]', m.text().slice(0, 240)); });
const t = (a) => `${((Date.now() - a) / 1000).toFixed(1)}s`;
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden') && document.getElementById('modal').classList.contains('hidden'), null, { timeout: 300000 });
const st = () => p.evaluate(() => ({ n: window.__viewer.loaded, undo: window.__app.hist.undo.length, redo: window.__app.hist.redo.length, ram: window.__app.hist.ram, spilled: window.__app.hist.undo.map(e => e.spilled), hist: document.getElementById('v-hist').textContent, cache: document.getElementById('v-cache').textContent }));
const modalClick = async (txt) => { await p.waitForSelector('#modal:not(.hidden)', { timeout: 20000 }); await p.click(`#modal-btns button:has-text("${txt}")`); };

await p.goto(URL, { waitUntil: 'networkidle' });
await p.evaluate(async st => { window.showSaveFilePicker = undefined; localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache', 'e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } document.getElementById('k-load').value = st; }, process.env.STRIDE || '4');
let t0 = Date.now();
await p.setInputFiles('#file-input', FILE);
await p.waitForFunction(() => /(loaded|from cache) in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 600000 });
await p.waitForTimeout(1200); await modalClick('Not now');
const N = (await st()).n; console.log(`LOAD ${N.toLocaleString()} pts in ${t(t0)}`);
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));

// crop: box around the orbit centre, ~35% of the extent → drops most points → spills to disk
await p.click('#k-cropcentre');
await p.evaluate(() => { for (const id of ['k-cropsize', 'k-cropsy', 'k-cropsz']) { const s = document.getElementById(id); s.value = '0.35'; s.dispatchEvent(new Event('input')); } });
t0 = Date.now(); await p.click('#k-cropapply'); await modalClick('Drop outside'); await idle();
let s = await st(); console.log(`CROP  ${s.n.toLocaleString()} pts in ${t(t0)} · undo ${s.undo} · spilled ${JSON.stringify(s.spilled)} · ram ${(s.ram/1e6).toFixed(0)} MB · "${s.hist}"`);
const cropN = s.n;
const files = await p.evaluate(async () => { const r = await navigator.storage.getDirectory(); let n = 0, bytes = 0; try { const d = await r.getDirectoryHandle('e57view-undo'); for await (const [, e] of d) { for await (const [, f] of e) { n++; bytes += (await f.getFile()).size; } } } catch {} return { n, bytes }; });
console.log(`SPILL files ${files.n} · ${(files.bytes / 1e6).toFixed(0)} MB on disk`);

t0 = Date.now(); await p.click('#tb-undo'); await idle();
s = await st(); console.log(`UNDO  ${s.n.toLocaleString()} pts in ${t(t0)} · undo ${s.undo} redo ${s.redo}`);
if (s.n !== N) throw new Error('undo did not restore every point');
t0 = Date.now(); await p.click('#tb-redo'); await idle();
s = await st(); console.log(`REDO  ${s.n.toLocaleString()} pts in ${t(t0)} · undo ${s.undo} redo ${s.redo}`);
if (s.n !== cropN) throw new Error('redo count differs from the crop');
t0 = Date.now(); await p.keyboard.press('Meta+z'); await idle();
s = await st(); console.log(`⌘Z    ${s.n.toLocaleString()} pts in ${t(t0)}`);
if (s.n !== N) throw new Error('second undo failed');

// AI clean: heuristic, approve all, apply, undo, redo
t0 = Date.now();
await p.evaluate(() => { const sel = document.getElementById('k-aiprov'); sel.value = 'heuristic'; sel.dispatchEvent(new Event('change')); });
await p.click('#k-aianalyse'); await idle();
const nSug = await p.evaluate(() => window.__app.suggestions.length);
await p.click('#k-aiacceptall'); await p.click('#k-aiapply'); await modalClick('Remove'); await idle();
s = await st(); console.log(`CLEAN ${nSug} boxes → ${s.n.toLocaleString()} pts in ${t(t0)} · spilled ${JSON.stringify(s.spilled)} · ram ${(s.ram/1e6).toFixed(0)} MB`);
const cleanN = s.n;
t0 = Date.now(); await p.click('#tb-undo'); await idle(); s = await st(); console.log(`UNDO  ${s.n.toLocaleString()} pts in ${t(t0)} · suggestions back: ${await p.evaluate(() => window.__app.suggestions.length)}`);
if (s.n !== N) throw new Error('undo of clean failed');
t0 = Date.now(); await p.click('#tb-redo'); await idle(); s = await st(); console.log(`REDO  ${s.n.toLocaleString()} pts in ${t(t0)}`);
if (s.n !== cleanN) throw new Error('redo of clean failed');

// Save while NOT cached: must not create a cache
const [dl1] = await Promise.all([p.waitForEvent('download', { timeout: 300000 }), (async () => { t0 = Date.now(); await p.click('#tb-save'); await modalClick('Choose'); })()]);
await idle(); await p.waitForFunction(() => window.__app.hist.undo.length === 0 && window.__app.hist.redo.length === 0, null, { timeout: 60000 }); s = await st();
const cachedNow = await p.evaluate(async () => { const r = await navigator.storage.getDirectory(); try { const d = await r.getDirectoryHandle('e57view-cache'); let n = 0; for await (const _ of d) n++; return n; } catch { return 0; } });
console.log(`SAVE (not cached) ${dl1.suggestedFilename()} in ${t(t0)} · undo ${s.undo} redo ${s.redo} · cache dirs now: ${cachedNow} · "${s.cache}"`);
if (cachedNow) throw new Error('Save created a cache although the scan was not cached');
if (!/undo cleared/.test(s.cache) || /cache updated/.test(s.cache)) throw new Error('status after uncached save is wrong: ' + s.cache);

// cache it, edit, save → cache must hold the edited points
t0 = Date.now(); await p.evaluate(() => window.__app.writeCache()); await idle(); console.log(`CACHE written in ${t(t0)}`);
await p.click('#k-cropcentre'); t0 = Date.now(); await p.click('#k-cropapply'); await modalClick('Drop outside'); await idle();
s = await st(); const crop2 = s.n; console.log(`CROP2 ${crop2.toLocaleString()} pts in ${t(t0)}`);
const [dl2] = await Promise.all([p.waitForEvent('download', { timeout: 300000 }), (async () => { t0 = Date.now(); await p.click('#tb-save'); await modalClick('Choose'); })()]);
await idle(); await p.waitForFunction(() => window.__app.hist.undo.length === 0 && window.__app.hist.redo.length === 0, null, { timeout: 60000 });
s = await st(); console.log(`SAVE (cached) ${dl2.suggestedFilename()} in ${t(t0)} · undo ${s.undo} redo ${s.redo} · "${s.cache}"`);
if (!/cache updated · undo cleared/.test(s.cache)) throw new Error('status after cached save is wrong: ' + s.cache);
t0 = Date.now(); await p.evaluate(() => document.getElementById('k-reload').click()); await p.waitForFunction(() => /from cache in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 120000 });
await p.waitForFunction(() => window.__viewer.cells.pendingCount === 0, null, { timeout: 60000 });
s = await st(); console.log(`RELOAD from cache ${s.n.toLocaleString()} pts in ${t(t0)} (expected ${crop2.toLocaleString()})`);
if (s.n !== crop2) throw new Error('cache does not hold the saved state');
const leftover = await p.evaluate(async () => { const r = await navigator.storage.getDirectory(); try { const d = await r.getDirectoryHandle('e57view-undo'); let n = 0; for await (const _ of d) n++; return n; } catch { return 0; } });
console.log(`UNDO DIR leftover entries: ${leftover}`);
await p.screenshot({ path: 'shots/undo-big.png' });
console.log('OK'); await b.close();
