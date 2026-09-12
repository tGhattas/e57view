// SPDX-License-Identifier: GPL-3.0-only
import { chromium, devices } from 'playwright';
import { requireTestFile } from './shared/testfile.mjs';
const FILE = requireTestFile();
if (!FILE) process.exit(0);
const URL = 'https://opensketch.web.app/';
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist','--enable-gpu'] });

for (const [name, dev] of [['desktop', null], ['iphone', devices['iPhone 15 Pro']]]) {
  const ctx = await b.newContext(dev ? { ...dev } : { viewport: { width: 1500, height: 940 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log(`  [${name} PAGEERROR]`, String(e).slice(0,300)));
  p.on('response', r => { if (r.status() >= 400) console.log(`  [${name}] ${r.status()} ${r.url()}`); });
  await p.goto(URL, { waitUntil: 'networkidle' });
  console.log(`\n=== LIVE ${name} ===`);
  console.log('  defaults: load 1 in', await p.evaluate(() => document.getElementById('k-load').value),
              '| budget', await p.evaluate(() => (+document.getElementById('k-budget').value/1e6)+'M'));
  await p.setInputFiles('#file-input', FILE);
  await p.waitForFunction(() => document.getElementById('ld-points')?.textContent !== '—', null, { timeout: 90000 });
  const t0 = Date.now();
  await p.waitForSelector('#topbar:not(.hidden)', { timeout: 240000 });
  console.log(`  preview after ${((Date.now()-t0)/1000).toFixed(1)}s`);
  await p.waitForFunction(() => (document.getElementById('tb-points')?.textContent||'').includes('loaded in'), null, { timeout: 600000 });
  await p.waitForTimeout(1500);
  console.log('  result:', await p.textContent('#tb-points'));
  console.log('  memory:', await p.textContent('#v-loaded'));
  console.log('  frame :', await p.textContent('#v-stats'), '| gpu', (await p.evaluate(() => window.__viewer.benchmark(15))).toFixed(1), 'ms');
  await p.screenshot({ path: `shots/live-${name}.png` });
  if (!dev) {
    // walk in through the courtyard for the hero shot
    await p.mouse.move(640, 500);
    for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, -240); await p.waitForTimeout(60); }
    await p.mouse.dblclick(640, 500); await p.waitForTimeout(300);
    for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, -240); await p.waitForTimeout(60); }
    await p.waitForTimeout(900);
    console.log('  close :', await p.textContent('#v-stats'), '| gpu', (await p.evaluate(() => window.__viewer.benchmark(15))).toFixed(1), 'ms');
    await p.screenshot({ path: `shots/live-close.png` });
  }
  await ctx.close();
}
await b.close();
