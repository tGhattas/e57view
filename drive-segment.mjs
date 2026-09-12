// Freehand selection: the polygon maths, then the same thing through real mouse clicks.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
const PLANE = 120 * 120, BLOB = 40 * 40, TOTAL = PLANE + BLOB;
const ply = join(tmpdir(), 'e57view-seg.ply');
{
  const L = ['ply', 'format ascii 1.0', `element vertex ${TOTAL}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  for (let i = 0; i < 120; i++) for (let j = 0; j < 120; j++)
    L.push(`${(10 + i * 0.05).toFixed(4)} ${(10 + j * 0.05).toFixed(4)} 20.0000 190 180 160`);
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++)
    L.push(`${(40 + i * 0.05).toFixed(4)} ${(40 + j * 0.05).toFixed(4)} 25.0000 90 190 120`);
  writeFileSync(ply, L.join('\n'));
}
mkdirSync('shots', { recursive: true });
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await b.newContext({ viewport: { width: 1200, height: 820 } })).newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 120000 });

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache','e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });
await p.setInputFiles('#file-input', ply);
await p.waitForFunction(() => /loaded in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 120000 });
await p.waitForTimeout(900);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 3000 }); } catch {}
await p.evaluate(() => { document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')); window.__viewer.topDown(); });
await p.waitForTimeout(600);
console.log('LOAD:', await p.textContent('#tb-points'));

// undo refits the camera, so recompute the screen rectangle before each use
const measure = () => p.evaluate(() => {
  window.__viewer.topDown(); window.__viewer.dirty = true; window.__viewer.render();
  const v = window.__viewer, b = v.bounds();
  const r = v.canvas.getBoundingClientRect();
  const P = (x, y, z) => {
    const p = new (v.camera.position.constructor)(x, y, z).project(v.camera);
    return [(p.x + 1) / 2 * r.width, (1 - p.y) / 2 * r.height];
  };
  // the blob sits at the maximum corner; pad by 0.4 m so its edge points are included
  const pad = 0.4, z = b.max.z;
  const c = [P(b.max.x - 2 - pad, b.max.y - 2 - pad, z), P(b.max.x + pad, b.max.y - 2 - pad, z),
             P(b.max.x + pad, b.max.y + pad, z), P(b.max.x - 2 - pad, b.max.y + pad, z)];
  const inside = v.polygonMask(c, true, r.width, r.height).reduce((a, m) => a + m.reduce((s, x) => s + x, 0), 0);
  const outside = v.polygonMask(c, false, r.width, r.height).reduce((a, m) => a + m.reduce((s, x) => s + x, 0), 0);
  return { poly: c.map(q => q.map(Math.round)), inside, outside, total: v.loaded };
});
let rect = await measure();
console.log('POLY', JSON.stringify(rect.poly));
ok('inside count matches the blob', Math.abs(rect.inside - 1600) < 60, `${rect.inside} inside, expected 1600`);
ok('inside and outside are complementary', rect.inside + rect.outside === rect.total, `${rect.inside} + ${rect.outside} = ${rect.total}`);

// --- the interaction: arm with S, click the corners, keep inside
await p.keyboard.press('s');
ok('S arms the tool', await p.evaluate(() => window.__viewer.tool === 'segment'), '');
ok('decision bar is showing', await p.evaluate(() => !document.getElementById('segbar').classList.contains('hidden')), '');
const canvas = await p.evaluate(() => { const r = document.getElementById('gl').getBoundingClientRect(); return { x: r.x, y: r.y }; });
for (const [x, y] of rect.poly) await p.mouse.click(canvas.x + x, canvas.y + y);
await p.waitForTimeout(200);
ok('four vertices captured', (await p.textContent('#seg-hint')).includes('4 points'), await p.textContent('#seg-hint'));
await p.screenshot({ path: 'shots/segment-drawn.png' });
ok('keep buttons enabled', await p.evaluate(() => !document.getElementById('seg-in').disabled), '');
await p.click('#seg-in'); await idle(); await p.waitForTimeout(300);
const kept = await p.evaluate(() => window.__viewer.loaded);
ok('keeping inside leaves the blob', Math.abs(kept - 1600) < 60, `${kept} points left`);
ok('tool disarmed after use', await p.evaluate(() => window.__viewer.tool === 'none' && document.getElementById('segbar').classList.contains('hidden')), '');
await p.screenshot({ path: 'shots/segment-kept.png' });

await p.click('#tb-undo'); await idle();
ok('undo restores everything', await p.evaluate(() => window.__viewer.loaded) === TOTAL, `${await p.evaluate(() => window.__viewer.loaded)}`);

// --- keep outside, the complement
rect = await measure(); await p.waitForTimeout(300);
await p.keyboard.press('s');
for (const [x, y] of rect.poly) await p.mouse.click(canvas.x + x, canvas.y + y);
await p.click('#seg-out'); await idle(); await p.waitForTimeout(300);
const outKept = await p.evaluate(() => window.__viewer.loaded);
ok('keeping outside removes the blob', Math.abs(outKept - (TOTAL - 1600)) < 60, `${outKept} points left`);
await p.click('#tb-undo'); await idle();

// --- Escape backs out without touching anything
rect = await measure();
await p.keyboard.press('s');
await p.mouse.click(canvas.x + rect.poly[0][0], canvas.y + rect.poly[0][1]);
await p.keyboard.press('Escape');
const afterEsc = await p.evaluate(() => ({ hint: document.getElementById('seg-hint').textContent, tool: window.__viewer.tool, n: window.__viewer.loaded }));
ok('Escape clears the polygon but keeps the tool', /Click to trace/.test(afterEsc.hint) && afterEsc.tool === 'segment', afterEsc.hint);
await p.keyboard.press('Escape');
ok('Escape again disarms', await p.evaluate(n => window.__viewer.tool === 'none' && window.__viewer.loaded === n, TOTAL), '');

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(fails ? 1 : 0);
