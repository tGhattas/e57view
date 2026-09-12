// PLY and LAS importers over a synchronous ranged reader: readRange(offset, length) -> Uint8Array.
// Used by the browser import worker (FileReaderSync) and by the cloud converter (fs.readSync).
// Output batches are relative to `translation` so positions stay f32-safe on the GPU.

const CHUNK = 8 * 1024 * 1024;

export function sniff(name, readRange) {
  const head = readRange(0, 16);
  const s = String.fromCharCode(...head.subarray(0, 8));
  if (s.startsWith('ASTM-E57')) return 'e57';
  if (s.startsWith('ply')) return 'ply';
  if (s.startsWith('LASF')) return 'las';
  const ext = (name || '').toLowerCase().split('.').pop();
  if (ext === 'e57' || ext === 'ply' || ext === 'las' || ext === 'laz') return ext;
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
  return { version: `${vMaj}.${vMin}`, offset, fmt, compressed, recLen, count, scale, off, min, max, rgbOff: rgbOff ?? -1, hasColor: rgbOff !== undefined };
}

export function parseLas(readRange, size, name, onMeta, onBatch, onProgress) {
  const h = lasHeader(readRange);
  if (h.compressed) throw new Error('This is a LAZ (compressed) file. Decompress it to LAS first — LAZ is not supported yet.');
  const tr = h.min.slice();
  onMeta({ name, points: h.count, translation: tr, bounds: [0, h.max[0] - h.min[0], 0, h.max[1] - h.min[1], 0, h.max[2] - h.min[2]],
           hasColor: h.hasColor, hasIntensity: true, hasNormals: false, format: 'las', version: h.version, pointFormat: h.fmt });
  const B = 262144;
  let xyz = new Float64Array(B * 3), rgb = new Uint8Array(B * 3), inten = new Uint8Array(B), nrm = new Int8Array(B * 3), j = 0, read = 0;
  const flush = () => { if (!j) return; onBatch({ xyz: xyz.subarray(0, j * 3), rgb: rgb.subarray(0, j * 3), inten: inten.subarray(0, j), nrm: nrm.subarray(0, j * 3), n: j, read }); xyz = new Float64Array(B * 3); rgb = new Uint8Array(B * 3); inten = new Uint8Array(B); nrm = new Int8Array(B * 3); j = 0; };
  let pos = h.offset, n = 0;
  const end = Math.min(size, h.offset + h.count * h.recLen);
  // intensity: 16-bit in LAS, but many writers only use 8 or 12 bits — scale by the observed max on the first chunk
  let iShift = 8;
  while (pos < end && n < h.count) {
    const want = Math.min(CHUNK - (CHUNK % h.recLen), end - pos);
    const buf = readRange(pos, want); pos += buf.length;
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
      j++; read++;
      if (j >= B) { flush(); onProgress?.(read, h.count); }
    }
  }
  flush();
  return { read };
}
