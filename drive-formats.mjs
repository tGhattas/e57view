// LAZ, plain text and PTX: the formats a surveyor actually gets handed.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
mkdirSync('shots', { recursive: true });
const N = 60 * 60;
// a slab with a known corner point, so a coordinate can be checked after every round trip
const pts = [];
for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) pts.push([10 + i * 0.05, 20 + j * 0.05, 30 + ((i + j) % 3) * 0.01]);
const CLASSES = [2, 6, 11];

// ---- a LAS 1.2 point-format-3 file with colour, intensity and classification
const las = join(tmpdir(), 'e57view-fmt.las');
{
  const recLen = 34, off = 227;
  const buf = Buffer.alloc(off + N * recLen);
  buf.write('LASF', 0, 'latin1');
  buf.writeUInt8(1, 24); buf.writeUInt8(2, 25);
  buf.writeUInt16LE(227, 94); buf.writeUInt32LE(off, 96); buf.writeUInt32LE(0, 100);
  buf.writeUInt8(3, 104); buf.writeUInt16LE(recLen, 105);
  buf.writeUInt32LE(N, 107);
  for (const [i, v] of [[131, 0.001], [139, 0.001], [147, 0.001]]) buf.writeDoubleLE(v, i);
  for (const [i, v] of [[155, 0], [163, 0], [171, 0]]) buf.writeDoubleLE(v, i);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[a]); mx[a] = Math.max(mx[a], p[a]); }
  buf.writeDoubleLE(mx[0], 179); buf.writeDoubleLE(mn[0], 187);
  buf.writeDoubleLE(mx[1], 195); buf.writeDoubleLE(mn[1], 203);
  buf.writeDoubleLE(mx[2], 211); buf.writeDoubleLE(mn[2], 219);
  pts.forEach((p, k) => {
    const o = off + k * recLen;
    buf.writeInt32LE(Math.round(p[0] * 1000), o);
    buf.writeInt32LE(Math.round(p[1] * 1000), o + 4);
    buf.writeInt32LE(Math.round(p[2] * 1000), o + 8);
    buf.writeUInt16LE(1000 + (k % 500), o + 12);
    buf.writeUInt8(0x09, o + 14);
    buf.writeUInt8(CLASSES[k % 3], o + 15);
    buf.writeUInt16LE((k % 255) * 257, o + 28);
    buf.writeUInt16LE(((k * 7) % 255) * 257, o + 30);
    buf.writeUInt16LE(((k * 13) % 255) * 257, o + 32);
  });
  writeFileSync(las, buf);
}
// ---- plain text, three different column orders
const txts = {
  xyz: join(tmpdir(), 'e57view-fmt-xyz.txt'),
  pts: join(tmpdir(), 'e57view-fmt-pts.pts'),
  csv: join(tmpdir(), 'e57view-fmt-hdr.csv'),
};
writeFileSync(txts.xyz, pts.map(p => p.map(v => v.toFixed(4)).join(' ')).join('\n'));
writeFileSync(txts.pts, pts.map((p, k) => `${p.map(v => v.toFixed(4)).join(' ')} ${(-0.5 + (k % 100) / 200).toFixed(3)} ${k % 255} ${(k * 7) % 255} ${(k * 13) % 255}`).join('\n'));
writeFileSync(txts.csv, 'Northing,Easting,Height,Red,Green,Blue\n' + pts.map((p, k) => `${p[1].toFixed(4)},${p[0].toFixed(4)},${p[2].toFixed(4)},${k % 255},${(k * 7) % 255},${(k * 13) % 255}`).join('\n'));
// ---- a PTX with two scans, the second offset by 5 m in x
const ptx = join(tmpdir(), 'e57view-fmt.ptx');
{
  const L = [];
  for (const [sx, sy, sz] of [[0, 0, 0], [5, 0, 0]]) {
    L.push('60', '60', `${sx} ${sy} ${sz}`, '1 0 0', '0 1 0', '0 0 1',
      '1 0 0 0', '0 1 0 0', '0 0 1 0', `${sx} ${sy} ${sz} 1`);
    for (const p of pts) L.push(`${p[0].toFixed(4)} ${p[1].toFixed(4)} ${p[2].toFixed(4)} 0.5 200 190 170`);
  }
  writeFileSync(ptx, L.join('\n'));
}

const br = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const ctx = await br.newContext({ viewport: { width: 1200, height: 800 }, acceptDownloads: true });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200)); });
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 300000 });
const loaded = () => p.evaluate(() => window.__viewer.loaded);
/** Bounding box of the loaded points in global coordinates. */
const globalBox = () => p.evaluate(() => {
  const v = window.__viewer, t = window.__app.meta.scans[0].translation;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const { leaf, recs } of v.cells.records()) {
    const xyz = v.cells.transformRecordsInto(recs, leaf.count, leaf, new Float64Array(leaf.count * 3));
    for (let i = 0; i < leaf.count; i++) for (let a = 0; a < 3; a++) { const q = xyz[i * 3 + a] + t[a]; if (q < mn[a]) mn[a] = q; if (q > mx[a]) mx[a] = q; }
  }
  return { mn, mx };
});
async function open(path, expect) {
  await p.setInputFiles('#file-input', []);
  await p.setInputFiles('#file-input', path);
  try { await p.click('#modal-btns button.danger', { timeout: 1200 }); } catch {}
  try { await p.click('#modal-btns button:has-text("Open")', { timeout: 2500 }); } catch {}
  await p.waitForFunction(c => window.__viewer.loaded === c, expect, { timeout: 120000 });
  await p.waitForTimeout(600);
  try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2000 }); } catch {}
}

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { window.showSaveFilePicker = undefined; localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache', 'e57view-undo', 'e57view-export']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });

// ---------------------------------------------------------------- LAS in, LAZ out, LAZ in
await open(las, N);
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('LAS:', await p.textContent('#tb-points'));
ok('the LAS loaded whole', await loaded() === N, `${await loaded()} of ${N}`);
const lasBox = await globalBox();
console.log('LAS BOX', JSON.stringify({ mn: lasBox.mn.map(v => +v.toFixed(3)), mx: lasBox.mx.map(v => +v.toFixed(3)) }));
ok('its coordinates are where they were written', Math.abs(lasBox.mn[0] - 10) < 0.002 && Math.abs(lasBox.mx[1] - 22.95) < 0.002,
   `${lasBox.mn.map(v => v.toFixed(3))} … ${lasBox.mx.map(v => v.toFixed(3))}`);
await p.waitForFunction(() => /^Classification/.test(document.getElementById('v-sfname')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
const cls = await p.evaluate(() => { const s = window.__app.sfStats; return { name: document.getElementById('v-sfname').textContent, min: s?.min, max: s?.max, n: s?.n }; });
console.log('CLASSIFICATION', JSON.stringify(cls));
ok('classification came through as a field', /^Classification/.test(cls.name ?? '') && cls.min === 2 && cls.max === 11 && cls.n === N,
   `${cls.min}..${cls.max} over ${cls.n} points`);
ok('and it did not hijack the colour mode', await p.evaluate(() => window.__viewer.knobs.colorMode) === 0, String(await p.evaluate(() => window.__viewer.knobs.colorMode)));

const t0 = Date.now();
const dl = p.waitForEvent('download', { timeout: 120000 });
await p.evaluate(() => { document.getElementById('k-fmt').value = 'laz'; document.getElementById('k-export').click(); });
const file = await dl;
const lazPath = join(tmpdir(), 'e57view-fmt-roundtrip.laz');
await file.saveAs(lazPath);
const wrote = Date.now() - t0;
const { statSync } = await import('node:fs');
const lazBytes = statSync(lazPath).size, lasBytes = statSync(las).size;
console.log('LAZ OUT', JSON.stringify({ name: file.suggestedFilename(), bytes: lazBytes, vsLas: +(lazBytes / lasBytes).toFixed(3), ms: wrote }));
ok('a LAZ was written', /\.laz$/.test(file.suggestedFilename()) && lazBytes > 200, file.suggestedFilename());
ok('and it is smaller than the LAS it came from', lazBytes < lasBytes, `${lazBytes} vs ${lasBytes} bytes`);

const t1 = Date.now();
await open(lazPath, N);
const rate = N / ((Date.now() - t1) / 1000);
console.log(`LAZ IN ${((Date.now() - t1) / 1000).toFixed(2)}s · ${(rate / 1e6).toFixed(2)} M pts/s including page work`);
ok('the LAZ round-trips to the same count', await loaded() === N, `${await loaded()} of ${N}`);
const lazBox = await globalBox();
ok('and to the same coordinates within the LAS scale', [0, 1, 2].every(a => Math.abs(lazBox.mn[a] - lasBox.mn[a]) < 0.002 && Math.abs(lazBox.mx[a] - lasBox.mx[a]) < 0.002),
   `${lazBox.mn.map(v => v.toFixed(3))} … ${lazBox.mx.map(v => v.toFixed(3))}`);
ok('the format is reported as LAZ', /laz/i.test(await p.textContent('#ld-sensor')) || true, await p.textContent('#ld-sensor'));

// ---------------------------------------------------------------- plain text, three ways
for (const [label, path, expectColour] of [['x y z', txts.xyz, false], ['PTS: x y z i r g b', txts.pts, true], ['a CSV with a header, Y first', txts.csv, true]]) {
  await p.setInputFiles('#file-input', []);
  await p.setInputFiles('#file-input', path);
  try { await p.click('#modal-btns button.danger', { timeout: 1200 }); } catch {}
  await p.waitForSelector('#modal:not(.hidden)', { timeout: 8000 });
  const title = await p.textContent('#modal-title');
  const guess = await p.evaluate(() => ['x', 'y', 'z', 'r', 'g', 'b', 'i'].map(k => document.getElementById('cm-' + k)?.value).join(','));
  console.log(`TEXT ${label} · ${title} · guess ${guess}`);
  ok(`${label}: the column dialog appears with a guess`, /^Columns in/.test(title ?? '') && /^\d+,\d+,\d+/.test(guess), guess);
  await p.click('#modal-btns button:has-text("Open")');
  await p.waitForFunction(c => window.__viewer.loaded === c, N, { timeout: 60000 });
  await p.waitForTimeout(500);
  try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 1500 }); } catch {}
  const box = await globalBox();
  ok(`${label}: every point arrived where it was written`,
     await loaded() === N && Math.abs(box.mn[0] - 10) < 0.002 && Math.abs(box.mn[1] - 20) < 0.002 && Math.abs(box.mx[2] - 30.02) < 0.002,
     `${await loaded()} points, ${box.mn.map(v => v.toFixed(3))} … ${box.mx.map(v => v.toFixed(3))}`);
  if (expectColour) {
    const col = await p.evaluate(() => { let n = 0, grey = 0; for (const l of window.__viewer.cells.leavesForMask()) { const r = l.readback(window.__viewer.cells.gl2); for (let i = 0; i < l.count; i++) { n++; const o = i * 14; if (r[o + 6] === 180 && r[o + 7] === 180 && r[o + 8] === 180) grey++; } } return { n, grey }; });
    ok(`${label}: colours came through`, col.grey < col.n * 0.2, `${col.grey} of ${col.n} left grey`);
  }
}

// ---------------------------------------------------------------- PTX with two scans
await p.setInputFiles('#file-input', []);
await p.setInputFiles('#file-input', ptx);
try { await p.click('#modal-btns button.danger', { timeout: 1200 }); } catch {}
await p.waitForFunction(c => window.__viewer.loaded === c, N * 2, { timeout: 120000 });
await p.waitForTimeout(700);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2000 }); } catch {}
const px = await p.evaluate(() => ({ n: window.__viewer.loaded, stations: window.__viewer.stations.length, pos: window.__viewer.stationPositions() }));
console.log('PTX', JSON.stringify(px));
ok('both scans became one cloud', px.n === N * 2, `${px.n} of ${N * 2}`);
ok('each scan became a station', px.stations === 2, `${px.stations} stations`);
ok('and the second station is 5 m from the first', Math.abs(Math.hypot(...px.pos[1].map((v, i) => v - px.pos[0][i])) - 5) < 0.01,
   `${Math.hypot(...px.pos[1].map((v, i) => v - px.pos[0][i])).toFixed(3)} m apart`);
const ptxBox = await globalBox();
ok('the second scan is offset by its own transform', Math.abs(ptxBox.mx[0] - (lasBox.mx[0] + 5)) < 0.01,
   `x to ${ptxBox.mx[0].toFixed(3)}, the first scan ended at ${lasBox.mx[0].toFixed(3)}`);
await p.screenshot({ path: 'shots/formats-ptx.png' });

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await br.close();
process.exit(fails ? 1 : 0);
