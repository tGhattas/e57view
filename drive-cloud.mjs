// Cloud mode round trip: upload → server conversion → stream with prefix + refinement.
import { chromium } from 'playwright';
const SRC = '/private/tmp/claude-501/-Users-tamer-Developer-playground/d6f1a1ba-ecc2-4157-a520-9812531d0480/scratchpad/exports/1973-registered.e57'; // 7.4M pts, 319 MB
const URL = process.env.URL || 'http://127.0.0.1:5180/';
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1500, height: 940 } });
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.text())) console.log('  [err]', m.text().slice(0, 240)); });
await p.goto(URL, { waitUntil: 'networkidle' });
const loaded = () => p.waitForFunction(() => /(loaded|from cache|streamed) in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 600000 });
await p.evaluate(() => { localStorage.clear(); localStorage.setItem('cloud', '1'); document.getElementById('k-load').value = '1'; });
await p.setInputFiles('#file-input', SRC);
await loaded(); await p.waitForTimeout(1500);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
await p.evaluate(() => { const c = document.getElementById('k-cloud'); c.checked = true; c.dispatchEvent(new Event('change')); });
await p.waitForTimeout(2500);
console.log('CLOUD UI:', await p.textContent('#v-cloud'), '| upload button hidden:', await p.evaluate(() => document.getElementById('k-cloudup').classList.contains('hidden')));
const t0 = Date.now();
await p.click('#k-cloudup'); await p.waitForSelector('#modal:not(.hidden)'); await p.click('#modal-btns button.primary');
let link = null;
for (let i = 0; i < 720; i++) {
  await p.waitForTimeout(1000);
  const st = await p.evaluate(() => ({ v: document.getElementById('v-cloud').textContent, busy: document.getElementById('busy').classList.contains('hidden') ? '' : document.getElementById('busy-text').textContent, err: document.getElementById('err').classList.contains('hidden') ? '' : document.getElementById('err').textContent, a: document.querySelector('#v-cloud a')?.href }));
  if (i % 10 === 0) console.log(`  t+${i}s ${st.busy || st.v}`);
  if (st.err) { console.log('ERROR:', st.err); break; }
  if (st.a) { link = st.a; break; }
  if (/failed/.test(st.v)) { console.log('FAILED:', st.v); break; }
}
console.log(`UPLOAD+CONVERT: ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${link}`);
if (link) {
  const t1 = Date.now();
  await p.goto(link, { waitUntil: 'networkidle' });
  await loaded();
  console.log(`STREAM: ${await p.textContent('#tb-points')} wall ${((Date.now() - t1) / 1000).toFixed(1)}s | ${await p.textContent('#v-loaded')}`);
  const before = await p.evaluate(() => window.__viewer.cells.leaves.reduce((a, l) => a + l.count, 0));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: 'shots/cloud-stream.png' });
  // zoom in: the cells in view should refine
  await p.mouse.move(700, 480); for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, -240); await p.waitForTimeout(80); }
  await p.waitForTimeout(6000);
  const after = await p.evaluate(() => window.__viewer.cells.leaves.reduce((a, l) => a + l.count, 0));
  console.log(`REFINE: loaded records ${before.toLocaleString()} -> ${after.toLocaleString()} (${after > before ? 'refined' : 'no change'}) | ${await p.textContent('#v-stats')}`);
  await p.screenshot({ path: 'shots/cloud-refined.png' });
}
await b.close();
