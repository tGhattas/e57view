// SPDX-License-Identifier: GPL-3.0-only
// Reading and writing triangle meshes: PLY, OBJ, STL.
//
// Separate from importers.mjs because a mesh is not a cloud: the cloud importers stream
// millions of points through a callback and never hold the file, while a mesh has to be held
// whole — the faces index the vertices, so nothing can be finished until both are read.
//
// Everything comes back in a local frame with the shift reported separately, the same
// contract as the cloud importers: a mesh in survey coordinates would lose centimetres to
// float32 otherwise.

const dec = (b) => new TextDecoder('latin1').decode(b);

/** What kind of mesh this is, from the first bytes rather than the name. */
export function sniffMesh(name, head) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const t = dec(head.subarray(0, 80));
  if (/^ply\s/.test(t)) return 'ply';
  if (ext === 'obj') return 'obj';
  if (ext === 'stl') return 'stl';
  if (/^\s*solid\s/.test(t) && ext !== 'ply') return 'stl';
  if (/^\s*(v\s|vn\s|vt\s|f\s|#|mtllib|o\s|g\s|usemtl)/m.test(t)) return 'obj';
  return null;
}

export const MESH_EXT = ['ply', 'obj', 'stl'];

const PLY_SIZES = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

function readProp(dv, off, type, le) {
  switch (type) {
    case 'char': case 'int8': return dv.getInt8(off);
    case 'uchar': case 'uint8': return dv.getUint8(off);
    case 'short': case 'int16': return dv.getInt16(off, le);
    case 'ushort': case 'uint16': return dv.getUint16(off, le);
    case 'int': case 'int32': return dv.getInt32(off, le);
    case 'uint': case 'uint32': return dv.getUint32(off, le);
    case 'double': case 'float64': return dv.getFloat64(off, le);
    default: return dv.getFloat32(off, le);
  }
}

/** Every element of a PLY header, not just the vertex one: the faces are the point here. */
function plyElements(bytes) {
  const text = dec(bytes.subarray(0, Math.min(bytes.length, 1 << 20)));
  const endIdx = text.indexOf('end_header');
  if (endIdx < 0) throw new Error('PLY header not found in the first megabyte');
  const headerLen = text.indexOf('\n', endIdx) + 1;
  let format = 'ascii'; const elements = []; let cur = null;
  for (const line of text.slice(0, endIdx).split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') { cur = { name: t[1], count: Number(t[2]), props: [] }; elements.push(cur); }
    else if (t[0] === 'property' && cur) {
      if (t[1] === 'list') cur.props.push({ list: true, countType: t[2], type: t[3], name: t[4] });
      else cur.props.push({ type: t[1], name: t[2] });
    }
  }
  return { format, headerLen, elements };
}

function parsePlyMesh(buf) {
  const bytes = new Uint8Array(buf);
  const { format, headerLen, elements } = plyElements(bytes);
  const vtx = elements.find(e => e.name === 'vertex');
  if (!vtx) throw new Error('that PLY has no vertex element');
  const face = elements.find(e => e.name === 'face' || e.name === 'tristrips');
  const nv = vtx.count;
  const pos = new Float64Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const col = new Uint8Array(nv * 3).fill(200);
  const find = (...n) => vtx.props.findIndex(p => n.includes(p.name.toLowerCase()));
  const ix = find('x'), iy = find('y'), iz = find('z');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('that PLY has no x/y/z');
  const inx = find('nx', 'normal_x'), iny = find('ny', 'normal_y'), inz = find('nz', 'normal_z');
  const ir = find('red', 'r', 'diffuse_red'), ig = find('green', 'g', 'diffuse_green'), ib = find('blue', 'b', 'diffuse_blue');
  // float colours are 0..1 in some writers and 0..255 in others; scale by what the type implies
  const cScale = ir >= 0 && /float|double/.test(vtx.props[ir].type) ? 255 : 1;
  let idx;

  if (format === 'ascii') {
    const text = dec(bytes.subarray(headerLen));
    const lines = text.split(/\r?\n/);
    let li = 0;
    const next = () => { while (li < lines.length) { const l = lines[li++].trim(); if (l && l[0] !== '#') return l.split(/\s+/); } return null; };
    for (let i = 0; i < nv; i++) {
      const t = next(); if (!t) throw new Error('PLY ended inside the vertex list');
      pos[i * 3] = +t[ix]; pos[i * 3 + 1] = +t[iy]; pos[i * 3 + 2] = +t[iz];
      if (inx >= 0) { nrm[i * 3] = +t[inx]; nrm[i * 3 + 1] = +t[iny]; nrm[i * 3 + 2] = +t[inz]; }
      if (ir >= 0) { col[i * 3] = Math.round(+t[ir] * cScale); col[i * 3 + 1] = Math.round(+t[ig] * cScale); col[i * 3 + 2] = Math.round(+t[ib] * cScale); }
    }
    const tri = [];
    for (let f = 0; f < (face?.count ?? 0); f++) {
      const t = next(); if (!t) break;
      const k = +t[0];
      for (let j = 2; j < k; j++) { tri.push(+t[1], +t[j], +t[j + 1]); }
    }
    idx = Uint32Array.from(tri);
  } else {
    const le = format !== 'binary_big_endian';
    const dv = new DataView(buf);
    let off = headerLen;
    const offs = []; let s = 0;
    for (const p of vtx.props) { offs.push(s); s += PLY_SIZES[p.type] ?? 4; }
    if (vtx.props.some(p => p.list)) throw new Error('a PLY vertex with list properties is not supported');
    for (let i = 0; i < nv; i++) {
      pos[i * 3] = readProp(dv, off + offs[ix], vtx.props[ix].type, le);
      pos[i * 3 + 1] = readProp(dv, off + offs[iy], vtx.props[iy].type, le);
      pos[i * 3 + 2] = readProp(dv, off + offs[iz], vtx.props[iz].type, le);
      if (inx >= 0) {
        nrm[i * 3] = readProp(dv, off + offs[inx], vtx.props[inx].type, le);
        nrm[i * 3 + 1] = readProp(dv, off + offs[iny], vtx.props[iny].type, le);
        nrm[i * 3 + 2] = readProp(dv, off + offs[inz], vtx.props[inz].type, le);
      }
      if (ir >= 0) {
        col[i * 3] = Math.round(readProp(dv, off + offs[ir], vtx.props[ir].type, le) * cScale);
        col[i * 3 + 1] = Math.round(readProp(dv, off + offs[ig], vtx.props[ig].type, le) * cScale);
        col[i * 3 + 2] = Math.round(readProp(dv, off + offs[ib], vtx.props[ib].type, le) * cScale);
      }
      off += s;
    }
    // elements between vertex and face have to be stepped over, or the faces read as noise
    for (const e of elements) {
      if (e === vtx) continue;
      if (e === face) break;
      if (e.props.some(p => p.list)) throw new Error(`PLY element "${e.name}" sits between the vertices and the faces and cannot be skipped`);
      let w = 0; for (const p of e.props) w += PLY_SIZES[p.type] ?? 4;
      off += w * e.count;
    }
    const tri = [];
    for (let f = 0; f < (face?.count ?? 0); f++) {
      const lp = face.props.find(p => p.list) ?? face.props[0];
      const k = readProp(dv, off, lp.countType ?? 'uchar', le);
      off += PLY_SIZES[lp.countType ?? 'uchar'] ?? 1;
      const w = PLY_SIZES[lp.type] ?? 4;
      const v = [];
      for (let j = 0; j < k; j++) { v.push(readProp(dv, off, lp.type, le)); off += w; }
      for (let j = 2; j < k; j++) tri.push(v[0], v[j - 1], v[j]);
      // any further properties on the face (a colour, say) come after the list
      for (const p of face.props) { if (p !== lp) off += PLY_SIZES[p.type] ?? 4; }
    }
    idx = Uint32Array.from(tri);
  }
  return { pos, nrm, col, idx };
}

function parseObjMesh(buf) {
  const text = dec(new Uint8Array(buf));
  const px = [], nrmRaw = [], colRaw = [], tri = [];
  let hasCol = false, hasNrm = false;
  const nIdxOf = [];               // vertex -> the vn it was last seen with
  let pos = 0;
  const len = text.length;
  while (pos < len) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = len;
    const line = text.slice(pos, nl);
    pos = nl + 1;
    if (!line || line[0] === '#') continue;
    const c = line.charCodeAt(0);
    if (c !== 118 && c !== 102) continue;                       // 'v' or 'f'
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') {
      px.push(+t[1], +t[2], +t[3]);
      if (t.length >= 7) {
        hasCol = true;
        const s = (+t[4] <= 1.0 && +t[5] <= 1.0 && +t[6] <= 1.0) ? 255 : 1;
        colRaw.push(Math.round(+t[4] * s), Math.round(+t[5] * s), Math.round(+t[6] * s));
      } else colRaw.push(200, 200, 200);
    } else if (t[0] === 'vn') {
      hasNrm = true;
      nrmRaw.push(+t[1], +t[2], +t[3]);
    } else if (t[0] === 'f') {
      const v = [], n = [];
      for (let i = 1; i < t.length; i++) {
        const parts = t[i].split('/');
        let a = parseInt(parts[0], 10);
        if (!Number.isFinite(a)) continue;
        a = a < 0 ? px.length / 3 + a : a - 1;
        v.push(a);
        let b = parts[2] !== undefined && parts[2] !== '' ? parseInt(parts[2], 10) : NaN;
        if (Number.isFinite(b)) { b = b < 0 ? nrmRaw.length / 3 + b : b - 1; n.push(b); } else n.push(-1);
      }
      for (let j = 2; j < v.length; j++) {
        tri.push(v[0], v[j - 1], v[j]);
        for (const k of [0, j - 1, j]) if (n[k] >= 0) nIdxOf[v[k]] = n[k];
      }
    }
  }
  const nv = px.length / 3;
  const out = { pos: Float64Array.from(px), nrm: new Float32Array(nv * 3), col: Uint8Array.from(colRaw), idx: Uint32Array.from(tri) };
  if (hasNrm) for (let i = 0; i < nv; i++) {
    const j = nIdxOf[i];
    if (j >= 0) { out.nrm[i * 3] = nrmRaw[j * 3]; out.nrm[i * 3 + 1] = nrmRaw[j * 3 + 1]; out.nrm[i * 3 + 2] = nrmRaw[j * 3 + 2]; }
  }
  if (!hasCol) out.col.fill(200);
  return out;
}

/** STL has no vertices, only loose triangles, so identical corners are welded back together —
 *  otherwise smoothing, decimation and the boundary-edge count are all meaningless. */
function weld(tris, nrms) {
  const n = tris.length / 3;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
    const v = tris[i * 3 + a];
    if (v < mn[a]) mn[a] = v;
    if (v > mx[a]) mx[a] = v;
  }
  const span = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-9);
  const q = span * 1e-7;                       // a ten-millionth of the model: well under any real feature
  const map = new Map();
  const pos = [], nrm = [], idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const x = tris[i * 3], y = tris[i * 3 + 1], z = tris[i * 3 + 2];
    const k = `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
    let j = map.get(k);
    if (j === undefined) {
      j = pos.length / 3;
      map.set(k, j);
      pos.push(x, y, z);
      nrm.push(0, 0, 0);
    }
    idx[i] = j;
    if (nrms) { nrm[j * 3] += nrms[i * 3]; nrm[j * 3 + 1] += nrms[i * 3 + 1]; nrm[j * 3 + 2] += nrms[i * 3 + 2]; }
  }
  const nv = pos.length / 3;
  const nf = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
    if (l > 1e-12) { nf[i * 3] = nrm[i * 3] / l; nf[i * 3 + 1] = nrm[i * 3 + 1] / l; nf[i * 3 + 2] = nrm[i * 3 + 2] / l; }
  }
  return { pos: Float64Array.from(pos), nrm: nf, col: new Uint8Array(nv * 3).fill(200), idx };
}

function parseStlMesh(buf) {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  const asciiish = /^\s*solid/.test(dec(bytes.subarray(0, 6)));
  const n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  const binary = buf.byteLength === 84 + n * 50 && n > 0;
  if (binary) {
    const tris = new Float64Array(n * 9), nrms = new Float32Array(n * 9);
    let off = 84;
    for (let i = 0; i < n; i++) {
      const nx = dv.getFloat32(off, true), ny = dv.getFloat32(off + 4, true), nz = dv.getFloat32(off + 8, true);
      off += 12;
      for (let k = 0; k < 3; k++) {
        tris[i * 9 + k * 3] = dv.getFloat32(off, true);
        tris[i * 9 + k * 3 + 1] = dv.getFloat32(off + 4, true);
        tris[i * 9 + k * 3 + 2] = dv.getFloat32(off + 8, true);
        nrms[i * 9 + k * 3] = nx; nrms[i * 9 + k * 3 + 1] = ny; nrms[i * 9 + k * 3 + 2] = nz;
        off += 12;
      }
      off += 2;
    }
    return weld(tris, nrms);
  }
  if (!asciiish) throw new Error('that STL is neither a valid binary nor an ASCII one');
  const text = dec(bytes);
  const tris = [], nrms = [];
  let nx = 0, ny = 0, nz = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'facet' && t[1] === 'normal') { nx = +t[2]; ny = +t[3]; nz = +t[4]; }
    else if (t[0] === 'vertex') { tris.push(+t[1], +t[2], +t[3]); nrms.push(nx, ny, nz); }
  }
  if (tris.length < 9) throw new Error('that STL has no triangles');
  return weld(Float64Array.from(tris), Float32Array.from(nrms));
}

/** Read a mesh file. Positions come back in float32 relative to `origin`, which is the
 *  rounded minimum corner — a survey-coordinate mesh keeps its millimetres that way. */
export function parseMesh(kind, buf) {
  const m = kind === 'ply' ? parsePlyMesh(buf) : kind === 'obj' ? parseObjMesh(buf) : parseStlMesh(buf);
  const nv = m.pos.length / 3;
  if (!nv) throw new Error('that file has no vertices');
  if (!m.idx.length) throw new Error('that file has no triangles — it is a point cloud, not a mesh (open it as a layer instead)');
  let mn = [Infinity, Infinity, Infinity];
  for (let i = 0; i < nv; i++) for (let a = 0; a < 3; a++) if (m.pos[i * 3 + a] < mn[a]) mn[a] = m.pos[i * 3 + a];
  // only shift when it actually buys precision; a model already near the origin keeps its frame
  const far = mn.some(v => Math.abs(v) > 1000);
  const origin = far ? mn.map(v => Math.round(v)) : [0, 0, 0];
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) for (let a = 0; a < 3; a++) pos[i * 3 + a] = m.pos[i * 3 + a] - origin[a];
  // Faces that index past the end are dropped whole rather than handed to the GPU: a stray
  // index is a corrupt file, and clamping it would draw a triangle that is not in the model.
  let bad = 0;
  const keep = [];
  for (let f = 0; f < m.idx.length; f += 3) {
    if (m.idx[f] < nv && m.idx[f + 1] < nv && m.idx[f + 2] < nv) keep.push(m.idx[f], m.idx[f + 1], m.idx[f + 2]);
    else bad++;
  }
  const idx = keep.length === m.idx.length ? m.idx : Uint32Array.from(keep);
  return { pos, nrm: m.nrm, col: m.col, idx, origin, badIndices: bad };
}

// ---------------------------------------------------------------- writing

/** Binary STL. No colours, no shared vertices: the format has neither. */
export function meshToStl(pos, idx, xform) {
  const nf = idx.length / 3;
  const buf = new ArrayBuffer(84 + nf * 50);
  const dv = new DataView(buf);
  const head = new Uint8Array(buf, 0, 80);
  const title = 'e57view mesh export';
  for (let i = 0; i < title.length; i++) head[i] = title.charCodeAt(i);
  dv.setUint32(80, nf, true);
  let off = 84;
  const p = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
  for (let f = 0; f < nf; f++) {
    for (const [k, v] of [[0, a], [1, b], [2, c]]) {
      const i = idx[f * 3 + k] * 3;
      xform(pos[i], pos[i + 1], pos[i + 2], p);
      v[0] = p[0]; v[1] = p[1]; v[2] = p[2];
    }
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l > 1e-20) n = [n[0] / l, n[1] / l, n[2] / l]; else n = [0, 0, 0];
    dv.setFloat32(off, n[0], true); dv.setFloat32(off + 4, n[1], true); dv.setFloat32(off + 8, n[2], true);
    off += 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(off, v[0], true); dv.setFloat32(off + 4, v[1], true); dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    dv.setUint16(off, 0, true); off += 2;
  }
  return buf;
}
