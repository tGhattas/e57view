// Converts an E57 / PLY / LAS file into cells.bin + meta.json — the exact format
// the browser's local cache uses — so the viewer streams it unchanged.
// Runs the same WebAssembly decoder as the browser, fed by fs.readSync.
import { createRequire } from 'node:module';
import { openSync, readSync, closeSync, writeSync, statSync } from 'node:fs';
import { sniff, parsePly, parseLas } from './importers.mjs';

const require = createRequire(import.meta.url);
const wasm = require('./wasm/e57_wasm.cjs');
const REC = 14;
const NB = 1024;

export async function convertFile(inPath, outDir, { name, size, stride = 1, memLimit = 3.6e9, onProgress } = {}) {
  const fd = openSync(inPath, 'r');
  const readRange = (offset, length) => { const b = Buffer.allocUnsafe(length); const n = readSync(fd, b, 0, length, offset); return new Uint8Array(b.buffer, b.byteOffset, n); };
  const kind = sniff(name, readRange);
  const out = openSync(`${outDir}/cells.bin`, 'w');
  let pos = 0;
  const leaves = [];
  const histogram = new Uint32Array(256);
  const axisHist = [new Uint32Array(NB), new Uint32Array(NB), new Uint32Array(NB)];
  let cube = null;               // root cube from the preview stream, for robust bounds
  let kept = 0;

  const preview = (rec, count, pm) => {
    cube = { origin: [pm[0], pm[1], pm[2]], size: pm[3] };
    const u16 = new Uint16Array(rec.buffer.slice(rec.byteOffset, rec.byteOffset + (rec.length & ~1)));
    for (let i = 0; i < rec.length; i += REC) {
      histogram[rec[i + 9]]++;
      const b = i >> 1;
      axisHist[0][u16[b] >> 6]++; axisHist[1][u16[b + 1] >> 6]++; axisHist[2][u16[b + 2] >> 6]++;
    }
  };
  const progress = (phase, done, total) => { onProgress?.(phase, done, total); return false; };
  const leaf = (blocks, count, pm) => {
    const offset = pos;
    for (const b of blocks) { writeSync(out, b); pos += b.length; }
    leaves.push({ offset, bytes: pos - offset, count, origin: [pm[0], pm[1], pm[2]], size: pm[3], bmin: [pm[4], pm[5], pm[6]], bmax: [pm[7], pm[8], pm[9]] });
    kept += count;
  };

  let scanMeta;
  if (kind === 'e57') {
    wasm.set_window_size(8 * 1024 * 1024);
    const h = new wasm.E57Handle(readRange, size);
    scanMeta = JSON.parse(h.meta());
    const stats = h.stream(0, stride, 1_200_000, memLimit, preview, progress, leaf);
    kept = stats.kept;
    h.free?.();
  } else if (kind === 'ply' || kind === 'las') {
    let sink = null;
    const onMeta = (im) => {
      scanMeta = { guid: null, library: `import:${im.format}`, images: 0, stations: [],
        scans: [{ name: im.name, points: im.points, bounds: im.bounds, translation: im.translation, sensorVendor: im.format.toUpperCase(), sensorModel: null,
                  hasColor: im.hasColor, hasIntensity: im.hasIntensity, hasNormals: im.hasNormals, cartesian: true, spherical: false, fields: 0 }] };
      const b = im.bounds;
      sink = new wasm.PointSink(new Float64Array([b[0], b[2], b[4], b[1], b[3], b[5]]), im.points / stride, memLimit, 1_200_000);
    };
    const onBatch = (bt) => {
      if (stride > 1) {
        const n = Math.ceil(bt.n / stride);
        const xyz = new Float64Array(n * 3), rgb = new Uint8Array(n * 3), inten = new Uint8Array(n), nrm = new Int8Array(n * 3);
        let j = 0;
        for (let i = 0; i < bt.n; i += stride, j++) { xyz.set(bt.xyz.subarray(i * 3, i * 3 + 3), j * 3); rgb.set(bt.rgb.subarray(i * 3, i * 3 + 3), j * 3); inten[j] = bt.inten[i]; nrm.set(bt.nrm.subarray(i * 3, i * 3 + 3), j * 3); }
        sink.push(xyz, rgb, inten, nrm, j, preview);
      } else sink.push(bt.xyz, bt.rgb, bt.inten, bt.nrm, bt.n, preview);
    };
    const total = size;
    if (kind === 'ply') parsePly(readRange, size, name, onMeta, onBatch, (r, c) => onProgress?.(0, r, c));
    else parseLas(readRange, size, name, onMeta, onBatch, (r, c) => onProgress?.(0, r, c));
    void total;
    const stats = sink.finish(preview, progress, leaf);
    kept = stats.kept;
  } else {
    throw new Error(`unsupported file type for ${name}`);
  }
  closeSync(out); closeSync(fd);

  // robust bounds from the preview sample, like the client does
  let robust = null;
  if (cube) {
    const total = axisHist[0].reduce((a, b) => a + b, 0);
    if (total) {
      const lo = [], hi = [];
      for (let a = 0; a < 3; a++) {
        const h = axisHist[a]; let acc = 0, l = 0, u = NB - 1;
        for (let i = 0; i < NB; i++) { acc += h[i]; if (acc >= total * 0.002) { l = i; break; } }
        acc = 0;
        for (let i = NB - 1; i >= 0; i--) { acc += h[i]; if (acc >= total * 0.002) { u = i; break; } }
        lo.push(cube.origin[a] + (l / NB) * cube.size); hi.push(cube.origin[a] + ((u + 1) / NB) * cube.size);
      }
      robust = { lo, hi };
    }
  }
  const meta = { name, size, lastModified: 0, stride, scanMeta, kept, histogram: Array.from(histogram), robust, leaves, bytes: pos, cachedAt: Date.now(), cloud: true };
  writeSync(openSync(`${outDir}/meta.json`, 'w'), JSON.stringify(meta));
  return { kept, leaves: leaves.length, bytes: pos, meta };
}

// CLI: node convert.mjs <file> <outDir> [stride]
if (process.argv[1] && process.argv[1].endsWith('convert.mjs') && process.argv[2]) {
  const [,, file, outDir, st] = process.argv;
  const t0 = Date.now();
  const r = await convertFile(file, outDir, { name: file.split('/').pop(), size: statSync(file).size, stride: Number(st || 1),
    onProgress: (ph, d, t) => { if (d % 5_000_000 < 300_000 || ph === 1 && d % 64 === 0) process.stderr.write(`  phase ${ph} ${d}/${t}\n`); } });
  console.log(JSON.stringify({ kept: r.kept, leaves: r.leaves, bytes: r.bytes, seconds: (Date.now() - t0) / 1000 }));
}
