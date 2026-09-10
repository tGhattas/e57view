/// <reference lib="webworker" />
// IO worker: everything that needs synchronous file access off the main thread.
//  - export  : PLY / LAS written in JS, E57 via the Rust writer, into an OPFS scratch file
//  - cache   : write the in-memory cells to OPFS, list / read / delete cached scans
//  - image   : pull a panorama JPEG out of the source E57
import init, { E57Handle, E57Export, set_window_size } from './wasm/e57_wasm.js';
import wasmUrl from './wasm/e57_wasm_bg.wasm?url';

const post = (m: any, t?: Transferable[]) => (self as any).postMessage(m, t ?? []);
let wasmReady: Promise<unknown> | null = null;
const ensureWasm = () => (wasmReady ??= init({ module_or_path: wasmUrl }));

const REC = 14;
const CACHE_DIR = 'e57view-cache';
const EXPORT_DIR = 'e57view-export';

async function dir(name: string, create = true) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create });
}

// ------------------------------------------------------------------ export
type Sink = FileSystemSyncAccessHandle;
let exp: {
  format: 'ply' | 'las' | 'e57'; sink: Sink; pos: number; name: string;
  count: number; total: number; tx: number; ty: number; tz: number;
  hasC: boolean; hasI: boolean; hasN: boolean;
  e57?: E57Export;
  // LAS bookkeeping
  min: number[]; max: number[];
} | null = null;

function u8(s: string) { return new TextEncoder().encode(s); }
function writeAt(sink: Sink, at: number, data: Uint8Array) { sink.write(data, { at }); }

async function exportStart(m: any) {
  const d = await dir(EXPORT_DIR);
  const fname = `${Date.now()}.${m.format}`;
  const fh = await d.getFileHandle(fname, { create: true });
  const sink = await fh.createSyncAccessHandle();
  sink.truncate(0);
  exp = { format: m.format, sink, pos: 0, name: fname, count: 0, total: m.total, tx: m.translation[0], ty: m.translation[1], tz: m.translation[2],
          hasC: m.hasColor, hasI: m.hasIntensity, hasN: m.hasNormals, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  if (m.format === 'ply') {
    // header written now with the expected count; rewritten at finish with the real one
    exp.pos = plyHeader(m.total).length;
    writeAt(sink, 0, plyHeader(m.total));
  } else if (m.format === 'las') {
    exp.pos = 227;                    // LAS 1.2 header; filled in at finish
  } else {
    await ensureWasm();
    const s = exp.sink;
    const sinkObj = {
      read: (at: number, len: number) => { const b = new Uint8Array(len); const n = s.read(b, { at }); return b.subarray(0, n); },
      write: (at: number, data: Uint8Array) => { s.write(data, { at }); },
      size: () => s.getSize(),
    };
    const guid = `{${crypto.randomUUID().toUpperCase()}}`;
    exp.e57 = new E57Export(sinkObj as any, guid, m.name, exp.tx, exp.ty, exp.tz, exp.hasC, exp.hasI, exp.hasN);
  }
  post({ type: 'export-ready' });
}

function plyHeader(n: number): Uint8Array {
  const e = exp!;
  const lines = ['ply', 'format binary_little_endian 1.0',
    `comment e57view export, coordinates are absolute (scan pose applied)`,
    `element vertex ${n}`, 'property double x', 'property double y', 'property double z'];
  if (e.hasC) lines.push('property uchar red', 'property uchar green', 'property uchar blue');
  if (e.hasI) lines.push('property float intensity');
  if (e.hasN) lines.push('property float nx', 'property float ny', 'property float nz');
  lines.push('end_header');
  // pad the header so a rewrite with a different count fits (count field width)
  return u8(lines.join('\n') + '\n');
}

function exportChunk(m: any) {
  const e = exp!;
  const xyz: Float64Array = m.xyz, rgb: Uint8Array = m.rgb, inten: Uint8Array = m.inten, nrm: Int8Array = m.nrm;
  const n: number = m.count;
  if (e.format === 'e57') {
    e.e57!.add_points(xyz, rgb, inten, nrm, n);
  } else if (e.format === 'ply') {
    const stride = 24 + (e.hasC ? 3 : 0) + (e.hasI ? 4 : 0) + (e.hasN ? 12 : 0);
    const buf = new ArrayBuffer(n * stride); const dv = new DataView(buf);
    let o = 0;
    for (let i = 0; i < n; i++) {
      dv.setFloat64(o, xyz[i * 3] + e.tx, true); dv.setFloat64(o + 8, xyz[i * 3 + 1] + e.ty, true); dv.setFloat64(o + 16, xyz[i * 3 + 2] + e.tz, true); o += 24;
      if (e.hasC) { dv.setUint8(o, rgb[i * 3]); dv.setUint8(o + 1, rgb[i * 3 + 1]); dv.setUint8(o + 2, rgb[i * 3 + 2]); o += 3; }
      if (e.hasI) { dv.setFloat32(o, inten[i] / 255, true); o += 4; }
      if (e.hasN) { dv.setFloat32(o, nrm[i * 3] / 127, true); dv.setFloat32(o + 4, nrm[i * 3 + 1] / 127, true); dv.setFloat32(o + 8, nrm[i * 3 + 2] / 127, true); o += 12; }
    }
    writeAt(e.sink, e.pos, new Uint8Array(buf)); e.pos += buf.byteLength;
  } else {
    // LAS 1.2, point format 2 (xyz, intensity, rgb), 26 bytes, scale 0.001, offset = translation
    const buf = new ArrayBuffer(n * 26); const dv = new DataView(buf);
    for (let i = 0; i < n; i++) {
      const o = i * 26;
      const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
      dv.setInt32(o, Math.round(x * 1000), true); dv.setInt32(o + 4, Math.round(y * 1000), true); dv.setInt32(o + 8, Math.round(z * 1000), true);
      dv.setUint16(o + 12, inten[i] * 257, true);
      dv.setUint8(o + 14, 0x09);          // 1 return, return 1
      dv.setUint8(o + 15, 0);             // classification
      dv.setInt8(o + 16, 0); dv.setUint8(o + 17, 0); dv.setUint16(o + 18, 0, true);
      dv.setUint16(o + 20, rgb[i * 3] * 257, true); dv.setUint16(o + 22, rgb[i * 3 + 1] * 257, true); dv.setUint16(o + 24, rgb[i * 3 + 2] * 257, true);
      if (x + e.tx < e.min[0]) e.min[0] = x + e.tx; if (x + e.tx > e.max[0]) e.max[0] = x + e.tx;
      if (y + e.ty < e.min[1]) e.min[1] = y + e.ty; if (y + e.ty > e.max[1]) e.max[1] = y + e.ty;
      if (z + e.tz < e.min[2]) e.min[2] = z + e.tz; if (z + e.tz > e.max[2]) e.max[2] = z + e.tz;
    }
    writeAt(e.sink, e.pos, new Uint8Array(buf)); e.pos += buf.byteLength;
  }
  e.count += n;
  post({ type: 'export-progress', written: e.count });
}

function exportFinish() {
  const e = exp!;
  let bytes = 0;
  if (e.format === 'e57') {
    e.e57!.finish();
    e.e57 = undefined;
    bytes = e.sink.getSize();
  } else if (e.format === 'ply') {
    const h = plyHeader(e.count);
    if (h.length !== plyHeader(e.total).length) {
      // count changed width: rewrite header padded with a comment so offsets hold
      const pad = plyHeader(e.total).length - h.length;
      const lines = new TextDecoder().decode(h).split('\n'); lines.pop();
      const end = lines.pop()!;
      lines.push('comment ' + 'x'.repeat(Math.max(0, pad - 9)), end);
      writeAt(e.sink, 0, u8(lines.join('\n') + '\n'));
    } else writeAt(e.sink, 0, h);
    bytes = e.pos;
  } else {
    const h = new ArrayBuffer(227); const dv = new DataView(h); const b = new Uint8Array(h);
    b.set(u8('LASF'), 0);
    dv.setUint8(24, 1); dv.setUint8(25, 2);                 // version 1.2
    b.set(u8('e57view'.padEnd(32, '\0')), 26);              // system id
    b.set(u8('e57view'.padEnd(32, '\0')), 58);              // generating software
    dv.setUint16(94, 227, true);                            // header size
    dv.setUint32(96, 227, true);                            // offset to point data
    dv.setUint32(100, 0, true);                             // VLRs
    dv.setUint8(104, 2); dv.setUint16(105, 26, true);       // point format 2, 26 bytes
    dv.setUint32(107, e.count, true);
    dv.setUint32(111, e.count, true);                       // returns by number [0]
    dv.setFloat64(131, 0.001, true); dv.setFloat64(139, 0.001, true); dv.setFloat64(147, 0.001, true);
    dv.setFloat64(155, e.tx, true); dv.setFloat64(163, e.ty, true); dv.setFloat64(171, e.tz, true);
    dv.setFloat64(179, e.max[0], true); dv.setFloat64(187, e.min[0], true);
    dv.setFloat64(195, e.max[1], true); dv.setFloat64(203, e.min[1], true);
    dv.setFloat64(211, e.max[2], true); dv.setFloat64(219, e.min[2], true);
    writeAt(e.sink, 0, b);
    bytes = e.pos;
  }
  e.sink.flush(); e.sink.close();
  post({ type: 'export-done', dir: EXPORT_DIR, name: e.name, bytes, count: e.count });
  exp = null;
}

// ------------------------------------------------------------------- cache
let cw: { sink: Sink; pos: number; key: string; leaves: any[]; meta: any } | null = null;

async function cacheStart(m: any) {
  const d = await dir(CACHE_DIR);
  const kd = await d.getDirectoryHandle(m.key, { create: true });
  const fh = await kd.getFileHandle('cells.bin', { create: true });
  const sink = await fh.createSyncAccessHandle();
  sink.truncate(0);
  cw = { sink, pos: 0, key: m.key, leaves: [], meta: m.meta };
  try { await navigator.storage.persist?.(); } catch {}
  post({ type: 'cache-ready' });
}
function cacheChunk(m: any) {
  const c = cw!;
  const recs = new Uint8Array(m.recs);
  writeAt(c.sink, c.pos, recs);
  c.leaves.push({ offset: c.pos, bytes: recs.byteLength, count: m.leaf.count, origin: m.leaf.origin, size: m.leaf.size, bmin: m.leaf.bmin, bmax: m.leaf.bmax });
  c.pos += recs.byteLength;
  post({ type: 'cache-progress', bytes: c.pos });
}
async function cacheFinish() {
  const c = cw!;
  c.sink.flush(); c.sink.close();
  const d = await dir(CACHE_DIR);
  const kd = await d.getDirectoryHandle(c.key);
  const mh = await kd.getFileHandle('meta.json', { create: true });
  const ms = await mh.createSyncAccessHandle();
  ms.truncate(0);
  const meta = { ...c.meta, leaves: c.leaves, bytes: c.pos, cachedAt: Date.now() };
  ms.write(u8(JSON.stringify(meta)), { at: 0 }); ms.flush(); ms.close();
  post({ type: 'cache-done', bytes: c.pos });
  cw = null;
}

async function cacheList() {
  const out: any[] = [];
  try {
    const d = await dir(CACHE_DIR, false);
    for await (const [name, h] of (d as any).entries()) {
      if (h.kind !== 'directory') continue;
      try {
        const mh = await h.getFileHandle('meta.json');
        const f = await mh.getFile();
        const meta = JSON.parse(await f.text());
        out.push({ key: name, name: meta.name, size: meta.size, points: meta.kept, bytes: meta.bytes, cachedAt: meta.cachedAt, stride: meta.stride });
      } catch {}
    }
  } catch {}
  post({ type: 'cache-list', items: out });
}

async function cacheHas(m: any) {
  try {
    const d = await dir(CACHE_DIR, false);
    const kd = await d.getDirectoryHandle(m.key);
    await kd.getFileHandle('meta.json');
    post({ type: 'cache-has', key: m.key, has: true });
  } catch { post({ type: 'cache-has', key: m.key, has: false }); }
}

async function cacheDelete(m: any) {
  try { const d = await dir(CACHE_DIR, false); await d.removeEntry(m.key, { recursive: true }); } catch {}
  post({ type: 'cache-deleted', key: m.key });
}

async function cacheRead(m: any) {
  const d = await dir(CACHE_DIR, false);
  const kd = await d.getDirectoryHandle(m.key);
  const meta = JSON.parse(await (await (await kd.getFileHandle('meta.json')).getFile()).text());
  post({ type: 'meta', meta: meta.scanMeta, openMs: 0, bytesPulled: 0, fromCache: true, histogram: meta.histogram, robust: meta.robust });
  post({ type: 'plan', stride: meta.stride, willKeep: meta.kept });
  const fh = await kd.getFileHandle('cells.bin');
  const h = await fh.createSyncAccessHandle();
  const t0 = performance.now();
  let done = 0;
  for (const l of meta.leaves) {
    const buf = new ArrayBuffer(l.bytes);
    h.read(new Uint8Array(buf), { at: l.offset });
    post({ type: 'leaf', blocks: [buf], count: l.count, meta: { origin: l.origin, size: l.size, bmin: l.bmin, bmax: l.bmax } }, [buf]);
    done += l.bytes;
    post({ type: 'progress', phase: 1, done, total: meta.bytes, elapsed: performance.now() - t0, bytesPulled: done });
  }
  h.close();
  post({ type: 'done', ms: performance.now() - t0, bytesPulled: meta.bytes, fromCache: true,
         stats: { read: meta.kept, kept: meta.kept, droppedInvalid: 0, leaves: meta.leaves.length, nodes: meta.leaves.length } });
}

// ------------------------------------------------------------------- image
let imgHandle: { file: File; h: E57Handle } | null = null;
async function image(m: any) {
  await ensureWasm();
  const file: File = m.file;
  if (!imgHandle || imgHandle.file !== file) {
    const fr = new FileReaderSync();
    const readRange = (offset: number, length: number) =>
      new Uint8Array(fr.readAsArrayBuffer(file.slice(offset, Math.min(offset + length, file.size))));
    set_window_size(2 * 1024 * 1024);
    imgHandle = { file, h: new E57Handle(readRange, file.size) };
  }
  const bytes = imgHandle.h.image_blob(m.index);
  const copy = new Uint8Array(bytes);          // own buffer, transferable
  post({ type: 'image', index: m.index, bytes: copy.buffer }, [copy.buffer]);
}

// ------------------------------------------------------------------- scratch cleanup
async function exportCleanup(m: any) {
  try { const d = await dir(EXPORT_DIR, false); await d.removeEntry(m.name); } catch {}
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'export': await exportStart(m); break;
      case 'export-chunk': exportChunk(m); break;
      case 'export-finish': exportFinish(); break;
      case 'export-cleanup': await exportCleanup(m); break;
      case 'cache-start': await cacheStart(m); break;
      case 'cache-chunk': cacheChunk(m); break;
      case 'cache-finish': await cacheFinish(); break;
      case 'cache-list': await cacheList(); break;
      case 'cache-has': await cacheHas(m); break;
      case 'cache-delete': await cacheDelete(m); break;
      case 'cache-read': await cacheRead(m); break;
      case 'image': await image(m); break;
    }
  } catch (e: any) {
    post({ type: 'error', op: m.type, message: String(e?.message ?? e) });
  }
};
