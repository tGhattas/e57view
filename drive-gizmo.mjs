// Crop gizmo: drag the arrows to move, drag the handles to resize.
import { chromium } from 'playwright';
const FILE = '/Users/tamer/Downloads/1973-registered.e57';
const b = await chromium.launch({ channel: 'chrome', headless: false });
const p = await b.newPage({ viewport: { width: 1500, height: 940 } });
p.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 300)));
await p.goto(process.env.URL || 'http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
await p.evaluate(() => { document.getElementById('k-load').value = '10'; });
await p.setInputFiles('#file-input', FILE);
await p.waitForFunction(() => /(loaded|from cache) in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 300000 });
await p.waitForTimeout(1200);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 3000 }); } catch {}

await p.evaluate(() => { document.querySelector('[data-grp="crop"]').classList.remove('closed'); });
// set the orbit target programmatically to a surface point, away from any station marker
await p.evaluate(() => { const v = window.__viewer; const w = v.pickWorld(640, 520) || v.bounds().getCenter(v.camera.position.clone()); v.controls.target.copy(w); v.controls.update(); });
await p.click('#k-cropcentre');
await p.waitForTimeout(500);
// the crop is a region in main.ts now, not a field on the viewer
const region = () => p.evaluate(() => { const c = window.__app.cropState; return c ? { c: c.center.map(v => +v.toFixed(2)), h: c.half.map(v => +v.toFixed(2)) } : null; });
console.log('region before:', JSON.stringify(await region()));
await p.screenshot({ path: 'shots/g-gizmo.png' });

// find the gizmo's X-axis arrow on screen: project centre + offset along +X and drag from there
const arrow = await p.evaluate(() => {
  const v = window.__viewer; const c = window.__app.cropState.center;
  const THREE_V = v.camera.position.constructor;   // Vector3
  const pr = new THREE_V(c[0], c[1], c[2]).project(v.camera);
  // gizmo arrows are drawn in screen-relative size; probe a few pixels right of centre
  return { x: (pr.x + 1) / 2 * innerWidth, y: (1 - pr.y) / 2 * innerHeight };
});
console.log('gizmo centre on screen:', arrow.x.toFixed(0), arrow.y.toFixed(0));
// hover along +x to find the axis hit (tc.axis becomes 'X')
let hit = null;
for (let dx = 20; dx <= 140; dx += 6) {
  await p.mouse.move(arrow.x + dx, arrow.y); await p.waitForTimeout(30);
  const ax = await p.evaluate(() => window.__viewer['tc'].axis);
  if (ax) { hit = { x: arrow.x + dx, y: arrow.y, ax }; break; }
}
if (!hit) { // try left / up / down too
  for (const [ddx, ddy] of [[-1, 0], [0, -1], [0, 1]]) {
    for (let d = 20; d <= 140 && !hit; d += 6) {
      await p.mouse.move(arrow.x + ddx * d, arrow.y + ddy * d); await p.waitForTimeout(30);
      const ax = await p.evaluate(() => window.__viewer['tc'].axis);
      if (ax) hit = { x: arrow.x + ddx * d, y: arrow.y + ddy * d, ax };
    }
  }
}
console.log('hovering handle:', hit ? `${hit.ax} at ${hit.x.toFixed(0)},${hit.y.toFixed(0)}` : 'none found');
if (hit) {
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) { await p.mouse.move(hit.x + i * 10, hit.y + i * 4); await p.waitForTimeout(25); }
  await p.mouse.up();
  await p.waitForTimeout(400);
  console.log('region after move drag:', JSON.stringify(await region()), '| slider size readout:', await p.textContent('#v-cropsize'));
  await p.screenshot({ path: 'shots/g-moved.png' });

  // resize mode
  await p.click('#k-cropresize'); await p.waitForTimeout(300);
  let h2 = null;
  const c2 = await p.evaluate(() => { const v = window.__viewer; const c = window.__app.cropState.center; const pr = new (v.camera.position.constructor)(c[0], c[1], c[2]).project(v.camera); return { x: (pr.x + 1) / 2 * innerWidth, y: (1 - pr.y) / 2 * innerHeight }; });
  for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, -1], [0, 1]]) {
    for (let d = 16; d <= 140 && !h2; d += 5) {
      await p.mouse.move(c2.x + ddx * d, c2.y + ddy * d); await p.waitForTimeout(30);
      const ax = await p.evaluate(() => window.__viewer['tc'].axis);
      if (ax) h2 = { x: c2.x + ddx * d, y: c2.y + ddy * d, ax, ddx, ddy };
    }
  }
  console.log('resize handle:', h2 ? `${h2.ax}` : 'none');
  if (h2) {
    await p.mouse.down();
    for (let i = 1; i <= 10; i++) { await p.mouse.move(h2.x + h2.ddx * i * 12, h2.y + h2.ddy * i * 12); await p.waitForTimeout(25); }
    await p.mouse.up();
    await p.waitForTimeout(400);
    console.log('region after resize drag:', JSON.stringify(await region()), '| readouts:', await p.textContent('#v-cropsize'), await p.textContent('#v-crop'));
    await p.screenshot({ path: 'shots/g-resized.png' });
  }
}
// orbit must be back on after the drag
console.log('orbit enabled after drag:', await p.evaluate(() => window.__viewer.controls.enabled));
await b.close();
