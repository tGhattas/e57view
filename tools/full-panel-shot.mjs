// SPDX-License-Identifier: GPL-3.0-only
// SPDX-License-Identifier: GPL-3.0-only
// The whole side panel at a given width, at the height a user actually sees.
//
//   node tools/full-panel-shot.mjs docs/panel.png 266
import { chromium } from 'playwright';
const out = process.argv[2]; const w = Number(process.argv[3] || 266);
const br = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const p = await (await br.newContext({ viewport: { width: 1400, height: 2400 }, deviceScaleFactor: 1.5 })).newPage();
p.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0,160)));
await p.goto(process.env.URL || 'http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
await p.evaluate((w) => {
  document.getElementById('drop').classList.add('hidden');
  const panel = document.getElementById('panel');
  panel.classList.remove('hidden');
  panel.style.width = w + 'px';
  // its real height, the way a user sees it, scrolled to the top
  document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed'));
  panel.scrollTop = 0;
}, w);
await p.waitForTimeout(700);
const el = await p.$('#panel');
await el.screenshot({ path: out });
const b = await el.boundingBox();
console.log(`${out} · ${Math.round(b.width)} x ${Math.round(b.height)}`);
await br.close();
