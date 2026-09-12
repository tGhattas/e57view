// What you can do to a triangle mesh once it is in memory.
//
// All of it runs on the main thread. A reconstructed surface or an imported model is tens to
// a few hundred thousand triangles, which is a fraction of a second here; the cloud work is
// what needed workers, because a cloud is two orders of magnitude bigger.
//
// Everything takes and returns a `MeshData` in the mesh's own local frame. Measurements are
// the exception: area and volume are only meaningful in world units, so they take the matrix
// the mesh is drawn through and apply it as they go.
import * as THREE from 'three';
import type { MeshData } from './meshview';

export interface MeshMeasure {
  vertices: number;
  triangles: number;
  /** Total surface area in square metres, through the mesh's transform. */
  area: number;
  /** Signed volume by the divergence theorem. Only meaningful when the mesh is closed. */
  volume: number;
  /** Edges used by exactly one triangle: a closed mesh has none. */
  boundaryEdges: number;
  /** Edges used by three or more: the mesh is not a surface there. */
  nonManifoldEdges: number;
  closed: boolean;
  /** Triangles with no area, which contribute nothing and break normals. */
  degenerate: number;
  bbox: { min: number[]; max: number[] };
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _u = new THREE.Vector3(), _v = new THREE.Vector3(), _n = new THREE.Vector3();

/** Edge key for a pair of vertex indices, order-independent. */
const ekey = (a: number, b: number) => a < b ? a * 4294967296 + b : b * 4294967296 + a;

/** Area, volume and topology, in the world the mesh is drawn in.
 *
 *  The volume is the divergence theorem: each triangle contributes the signed volume of the
 *  tetrahedron it makes with the origin, and on a closed consistently-wound surface those
 *  cancel down to the enclosed volume whatever the origin is. On an open one they do not
 *  cancel to anything, which is why the boundary edge count is reported next to it rather
 *  than hidden — the number is only as good as "closed" says it is. */
export function measureMesh(m: MeshData, model: THREE.Matrix4): MeshMeasure {
  const nf = m.idx.length / 3;
  let area = 0, vol = 0, degenerate = 0;
  const bb = new THREE.Box3();
  const edges = new Map<number, number>();
  for (let f = 0; f < nf; f++) {
    const i0 = m.idx[f * 3], i1 = m.idx[f * 3 + 1], i2 = m.idx[f * 3 + 2];
    _a.set(m.pos[i0 * 3], m.pos[i0 * 3 + 1], m.pos[i0 * 3 + 2]).applyMatrix4(model);
    _b.set(m.pos[i1 * 3], m.pos[i1 * 3 + 1], m.pos[i1 * 3 + 2]).applyMatrix4(model);
    _c.set(m.pos[i2 * 3], m.pos[i2 * 3 + 1], m.pos[i2 * 3 + 2]).applyMatrix4(model);
    _u.subVectors(_b, _a); _v.subVectors(_c, _a); _n.crossVectors(_u, _v);
    const a2 = _n.length();
    if (a2 < 1e-18) degenerate++;
    area += a2 * 0.5;
    vol += _a.dot(_n) / 6;         // = a · (b-a) × (c-a) / 6, the tetrahedron with the origin
    for (const [p, q] of [[i0, i1], [i1, i2], [i2, i0]] as [number, number][]) {
      const k = ekey(p, q);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  for (let i = 0; i < m.pos.length; i += 3) bb.expandByPoint(_a.set(m.pos[i], m.pos[i + 1], m.pos[i + 2]).applyMatrix4(model));
  let boundary = 0, nonManifold = 0;
  for (const n of edges.values()) { if (n === 1) boundary++; else if (n > 2) nonManifold++; }
  return {
    vertices: m.pos.length / 3, triangles: nf, area, volume: Math.abs(vol),
    boundaryEdges: boundary, nonManifoldEdges: nonManifold,
    closed: boundary === 0 && nonManifold === 0, degenerate,
    bbox: { min: bb.min.toArray(), max: bb.max.toArray() },
  };
}

/** Area-weighted vertex normals, recomputed from the triangles. Kept in the mesh's own
 *  frame: the renderer rotates them by the model like it does the positions. */
export function recomputeNormals(m: MeshData): Float32Array {
  const nv = m.pos.length / 3;
  const out = new Float32Array(nv * 3);
  for (let f = 0; f < m.idx.length; f += 3) {
    const i0 = m.idx[f], i1 = m.idx[f + 1], i2 = m.idx[f + 2];
    _a.set(m.pos[i0 * 3], m.pos[i0 * 3 + 1], m.pos[i0 * 3 + 2]);
    _b.set(m.pos[i1 * 3], m.pos[i1 * 3 + 1], m.pos[i1 * 3 + 2]);
    _c.set(m.pos[i2 * 3], m.pos[i2 * 3 + 1], m.pos[i2 * 3 + 2]);
    _n.crossVectors(_u.subVectors(_b, _a), _v.subVectors(_c, _a));    // length is twice the area: the weight
    for (const i of [i0, i1, i2]) { out[i * 3] += _n.x; out[i * 3 + 1] += _n.y; out[i * 3 + 2] += _n.z; }
  }
  for (let i = 0; i < nv; i++) {
    const l = Math.hypot(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]);
    if (l > 1e-20) { out[i * 3] /= l; out[i * 3 + 1] /= l; out[i * 3 + 2] /= l; }
  }
  return out;
}

/** Reverse every triangle's winding, and the normals with it. What a mesh that imported
 *  inside-out needs: nothing about the geometry changes, only which side is the front. */
export function flipMesh(m: MeshData): MeshData {
  const idx = new Uint32Array(m.idx.length);
  for (let f = 0; f < m.idx.length; f += 3) { idx[f] = m.idx[f]; idx[f + 1] = m.idx[f + 2]; idx[f + 2] = m.idx[f + 1]; }
  const nrm = new Float32Array(m.nrm.length);
  for (let i = 0; i < m.nrm.length; i++) nrm[i] = -m.nrm[i];
  return { pos: m.pos.slice(), nrm, col: m.col.slice(), idx };
}

/** Vertex neighbour lists, in CSR form. */
function adjacency(m: MeshData) {
  const nv = m.pos.length / 3;
  const seen = new Set<number>();
  const counts = new Uint32Array(nv);
  const pairs: number[] = [];
  for (let f = 0; f < m.idx.length; f += 3) {
    const t = [m.idx[f], m.idx[f + 1], m.idx[f + 2]];
    for (const [p, q] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]] as [number, number][]) {
      const k = ekey(p, q);
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push(p, q);
      counts[p]++; counts[q]++;
    }
  }
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < nv; i++) start[i + 1] = start[i] + counts[i];
  const nb = new Uint32Array(start[nv]);
  const fill = start.slice(0, nv);
  for (let i = 0; i < pairs.length; i += 2) {
    nb[fill[pairs[i]]++] = pairs[i + 1];
    nb[fill[pairs[i + 1]]++] = pairs[i];
  }
  return { start, nb };
}

/** Which vertices sit on a boundary edge. Those are pinned by the smoother: a boundary
 *  vertex has neighbours on one side only, so averaging drags the edge inward. */
function boundaryVerts(m: MeshData): Uint8Array {
  const nv = m.pos.length / 3;
  const use = new Map<number, number>();
  for (let f = 0; f < m.idx.length; f += 3) {
    const t = [m.idx[f], m.idx[f + 1], m.idx[f + 2]];
    for (const [p, q] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]] as [number, number][]) {
      const k = ekey(p, q);
      use.set(k, (use.get(k) ?? 0) + 1);
    }
  }
  const out = new Uint8Array(nv);
  for (const [k, n] of use) {
    if (n !== 1) continue;
    const b = k % 4294967296, a = (k - b) / 4294967296;
    out[a] = 1; out[b] = 1;
  }
  return out;
}

/** Taubin smoothing: a shrinking pass followed by an expanding one.
 *
 *  Plain Laplacian smoothing shrinks — every pass pulls a sphere toward its centre, and a
 *  wall pulls toward the room. Taubin's fix is to follow each λ pass with a μ pass at a
 *  slightly larger negative weight, which is a low-pass filter on the surface rather than a
 *  blur: the noise goes and the volume stays. Pass `mu = 0` for plain Laplacian. */
export function smoothMesh(m: MeshData, iterations: number, lambda = 0.5, mu = -0.53): MeshData {
  const nv = m.pos.length / 3;
  const { start, nb } = adjacency(m);
  const pinned = boundaryVerts(m);
  let pos = Float32Array.from(m.pos);
  const tmp = new Float32Array(nv * 3);
  const pass = (w: number) => {
    for (let i = 0; i < nv; i++) {
      const s = start[i], e = start[i + 1];
      if (e === s || pinned[i]) { tmp[i * 3] = pos[i * 3]; tmp[i * 3 + 1] = pos[i * 3 + 1]; tmp[i * 3 + 2] = pos[i * 3 + 2]; continue; }
      let cx = 0, cy = 0, cz = 0;
      for (let j = s; j < e; j++) { const k = nb[j] * 3; cx += pos[k]; cy += pos[k + 1]; cz += pos[k + 2]; }
      const inv = 1 / (e - s);
      tmp[i * 3] = pos[i * 3] + w * (cx * inv - pos[i * 3]);
      tmp[i * 3 + 1] = pos[i * 3 + 1] + w * (cy * inv - pos[i * 3 + 1]);
      tmp[i * 3 + 2] = pos[i * 3 + 2] + w * (cz * inv - pos[i * 3 + 2]);
    }
    pos.set(tmp);
  };
  for (let it = 0; it < iterations; it++) { pass(lambda); if (mu !== 0) pass(mu); }
  const out: MeshData = { pos, nrm: new Float32Array(nv * 3), col: m.col.slice(), idx: m.idx.slice() };
  out.nrm = recomputeNormals(out);
  return out;
}

/** Solve a 3x3 system by Cramer's rule, or null when it is too close to singular. */
function solve3(A: number[][], b: number[]): number[] | null {
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(A);
  const scale = Math.max(...A.flat().map(Math.abs), 1e-30);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-8 * scale ** 3) return null;
  const out = [];
  for (let c = 0; c < 3; c++) {
    const M = A.map(r => r.slice());
    for (let r = 0; r < 3; r++) M[r][c] = b[r];
    out.push(det(M) / d);
  }
  return out;
}

/** Decimate by **vertex clustering**, not quadric edge collapse.
 *
 *  Said plainly because the two behave differently: clustering is one pass over the
 *  triangles with no priority queue, so it is linear and finishes on a million triangles in
 *  well under a second, but it cannot hit an exact triangle target — you ask for a grid and
 *  get whatever that grid produces. Edge collapse hits a target exactly and follows thin
 *  features better; it also needs a heap of every edge, re-ranked on each collapse, which is
 *  minutes on the meshes a scan produces.
 *
 *  What it does keep is corners: each cluster's representative is the point that minimises
 *  the sum of squared distances to the planes of the triangles in it (the quadric), not the
 *  mean of its vertices. On a box that puts the representative back on the corner instead of
 *  rounding it off. Where the quadric is degenerate — a flat patch, where any point on the
 *  plane is as good — it falls back to the area-weighted mean. */
export function decimateMesh(m: MeshData, cell: number): MeshData {
  const nv = m.pos.length / 3;
  if (!(cell > 0)) return m;
  const inv = 1 / cell;
  // Two levels of map rather than one packed integer key: packing three cell indices into a
  // double silently collides past 2^53, and a collision here welds two unrelated parts of the
  // model together. The outer key is the x index; the inner packs y and z, which cannot
  // overflow for any grid a machine could hold.
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) for (let a = 0; a < 3; a++) {
    const g = Math.floor(m.pos[i * 3 + a] * inv);
    if (g < lo[a]) lo[a] = g;
    if (g > hi[a]) hi[a] = g;
  }
  const dz = hi[2] - lo[2] + 1;
  const rows = new Map<number, Map<number, number>>();
  const remap = new Uint32Array(nv);
  let nc = 0;
  for (let i = 0; i < nv; i++) {
    const x = Math.floor(m.pos[i * 3] * inv) - lo[0];
    const y = Math.floor(m.pos[i * 3 + 1] * inv) - lo[1];
    const z = Math.floor(m.pos[i * 3 + 2] * inv) - lo[2];
    let row = rows.get(x);
    if (!row) { row = new Map(); rows.set(x, row); }
    const k = y * dz + z;
    let c = row.get(k);
    if (c === undefined) { c = nc++; row.set(k, c); }
    remap[i] = c;
  }
  // accumulate the quadric (A, b) and an area-weighted mean per cluster
  const A = new Float64Array(nc * 6);          // xx xy xz yy yz zz
  const B = new Float64Array(nc * 3);
  const mean = new Float64Array(nc * 3);
  const wsum = new Float64Array(nc);
  const csum = new Float64Array(nc * 3);
  const hits = new Uint32Array(nc);      // triangle corners per cluster, for the colour average
  for (let f = 0; f < m.idx.length; f += 3) {
    const i0 = m.idx[f], i1 = m.idx[f + 1], i2 = m.idx[f + 2];
    _a.set(m.pos[i0 * 3], m.pos[i0 * 3 + 1], m.pos[i0 * 3 + 2]);
    _b.set(m.pos[i1 * 3], m.pos[i1 * 3 + 1], m.pos[i1 * 3 + 2]);
    _c.set(m.pos[i2 * 3], m.pos[i2 * 3 + 1], m.pos[i2 * 3 + 2]);
    _n.crossVectors(_u.subVectors(_b, _a), _v.subVectors(_c, _a));
    const twoA = _n.length();
    if (twoA < 1e-20) continue;
    const nx = _n.x / twoA, ny = _n.y / twoA, nz = _n.z / twoA;
    const d = -(nx * _a.x + ny * _a.y + nz * _a.z);
    const w = twoA * 0.5;
    for (const i of [i0, i1, i2]) {
      const c = remap[i];
      A[c * 6] += w * nx * nx; A[c * 6 + 1] += w * nx * ny; A[c * 6 + 2] += w * nx * nz;
      A[c * 6 + 3] += w * ny * ny; A[c * 6 + 4] += w * ny * nz; A[c * 6 + 5] += w * nz * nz;
      B[c * 3] -= w * d * nx; B[c * 3 + 1] -= w * d * ny; B[c * 3 + 2] -= w * d * nz;
      mean[c * 3] += w * m.pos[i * 3]; mean[c * 3 + 1] += w * m.pos[i * 3 + 1]; mean[c * 3 + 2] += w * m.pos[i * 3 + 2];
      wsum[c] += w;
      csum[c * 3] += m.col[i * 3]; csum[c * 3 + 1] += m.col[i * 3 + 1]; csum[c * 3 + 2] += m.col[i * 3 + 2];
      hits[c]++;
    }
  }
  const pos = new Float32Array(nc * 3);
  const col = new Uint8Array(nc * 3);
  const half = cell * 0.75;                 // how far the representative may stray from the cell
  for (let c = 0; c < nc; c++) {
    const w = wsum[c] || 1;
    const mx = mean[c * 3] / w, my = mean[c * 3 + 1] / w, mz = mean[c * 3 + 2] / w;
    let p: number[] | null = null;
    if (wsum[c] > 0) {
      p = solve3([[A[c * 6], A[c * 6 + 1], A[c * 6 + 2]], [A[c * 6 + 1], A[c * 6 + 3], A[c * 6 + 4]], [A[c * 6 + 2], A[c * 6 + 4], A[c * 6 + 5]]],
        [B[c * 3], B[c * 3 + 1], B[c * 3 + 2]]);
      // a nearly-degenerate quadric can throw the point across the model; keep it local
      if (p && (Math.abs(p[0] - mx) > half || Math.abs(p[1] - my) > half || Math.abs(p[2] - mz) > half)) p = null;
    }
    const q = p ?? [mx, my, mz];
    pos[c * 3] = q[0]; pos[c * 3 + 1] = q[1]; pos[c * 3 + 2] = q[2];
    // each vertex was added once per incident triangle corner, so divide by that same count
    const k = hits[c] || 1;
    for (let a = 0; a < 3; a++) col[c * 3 + a] = Math.max(0, Math.min(255, Math.round(csum[c * 3 + a] / k)));
  }
  // clusters with no incident triangle area still need a position
  for (let i = 0; i < nv; i++) {
    const c = remap[i];
    if (wsum[c] === 0) { pos[c * 3] = m.pos[i * 3]; pos[c * 3 + 1] = m.pos[i * 3 + 1]; pos[c * 3 + 2] = m.pos[i * 3 + 2]; }
  }
  const tri: number[] = [];
  // The same three clusters can be hit by several triangles; keep one. Two levels again, for
  // the same reason: one packed key over a few million clusters would not fit in a double.
  const seen = new Map<number, Set<number>>();
  for (let f = 0; f < m.idx.length; f += 3) {
    const a = remap[m.idx[f]], b = remap[m.idx[f + 1]], c = remap[m.idx[f + 2]];
    if (a === b || b === c || a === c) continue;             // collapsed to a line or a point
    const s = [a, b, c].sort((x, y) => x - y);
    let row = seen.get(s[0]);
    if (!row) { row = new Set(); seen.set(s[0], row); }
    const k = s[1] * nc + s[2];
    if (row.has(k)) continue;
    row.add(k);
    tri.push(a, b, c);
  }
  const out: MeshData = { pos, nrm: new Float32Array(nc * 3), col, idx: Uint32Array.from(tri) };
  out.nrm = recomputeNormals(out);
  return out;
}

export interface SampledPoints {
  xyz: Float64Array; nrm: Float32Array; rgb: Uint8Array; count: number; area: number;
}

/** Scatter points over the surface, area-weighted, so the density is uniform in metres
 *  rather than per triangle — one big triangle gets as many points as the hundred small ones
 *  covering the same area. Positions come back in world coordinates, because that is where
 *  a point layer lives. */
export function samplePoints(m: MeshData, model: THREE.Matrix4, count: number, seed = 12345): SampledPoints {
  const nf = m.idx.length / 3;
  const cum = new Float64Array(nf + 1);
  const nrmMat = new THREE.Matrix3().setFromMatrix4(model);
  for (let f = 0; f < nf; f++) {
    const i0 = m.idx[f * 3], i1 = m.idx[f * 3 + 1], i2 = m.idx[f * 3 + 2];
    _a.set(m.pos[i0 * 3], m.pos[i0 * 3 + 1], m.pos[i0 * 3 + 2]).applyMatrix4(model);
    _b.set(m.pos[i1 * 3], m.pos[i1 * 3 + 1], m.pos[i1 * 3 + 2]).applyMatrix4(model);
    _c.set(m.pos[i2 * 3], m.pos[i2 * 3 + 1], m.pos[i2 * 3 + 2]).applyMatrix4(model);
    cum[f + 1] = cum[f] + _u.subVectors(_b, _a).cross(_v.subVectors(_c, _a)).length() * 0.5;
  }
  const area = cum[nf];
  const n = Math.max(0, Math.round(count));
  const xyz = new Float64Array(n * 3), nrm = new Float32Array(n * 3), rgb = new Uint8Array(n * 3);
  // a small deterministic generator: the same mesh gives the same points, which is what a
  // driver and a repeated measurement both need
  let s = seed >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = 0; i < n; i++) {
    const t = rnd() * area;
    // binary search for the triangle this lands in
    let lo = 0, hi = nf - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid + 1] < t) lo = mid + 1; else hi = mid; }
    const f = lo;
    const i0 = m.idx[f * 3], i1 = m.idx[f * 3 + 1], i2 = m.idx[f * 3 + 2];
    // uniform barycentric coordinates: the square root folds the unit square onto the triangle
    let r1 = Math.sqrt(rnd()), r2 = rnd();
    const w0 = 1 - r1, w1 = r1 * (1 - r2), w2 = r1 * r2;
    _a.set(m.pos[i0 * 3], m.pos[i0 * 3 + 1], m.pos[i0 * 3 + 2]).applyMatrix4(model);
    _b.set(m.pos[i1 * 3], m.pos[i1 * 3 + 1], m.pos[i1 * 3 + 2]).applyMatrix4(model);
    _c.set(m.pos[i2 * 3], m.pos[i2 * 3 + 1], m.pos[i2 * 3 + 2]).applyMatrix4(model);
    xyz[i * 3] = _a.x * w0 + _b.x * w1 + _c.x * w2;
    xyz[i * 3 + 1] = _a.y * w0 + _b.y * w1 + _c.y * w2;
    xyz[i * 3 + 2] = _a.z * w0 + _b.z * w1 + _c.z * w2;
    _n.set(
      m.nrm[i0 * 3] * w0 + m.nrm[i1 * 3] * w1 + m.nrm[i2 * 3] * w2,
      m.nrm[i0 * 3 + 1] * w0 + m.nrm[i1 * 3 + 1] * w1 + m.nrm[i2 * 3 + 1] * w2,
      m.nrm[i0 * 3 + 2] * w0 + m.nrm[i1 * 3 + 2] * w1 + m.nrm[i2 * 3 + 2] * w2).applyMatrix3(nrmMat);
    if (_n.lengthSq() < 1e-18) {
      _n.crossVectors(_u.subVectors(_b, _a), _v.subVectors(_c, _a));
    }
    if (_n.lengthSq() > 1e-18) _n.normalize();
    nrm[i * 3] = _n.x; nrm[i * 3 + 1] = _n.y; nrm[i * 3 + 2] = _n.z;
    for (let k = 0; k < 3; k++) rgb[i * 3 + k] = Math.round(m.col[i0 * 3 + k] * w0 + m.col[i1 * 3 + k] * w1 + m.col[i2 * 3 + k] * w2);
  }
  return { xyz, nrm, rgb, count: n, area };
}
