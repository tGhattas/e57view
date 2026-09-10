import { chromium } from 'playwright';
const ID = process.env.CLOUD_ID || '0233c9aada284b279a13';
const URL = (process.env.URL || 'http://127.0.0.1:5180/') + '?cloud=' + ID;
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1500, height: 940 } });
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.text())) console.log('  [err]', m.text().slice(0, 240)); });
const t0 = Date.now();
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => /streamed in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 300000 });
console.log(`STREAM: ${await p.textContent('#tb-points')} wall ${((Date.now() - t0) / 1000).toFixed(1)}s | ${await p.textContent('#v-loaded')}`);
console.log('  fields:', await p.textContent('#ld-fields'), '| loaded bytes so far:', await p.evaluate(() => window.__viewer.cells.leaves.reduce((a, l) => a + l.count, 0) * 14));
const before = await p.evaluate(() => window.__viewer.cells.leaves.reduce((a, l) => a + l.count, 0));
await p.waitForTimeout(1200);
await p.screenshot({ path: 'shots/cloud-stream.png' });
await p.mouse.move(700, 480); for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, -240); await p.waitForTimeout(80); }
await p.waitForTimeout(7000);
const after = await p.evaluate(() => window.__viewer.cells.leaves.reduce((a, l) => a + l.count, 0));
console.log(`REFINE after zoom: records ${before.toLocaleString()} -> ${after.toLocaleString()} (${after > before ? 'refined' : 'no change'}) | ${await p.textContent('#v-stats')}`);
await p.screenshot({ path: 'shots/cloud-refined.png' });
// range request sanity from node itself
const meta = await p.evaluate(async () => { const m = await window.__app.clouds(); return m?.find(c => c.status === 'ready'); });
if (meta) { const r = await fetch(meta.cellsUrl, { headers: { Range: 'bytes=0-13' } }); console.log('  range request status:', r.status, 'accept-ranges:', r.headers.get('accept-ranges'), 'len:', (await r.arrayBuffer()).byteLength); }
await b.close();
