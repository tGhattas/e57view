import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const FILE = '/Users/tamer/Downloads/1973-registered.e57';
const URL = process.env.URL || 'http://127.0.0.1:5180/';
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1500, height: 940 } });
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.text())) console.log('  [err]', m.text().slice(0, 240)); });
await p.goto(URL, { waitUntil: 'networkidle' });
await p.evaluate(st => { localStorage.clear(); document.getElementById('k-load').value = st; }, process.env.STRIDE || '4');
await p.setInputFiles('#file-input', FILE);
await p.waitForFunction(() => /(loaded|from cache) in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 600000 });
await p.waitForTimeout(1200); try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('LOAD:', await p.textContent('#tb-points'));

// what the model sees
const t0r = Date.now();
const r = await p.evaluate(async () => { const x = await window.__app.aiRenders(); return { frame: x.frame, top: x.images[0].dataUrl, obl: x.images[1].dataUrl, cands: x.candCtx, closeups: x.images.slice(2).map(i => i.dataUrl), n: x.closeups }; });
console.log(`PREP: ${((Date.now() - t0r) / 1000).toFixed(1)}s, ${r.closeups.length} close-ups`);
r.closeups.forEach((d, i) => writeFileSync(`shots/ai/c${i + 1}.jpg`, Buffer.from(d.split(',')[1], 'base64')));
writeFileSync('shots/ai/context.json', JSON.stringify({ extentX: r.frame.extentX, extentY: r.frame.extentY, zMin: 0, zMax: r.frame.zMax - r.frame.zMin, candidates: r.cands, closeups: r.n }, null, 1));
writeFileSync('shots/ai/top.png', Buffer.from(r.top.split(',')[1], 'base64'));
writeFileSync('shots/ai/oblique.png', Buffer.from(r.obl.split(',')[1], 'base64'));
console.log('RENDERS:', JSON.stringify({ ...r.frame }), `top ${(r.top.length * 0.75 / 1e6).toFixed(2)} MB, oblique ${(r.obl.length * 0.75 / 1e6).toFixed(2)} MB`);
console.log('CANDIDATES:', r.cands.map(c => `${c.id} ${c.area.toFixed(0)}m² h${c.height.toFixed(1)} @${c.x.toFixed(0)},${c.y.toFixed(0)}`).join(' | '));

for (const prov of (process.env.PROVIDERS || 'openai,xai').split(',')) {
  if (!['openai', 'xai'].includes(prov)) continue;
  await p.evaluate(pr => { const s = document.getElementById('k-aiprov'); s.value = pr; s.dispatchEvent(new Event('change')); document.getElementById('k-aimodel').value = ''; }, prov);
  const t0 = Date.now();
  await p.click('#k-aianalyse');
  await p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 360000 });
  await p.waitForTimeout(600);
  const status = await p.textContent('#v-ai');
  console.log(`\n${prov.toUpperCase()} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${status}`);
  const sug = await p.evaluate(() => window.__app.suggestions.map(s => ({ label: s.label, kind: s.kind, c: s.center.map(v => +v.toFixed(1)), size: s.kind === 'slab' ? `${(s.half[2] * 2).toFixed(1)} m thick` : s.half.map(v => +(v * 2).toFixed(1)).join('×') })));
  for (const s of sug) console.log(`  - ${s.kind.padEnd(4)} ${s.label.padEnd(44)} at ${s.c.join(',').padEnd(20)} ${s.size}`);
  const raw = await p.evaluate(() => window.__app.lastAi?.result);
  if (raw) { for (const c of raw.candidates) console.log(`    ${c.id.padEnd(4)} ${c.remove ? 'REMOVE' : 'keep  '} ${c.label.padEnd(16)} ${(c.confidence*100).toFixed(0)}% ${c.reason}`); for (const a of raw.additional) console.log(`    + ${a.label} ${(a.confidence*100).toFixed(0)}% [${a.x0},${a.y0}→${a.x1},${a.y1}] ${a.reason}`); for (const x of raw.sections) console.log(`    § ${x.label} ${x.from}→${x.to} ${x.reason}`); }
  await p.click('#k-fit'); await p.waitForTimeout(800);
  await p.screenshot({ path: `shots/ai/${prov}-suggestions.png` });
  await p.evaluate(() => { document.getElementById('k-airejectall').click(); });
}
await b.close();
