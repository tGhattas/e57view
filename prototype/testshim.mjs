// SPDX-License-Identifier: GPL-3.0-only
import { openSync, readSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { requireTestFile } from '../shared/testfile.mjs';
const require = createRequire(import.meta.url);
const { E57Handle } = require('./shimpkg/shim.js');

const PATH = requireTestFile();
if (!PATH) process.exit(0);
const fd = openSync(PATH, 'r');
const size = statSync(PATH).size;

// Simulates FileReaderSync over File.slice() in a Worker: SYNCHRONOUS ranged read.
let reads = 0, bytesRead = 0;
const readRange = (offset, length) => {
  const buf = Buffer.allocUnsafe(Number(length));
  const n = readSync(fd, buf, 0, Number(length), Number(offset));
  reads++; bytesRead += n;
  return new Uint8Array(buf.buffer, buf.byteOffset, n);
};

console.log(`file size: ${(size/1e9).toFixed(2)} GB — NOT loaded into wasm memory`);
let t = performance.now();
const h = new E57Handle(readRange, size);
console.log(`open: ${(performance.now()-t).toFixed(0)}ms  reads=${reads}  bytesPulled=${(bytesRead/1e6).toFixed(1)}MB`);
console.log(`scans=${h.scan_count()}  points=${h.total_points().toLocaleString()}  images=${h.image_count()}`);

for (const N of [200000, 1000000]) {
  reads = 0; bytesRead = 0;
  t = performance.now();
  const r = h.decode(0, N);
  const dt = (performance.now()-t)/1000;
  console.log(`decode ${r.count.toLocaleString()} pts in ${dt.toFixed(2)}s -> ${(r.count/dt/1e6).toFixed(2)} M pts/s | reads=${reads} pulled=${(bytesRead/1e6).toFixed(0)}MB`);
  console.log(`   xyz[0..3]=${[...r.xyz.slice(0,3)].map(v=>v.toFixed(2))}  rgb[0..3]=${[...r.rgb.slice(0,3)]}  i[0]=${r.intensity[0]}`);
}
