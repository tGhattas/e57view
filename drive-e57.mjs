// SPDX-License-Identifier: GPL-3.0-only
import { chromium } from 'playwright';
import { statSync, mkdirSync } from 'node:fs';
import { requireTestFile } from './shared/testfile.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const FILE = requireTestFile();
if (!FILE) process.exit(0);
const OUT = join(tmpdir(), 'e57view-out');
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await b.newContext({ viewport: { width: 1500, height: 940 }, acceptDownloads: true });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0,300)));
p.on('console', m => { if (m.type()==='error'||/wasm|panic/i.test(m.text())) console.log('[browser]', m.text().slice(0,300)); });
await p.goto('http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
await p.evaluate((st) => { window.showSaveFilePicker = undefined; document.getElementById('k-load').value = st; }, process.env.STRIDE || '10');
await p.setInputFiles('#file-input', FILE);
await p.waitForFunction(() => /(loaded|from cache) in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 300000 });
await p.waitForTimeout(1200);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 3000 }); } catch {}
console.log('LOADED:', await p.textContent('#tb-points'));
await p.evaluate(() => { document.querySelector('[data-grp="export"]').classList.remove('closed'); const s = document.getElementById('k-fmt'); s.value = 'e57'; s.dispatchEvent(new Event('change')); });
const t0 = Date.now();
let dl = null;
const dlp = p.waitForEvent('download', { timeout: 900000 }).then(d => dl = d).catch(() => null);
await p.click('#k-export');
// poll status while it runs
for (let i = 0; i < 900; i++) {
  await p.waitForTimeout(1000);
  const busy = await p.evaluate(() => document.getElementById('busy').classList.contains('hidden') ? '' : document.getElementById('busy-text').textContent);
  const err = await p.evaluate(() => document.getElementById('err').classList.contains('hidden') ? '' : document.getElementById('err').textContent);
  if (i % 5 === 0 && busy) console.log(`  t+${i}s ${busy}`);
  if (err) { console.log('ERROR:', err); break; }
  if (dl) break;
}
if (dl) {
  const path = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  console.log(`E57 EXPORT: ${(Date.now()-t0)/1000}s -> ${path} ${(statSync(path).size/1e6).toFixed(1)} MB |`, await p.textContent('#v-export'));
} else console.log('no download');
await b.close();
