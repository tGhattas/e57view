import { chromium } from 'playwright';
const FILE = '/Users/tamer/Downloads/1973-registered.e57';
const URL = process.env.URL || 'http://127.0.0.1:5180/';
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist','--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
p.on('console', m => { const t=m.text(); if(m.type()==='error'||t.includes('wasm')) console.log('  [browser]', t.slice(0,220)); });
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0,400)));

await p.goto(URL, { waitUntil: 'networkidle' });
const stats = async () => (await p.textContent('#v-stats')) + ' | ' + (await p.textContent('#tb-fps'));

await p.evaluate(v => { document.getElementById('k-load').value = v; }, process.env.LOAD || '1');
await p.setInputFiles('#file-input', FILE);
await p.waitForFunction(() => document.getElementById('ld-points')?.textContent !== '—', null, { timeout: 60000 });
console.log('META:', await p.textContent('#ld-points'), '|', await p.textContent('#ld-fields'));
console.log('OPEN:', await p.textContent('#ld-stat'));

const tPrev = Date.now();
await p.waitForSelector('#topbar:not(.hidden)', { timeout: 120000 });
console.log(`preview visible after ${((Date.now()-tPrev)/1000).toFixed(1)}s`);

const t0 = Date.now();
await p.waitForFunction(() => (document.getElementById('tb-points')?.textContent||'').includes('loaded in'), null, { timeout: 600000 });
console.log(`LOADED in ${((Date.now()-t0)/1000).toFixed(1)}s (wall) ->`, await p.textContent('#tb-points'));
console.log('MEM:', await p.textContent('#v-loaded'));
await p.waitForTimeout(1500);
console.log('STATS fit:', await stats());
await p.screenshot({ path: 'shots/v2-rgb.png' });

// --- zoom toward the building with the cursor (Q1) ---
const cx = 620, cy = 520;
await p.mouse.move(cx, cy);
for (let i = 0; i < 14; i++) { await p.mouse.wheel(0, -240); await p.waitForTimeout(70); }
await p.waitForTimeout(900);
console.log('STATS zoomed:', await stats());
await p.screenshot({ path: 'shots/v2-zoom.png' });

// --- double-click to re-centre, then zoom further ---
await p.mouse.dblclick(cx, cy);
await p.waitForTimeout(300);
for (let i = 0; i < 10; i++) { await p.mouse.wheel(0, -240); await p.waitForTimeout(70); }
await p.waitForTimeout(900);
console.log('STATS close:', await stats());
await p.screenshot({ path: 'shots/v2-close.png' });

// --- fly mode: walk forward ---
await p.keyboard.press('f');
await p.waitForTimeout(200);
await p.keyboard.down('w'); await p.waitForTimeout(1800); await p.keyboard.up('w');
await p.waitForTimeout(700);
console.log('STATS fly:', await stats());
await p.screenshot({ path: 'shots/v2-fly.png' });
await p.keyboard.press('f');

// --- measure interaction frame time: orbit drag ---
await p.click('#k-fit'); await p.waitForTimeout(800);
const ms = [];
await p.mouse.move(700, 450); await p.mouse.down();
for (let i = 0; i < 40; i++) { await p.mouse.move(700 + i*6, 450 + i*2); await p.waitForTimeout(16);
  ms.push(await p.evaluate(() => window.__viewer.frameMs)); }
await p.mouse.up();
await p.waitForTimeout(600);
ms.sort((a,b)=>a-b);
console.log(`frame ms while orbiting: median ${ms[20].toFixed(1)}  p90 ${ms[36].toFixed(1)}`);
console.log('STATS idle:', await stats());

// --- GPU-inclusive frame time at several budgets (fit view, then close view) ---
for (const view of ['fit','close']) {
  if (view === 'fit') { await p.click('#k-fit'); }
  else { await p.mouse.move(cx, cy); for (let i=0;i<14;i++){ await p.mouse.wheel(0,-240); await p.waitForTimeout(40);} }
  await p.waitForTimeout(700);
  for (const budget of ['4000000','8000000','16000000','32000000']) {
    await p.evaluate(v => { const s=document.getElementById('k-budget'); s.value=v; s.dispatchEvent(new Event('change')); }, budget);
    await p.waitForTimeout(150);
    const ms = await p.evaluate(() => window.__viewer.benchmark(20));
    const st = await p.textContent('#v-stats');
    console.log(`GPU ${view.padEnd(5)} budget ${(+budget/1e6).toString().padStart(2)}M: ${ms.toFixed(1)} ms/frame  (${st.split('·')[0].trim()})`);
  }
}
await p.evaluate(() => { const s=document.getElementById('k-budget'); s.value='8000000'; s.dispatchEvent(new Event('change')); });
await p.click('#k-fit'); await p.waitForTimeout(800);
await p.screenshot({ path: 'shots/v2-rgb.png' });

// --- other colour modes ---
await p.selectOption('#k-color', '3'); await p.waitForTimeout(500);
await p.screenshot({ path: 'shots/v2-elev.png' });
await p.selectOption('#k-color', '0'); await p.check('#k-nrm'); await p.waitForTimeout(500);
await p.screenshot({ path: 'shots/v2-normals.png' });
await b.close();
