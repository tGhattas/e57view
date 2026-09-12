// Raw WebGL2 point renderer for octree leaves.
//
// Each leaf is one VBO of 14-byte records (u16 xyz quantised to the leaf cube,
// u8 rgb + intensity, i8 normal) whose records were shuffled at build time. So
// drawing the first N of a leaf is a uniform random subsample: continuous level
// of detail with no extra memory. Per frame we frustum-cull leaves, size each
// one's draw count by its projected screen area, scale to the frame budget, and
// hand the shader an effective spacing so adaptive point size stays gap-free.
//
// three.js is deliberately bypassed here: per-object overhead at 700 draws a
// frame is measurable, and a bare VAO loop is ~10x cheaper.

import * as THREE from 'three';

export const REC = 14;
/** Stands in for "this point has no value" on the GPU.
 *  NaN is not dependable through a driver's fast maths, and a near-FLT_MAX sentinel is
 *  outside the float range GLSL ES guarantees a vertex shader, so use a modest magnitude. */
export const SF_NONE = -1.0e18;

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColI;
layout(location=2) in vec4 aNrm;
layout(location=3) in float aSF;
uniform mat4 uVP, uView, uModel;
uniform vec3 uOrigin; uniform float uSize, uSpacing;
uniform float uPtSize, uSizeMode, uColorMode, uZMin, uZMax, uIMin, uIMax;
uniform float uScreenH, uSlope, uMinPx, uMaxPx, uClipZMin, uClipZMax;
// > 0 when the projection is orthographic: one metre is the same number of pixels
// everywhere, which is the whole point of a measurable plan or elevation.
uniform float uOrthoMpp;
uniform float uSFMin, uSFMax, uSFLo, uSFHi, uSFHide;
uniform vec3 uTint;                      // per-entity colour multiplier, 1,1,1 when off
// Regions: up to 16, each a box (1), sphere (2), slab (3) or prism (4) with its own frame.
// role 0 = keep (a point must be inside at least one keep region),
// role 1 = delete-pending (inside is tinted), role 2 = delete (inside is dimmed / hidden)
#define NREG 16
// A prism is a drawn outline extruded along its local Z. The outlines of every active prism
// share one vertex pool; each region says where its own run starts and how long it is.
#define NPV 96
uniform float uRegN, uRegHide;
uniform float uRegMode[NREG]; uniform float uRegRole[NREG];
uniform vec3 uRegC[NREG]; uniform vec3 uRegS[NREG];
uniform mat3 uRegRot[NREG];              // world -> region local
uniform vec2 uPrismV[NPV];
uniform float uPrismStart[NREG], uPrismCount[NREG];
out vec3 vCol; out float vLogDepth; out vec3 vNrm; flat out float vDrop; flat out float vOut; flat out float vTint;

vec3 ramp(float t){
  t = clamp(t, 0.0, 1.0);
  if (t < 0.25) return vec3(0.0, t*4.0, 1.0);
  if (t < 0.50) return vec3(0.0, 1.0, 1.0-(t-0.25)*4.0);
  if (t < 0.75) return vec3((t-0.5)*4.0, 1.0, 0.0);
  return vec3(1.0, 1.0-(t-0.75)*4.0, 0.0);
}
void main(){
  // The records stay quantised in their original leaf cube; uModel is the cloud's transform,
  // applied here so the region tests, the clipping and the elevation ramp all see the points
  // where they are drawn. Nothing is ever baked into the 16-bit positions.
  vec3 p = (uModel * vec4(uOrigin + aPos * (uSize / 65536.0), 1.0)).xyz;
  vec4 mv = uView * vec4(p, 1.0);
  gl_Position = uVP * vec4(p, 1.0);
  vLogDepth = log2(max(-mv.z, 1e-4));
  vNrm = mat3(uModel) * aNrm.xyz;
  vDrop = (p.z < uClipZMin || p.z > uClipZMax) ? 1.0 : 0.0;
  vOut = 0.0; vTint = 0.0;
  bool anyKeep = false, inKeep = false, inDel = false;
  for (int i = 0; i < NREG; i++) {
    if (i >= int(uRegN)) break;
    float m = uRegMode[i];
    vec3 l = uRegRot[i] * (p - uRegC[i]);
    bool inside;
    if (m > 3.5) {                                                           // prism
      inside = abs(l.z) <= uRegS[i].z;
      if (inside) {
        int st = int(uPrismStart[i]), c = int(uPrismCount[i]);
        bool odd = false;
        for (int k = 0; k < NPV; k++) {
          if (k >= c) break;
          vec2 a = uPrismV[st + k];
          vec2 b = uPrismV[st + (k + 1 == c ? 0 : k + 1)];
          if ((a.y > l.y) != (b.y > l.y) && l.x < a.x + (l.y - a.y) / (b.y - a.y) * (b.x - a.x)) odd = !odd;
        }
        inside = odd;
      }
    }
    else if (m > 2.5) inside = abs(l.z) <= uRegS[i].z;                       // slab: infinite in x,y
    else if (m > 1.5) inside = dot(l, l) <= uRegS[i].x * uRegS[i].x;         // sphere
    else              inside = all(lessThanEqual(abs(l), uRegS[i]));         // box
    float r = uRegRole[i];
    if (r < 0.5) { anyKeep = true; inKeep = inKeep || inside; }
    else if (r < 1.5) { if (inside) vTint = 1.0; }
    else { inDel = inDel || inside; }
  }
  if ((anyKeep && !inKeep) || inDel) vOut = 1.0;
  if (uRegHide > 0.5 && vOut > 0.5) vDrop = 1.0;

  float inten = clamp((aColI.a - uIMin) / max(uIMax - uIMin, 1e-4), 0.0, 1.0);
  float elev  = (p.z - uZMin) / max(uZMax - uZMin, 1e-4);
  if      (uColorMode < 0.5) vCol = aColI.rgb;
  else if (uColorMode < 1.5) vCol = vec3(inten);
  else if (uColorMode < 2.5) vCol = aColI.rgb * (0.35 + 0.9 * inten);
  else if (uColorMode < 3.5) vCol = ramp(elev);
  else if (uColorMode < 4.5) vCol = normalize(vNrm + vec3(1e-6)) * 0.5 + 0.5;
  else if (uColorMode < 5.5) vCol = aSF < -1.0e17 ? vec3(0.32, 0.34, 0.36)
                                  : ramp((aSF - uSFMin) / max(uSFMax - uSFMin, 1e-9));
  else                       vCol = vec3(0.72, 0.75, 0.76);
  vCol *= uTint;
  // value filter: points outside the kept range dim, or vanish when hiding
  if (uSFHi > uSFLo) {
    bool inRange = aSF > -1.0e17 && aSF >= uSFLo && aSF <= uSFHi;
    if (!inRange) { if (uSFHide > 0.5) vDrop = 1.0; else vOut = 1.0; }
  }

  float projFactor = uOrthoMpp > 0.0 ? (1.0 / uOrthoMpp) : (0.5 * uScreenH) / (uSlope * max(-mv.z, 0.001));
  float px = (uSizeMode > 0.5) ? uPtSize * uSpacing * projFactor : uPtSize * 2.0;
  gl_PointSize = clamp(px, uMinPx, uMaxPx);
}`;

const FS = `#version 300 es
precision highp float;
uniform float uRound, uNormalShade, uBright, uGamma;
in vec3 vCol; in float vLogDepth; in vec3 vNrm; flat in float vDrop; flat in float vOut; flat in float vTint;
out vec4 frag;
void main(){
  if (vDrop > 0.5) discard;
  if (uRound > 0.5) { vec2 d = gl_PointCoord * 2.0 - 1.0; if (dot(d, d) > 1.0) discard; }
  vec3 c = vCol;
  if (uNormalShade > 0.5) {
    vec3 n = normalize(vNrm + vec3(1e-5));
    c *= mix(0.45, 1.25, n.z * 0.5 + 0.5);
  }
  c = pow(max(c * uBright, 0.0), vec3(1.0 / uGamma));
  if (vOut > 0.5) c = mix(c, vec3(0.06, 0.09, 0.11), 0.72);   // outside the keep set / inside a delete: dimmed
  else if (vTint > 0.5) c = mix(c, vec3(1.0, 0.55, 0.1), 0.55); // inside a pending suggestion: tinted
  frag = vec4(c, vLogDepth);
}`;

/** One leaf's previous normal bytes (3 per point), for the undo stack. */
export interface NormalsLeaf { leaf: Leaf; index: number; count: number; recs: Uint8Array }
export interface NormalsUndo { leaves: NormalsLeaf[]; bytes: number }

export interface UndoLeaf { leaf: Leaf; recs: Uint8Array; sf: Float32Array | null; mask: Uint8Array | null; count: number; capacity: number; bmin: THREE.Vector3; bmax: THREE.Vector3; spacing: number; index: number }
export interface UndoRecord { leaves: UndoLeaf[]; bytes: number; prevTotal: number; regions: Region[] }

export interface LeafMeta {
  origin: [number, number, number]; size: number;
  bmin: [number, number, number]; bmax: [number, number, number];
}

export class Leaf {
  vao: WebGLVertexArrayObject; vbo: WebGLBuffer;
  count: number; preview: boolean;
  capacity: number;                 // full point count (cloud leaves start partially loaded)
  fetching = false;
  origin: THREE.Vector3; size: number;
  center: THREE.Vector3; radius: number;
  bmin: THREE.Vector3; bmax: THREE.Vector3;
  spacing: number;
  // an optional per-point number, uploaded alongside the records
  sf: Float32Array | null = null;
  sfVbo: WebGLBuffer | null = null;
  // per-frame scratch
  desired = 0; draw = 0; dist = 0;
  tag = -1;
  constructor(gl: WebGL2RenderingContext, blocks: ArrayBuffer[], count: number, m: LeafMeta, preview: boolean, capacity = count) {
    this.count = count; this.preview = preview; this.capacity = Math.max(capacity, count);
    this.origin = new THREE.Vector3(...m.origin); this.size = m.size;
    const bmin = new THREE.Vector3(...m.bmin), bmax = new THREE.Vector3(...m.bmax);
    this.bmin = bmin; this.bmax = bmax;
    this.center = bmin.clone().add(bmax).multiplyScalar(0.5);
    this.radius = Math.max(bmax.distanceTo(bmin) * 0.5, 1e-3);
    // spacing: assume points lie on a surface spanning the largest face of the tight box
    const d = bmax.clone().sub(bmin);
    const area = Math.max(d.x * d.y, d.y * d.z, d.x * d.z, 1e-6);
    this.spacing = Math.min(Math.max(Math.sqrt(area / Math.max(this.capacity, 1)), 1e-4), m.size * 0.5);

    ({ vbo: this.vbo, vao: this.vao } = Leaf.alloc(gl, this.capacity, blocks));
  }
  private static alloc(gl: WebGL2RenderingContext, capacity: number, blocks: ArrayBufferView[] | ArrayBuffer[]) {
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, Math.max(capacity, 1) * REC, gl.STATIC_DRAW);
    let off = 0;
    for (const b of blocks) { const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength); gl.bufferSubData(gl.ARRAY_BUFFER, off, u); off += u.byteLength; }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, false, REC, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, REC, 6);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.BYTE, true, REC, 10);
    gl.disableVertexAttribArray(3); gl.vertexAttrib1f(3, SF_NONE);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { vbo, vao };
  }
  dispose(gl: WebGL2RenderingContext) {
    gl.deleteVertexArray(this.vao); gl.deleteBuffer(this.vbo);
    if (this.sfVbo) { gl.deleteBuffer(this.sfVbo); this.sfVbo = null; }
    this.sf = null; this.disposed = true;
  }

  /** Attach (or replace) this leaf's scalar values. Missing entries read as NaN and draw grey. */
  setScalar(gl: WebGL2RenderingContext, v: Float32Array | null) {
    if (!v) {
      if (this.sfVbo) { gl.deleteBuffer(this.sfVbo); this.sfVbo = null; }
      this.sf = null;
      gl.bindVertexArray(this.vao); gl.disableVertexAttribArray(3); gl.vertexAttrib1f(3, SF_NONE); gl.bindVertexArray(null);
      return;
    }
    this.sf = v;
    // the CPU copy keeps NaN for statistics; the GPU copy swaps it for a finite sentinel
    const gpu = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) gpu[i] = Number.isFinite(v[i]) ? v[i] : SF_NONE;
    if (!this.sfVbo) this.sfVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sfVbo);
    gl.bufferData(gl.ARRAY_BUFFER, gpu, gl.STATIC_DRAW);
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** Overwrite the record bytes in place, keeping count, bounds and any scalar values. */
  rewrite(gl: WebGL2RenderingContext, recs: Uint8Array) {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, recs.subarray(0, this.count * REC));
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
  disposed = false;

  /** Put a leaf back the way it was (undo): fresh buffers if it was disposed, original capacity, bounds and spacing. */
  restore(gl: WebGL2RenderingContext, recs: Uint8Array, count: number, capacity: number, bmin: THREE.Vector3, bmax: THREE.Vector3, spacing: number) {
    if (!this.disposed) { gl.deleteVertexArray(this.vao); gl.deleteBuffer(this.vbo); }
    ({ vbo: this.vbo, vao: this.vao } = Leaf.alloc(gl, Math.max(capacity, count), [recs.subarray(0, count * REC)]));
    this.disposed = false; this.fetching = false;
    this.count = count; this.capacity = Math.max(capacity, count);
    this.bmin.copy(bmin); this.bmax.copy(bmax); this.spacing = spacing;
    this.center.copy(bmin).add(bmax).multiplyScalar(0.5);
    this.radius = Math.max(bmax.distanceTo(bmin) * 0.5, 1e-3);
  }

  /** More records for a partially loaded (cloud) leaf. */
  append(gl: WebGL2RenderingContext, recs: Uint8Array, n: number) {
    const room = this.capacity - this.count;
    const take = Math.min(n, room);
    if (take <= 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, this.count * REC, recs.subarray(0, take * REC));
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.count += take;
    this.fetching = false;
  }

  /** Pull the records back out of the GPU. One-off operations only. */
  readback(gl: WebGL2RenderingContext): Uint8Array {
    const out = new Uint8Array(this.count * REC);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return out;
  }

  /** Replace contents with a filtered record set; recomputes tight bounds and spacing. */
  replace(gl: WebGL2RenderingContext, recs: Uint8Array, count: number) {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, recs.subarray(0, count * REC), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.count = count; this.capacity = count;
    let mn = [65535, 65535, 65535], mx = [0, 0, 0];
    const u16 = new Uint16Array(recs.buffer, recs.byteOffset, (count * REC) >> 1);
    for (let i = 0; i < count; i++) {
      const b = i * 7;
      for (let a = 0; a < 3; a++) { const q = u16[b + a]; if (q < mn[a]) mn[a] = q; if (q > mx[a]) mx[a] = q; }
    }
    const k = this.size / 65536;
    this.bmin.set(this.origin.x + mn[0] * k, this.origin.y + mn[1] * k, this.origin.z + mn[2] * k);
    this.bmax.set(this.origin.x + (mx[0] + 1) * k, this.origin.y + (mx[1] + 1) * k, this.origin.z + (mx[2] + 1) * k);
    this.center.copy(this.bmin).add(this.bmax).multiplyScalar(0.5);
    this.radius = Math.max(this.bmax.distanceTo(this.bmin) * 0.5, 1e-3);
    const d = this.bmax.clone().sub(this.bmin);
    const area = Math.max(d.x * d.y, d.y * d.z, d.x * d.z, 1e-6);
    this.spacing = Math.min(Math.max(Math.sqrt(area / Math.max(count, 1)), 1e-4), this.size * 0.5);
  }
}

export interface DrawParams {
  budget: number;        // max points this frame
  density: number;       // target points per screen pixel of projected leaf area
  ptSize: number; sizeMode: number; minPx: number; maxPx: number;
  colorMode: number; zMin: number; zMax: number; iMin: number; iMax: number;
  clipZMin: number; clipZMax: number;
  round: boolean; normalShade: boolean; bright: number; gamma: number;
  screenH: number; fovDeg: number;
  sfMin?: number; sfMax?: number; sfLo?: number; sfHi?: number; sfHide?: boolean;
  regions?: Region[]; regionHide?: boolean;
  /** Metres per pixel, when the camera's projection has been swapped for an orthographic one. */
  orthoMpp?: number;
  /** Colour multiplier for this entity. */
  tint?: [number, number, number];
}

export type RegionKind = 'box' | 'sphere' | 'slab' | 'prism';
export type RegionRole = 'keep' | 'pending' | 'delete';
/** Maximum outline vertices in one prism, and in all active prisms together. The shader holds
 *  them in one fixed uniform array, so these are its dimensions, not a style preference. */
export const PRISM_MAX_V = 24;
export const PRISM_POOL = 96;
export interface Region {
  id: string; kind: RegionKind; role: RegionRole;
  center: [number, number, number];
  half: [number, number, number];        // box half extents; slab and prism: half[2] = half depth
  radius: number;                        // sphere
  quat: [number, number, number, number]; // x y z w, region local -> world
  label?: string;
  /** prism: the drawn outline in the region's local XY plane, in metres, centred on its own
   *  centroid. Extruded along local Z to +/- half[2]. */
  poly?: [number, number][];
}
/** @deprecated use Region */
export type CropRegion = Region;

/** World -> region-local rotation as a column-major mat3 (inverse of quat). */
function invRot(q: [number, number, number, number]): Float32Array {
  const m = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]).invert()));
  return new Float32Array(m.elements);
}
function toLocal(p: THREE.Vector3, r: Region, inv: THREE.Matrix3, out: THREE.Vector3) {
  return out.set(p.x - r.center[0], p.y - r.center[1], p.z - r.center[2]).applyMatrix3(inv);
}
/** Even-odd crossing test, the same one the vertex shader runs. */
export function pointInPoly(x: number, y: number, poly: [number, number][]): boolean {
  let odd = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
}
function insideLocal(l: THREE.Vector3, r: Region): boolean {
  if (r.kind === 'prism') return Math.abs(l.z) <= r.half[2] && !!r.poly && pointInPoly(l.x, l.y, r.poly);
  if (r.kind === 'slab') return Math.abs(l.z) <= r.half[2];
  if (r.kind === 'sphere') return l.lengthSq() <= r.radius * r.radius;
  return Math.abs(l.x) <= r.half[0] && Math.abs(l.y) <= r.half[1] && Math.abs(l.z) <= r.half[2];
}
/** Bounding half extents of a prism's outline, for the gizmo and the cheap rejections. */
export function polyHalf(poly: [number, number][]): [number, number] {
  let x = 0, y = 0;
  for (const [px, py] of poly) { x = Math.max(x, Math.abs(px)); y = Math.max(y, Math.abs(py)); }
  return [Math.max(x, 1e-4), Math.max(y, 1e-4)];
}
/** Ramer-Douglas-Peucker that survives a closed ring.
 *
 *  The plain algorithm keeps the two endpoints and measures every other vertex against the
 *  line between them; on a ring those endpoints are the same point, that line has no length,
 *  and the whole outline collapses to one vertex. Cut it at the vertex furthest from the
 *  start and simplify the halves. */
export function simplifyRing(line: number[][], tol: number): number[][] {
  if (line.length < 3) return line;
  const closed = Math.hypot(line[0][0] - line[line.length - 1][0], line[0][1] - line[line.length - 1][1]) < tol * 1e-3 + 1e-9;
  if (closed && line.length > 4) {
    let far = 1, best = -1;
    for (let i = 1; i < line.length - 1; i++) {
      const d = Math.hypot(line[i][0] - line[0][0], line[i][1] - line[0][1]);
      if (d > best) { best = d; far = i; }
    }
    return rdp(line.slice(0, far + 1), tol).concat(rdp(line.slice(far), tol).slice(1));
  }
  return rdp(line, tol);
}
function rdp(line: number[][], tol: number): number[][] {
  if (line.length < 3) return line;
  const keep = new Uint8Array(line.length); keep[0] = 1; keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [x1, y1] = line[s], [x2, y2] = line[e];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-9;
    let worst = -1, at = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((line[i][0] - x1) * dy - (line[i][1] - y1) * dx) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol && at > 0) { keep[at] = 1; stack.push([s, at], [at, e]); }
  }
  return line.filter((_, i) => keep[i]);
}
const _pin = new THREE.Vector3(), _plin = new THREE.Vector3(), _cor = new THREE.Vector3();
const _ident = new THREE.Matrix4();
export function pointInRegion(p: [number, number, number] | THREE.Vector3, r: Region): boolean {
  const inv = new THREE.Matrix3().fromArray(Array.from(invRot(r.quat)));
  const pt = p instanceof THREE.Vector3 ? p : _pin.set(p[0], p[1], p[2]);
  return insideLocal(toLocal(pt, r, inv, _plin), r);
}
/** Conservative cell test: true = fully inside, false = fully outside, null = straddles. */
function classifyRegion(bmin: THREE.Vector3, bmax: THREE.Vector3, r: Region, inv: THREE.Matrix3): boolean | null {
  const c = new THREE.Vector3(), l = new THREE.Vector3();
  if (r.kind === 'prism' && r.poly) {
    // The cell's eight corners projected into the prism's frame: their 2D bounding box is a
    // superset of the cell's footprint, so a miss against the outline's bounding box is a
    // real miss, and a Z range clear of the depth is a real miss too.
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let allIn = true;
    for (let i = 0; i < 8; i++) {
      c.set(i & 1 ? bmax.x : bmin.x, i & 2 ? bmax.y : bmin.y, i & 4 ? bmax.z : bmin.z);
      toLocal(c, r, inv, l);
      x0 = Math.min(x0, l.x); x1 = Math.max(x1, l.x);
      y0 = Math.min(y0, l.y); y1 = Math.max(y1, l.y);
      z0 = Math.min(z0, l.z); z1 = Math.max(z1, l.z);
      if (allIn && !(Math.abs(l.z) <= r.half[2] && pointInPoly(l.x, l.y, r.poly))) allIn = false;
    }
    if (z1 < -r.half[2] || z0 > r.half[2]) return false;
    const [hx, hy] = polyHalf(r.poly);
    if (x1 < -hx || x0 > hx || y1 < -hy || y0 > hy) return false;
    return allIn ? true : null;
  }
  let allIn = true, anyIn = false;
  for (let i = 0; i < 8; i++) {
    c.set(i & 1 ? bmax.x : bmin.x, i & 2 ? bmax.y : bmin.y, i & 4 ? bmax.z : bmin.z);
    const inside = insideLocal(toLocal(c, r, inv, l), r);
    allIn = allIn && inside; anyIn = anyIn || inside;
  }
  if (allIn) return true;
  if (anyIn) return null;
  // no corner inside: the region could still poke through the cell. Bounding-sphere check.
  const cc = bmin.clone().add(bmax).multiplyScalar(0.5), rad = bmax.distanceTo(bmin) * 0.5;
  const lc = toLocal(cc, r, inv, l);
  const reach = r.kind === 'sphere' ? r.radius : r.kind === 'slab' ? r.half[2] : Math.hypot(r.half[0], r.half[1], r.half[2]);
  const dist = r.kind === 'slab' ? Math.abs(lc.z) : lc.length();
  return dist > reach + rad ? false : null;
}
/** Point kept iff (no keep regions or inside one) and not inside any delete region. */
function keepPoint(l: THREE.Vector3, p: THREE.Vector3, sets: { keep: { r: Region; inv: THREE.Matrix3 }[]; del: { r: Region; inv: THREE.Matrix3 }[] }): boolean {
  if (sets.keep.length) {
    let inK = false;
    for (const k of sets.keep) { if (insideLocal(toLocal(p, k.r, k.inv, l), k.r)) { inK = true; break; } }
    if (!inK) return false;
  }
  for (const d of sets.del) { if (insideLocal(toLocal(p, d.r, d.inv, l), d.r)) return false; }
  return true;
}

export interface DrawStats { leavesVisible: number; leavesDrawn: number; pointsDrawn: number; pointsTotal: number }

export class CellRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  leaves: Leaf[] = [];
  total = 0;
  private frustum = new THREE.Frustum();
  private vp = new THREE.Matrix4();
  private pending: { blocks: ArrayBuffer[]; count: number; meta: LeafMeta; preview: boolean; capacity?: number; tag?: number }[] = [];
  /** Leaves that would like more points than they have loaded (cloud streaming). */
  refine: { leaf: Leaf; want: number }[] = [];
  /** World AABB of the cloud **after** the model matrix. */
  bounds = new THREE.Box3();
  /** The cloud's transform. Points are never baked: this matrix is applied at render, test,
   *  export and analysis time, which makes a transform instant, lossless and undoable. */
  model = new THREE.Matrix4();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = this.compile(VS, FS);
    for (const n of ['uSFMin','uSFMax','uSFLo','uSFHi','uSFHide',
      'uVP','uView','uOrigin','uSize','uSpacing','uPtSize','uSizeMode','uColorMode','uZMin','uZMax',
                     'uIMin','uIMax','uScreenH','uSlope','uMinPx','uMaxPx','uClipZMin','uClipZMax',
                     'uRound','uNormalShade','uBright','uGamma','uRegN','uRegHide','uModel','uOrthoMpp','uTint']) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }
    for (let i = 0; i < 16; i++) for (const n of ['uRegMode', 'uRegRole', 'uRegC', 'uRegS', 'uRegRot']) {
      this.u[`${n}[${i}]`] = gl.getUniformLocation(this.prog, `${n}[${i}]`);
    }
    // set wholesale from the location of element 0
    for (const n of ['uPrismV', 'uPrismStart', 'uPrismCount']) this.u[n] = gl.getUniformLocation(this.prog, `${n}[0]`);
  }

  private compile(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const mk = (t: number, s: string) => {
      const sh = gl.createShader(t)!; gl.shaderSource(sh, s); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh));
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    return p;
  }

  /** Queue a leaf; uploads are spread across frames to avoid one long stall. */
  enqueue(blocks: ArrayBuffer[], count: number, meta: LeafMeta, preview = false, capacity?: number, tag?: number) {
    this.pending.push({ blocks, count, meta, preview, capacity, tag });
  }
  appendLeaf(tag: number, recs: Uint8Array, n: number) {
    const l = this.leaves.find(x => x.tag === tag);
    if (l) l.append(this.gl, recs, n);
  }
  get pendingCount() { return this.pending.length; }

  /** Upload up to `maxBytes` of queued leaves. Returns true if anything changed. */
  flushUploads(maxBytes = 48 * 1024 * 1024): boolean {
    let done = 0, changed = false;
    while (this.pending.length && done < maxBytes) {
      const p = this.pending.shift()!;
      const leaf = new Leaf(this.gl, p.blocks, p.count, p.meta, p.preview, p.capacity);
      leaf.tag = p.tag ?? -1;
      this.leaves.push(leaf);
      if (!p.preview) this.total += p.capacity ?? p.count;
      this.bounds.union(this.leafBox(leaf));
      done += p.count * REC; changed = true;
    }
    return changed;
  }

  dropPreview() {
    // Uploads are deferred to the next frame, so a preview can still be queued when the first
    // real leaf arrives — and on a small file every message lands before a frame runs, which
    // left the preview in the queue, uploaded after this call and drawn on top of the real
    // points for the rest of the session. Drop the queued ones too.
    this.pending = this.pending.filter(p => !p.preview);
    const keep: Leaf[] = [];
    for (const l of this.leaves) { if (l.preview) l.dispose(this.gl); else keep.push(l); }
    this.leaves = keep;
    this.recomputeBounds();
  }

  clear() {
    for (const l of this.leaves) l.dispose(this.gl);
    this.leaves = []; this.pending = []; this.total = 0; this.bounds.makeEmpty();
  }

  /** Replace the cloud's transform. Instant: only the derived bounds are recomputed. */
  setModel(m: THREE.Matrix4) { this.model.copy(m); this.recomputeBounds(); }
  /** The cloud's transform, as a copy. */
  worldMatrix() { return this.model.clone(); }
  /** Average linear scale the model applies — what point spacing and voxel sizes scale by. */
  get modelScale(): number {
    const e = this.model.elements;
    const a = Math.hypot(e[0], e[1], e[2]), b = Math.hypot(e[4], e[5], e[6]), c = Math.hypot(e[8], e[9], e[10]);
    return (a + b + c) / 3 || 1;
  }

  /** Per-leaf affine that turns a quantised record into a world position, so a point costs
   *  three multiply-adds instead of a matrix product. The leaf's quantisation and the
   *  cloud's model matrix fold into the same three columns. */
  private leafFold(lf: { origin: THREE.Vector3; size: number }) {
    const k = lf.size / 65536;
    const e = this.model.elements;    // column-major
    const bx = e[0] * lf.origin.x + e[4] * lf.origin.y + e[8] * lf.origin.z + e[12];
    const by = e[1] * lf.origin.x + e[5] * lf.origin.y + e[9] * lf.origin.z + e[13];
    const bz = e[2] * lf.origin.x + e[6] * lf.origin.y + e[10] * lf.origin.z + e[14];
    const ax = e[0] * k, ay = e[4] * k, az = e[8] * k;
    const bx2 = e[1] * k, by2 = e[5] * k, bz2 = e[9] * k;
    const cx = e[2] * k, cy = e[6] * k, cz = e[10] * k;
    return {
      at(qx: number, qy: number, qz: number, out: THREE.Vector3) {
        return out.set(bx + qx * ax + qy * ay + qz * az,
                       by + qx * bx2 + qy * by2 + qz * bz2,
                       bz + qx * cx + qy * cy + qz * cz);
      },
    };
  }
  /** Transformed AABB of a leaf's tight box: conservative, since a rotated box is larger
   *  than its own extent. Whole-cell region tests stay correct either way — a box that is
   *  too big only ever falls back to the per-point test. */
  leafBox(lf: Leaf, out = new THREE.Box3()): THREE.Box3 {
    out.makeEmpty();
    if (this.identity) { out.min.copy(lf.bmin); out.max.copy(lf.bmax); return out; }
    const v = _cor;
    for (let i = 0; i < 8; i++) {
      out.expandByPoint(v.set(i & 1 ? lf.bmax.x : lf.bmin.x, i & 2 ? lf.bmax.y : lf.bmin.y, i & 4 ? lf.bmax.z : lf.bmin.z).applyMatrix4(this.model));
    }
    return out;
  }
  private get identity() { return _ident.equals(this.model); }
  /** Decode `count` records of `leaf` into world-space double triples. `leaf` only has to
   *  carry its cube, so the structural leaf `records()` yields is accepted too. */
  transformRecordsInto(recs: Uint8Array, count: number, leaf: { origin: THREE.Vector3; size: number }, out: Float64Array): Float64Array {
    const u16 = new Uint16Array(recs.buffer, recs.byteOffset, (count * REC) >> 1);
    const fold = this.leafFold(leaf);
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const b = i * 7;
      fold.at(u16[b], u16[b + 1], u16[b + 2], p);
      out[i * 3] = p.x; out[i * 3 + 1] = p.y; out[i * 3 + 2] = p.z;
    }
    return out;
  }

  private sets(regions: Region[]) {
    const mk = (r: Region) => ({ r, inv: new THREE.Matrix3().fromArray(Array.from(invRot(r.quat))) });
    return { keep: regions.filter(r => r.role === 'keep').map(mk), del: regions.filter(r => r.role === 'delete').map(mk) };
  }

  /** Rough kept-point estimate for confirmation dialogs: whole cells count fully, straddling cells half. */
  estimateKept(regions: Region[]): number {
    const sets = this.sets(regions);
    if (!sets.keep.length && !sets.del.length) return this.total;
    let n = 0;
    for (const l of this.leaves) {
      if (l.preview) continue;
      const box = this.leafBox(l);
      let keepCls: boolean | null = sets.keep.length ? false : true;
      for (const k of sets.keep) { const c = classifyRegion(box.min, box.max, k.r, k.inv); if (c === true) { keepCls = true; break; } if (c === null) keepCls = null; }
      let delCls: boolean | null = false;
      for (const d of sets.del) { const c = classifyRegion(box.min, box.max, d.r, d.inv); if (c === true) { delCls = true; break; } if (c === null) delCls = null; }
      if (keepCls === false || delCls === true) continue;
      n += (keepCls === true && delCls === false) ? l.count : l.count * 0.5;
    }
    return Math.round(n);
  }

  /** Drop every point outside the keep set or inside a delete region. Returns { kept, dropped } and,
   *  when `record` is set, everything needed to put the points back: per changed leaf the dropped
   *  records in their original order plus a bit mask (1 = dropped) over the original record order,
   *  so undo re-interleaves exactly and the shuffled LOD prefix stays uniform. */
  /** Attach one scalar per point, leaf by leaf in the order `records()` yields them.
   *  The low-resolution preview leaves are dropped first: they are a loading aid with no
   *  correspondence to the analysed points, and drawing them over the result would paint
   *  the whole cloud in the "no value" grey. */
  setScalarField(per: (Float32Array | null)[]) {
    this.dropPreview();
    let i = 0;
    for (const l of this.leaves) {
      if (l.preview) continue;
      l.setScalar(this.gl, per[i] ?? null);
      i++;
    }
  }
  clearScalarField() {
    for (const l of this.leaves) if (!l.preview) l.setScalar(this.gl, null);
  }
  get hasScalarField() { return this.leaves.some(l => !l.preview && !!l.sf); }
  /** The leaves a mask must line up with, in the same order as `records()`. */
  leavesForMask(): Leaf[] { return this.leaves.filter(l => !l.preview); }
  get gl2() { return this.gl; }

  /** Range and distribution of the current field, for the ramp and the histogram. */
  scalarStats(bins = 128): { min: number; max: number; hist: Uint32Array; n: number } | null {
    let min = Infinity, max = -Infinity, n = 0;
    for (const l of this.leaves) {
      if (l.preview || !l.sf) continue;
      for (let i = 0; i < l.count; i++) {
        const v = l.sf[i];
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v; if (v > max) max = v; n++;
      }
    }
    if (!n) return null;
    const hist = new Uint32Array(bins);
    const span = Math.max(max - min, 1e-12);
    for (const l of this.leaves) {
      if (l.preview || !l.sf) continue;
      for (let i = 0; i < l.count; i++) {
        const v = l.sf[i];
        if (!Number.isFinite(v)) continue;
        hist[Math.min(bins - 1, Math.max(0, Math.floor((v - min) / span * bins)))]++;
      }
    }
    return { min, max, hist, n };
  }

  /** Write computed normals (3 signed bytes per point, in `records()` order) into every
   *  leaf's records in place, and hand back the bytes that were there so the change undoes
   *  like any other edit. */
  writeNormals(nrm: Int8Array): NormalsUndo {
    const leaves: NormalsLeaf[] = [];
    let at = 0, bytes = 0;
    this.leaves.forEach((lf, index) => {
      if (lf.preview) return;
      const recs = lf.readback(this.gl);
      const prev = new Uint8Array(lf.count * 3);
      for (let i = 0; i < lf.count; i++) {
        const o = i * REC, q = (at + i) * 3;
        prev[i * 3] = recs[o + 10]; prev[i * 3 + 1] = recs[o + 11]; prev[i * 3 + 2] = recs[o + 12];
        recs[o + 10] = nrm[q] & 0xff; recs[o + 11] = nrm[q + 1] & 0xff; recs[o + 12] = nrm[q + 2] & 0xff;
      }
      lf.rewrite(this.gl, recs);
      leaves.push({ leaf: lf, index, count: lf.count, recs: prev });
      bytes += prev.byteLength;
      at += lf.count;
    });
    return { leaves, bytes };
  }

  /** Put stored normal bytes back, keeping what was replaced in their place. Undo and redo
   *  of a normals change are the same operation run twice. `fetch` supplies entry i's bytes
   *  from RAM or the spill file. */
  async swapNormals(rec: NormalsUndo, fetch: (i: number) => Promise<Uint8Array> | Uint8Array) {
    for (let i = 0; i < rec.leaves.length; i++) {
      const e = rec.leaves[i];
      const want = await fetch(i);
      if (e.leaf.disposed) { e.recs = want.slice(); continue; }
      const recs = e.leaf.readback(this.gl);
      const n = Math.min(e.leaf.count, e.count);
      const prev = new Uint8Array(n * 3);
      for (let j = 0; j < n; j++) {
        const o = j * REC;
        prev[j * 3] = recs[o + 10]; prev[j * 3 + 1] = recs[o + 11]; prev[j * 3 + 2] = recs[o + 12];
        recs[o + 10] = want[j * 3]; recs[o + 11] = want[j * 3 + 1]; recs[o + 12] = want[j * 3 + 2];
      }
      e.leaf.rewrite(this.gl, recs);
      e.recs = prev;
    }
    rec.bytes = rec.leaves.reduce((b, l) => b + l.recs.byteLength, 0);
  }

  /** Drop points by an explicit per-leaf keep mask (1 keep, 0 drop), undoably.
   *  Same bookkeeping as applyRegions, but the decision comes from outside. */
  applyMask(maskFor: (leaf: Leaf, i: number) => Uint8Array | null, record = false): { kept: number; dropped: number; undo: UndoRecord | null } {
    const gl = this.gl;
    const keep: Leaf[] = [];
    const undo: UndoRecord | null = record ? { leaves: [], bytes: 0, prevTotal: this.total, regions: [] } : null;
    let kept = 0, dropped = 0, li = 0;
    this.leaves.forEach((lf, index) => {
      if (lf.preview) { lf.dispose(gl); return; }
      const m = maskFor(lf, li++);
      if (!m) { keep.push(lf); kept += lf.count; return; }
      let n = 0;
      for (let i = 0; i < lf.count; i++) if (m[i]) n++;
      if (n === lf.count) { keep.push(lf); kept += lf.count; return; }
      const src = lf.readback(gl);
      const bits = new Uint8Array((lf.count + 7) >> 3);
      const dst = new Uint8Array(src.length);
      const gone = lf.count - n;
      const out = new Uint8Array(gone * REC);
      let a = 0, b = 0;
      const keptSf = lf.sf ? new Float32Array(n) : null;
      const goneSf = lf.sf ? new Float32Array(gone) : null;
      for (let i = 0; i < lf.count; i++) {
        if (m[i]) {
          dst.set(src.subarray(i * REC, i * REC + REC), a * REC);
          if (keptSf) keptSf[a] = lf.sf![i];
          a++;
        } else {
          bits[i >> 3] |= 1 << (i & 7);
          out.set(src.subarray(i * REC, i * REC + REC), b * REC);
          if (goneSf) goneSf[b] = lf.sf![i];
          b++;
        }
      }
      dropped += gone;
      if (undo) {
        undo.leaves.push({
          leaf: lf, recs: n === 0 ? src : out, sf: n === 0 ? (lf.sf ? lf.sf.slice(0, lf.count) : null) : goneSf,
          mask: n === 0 ? null : bits, count: lf.count, capacity: lf.capacity,
          bmin: lf.bmin.clone(), bmax: lf.bmax.clone(), spacing: lf.spacing, index,
        });
        undo.bytes += (n === 0 ? src.byteLength : out.byteLength) + bits.byteLength + (goneSf?.byteLength ?? 0);
      }
      if (n === 0) { lf.dispose(gl); return; }
      lf.replace(gl, dst, n);
      if (keptSf) lf.setScalar(gl, keptSf);
      keep.push(lf); kept += n;
    });
    this.leaves = keep;
    this.total = kept;
    this.recomputeBounds();
    return { kept, dropped, undo };
  }

  applyRegions(regions: Region[], record = false): { kept: number; dropped: number; undo: UndoRecord | null } {
    const gl = this.gl;
    const sets = this.sets(regions);
    if (!sets.keep.length && !sets.del.length) return { kept: this.total, dropped: 0, undo: null };
    const keep: Leaf[] = [];
    const undo: UndoRecord | null = record ? {
      leaves: [], bytes: 0, prevTotal: this.total,
      regions: regions.map(r => ({ id: r.id, kind: r.kind, role: r.role, center: [...r.center] as [number, number, number], half: [...r.half] as [number, number, number], radius: r.radius, quat: [...r.quat] as [number, number, number, number], label: r.label })),
    } : null;
    let kept = 0, dropped = 0;
    const p = new THREE.Vector3(), l = new THREE.Vector3();
    const snap = (lf: Leaf, index: number, recs: Uint8Array, mask: Uint8Array | null, sf: Float32Array | null = null) => {
      if (!undo) return;
      undo.leaves.push({ leaf: lf, recs, sf, mask, count: lf.count, capacity: lf.capacity, bmin: lf.bmin.clone(), bmax: lf.bmax.clone(), spacing: lf.spacing, index });
      undo.bytes += recs.byteLength + (mask?.byteLength ?? 0) + (sf?.byteLength ?? 0);
    };
    this.leaves.forEach((lf, index) => {
      if (lf.preview) { lf.dispose(gl); return; }
      const box = this.leafBox(lf);
      let keepCls: boolean | null = sets.keep.length ? false : true;
      for (const k of sets.keep) { const c = classifyRegion(box.min, box.max, k.r, k.inv); if (c === true) { keepCls = true; break; } if (c === null) keepCls = null; }
      let delCls: boolean | null = false;
      for (const d of sets.del) { const c = classifyRegion(box.min, box.max, d.r, d.inv); if (c === true) { delCls = true; break; } if (c === null) delCls = null; }
      if (keepCls === false || delCls === true) { dropped += lf.count; if (undo) snap(lf, index, lf.readback(gl), null, lf.sf ? lf.sf.slice(0, lf.count) : null); lf.dispose(gl); return; }
      if (keepCls === true && delCls === false) { keep.push(lf); kept += lf.count; return; }
      const src = lf.readback(gl);
      const u16 = new Uint16Array(src.buffer, 0, (lf.count * REC) >> 1);
      const dst = new Uint8Array(src.length);
      // One keep/drop decision per point, taken once and then used by the record
      // compaction, the scalar compaction and (when recording) the undo bit mask. It has to
      // exist whether or not we are recording: deriving the scalar order from an undo-only
      // mask silently mis-ordered every value when `record` was false.
      const mask = new Uint8Array((lf.count + 7) >> 3);
      const fold = this.leafFold(lf);
      let n = 0;
      for (let i = 0; i < lf.count; i++) {
        const b = i * 7;
        fold.at(u16[b], u16[b + 1], u16[b + 2], p);
        if (keepPoint(l, p, sets)) { dst.set(src.subarray(i * REC, i * REC + REC), n * REC); n++; }
        else mask[i >> 3] |= 1 << (i & 7);
      }
      const gone = lf.count - n;
      dropped += gone;
      // a scalar field rides along: the kept values keep their points, the dropped ones
      // are stored so undo can put both back together in the original order
      let keptSf: Float32Array | null = null, goneSf: Float32Array | null = null;
      if (lf.sf) {
        keptSf = new Float32Array(n); goneSf = new Float32Array(gone);
        let a = 0, b = 0;
        for (let i = 0; i < lf.count; i++) {
          if (mask[i >> 3] & (1 << (i & 7))) goneSf[b++] = lf.sf[i];
          else keptSf[a++] = lf.sf[i];
        }
      }
      if (undo && gone) {
        // dropped records in original order, compacted into their own buffer
        const out = new Uint8Array(gone * REC); let o = 0;
        for (let i = 0; i < lf.count; i++) if (mask[i >> 3] & (1 << (i & 7))) { out.set(src.subarray(i * REC, i * REC + REC), o); o += REC; }
        snap(lf, index, out, n === 0 ? null : mask, n === 0 ? (lf.sf ? lf.sf.slice(0, lf.count) : null) : goneSf);
        if (n === 0) undo.leaves[undo.leaves.length - 1].recs = src;   // whole leaf went: keep it verbatim
      }
      if (n === 0) { lf.dispose(gl); return; }
      lf.replace(gl, dst, n);
      if (keptSf) lf.setScalar(gl, keptSf);
      keep.push(lf); kept += n;
    });
    this.leaves = keep;
    this.total = kept;
    this.recomputeBounds();
    return { kept, dropped, undo };
  }
  private recomputeBounds() {
    this.bounds.makeEmpty();
    const b = new THREE.Box3();
    for (const lf of this.leaves) this.bounds.union(this.leafBox(lf, b));
  }

  /** Put every leaf of an undo record back. `fetch(i)` supplies the dropped records of entry i (RAM or disk). */
  async undoApply(rec: UndoRecord, fetch: (i: number) => Promise<Uint8Array> | Uint8Array): Promise<number> {
    const gl = this.gl;
    const order = rec.leaves.map((e, i) => i).sort((a, b) => rec.leaves[a].index - rec.leaves[b].index);
    for (const i of order) {
      const e = rec.leaves[i];
      const gone = await fetch(i);
      let full: Uint8Array;
      if (!e.mask) full = gone;
      else {
        const cur = e.leaf.disposed ? new Uint8Array(0) : e.leaf.readback(gl);
        full = new Uint8Array(e.count * REC);
        let a = 0, b = 0;
        for (let j = 0; j < e.count; j++) {
          if (e.mask[j >> 3] & (1 << (j & 7))) { full.set(gone.subarray(b, b + REC), j * REC); b += REC; }
          else { full.set(cur.subarray(a, a + REC), j * REC); a += REC; }
        }
      }
      let fullSf: Float32Array | null = null;
      if (e.sf) {
        if (!e.mask) fullSf = e.sf;
        else {
          const cur = e.leaf.sf;
          fullSf = new Float32Array(e.count);
          let a = 0, b = 0;
          for (let j = 0; j < e.count; j++) {
            if (e.mask[j >> 3] & (1 << (j & 7))) fullSf[j] = e.sf[b++];
            else fullSf[j] = cur ? cur[a++] : NaN;
          }
        }
      }
      e.leaf.restore(gl, full, e.count, e.capacity, e.bmin, e.bmax, e.spacing);
      e.leaf.setScalar(gl, fullSf);
      if (!this.leaves.includes(e.leaf)) this.leaves.splice(Math.min(e.index, this.leaves.length), 0, e.leaf);
    }
    this.total = this.leaves.reduce((n, l) => n + (l.preview ? 0 : l.count), 0);
    this.recomputeBounds();
    return this.total;
  }

  /** Apply an undone record again using its masks (no re-classification). Refills `recs` so the record can be undone once more.
   *  Cloud leaves may have grown past `e.count` after undo; extras are classified with the stored regions. */
  redoApply(rec: UndoRecord): { kept: number; dropped: number } {
    const gl = this.gl;
    let dropped = 0; rec.bytes = 0;
    const sets = rec.regions?.length ? this.sets(rec.regions) : null;
    const p = new THREE.Vector3(), loc = new THREE.Vector3();
    for (const e of rec.leaves) {
      const src = e.leaf.readback(gl);
      if (e.leaf.count === e.count) {
        if (!e.mask) { e.recs = src; e.sf = e.leaf.sf ? e.leaf.sf.slice(0, e.leaf.count) : null; dropped += e.leaf.count; e.leaf.dispose(gl); const i = this.leaves.indexOf(e.leaf); if (i >= 0) this.leaves.splice(i, 1); }
        else {
          const dst = new Uint8Array(src.length); let n = 0, gone = 0;
          for (let j = 0; j < e.count; j++) if (e.mask[j >> 3] & (1 << (j & 7))) gone++;
          const out = new Uint8Array(gone * REC); let o = 0;
          for (let j = 0; j < e.count; j++) {
            const r = src.subarray(j * REC, j * REC + REC);
            if (e.mask[j >> 3] & (1 << (j & 7))) { out.set(r, o); o += REC; } else { dst.set(r, n * REC); n++; }
          }
          e.recs = out; dropped += gone; e.leaf.replace(gl, dst, n);
        }
      } else {
        const nCur = e.leaf.count;
        const mask = new Uint8Array((nCur + 7) >> 3);
        if (!e.mask) { for (let j = 0; j < e.count; j++) mask[j >> 3] |= 1 << (j & 7); }
        else { for (let j = 0; j < e.count; j++) if (e.mask[j >> 3] & (1 << (j & 7))) mask[j >> 3] |= 1 << (j & 7); }
        if (sets) {
          const u16 = new Uint16Array(src.buffer, src.byteOffset, (nCur * REC) >> 1);
          const fold = this.leafFold(e.leaf);
          for (let j = e.count; j < nCur; j++) {
            const b = j * 7;
            fold.at(u16[b], u16[b + 1], u16[b + 2], p);
            if (!keepPoint(loc, p, sets)) mask[j >> 3] |= 1 << (j & 7);
          }
        }
        let gone = 0, n = 0;
        for (let j = 0; j < nCur; j++) if (mask[j >> 3] & (1 << (j & 7))) gone++;
        const out = new Uint8Array(gone * REC); let o = 0;
        const dst = new Uint8Array(nCur * REC);
        for (let j = 0; j < nCur; j++) {
          const r = src.subarray(j * REC, j * REC + REC);
          if (mask[j >> 3] & (1 << (j & 7))) { out.set(r, o); o += REC; } else { dst.set(r, n * REC); n++; }
        }
        e.count = nCur;
        e.mask = n === 0 ? null : mask;
        e.recs = n === 0 ? src : out;
        dropped += gone;
        if (n === 0) { e.leaf.dispose(gl); const i = this.leaves.indexOf(e.leaf); if (i >= 0) this.leaves.splice(i, 1); }
        else e.leaf.replace(gl, dst, n);
      }
      rec.bytes += e.recs.byteLength + (e.mask?.byteLength ?? 0);
    }
    this.total = this.leaves.reduce((n, l) => n + (l.preview ? 0 : l.count), 0);
    this.recomputeBounds();
    return { kept: this.total, dropped };
  }

  /** Points inside a region from cell classification alone: no readback, so it is safe to call
   *  while a gizmo is being dragged. Whole cells count fully, straddling cells half. */
  estimateInside(r: Region): number {
    const inv = new THREE.Matrix3().fromArray(Array.from(invRot(r.quat)));
    const b = new THREE.Box3();
    let n = 0;
    for (const lf of this.leaves) {
      if (lf.preview) continue;
      const box = this.leafBox(lf, b);
      const c = classifyRegion(box.min, box.max, r, inv);
      if (c === false) continue;
      n += c === true ? lf.count : lf.count * 0.5;
    }
    return Math.round(n);
  }

  /** Points inside a region (any role) counted from a sample of cells — for suggestion sizing. */
  countInside(r: Region, sampleEvery = 16): number {
    const inv = new THREE.Matrix3().fromArray(Array.from(invRot(r.quat)));
    const p = new THREE.Vector3(), l = new THREE.Vector3();
    let n = 0;
    for (const lf of this.leaves) {
      if (lf.preview) continue;
      const box = this.leafBox(lf);
      const c = classifyRegion(box.min, box.max, r, inv);
      if (c === false) continue;
      if (c === true) { n += lf.count; continue; }
      const src = lf.readback(this.gl);
      const u16 = new Uint16Array(src.buffer, 0, (lf.count * REC) >> 1);
      const fold = this.leafFold(lf);
      let m = 0;
      for (let i = 0; i < lf.count; i += sampleEvery) {
        const b = i * 7; fold.at(u16[b], u16[b + 1], u16[b + 2], p);
        if (insideLocal(toLocal(p, r, inv, l), r)) m++;
      }
      n += m * sampleEvery;
    }
    return n;
  }

  /** Exact count and world bounding box of the points inside a region. Whole cells are
   *  counted without being read back; only the cells the region cuts through are. */
  insideExact(r: Region): { count: number; min: number[] | null; max: number[] | null } {
    const inv = new THREE.Matrix3().fromArray(Array.from(invRot(r.quat)));
    const p = new THREE.Vector3(), l = new THREE.Vector3(), box = new THREE.Box3();
    const b = new THREE.Box3();
    let n = 0;
    for (const lf of this.leaves) {
      if (lf.preview || !lf.count) continue;
      const lb = this.leafBox(lf, b);
      const c = classifyRegion(lb.min, lb.max, r, inv);
      if (c === false) continue;
      const src = lf.readback(this.gl);
      const u16 = new Uint16Array(src.buffer, src.byteOffset, (lf.count * REC) >> 1);
      const fold = this.leafFold(lf);
      for (let i = 0; i < lf.count; i++) {
        const q = i * 7;
        fold.at(u16[q], u16[q + 1], u16[q + 2], p);
        if (c !== true && !insideLocal(toLocal(p, r, inv, l), r)) continue;
        n++; box.expandByPoint(p);
      }
    }
    return { count: n, min: box.isEmpty() ? null : box.min.toArray(), max: box.isEmpty() ? null : box.max.toArray() };
  }

  /** A uniform sample: the first `perLeaf` records of each leaf (they are shuffled). */
  *sample(perLeaf: number | ((l: Leaf) => number) = 1500): Generator<{ leaf: Leaf; recs: Uint8Array; n: number }> {
    const gl = this.gl;
    for (const l of this.leaves) {
      if (l.preview || !l.count) continue;
      const n = Math.max(0, Math.min(l.count, typeof perLeaf === 'function' ? perLeaf(l) : perLeaf)); if (!n) continue;
      const out = new Uint8Array(n * REC);
      gl.bindBuffer(gl.ARRAY_BUFFER, l.vbo); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      yield { leaf: l, recs: out, n };
    }
  }

  /** Height range of sampled points inside an XY rectangle, or null. */
  zRangeIn(x0: number, y0: number, x1: number, y1: number): [number, number] | null {
    let lo = Infinity, hi = -Infinity;
    for (const { leaf, recs, n } of this.sample(2000)) {
      if (leaf.bmax.x < x0 || leaf.bmin.x > x1 || leaf.bmax.y < y0 || leaf.bmin.y > y1) continue;
      const u16 = new Uint16Array(recs.buffer, recs.byteOffset, (n * REC) >> 1);
      const k = leaf.size / 65536;
      for (let i = 0; i < n; i++) {
        const q = i * 7;
        const x = leaf.origin.x + u16[q] * k, y = leaf.origin.y + u16[q + 1] * k;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const z = leaf.origin.z + u16[q + 2] * k;
        if (z < lo) lo = z; if (z > hi) hi = z;
      }
    }
    return isFinite(lo) ? [lo, hi] : null;
  }

  /** Iterate every leaf's records (readback), for export and caching. */
  *records(): Generator<{ leaf: { count: number; origin: THREE.Vector3; size: number; bmin: THREE.Vector3; bmax: THREE.Vector3 }; recs: Uint8Array }> {
    for (const l of this.leaves) { if (l.preview) continue; yield { leaf: l, recs: l.readback(this.gl) }; }
  }
  get leafCount() { return this.leaves.filter(l => !l.preview).length; }
  /** Median of the per-cell point spacing estimates — the natural scale of this scan,
   *  in the frame it is drawn in, so a scaled cloud reports a scaled spacing. */
  get medianSpacing(): number {
    const s = this.leaves.filter(l => !l.preview && l.count > 64).map(l => l.spacing).sort((a, b) => a - b);
    return (s.length ? s[s.length >> 1] : 0.05) * this.modelScale;
  }

  /** Cull, budget, draw. Assumes the target framebuffer and viewport are already bound. */
  draw(camera: THREE.PerspectiveCamera, p: DrawParams): DrawStats {
    const gl = this.gl;
    const stats: DrawStats = { leavesVisible: 0, leavesDrawn: 0, pointsDrawn: 0, pointsTotal: this.total };
    if (!this.leaves.length) return stats;

    this.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.vp);
    const slope = Math.tan((p.fovDeg * Math.PI / 180) / 2);
    const mpp = p.orthoMpp ?? 0;
    const camPos = camera.position;
    const near = camera.near;

    // ---- LOD: desired points per leaf from projected area ----
    const vis: Leaf[] = [];
    let want = 0;
    const sph = new THREE.Sphere();
    const scale = this.modelScale;
    for (const l of this.leaves) {
      // the leaf's bounding sphere seen through the model: centre transformed, radius scaled
      sph.center.copy(l.center).applyMatrix4(this.model); sph.radius = l.radius * scale;
      if (!this.frustum.intersectsSphere(sph)) continue;
      const d = Math.max(camPos.distanceTo(sph.center) - sph.radius, near);
      l.dist = d;
      const rpx = mpp > 0 ? sph.radius / mpp : sph.radius * (0.5 * p.screenH) / (slope * d);
      const area = Math.PI * rpx * rpx;
      l.desired = Math.min(l.capacity, Math.ceil(p.density * area));
      want += l.desired;
      vis.push(l);
    }
    this.refine = [];
    stats.leavesVisible = vis.length;
    vis.sort((a, b) => a.dist - b.dist);       // front to back: early-z, and priority

    if (want <= p.budget) {
      // headroom: spend it proportionally, two passes so capped leaves hand
      // their surplus to the others
      const scale = want > 0 ? p.budget / want : 1;
      let capped = 0, uncapped = 0;
      for (const l of vis) { const d = l.desired * scale; if (d >= l.count) capped += l.count; else uncapped += d; }
      const s2 = uncapped > 0 ? Math.max(1, (p.budget - capped) / (uncapped / scale)) : scale;
      for (const l of vis) l.draw = Math.min(l.count, Math.floor(l.desired * (l.desired * scale >= l.count ? scale : s2)));
    } else {
      // over budget: every leaf keeps a floor so the background never vanishes,
      // then the nearest leaves are filled to their full desire first. That keeps
      // the wall you are standing next to solid instead of thinning everything
      // uniformly and showing the room behind through the gaps.
      const floorFrac = 0.12;
      let used = 0;
      for (const l of vis) { l.draw = Math.min(l.count, Math.ceil(l.desired * floorFrac)); used += l.draw; }
      let left = p.budget - used;
      for (const l of vis) {
        if (left <= 0) break;
        const extra = Math.min(l.desired - l.draw, left);
        if (extra > 0) { l.draw += extra; left -= extra; }
      }
    }

    // ---- state ----
    gl.useProgram(this.prog);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.uniformMatrix4fv(this.u.uVP, false, this.vp.elements);
    gl.uniformMatrix4fv(this.u.uView, false, camera.matrixWorldInverse.elements);
    gl.uniformMatrix4fv(this.u.uModel, false, this.model.elements);
    gl.uniform1f(this.u.uPtSize, p.ptSize); gl.uniform1f(this.u.uSizeMode, p.sizeMode);
    gl.uniform1f(this.u.uColorMode, p.colorMode);
    gl.uniform1f(this.u.uSFMin, p.sfMin ?? 0); gl.uniform1f(this.u.uSFMax, p.sfMax ?? 1);
    gl.uniform1f(this.u.uSFLo, p.sfLo ?? 0); gl.uniform1f(this.u.uSFHi, p.sfHi ?? -1);
    gl.uniform1f(this.u.uSFHide, p.sfHide ? 1 : 0);
    gl.uniform1f(this.u.uZMin, p.zMin); gl.uniform1f(this.u.uZMax, p.zMax);
    gl.uniform1f(this.u.uIMin, p.iMin); gl.uniform1f(this.u.uIMax, p.iMax);
    gl.uniform1f(this.u.uScreenH, p.screenH); gl.uniform1f(this.u.uSlope, slope);
    gl.uniform1f(this.u.uOrthoMpp, mpp);
    const tint = p.tint ?? [1, 1, 1];
    gl.uniform3f(this.u.uTint, tint[0], tint[1], tint[2]);
    gl.uniform1f(this.u.uMinPx, p.minPx); gl.uniform1f(this.u.uMaxPx, p.maxPx);
    gl.uniform1f(this.u.uClipZMin, p.clipZMin); gl.uniform1f(this.u.uClipZMax, p.clipZMax);
    gl.uniform1f(this.u.uRound, p.round ? 1 : 0); gl.uniform1f(this.u.uNormalShade, p.normalShade ? 1 : 0);
    gl.uniform1f(this.u.uBright, p.bright); gl.uniform1f(this.u.uGamma, p.gamma);
    const regs = (p.regions ?? []).slice(0, 16);
    gl.uniform1f(this.u.uRegN, regs.length);
    gl.uniform1f(this.u.uRegHide, p.regionHide ? 1 : 0);
    // pack every prism's outline into the shared pool; a prism that will not fit is skipped
    const pv = new Float32Array(PRISM_POOL * 2);
    const pStart = new Float32Array(16), pCount = new Float32Array(16);
    let at = 0;
    regs.forEach((r, i) => {
      if (r.kind !== 'prism' || !r.poly?.length) return;
      const n = Math.min(r.poly.length, PRISM_MAX_V);
      if (at + n > PRISM_POOL) return;
      pStart[i] = at; pCount[i] = n;
      for (let k = 0; k < n; k++) { pv[(at + k) * 2] = r.poly[k][0]; pv[(at + k) * 2 + 1] = r.poly[k][1]; }
      at += n;
    });
    gl.uniform2fv(this.u.uPrismV, pv);
    gl.uniform1fv(this.u.uPrismStart, pStart);
    gl.uniform1fv(this.u.uPrismCount, pCount);
    regs.forEach((r, i) => {
      gl.uniform1f(this.u[`uRegMode[${i}]`], r.kind === 'prism' ? 4 : r.kind === 'slab' ? 3 : r.kind === 'sphere' ? 2 : 1);
      gl.uniform1f(this.u[`uRegRole[${i}]`], r.role === 'keep' ? 0 : r.role === 'pending' ? 1 : 2);
      gl.uniform3f(this.u[`uRegC[${i}]`], r.center[0], r.center[1], r.center[2]);
      gl.uniform3f(this.u[`uRegS[${i}]`], r.kind === 'sphere' ? r.radius : r.half[0], r.half[1], r.half[2]);
      gl.uniformMatrix3fv(this.u[`uRegRot[${i}]`], false, invRot(r.quat));
    });

    for (const l of vis) {
      if (l.draw > l.count && l.count < l.capacity && !l.fetching) this.refine.push({ leaf: l, want: Math.min(l.capacity, Math.ceil(l.draw * 1.5)) });
      const n = Math.min(l.draw, l.count);
      if (n < 1) continue;
      // fewer points drawn => each must cover more ground
      const eff = l.spacing * scale * Math.sqrt(l.capacity / n);
      gl.uniform3f(this.u.uOrigin, l.origin.x, l.origin.y, l.origin.z);
      gl.uniform1f(this.u.uSize, l.size);
      gl.uniform1f(this.u.uSpacing, eff);
      gl.bindVertexArray(l.vao);
      gl.drawArrays(gl.POINTS, 0, n);
      stats.pointsDrawn += n; stats.leavesDrawn++;
    }
    gl.bindVertexArray(null);
    return stats;
  }
}
