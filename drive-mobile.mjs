import { chromium, devices } from 'playwright';

const FILE = '/Users/tamer/Downloads/1973-registered.e57';
const targets = [
  ['iphone', devices['iPhone 15 Pro']],
  ['ipad',   devices['iPad Pro 11']],
];

const b = await chromium.launch({ channel: 'chrome', headless: false });
for (const [name, dev] of targets) {
  const ctx = await b.newContext({ ...dev, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log(`  [${name} PAGEERROR]`, String(e).slice(0, 300)));
  p.on('console', m => { if (m.type() === 'error') console.log(`  [${name} err]`, m.text().slice(0,200)); });

  await p.goto('http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
  const vp = p.viewportSize();
  console.log(`\n=== ${name} ${vp.width}x${vp.height} dpr=${dev.deviceScaleFactor} touch=${dev.hasTouch} ===`);
  console.log('  coarse pointer:', await p.evaluate(() => matchMedia('(pointer: coarse)').matches));
  await p.screenshot({ path: `shots/${name}-entry.png` });

  console.log('  load default:', await p.evaluate(() => document.getElementById('k-load').value), '| budget:', await p.evaluate(() => document.getElementById('k-budget').value));
  await p.setInputFiles('#file-input', FILE);
  await p.waitForFunction(() => document.getElementById('ld-points')?.textContent !== '—', null, { timeout: 90000 });
  console.log('  plan:', await p.textContent('#ld-stat'));
  await p.screenshot({ path: `shots/${name}-loading.png` });

  await p.waitForSelector('#topbar:not(.hidden)', { timeout: 240000 });
  await p.waitForFunction(() => (document.getElementById('tb-points')?.textContent||'').includes('loaded in'),
                          null, { timeout: 600000 }).catch(()=>console.log('  (still streaming)'));
  await p.waitForTimeout(2500);
  console.log('  topbar:', await p.textContent('#tb-points'));
  console.log('  mem:', await p.textContent('#v-loaded'));
  console.log('  stats:', await p.textContent('#v-stats'));
  console.log('  gpu ms/frame:', (await p.evaluate(() => window.__viewer.benchmark(15))).toFixed(1));
  console.log('  sheet peeking:', await p.evaluate(() => document.getElementById('panel').classList.contains('peek')));
  await p.screenshot({ path: `shots/${name}-view.png` });

  // open the sheet
  await p.click('#grabber');
  await p.waitForTimeout(700);
  await p.screenshot({ path: `shots/${name}-panel.png` });

  // pinch/orbit sanity: drag to rotate
  const cx = vp.width/2, cy = vp.height*0.35;
  await p.touchscreen.tap(cx, cy);
  await p.waitForTimeout(200);
  console.log('  webgl ok:', await p.evaluate(() => {
    const v = window.__viewer; return !!v && v.loaded > 0;
  }));
  await ctx.close();
}
await b.close();
