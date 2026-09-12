// SPDX-License-Identifier: GPL-3.0-only
// PLY and LAS importers over a synchronous ranged reader: readRange(offset, length) -> Uint8Array.
// Used by the browser import worker (FileReaderSync) and by the cloud converter (fs.readSync).
// Output batches are relative to `translation` so positions stay f32-safe on the GPU.

const CHUNK = 8 * 1024 * 1024;

export const ASCII_EXT = ['txt', 'xyz', 'pts', 'asc', 'csv', 'neu'];

export function sniff(name, readRange) {
  const head = readRange(0, 128);
  const s = String.fromCharCode(...head.subarray(0, 8));
  if (s.startsWith('ASTM-E57')) return 'e57';
  if (s.startsWith('ply')) return 'ply';
  // LASF covers both: bit 7 of the point-format byte says the points are laszip-compressed,
  // whatever the extension claims
  if (s.startsWith('LASF')) {
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return (dv.getUint8(104) & 0x80) ? 'laz' : 'las';
  }
  const ext = (name || '').toLowerCase().split('.').pop();
  if (ext === 'e57' || ext === 'ply' || ext === 'las' || ext === 'laz') return ext;
  if (ext === 'ptx') return 'ptx';
  if (ASCII_EXT.includes(ext)) return 'ascii';
  return null;
}

// ------------------------------------------------------------------- PLY
const PLY_SIZES = { char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
                    int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
function plyRead(dv, off, type, le) {
  switch (type) {
    case 'char': case 'int8': return dv.getInt8(off);
    case 'uchar': case 'uint8': return dv.getUint8(off);
    case 'short': case 'int16': return dv.getInt16(off, le);
    case 'ushort': case 'uint16': return dv.getUint16(off, le);
    case 'int': case 'int32': return dv.getInt32(off, le);
    case 'uint': case 'uint32': return dv.getUint32(off, le);
    case 'float': case 'float32': return dv.getFloat32(off, le);
    case 'double': case 'float64': return dv.getFloat64(off, le);
  }
  return 0;
}

export function plyHeader(readRange) {
  const head = readRange(0, 65536);
  let text = new TextDecoder('latin1').decode(head);
  const endIdx = text.indexOf('end_header');
  if (endIdx < 0) throw new Error('PLY header not found in the first 64 KB');
  const nl = text.indexOf('\n', endIdx);
  const headerLen = nl + 1;
  const lines = text.slice(0, endIdx).split(/\r?\n/);
  let format = 'ascii', elements = [], cur = null;
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') { cur = { name: t[1], count: Number(t[2]), props: [] }; elements.push(cur); }
    else if (t[0] === 'property' && cur) {
      if (t[1] === 'list') cur.props.push({ list: true, countType: t[2], type: t[3], name: t[4] });
      else cur.props.push({ type: t[1], name: t[2] });
    }
  }
  const vertex = elements.find(e => e.name === 'vertex');
  if (!vertex) throw new Error('PLY has no vertex element');
  if (elements[0] !== vertex) throw new Error('PLY vertex element must come first');
  if (vertex.props.some(p => p.list)) throw new Error('PLY vertex with list properties is not supported');
  let off = 0;
  for (const p of vertex.props) { p.offset = off; off += PLY_SIZES[p.type] ?? 4; }
  const find = (...names) => vertex.props.find(p => names.includes(p.name.toLowerCase()));
  return {
    format, headerLen, count: vertex.count, stride: off, props: vertex.props,
    x: find('x'), y: find('y'), z: find('z'),
    r: find('red', 'diffuse_red', 'r'), g: find('green', 'diffuse_green', 'g'), b: find('blue', 'diffuse_blue', 'b'),
    i: find('intensity', 'scalar_intensity', 'scalar_intensity_'), nx: find('nx', 'normal_x'), ny: find('ny', 'normal_y'), nz: find('nz', 'normal_z'),
  };
}

/** Two passes: bounds first (cheap, positions only), then batches relative to the min corner. */
export function parsePly(readRange, size, name, onMeta, onBatch, onProgress) {
  const h = plyHeader(readRange);
  if (!h.x || !h.y || !h.z) throw new Error('PLY has no x/y/z');
  const le = h.format !== 'binary_big_endian';
  const ascii = h.format === 'ascii';
  const colorScale = h.r && (h.r.type === 'float' || h.r.type === 'double' || h.r.type === 'float32') ? 255 : 1;
  const iType = h.i?.type;
  const iScale = !h.i ? 1 : (iType === 'float' || iType === 'double' || iType === 'float32') ? 255 : (iType === 'ushort' || iType === 'uint16') ? 255 / 65535 : 1;

  // pass 1: bounds
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const eachRecord = (fn) => {
    if (ascii) {
      let pos = h.headerLen, carry = '', n = 0;
      while (pos < size && n < h.count) {
        const buf = readRange(pos, Math.min(CHUNK, size - pos)); pos += buf.length;
        const text = carry + new TextDecoder('latin1').decode(buf);
        const lines = text.split('\n'); carry = pos < size ? lines.pop() : '';
        for (const line of lines) {
          if (n >= h.count) break;
          const t = line.trim(); if (!t) continue;
          const v = t.split(/\s+/).map(Number);
          fn((p) => v[h.props.indexOf(p)], n); n++;
        }
        if (carry && pos >= size) { const v = carry.trim().split(/\s+/).map(Number); if (v.length >= 3 && n < h.count) { fn((p) => v[h.props.indexOf(p)], n); n++; } carry = ''; }
      }
    } else {
      let pos = h.headerLen, n = 0;
      const end = h.headerLen + h.count * h.stride;
      while (pos < end && n < h.count) {
        const want = Math.min(CHUNK - (CHUNK % h.stride), end - pos);
        const buf = readRange(pos, want); pos += buf.length;
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const recs = Math.floor(buf.length / h.stride);
        for (let k = 0; k < recs && n < h.count; k++, n++) {
          const base = k * h.stride;
          fn((p) => plyRead(dv, base + p.offset, p.type, le), n);
        }
      }
    }
  };
  eachRecord((get) => {
    const x = get(h.x), y = get(h.y), z = get(h.z);
    if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x; if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y; if (z < mn[2]) mn[2] = z; if (z > mx[2]) mx[2] = z;
  });
  if (!isFinite(mn[0])) throw new Error('PLY has no readable vertices');
  const tr = mn.slice();
  onMeta({ name, points: h.count, translation: tr, bounds: [0, mx[0] - mn[0], 0, mx[1] - mn[1], 0, mx[2] - mn[2]],
           hasColor: !!(h.r && h.g && h.b), hasIntensity: !!h.i, hasNormals: !!(h.nx && h.ny && h.nz), format: 'ply' });

  // pass 2: batches
  const B = 262144;
  let xyz = new Float64Array(B * 3), rgb = new Uint8Array(B * 3), inten = new Uint8Array(B), nrm = new Int8Array(B * 3), j = 0, read = 0;
  const flush = () => { if (!j) return; onBatch({ xyz: xyz.subarray(0, j * 3), rgb: rgb.subarray(0, j * 3), inten: inten.subarray(0, j), nrm: nrm.subarray(0, j * 3), n: j, read }); xyz = new Float64Array(B * 3); rgb = new Uint8Array(B * 3); inten = new Uint8Array(B); nrm = new Int8Array(B * 3); j = 0; };
  eachRecord((get) => {
    xyz[j * 3] = get(h.x) - tr[0]; xyz[j * 3 + 1] = get(h.y) - tr[1]; xyz[j * 3 + 2] = get(h.z) - tr[2];
    if (h.r && h.g && h.b) { rgb[j * 3] = get(h.r) * colorScale; rgb[j * 3 + 1] = get(h.g) * colorScale; rgb[j * 3 + 2] = get(h.b) * colorScale; }
    else { rgb[j * 3] = rgb[j * 3 + 1] = rgb[j * 3 + 2] = 180; }
    inten[j] = h.i ? Math.max(0, Math.min(255, get(h.i) * iScale)) : 128;
    if (h.nx && h.ny && h.nz) {
      nrm[j * 3] = get(h.nx) * 127; nrm[j * 3 + 1] = get(h.ny) * 127; nrm[j * 3 + 2] = get(h.nz) * 127;
      // (0,0,127) marks "no normal", so a real up-normal steps down one to stay distinct
      if (nrm[j * 3] === 0 && nrm[j * 3 + 1] === 0 && nrm[j * 3 + 2] >= 127) nrm[j * 3 + 2] = 126;
    }
    else { nrm[j * 3] = 0; nrm[j * 3 + 1] = 0; nrm[j * 3 + 2] = 127; }
    j++; read++;
    if (j >= B) { flush(); onProgress?.(read, h.count); }
  });
  flush();
  return { read };
}

// ------------------------------------------------------------------- LAS
export function lasHeader(readRange) {
  const b = readRange(0, 400);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (String.fromCharCode(...b.subarray(0, 4)) !== 'LASF') throw new Error('Not a LAS file');
  const vMaj = dv.getUint8(24), vMin = dv.getUint8(25);
  const headerSize = dv.getUint16(94, true);
  const offset = dv.getUint32(96, true);
  const fmtByte = dv.getUint8(104);
  const compressed = (fmtByte & 0x80) !== 0;
  const fmt = fmtByte & 0x3f;
  const recLen = dv.getUint16(105, true);
  let count = dv.getUint32(107, true);
  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  const off = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];
  const max = [dv.getFloat64(179, true), dv.getFloat64(195, true), dv.getFloat64(211, true)];
  const min = [dv.getFloat64(187, true), dv.getFloat64(203, true), dv.getFloat64(219, true)];
  if (vMaj === 1 && vMin >= 4 && headerSize >= 375) { const ext = Number(dv.getBigUint64(247, true)); if (ext) count = ext; }
  const rgbOff = ({ 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 })[fmt];
  // classification moved when the point record was rewritten for 1.4: a byte of flags took
  // its place at 15, and it went to 16
  const classOff = fmt >= 6 ? 16 : 15;
  const nVlr = dv.getUint32(100, true);
  // the laszip VLR describes how the points were compressed; without it a LAZ cannot be read
  let lazVlr = null;
  if (compressed || nVlr) {
    let at = headerSize;
    const dec = new TextDecoder('latin1');
    for (let i = 0; i < Math.min(nVlr, 200); i++) {
      const hdr = readRange(at, 54);
      if (hdr.length < 54) break;
      const h = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
      const user = dec.decode(hdr.subarray(2, 18)).replace(/\0.*$/, '');
      const rid = h.getUint16(18, true), len = h.getUint16(20, true);
      if (user === 'laszip encoded' && rid === 22204) lazVlr = readRange(at + 54, len).slice();
      at += 54 + len;
    }
  }
  return { version: `${vMaj}.${vMin}`, offset, fmt, compressed, recLen, count, scale, off, min, max,
           rgbOff: rgbOff ?? -1, hasColor: rgbOff !== undefined, classOff, lazVlr, headerSize };
}

/** LAS and LAZ. A LAZ is read through `makeLaz(vlr, offset, recLen)`, which the caller
 *  supplies because the decompressor lives in WebAssembly: it hands back `{ read(n) }`
 *  returning the next n points as uncompressed records, so both formats share one decode
 *  loop and neither holds more than a chunk at a time. */
export function parseLas(readRange, size, name, onMeta, onBatch, onProgress, opts = {}) {
  const h = lasHeader(readRange);
  const SUPPORTED = [0, 1, 2, 3, 6, 7, 8];
  if (h.compressed) {
    if (!opts.makeLaz) throw new Error('This is a LAZ (compressed) file and no decompressor was supplied.');
    if (!h.lazVlr) throw new Error('This LAZ has no laszip VLR, so nothing describes how it was compressed.');
    if (!SUPPORTED.includes(h.fmt)) throw new Error(`LAZ point format ${h.fmt} is not supported — 0-3 and 6-8 are.`);
  }
  const laz = h.compressed ? opts.makeLaz(h.lazVlr, h.offset, h.recLen) : null;
  const tr = h.min.slice();
  onMeta({ name, points: h.count, translation: tr, bounds: [0, h.max[0] - h.min[0], 0, h.max[1] - h.min[1], 0, h.max[2] - h.min[2]],
           hasColor: h.hasColor, hasIntensity: true, hasNormals: false, hasClassification: true,
           format: h.compressed ? 'laz' : 'las', version: h.version, pointFormat: h.fmt });
  const B = 262144;
  let xyz = new Float64Array(B * 3), rgb = new Uint8Array(B * 3), inten = new Uint8Array(B), nrm = new Int8Array(B * 3), cls = new Uint8Array(B), j = 0, read = 0;
  const flush = () => { if (!j) return; onBatch({ xyz: xyz.subarray(0, j * 3), rgb: rgb.subarray(0, j * 3), inten: inten.subarray(0, j), nrm: nrm.subarray(0, j * 3), cls: cls.subarray(0, j), n: j, read }); xyz = new Float64Array(B * 3); rgb = new Uint8Array(B * 3); inten = new Uint8Array(B); nrm = new Int8Array(B * 3); cls = new Uint8Array(B); j = 0; };
  let pos = h.offset, n = 0;
  const end = Math.min(size, h.offset + h.count * h.recLen);
  // intensity: 16-bit in LAS, but many writers only use 8 or 12 bits — scale by the observed max on the first chunk
  let iShift = 8;
  const perChunk = Math.max(1, Math.floor((CHUNK - (CHUNK % h.recLen)) / h.recLen));
  while (n < h.count && (laz || pos < end)) {
    let buf;
    if (laz) buf = laz.read(Math.min(perChunk, h.count - n));
    else { const want = Math.min(CHUNK - (CHUNK % h.recLen), end - pos); buf = readRange(pos, want); pos += buf.length; }
    if (!buf.length) break;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const recs = Math.floor(buf.length / h.recLen);
    if (n === 0) { let m = 0; for (let k = 0; k < Math.min(recs, 50000); k++) m = Math.max(m, dv.getUint16(k * h.recLen + 12, true)); iShift = m > 4095 ? 8 : m > 255 ? 4 : 0; }
    for (let k = 0; k < recs && n < h.count; k++, n++) {
      const base = k * h.recLen;
      xyz[j * 3] = dv.getInt32(base, true) * h.scale[0] + h.off[0] - tr[0];
      xyz[j * 3 + 1] = dv.getInt32(base + 4, true) * h.scale[1] + h.off[1] - tr[1];
      xyz[j * 3 + 2] = dv.getInt32(base + 8, true) * h.scale[2] + h.off[2] - tr[2];
      inten[j] = Math.min(255, dv.getUint16(base + 12, true) >> iShift);
      if (h.rgbOff >= 0) { rgb[j * 3] = dv.getUint16(base + h.rgbOff, true) >> 8; rgb[j * 3 + 1] = dv.getUint16(base + h.rgbOff + 2, true) >> 8; rgb[j * 3 + 2] = dv.getUint16(base + h.rgbOff + 4, true) >> 8;
        if (rgb[j * 3] === 0 && rgb[j * 3 + 1] === 0 && rgb[j * 3 + 2] === 0) { const r8 = dv.getUint16(base + h.rgbOff, true); if (r8 && r8 < 256) { rgb[j * 3] = r8; rgb[j * 3 + 1] = dv.getUint16(base + h.rgbOff + 2, true); rgb[j * 3 + 2] = dv.getUint16(base + h.rgbOff + 4, true); } } }
      else { rgb[j * 3] = rgb[j * 3 + 1] = rgb[j * 3 + 2] = 180; }
      nrm[j * 3] = 0; nrm[j * 3 + 1] = 0; nrm[j * 3 + 2] = 127;
      cls[j] = h.fmt >= 6 ? dv.getUint8(base + h.classOff) : (dv.getUint8(base + h.classOff) & 0x1f);
      j++; read++;
      if (j >= B) { flush(); onProgress?.(read, h.count); }
    }
  }
  flush();
  return { read };
}

// ------------------------------------------------------------------- ASCII
/** Guess the delimiter and what each column is, from the first lines of a text file. */
export function asciiGuess(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('//'));
  if (!lines.length) throw new Error('that file has no readable lines');
  const counts = [[',', 0], [';', 0], ['\t', 0], [' ', 0]].map(([d]) => [d, lines[0].split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  const delim = counts[0][1] > 1 ? counts[0][0] : ' ';
  const split = (l) => (delim === ' ' ? l.trim().split(/\s+/) : l.split(delim).map(t => t.trim()));
  // a header row is one whose fields are not all numbers
  const first = split(lines[0]);
  const header = first.some(t => t !== '' && !isFinite(Number(t))) ? first : null;
  const rows = (header ? lines.slice(1) : lines).slice(0, 20).map(split);
  const cols = Math.max(...rows.map(r => r.length));
  const sample = rows.slice(0, 20);
  // by name first, then by the shape of the numbers
  const map = { x: 0, y: 1, z: 2, r: -1, g: -1, b: -1, i: -1, nx: -1, ny: -1, nz: -1, s: -1 };
  if (header) {
    const at = (...names) => header.findIndex(h => names.includes(h.toLowerCase().replace(/[^a-z]/g, '')));
    const set = (k, ...names) => { const i = at(...names); if (i >= 0) map[k] = i; };
    set('x', 'x', 'easting', 'e'); set('y', 'y', 'northing', 'n'); set('z', 'z', 'height', 'h', 'elevation');
    set('r', 'r', 'red'); set('g', 'g', 'green'); set('b', 'b', 'blue');
    set('i', 'i', 'intensity', 'reflectance'); set('nx', 'nx', 'normalx'); set('ny', 'ny', 'normaly'); set('nz', 'nz', 'normalz');
  } else if (cols >= 7) { map.i = 3; map.r = 4; map.g = 5; map.b = 6; }      // the PTS convention
  else if (cols === 6) { map.r = 3; map.g = 4; map.b = 5; }
  else if (cols === 4) { map.i = 3; }
  return { delim, header, cols, sample, map, lines: lines.length };
}
/** Stream an ASCII cloud. `map` names the column of each field, -1 for absent. */
export function parseAscii(readRange, size, name, map, delim, skip, onMeta, onBatch, onProgress) {
  const dec = new TextDecoder('latin1');
  const splitLine = (l) => (delim === ' ' ? l.trim().split(/\s+/) : l.split(delim));
  const eachLine = (fn) => {
    let pos = 0, tail = '', line = 0;
    while (pos < size) {
      const buf = readRange(pos, Math.min(CHUNK, size - pos));
      if (!buf.length) break;
      pos += buf.length;
      const text = tail + dec.decode(buf);
      const parts = text.split('\n');
      tail = pos < size ? parts.pop() : '';
      for (const raw of parts) {
        const l = raw.trim();
        if (!l || l.startsWith('#') || l.startsWith('//')) continue;
        if (line++ < skip) continue;
        fn(splitLine(l));
      }
    }
    if (tail.trim()) { const l = tail.trim(); if (!(l.startsWith('#') || l.startsWith('//')) && line++ >= skip) fn(splitLine(l)); }
  };
  // pass 1: bounds and a count, so the octree can be sized before anything is inserted
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], total = 0;
  eachLine(f => {
    const x = +f[map.x], y = +f[map.y], z = +f[map.z];
    if (!(isFinite(x) && isFinite(y) && isFinite(z))) return;
    total++;
    if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x;
    if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y;
    if (z < mn[2]) mn[2] = z; if (z > mx[2]) mx[2] = z;
  });
  if (!total) throw new Error('no lines parsed as x y z with that column mapping');
  const tr = mn.slice();
  onMeta({ name, points: total, translation: tr, bounds: [0, mx[0] - mn[0], 0, mx[1] - mn[1], 0, mx[2] - mn[2]],
           hasColor: map.r >= 0, hasIntensity: map.i >= 0, hasNormals: map.nx >= 0, format: 'ascii', version: `${map.cols ?? ''}` });
  const B = 262144;
  let xyz = new Float64Array(B * 3), rgb = new Uint8Array(B * 3), inten = new Uint8Array(B), nrm = new Int8Array(B * 3), j = 0, read = 0;
  const flush = () => { if (!j) return; onBatch({ xyz: xyz.subarray(0, j * 3), rgb: rgb.subarray(0, j * 3), inten: inten.subarray(0, j), nrm: nrm.subarray(0, j * 3), n: j, read }); xyz = new Float64Array(B * 3); rgb = new Uint8Array(B * 3); inten = new Uint8Array(B); nrm = new Int8Array(B * 3); j = 0; };
  // colours written as 0..1 floats are common; decide once from the first rows
  let colScale = 1, decided = false;
  eachLine(f => {
    const x = +f[map.x], y = +f[map.y], z = +f[map.z];
    if (!(isFinite(x) && isFinite(y) && isFinite(z))) return;
    xyz[j * 3] = x - tr[0]; xyz[j * 3 + 1] = y - tr[1]; xyz[j * 3 + 2] = z - tr[2];
    if (map.r >= 0) {
      if (!decided) { const v = [+f[map.r], +f[map.g], +f[map.b]]; if (v.every(q => isFinite(q) && q <= 1.001)) colScale = 255; decided = true; }
      rgb[j * 3] = Math.max(0, Math.min(255, Math.round(+f[map.r] * colScale)));
      rgb[j * 3 + 1] = Math.max(0, Math.min(255, Math.round(+f[map.g] * colScale)));
      rgb[j * 3 + 2] = Math.max(0, Math.min(255, Math.round(+f[map.b] * colScale)));
    } else { rgb[j * 3] = rgb[j * 3 + 1] = rgb[j * 3 + 2] = 180; }
    if (map.i >= 0) { const v = +f[map.i]; inten[j] = Math.max(0, Math.min(255, Math.round(v <= 1.001 && v >= -1.001 ? (v < 0 ? (v + 1) * 127 : v * 255) : v > 255 ? v / 257 : v))); }
    else inten[j] = 128;
    if (map.nx >= 0) {
      const a = +f[map.nx], b = +f[map.ny], c = +f[map.nz];
      const l = Math.hypot(a, b, c) || 1;
      nrm[j * 3] = Math.round(a / l * 127); nrm[j * 3 + 1] = Math.round(b / l * 127); nrm[j * 3 + 2] = Math.round(c / l * 127);
      if (nrm[j * 3] === 0 && nrm[j * 3 + 1] === 0 && nrm[j * 3 + 2] >= 127) nrm[j * 3 + 2] = 126;
    } else { nrm[j * 3] = 0; nrm[j * 3 + 1] = 0; nrm[j * 3 + 2] = 127; }
    j++; read++;
    if (j >= B) { flush(); onProgress?.(read, total); }
  });
  flush();
  return { read };
}

// ------------------------------------------------------------------- PTX
/** Leica PTX: a sequence of structured scans, each with its own pose. Rows and columns are
 *  the scanner's own grid, so an unreturned shot is written as 0 0 0 and skipped. The pose
 *  puts every scan into one frame, and its translation is the station position. */
export function parsePtx(readRange, size, name, onMeta, onBatch, onProgress) {
  const dec = new TextDecoder('latin1');
  let buf = '', pos = 0, done = false;
  const fill = () => {
    while (!done && buf.length < 4 * 1024 * 1024) {
      if (pos >= size) { done = true; break; }
      const b = readRange(pos, Math.min(CHUNK, size - pos));
      if (!b.length) { done = true; break; }
      pos += b.length; buf += dec.decode(b);
    }
  };
  let cursor = 0;
  const nextLine = () => {
    for (;;) {
      const nl = buf.indexOf('\n', cursor);
      if (nl >= 0) { const l = buf.slice(cursor, nl); cursor = nl + 1; return l; }
      if (done) { if (cursor < buf.length) { const l = buf.slice(cursor); cursor = buf.length; return l; } return null; }
      buf = buf.slice(cursor); cursor = 0; fill();
      if (done && buf.indexOf('\n') < 0 && !buf.length) return null;
    }
  };
  fill();
  const scans = [];
  const batches = [];
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], total = 0;
  let hasColor = false, hasIntensity = false;
  for (;;) {
    const colsL = nextLine(); if (colsL === null) break;
    const cols = Number(colsL.trim()); if (!isFinite(cols) || cols <= 0) break;
    const rows = Number((nextLine() ?? '').trim());
    const num = (l) => (l ?? '').trim().split(/\s+/).map(Number);
    const sp = num(nextLine());                       // scanner position
    const ax = num(nextLine()), ay = num(nextLine()), az = num(nextLine());   // scanner axes
    const m0 = num(nextLine()), m1 = num(nextLine()), m2 = num(nextLine()), m3 = num(nextLine()); // 4x4, column-major-ish
    void ax; void ay; void az;
    // PTX writes the transform as four rows of four, the last row being the translation
    const T = (x, y, z) => [
      m0[0] * x + m1[0] * y + m2[0] * z + m3[0],
      m0[1] * x + m1[1] * y + m2[1] * z + m3[1],
      m0[2] * x + m1[2] * y + m2[2] * z + m3[2],
    ];
    const n = rows * cols;
    const xyz = [], rgbv = [], iv = [];
    for (let k = 0; k < n; k++) {
      const l = nextLine(); if (l === null) break;
      const f = l.trim().split(/\s+/);
      const x = +f[0], y = +f[1], z = +f[2];
      if (!(isFinite(x) && isFinite(y) && isFinite(z))) continue;
      if (x === 0 && y === 0 && z === 0) continue;      // no return on that shot
      const w = T(x, y, z);
      xyz.push(w[0], w[1], w[2]);
      const ii = f.length > 3 ? +f[3] : 0.5;
      if (f.length > 3) hasIntensity = true;
      iv.push(Math.max(0, Math.min(255, Math.round(ii <= 1.001 ? ii * 255 : ii))));
      if (f.length >= 7) { hasColor = true; rgbv.push(+f[4] | 0, +f[5] | 0, +f[6] | 0); }
      else rgbv.push(180, 180, 180);
      for (let a = 0; a < 3; a++) { if (w[a] < mn[a]) mn[a] = w[a]; if (w[a] > mx[a]) mx[a] = w[a]; }
      total++;
    }
    scans.push({ position: [sp[0] ?? m3[0], sp[1] ?? m3[1], sp[2] ?? m3[2]], rows, cols, points: xyz.length / 3 });
    batches.push({ xyz, rgbv, iv });
    onProgress?.(total, 0);
    if (done && cursor >= buf.length) break;
  }
  if (!total) throw new Error('no points found in that PTX');
  const tr = mn.slice();
  onMeta({ name, points: total, translation: tr, bounds: [0, mx[0] - mn[0], 0, mx[1] - mn[1], 0, mx[2] - mn[2]],
           hasColor, hasIntensity, hasNormals: false, format: 'ptx', version: `${scans.length} scans`,
           stations: scans.map((s, i) => ({ image: -1, t: s.position, q: [1, 0, 0, 0], w: s.cols, h: s.rows, bytes: 0, name: `Scan ${i + 1}` })) });
  let read = 0;
  for (const b of batches) {
    const n = b.xyz.length / 3;
    const xyz = new Float64Array(n * 3), rgb = new Uint8Array(b.rgbv), inten = new Uint8Array(b.iv), nrm = new Int8Array(n * 3);
    for (let i = 0; i < n; i++) {
      xyz[i * 3] = b.xyz[i * 3] - tr[0]; xyz[i * 3 + 1] = b.xyz[i * 3 + 1] - tr[1]; xyz[i * 3 + 2] = b.xyz[i * 3 + 2] - tr[2];
      nrm[i * 3] = 0; nrm[i * 3 + 1] = 0; nrm[i * 3 + 2] = 127;
    }
    read += n;
    onBatch({ xyz, rgb, inten, nrm, n, read });
    onProgress?.(read, total);
  }
  return { read };
}
