// AI cleaning: find vegetation / vehicles / noise and propose removals as regions
// the user confirms one by one. Two routes:
//  - heuristic: runs here, on a uniform sample of the cloud (no network, no keys)
//  - openai / xai: a hybrid. The heuristic finds candidate clumps from the data;
//    a clean top-down render with a metre grid and the numbered candidates plus an
//    oblique view go to the model (through the Cloud Function that holds the keys,
//    or directly with a key you paste). The model confirms or rejects each
//    candidate, may add boxes of its own (which are then snapped to the data), and
//    may propose height sections. Geometry always comes from the points, so boxes
//    stay tight; the model only supplies judgement.
import * as THREE from 'three';
import type { Viewer } from './viewer';
import type { Region } from './cells';
import { REC } from './cells';
import { parseResponse, requestBody, type AiCandidateCtx, type AiParsed } from '../shared/aiprompt.mjs';

export interface AiFrame { originX: number; originY: number; extentX: number; extentY: number; zMin: number; zMax: number; width: number; height: number }
export interface AiResult extends AiParsed { via: string; model: string; ms: number }
export interface AiImage { name: string; dataUrl: string; detail?: 'high' | 'low' }
export interface AiPrep { images: AiImage[]; frame: AiFrame; candidates: Region[]; candCtx: AiCandidateCtx[]; grid: VegGrid; closeups: number }

const uid = () => 'ai-' + Math.random().toString(36).slice(2, 9);
const pct = (c: number) => `${(c * 100).toFixed(0)}%`;

// ------------------------------------------------------------ grid statistics
/** Per-metre-cell statistics of a uniform sample: occupancy, greenness, normal chaos, height range. */
export interface VegGrid { b: THREE.Box3; cell: number; nx: number; ny: number; cnt: Float32Array; green: Float32Array; veg: Uint8Array; chaos: Uint8Array; zmin: Float32Array; zmax: Float32Array; anyNormals: boolean }
export interface Comp { cells: number[]; x0: number; y0: number; x1: number; y1: number; z0: number; z1: number; pts: number }

export function analyzeGrid(viewer: Viewer, opts: { cell?: number; perLeaf?: number } = {}): VegGrid {
  const b = viewer.bounds();
  const cell = opts.cell ?? 1.0;
  const nx = Math.max(1, Math.ceil((b.max.x - b.min.x) / cell)), ny = Math.max(1, Math.ceil((b.max.y - b.min.y) / cell));
  const N = nx * ny;
  const cnt = new Float32Array(N), green = new Float32Array(N), nz1 = new Float32Array(N), nz2 = new Float32Array(N);
  const zmin = new Float32Array(N).fill(Infinity), zmax = new Float32Array(N).fill(-Infinity);
  let anyNormals = false;
  if (b.isEmpty()) return { b, cell, nx, ny, cnt, green, veg: new Uint8Array(N), chaos: new Uint8Array(N), zmin, zmax, anyNormals };
  // sample per leaf in proportion to its footprint (about 30 records per metre cell), so sparse
  // outer leaves — where the trees are — get as much say as the dense interior
  const per = opts.perLeaf ? () => opts.perLeaf! : (l: { size: number }) => Math.min(60_000, Math.max(800, Math.round((l.size / cell) ** 2 * 30)));
  for (const { leaf, recs, n } of viewer.cells.sample(per)) {
    const u16 = new Uint16Array(recs.buffer, recs.byteOffset, (n * REC) >> 1);
    const k = leaf.size / 65536;
    for (let i = 0; i < n; i++) {
      const o = i * REC, q = i * 7;
      const x = leaf.origin.x + u16[q] * k, y = leaf.origin.y + u16[q + 1] * k, z = leaf.origin.z + u16[q + 2] * k;
      const gx = Math.floor((x - b.min.x) / cell), gy = Math.floor((y - b.min.y) / cell);
      if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) continue;
      const g = gy * nx + gx;
      const r = recs[o + 6], gg = recs[o + 7], bb = recs[o + 8];
      const nzv = (recs[o + 12] << 24 >> 24) / 127;
      if (recs[o + 10] !== 0 || recs[o + 11] !== 0 || recs[o + 12] !== 127) anyNormals = true;
      cnt[g]++; if (gg > r + 10 && gg > bb + 10) green[g]++;
      nz1[g] += nzv; nz2[g] += nzv * nzv;
      if (z < zmin[g]) zmin[g] = z; if (z > zmax[g]) zmax[g] = z;
    }
  }
  // veg: green + rough + tall.  chaos: rough + tall regardless of colour (overexposed canopies
  // come out white in sunny scans); used to snap boxes the model adds.
  const veg = new Uint8Array(N), chaos = new Uint8Array(N);
  for (let g = 0; g < N; g++) {
    if (cnt[g] < 6) continue;
    const gf = green[g] / cnt[g];
    const mean = nz1[g] / cnt[g], sd = Math.sqrt(Math.max(0, nz2[g] / cnt[g] - mean * mean));
    const zr = zmax[g] - zmin[g];
    const rough = anyNormals ? sd > 0.33 : true;
    const tall = zr >= 1.2 || !anyNormals && zr >= 2.0;
    if (rough && tall) chaos[g] = 1;
    if (gf >= 0.35 && rough && tall) veg[g] = 1;
  }
  return { b, cell, nx, ny, cnt, green, veg, chaos, zmin, zmax, anyNormals };
}

/** 4-connected components of cells passing `mask` (default: vegetation), largest first. */
export function components(grid: VegGrid, mask: (g: number) => boolean = g => grid.veg[g] === 1, minCells = 2): Comp[] {
  const { nx, ny, cell, b } = grid; const N = nx * ny;
  const seen = new Uint8Array(N); const comps: Comp[] = [];
  for (let s = 0; s < N; s++) {
    if (seen[s] || !mask(s)) continue;
    const stack = [s]; seen[s] = 1; const cells: number[] = [];
    while (stack.length) {
      const g = stack.pop()!; cells.push(g);
      const gx = g % nx, gy = (g / nx) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = gx + dx, y = gy + dy; if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
        const h = y * nx + x; if (!seen[h] && mask(h)) { seen[h] = 1; stack.push(h); }
      }
    }
    if (cells.length < minCells) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity, pts = 0;
    for (const g of cells) {
      const gx = g % nx, gy = (g / nx) | 0;
      x0 = Math.min(x0, b.min.x + gx * cell); x1 = Math.max(x1, b.min.x + (gx + 1) * cell);
      y0 = Math.min(y0, b.min.y + gy * cell); y1 = Math.max(y1, b.min.y + (gy + 1) * cell);
      z0 = Math.min(z0, grid.zmin[g]); z1 = Math.max(z1, grid.zmax[g]); pts += grid.cnt[g];
    }
    comps.push({ cells, x0, y0, x1, y1, z0, z1, pts });
  }
  comps.sort((a, c) => c.cells.length - a.cells.length);
  return comps;
}

function compRegion(c: Comp, label: string, margin = 0.4): Region {
  return { id: uid(), kind: 'box', role: 'pending', label,
    center: [(c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2, (c.z0 + c.z1) / 2],
    half: [(c.x1 - c.x0) / 2 + margin, (c.y1 - c.y0) / 2 + margin, (c.z1 - c.z0) / 2 + margin], radius: 0, quat: [0, 0, 0, 1] };
}

// ------------------------------------------------------------ heuristic
/** Vegetation from colour and surface chaos on a uniform sample; returns pending boxes. */
export function heuristicSuggest(viewer: Viewer, opts: { cell?: number; perLeaf?: number; max?: number } = {}): Region[] {
  const grid = analyzeGrid(viewer, opts);
  return components(grid).slice(0, opts.max ?? 24).map(c => compRegion(c, `vegetation · ${c.cells.length} m²`));
}

// ------------------------------------------------------------ renders for the model
/** Clean renders plus the metres↔pixels mapping (no candidates drawn). */
export function renderForAI(viewer: Viewer): { images: AiImage[]; frame: AiFrame } {
  const b = viewer.bounds();
  const top = viewer.renderTopDown(b, 1024);
  const oblique = viewer.snapshotFromFit(1024);
  return {
    images: [{ name: 'top-down', dataUrl: top.dataUrl }, { name: 'oblique', dataUrl: oblique }],
    frame: { originX: top.originX, originY: top.originY, extentX: top.extentX, extentY: top.extentY, zMin: b.min.z, zMax: b.max.z, width: top.width, height: top.height },
  };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
}

/** Draw a labelled metre grid and the numbered candidate boxes over the top-down render. */
export async function annotateTopDown(dataUrl: string, frame: AiFrame, candidates: Region[]): Promise<string> {
  const im = await loadImage(dataUrl);
  const c = document.createElement('canvas'); c.width = frame.width; c.height = frame.height;
  const g = c.getContext('2d')!; g.drawImage(im, 0, 0);
  const sx = frame.width / frame.extentX, sy = frame.height / frame.extentY;
  const px = (x: number) => (x - frame.originX) * sx, py = (y: number) => frame.height - (y - frame.originY) * sy;
  const ext = Math.max(frame.extentX, frame.extentY);
  const step = ext > 400 ? 50 : ext > 160 ? 20 : ext > 60 ? 10 : 5;
  g.font = 'bold 13px system-ui, sans-serif'; g.textBaseline = 'middle';
  g.strokeStyle = 'rgba(120,220,255,0.55)'; g.lineWidth = 1; g.setLineDash([6, 6]);
  for (let x = step; x < frame.extentX; x += step) {
    const X = px(frame.originX + x); g.beginPath(); g.moveTo(X, 0); g.lineTo(X, frame.height); g.stroke();
    g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(X + 2, frame.height - 20, 34, 16); g.fillStyle = '#9fe8ff'; g.textAlign = 'left'; g.fillText(`x${x}`, X + 4, frame.height - 12);
  }
  for (let y = step; y < frame.extentY; y += step) {
    const Y = py(frame.originY + y); g.beginPath(); g.moveTo(0, Y); g.lineTo(frame.width, Y); g.stroke();
    g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(2, Y - 18, 34, 16); g.fillStyle = '#9fe8ff'; g.textAlign = 'left'; g.fillText(`y${y}`, 4, Y - 10);
  }
  g.setLineDash([]);
  candidates.forEach((r, i) => {
    const x0 = px(r.center[0] - r.half[0]), x1 = px(r.center[0] + r.half[0]);
    const y0 = py(r.center[1] + r.half[1]), y1 = py(r.center[1] - r.half[1]);
    g.strokeStyle = '#ff9a2e'; g.lineWidth = 2.5; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    const tag = `C${i + 1}`; g.font = 'bold 14px system-ui, sans-serif'; const w = g.measureText(tag).width + 8;
    const tx = Math.min(Math.max(0, x0), frame.width - w), ty = Math.max(0, y0 - 18);
    g.fillStyle = '#ff9a2e'; g.fillRect(tx, ty, w, 18); g.fillStyle = '#000'; g.textAlign = 'left'; g.fillText(tag, tx + 4, ty + 9);
  });
  return c.toDataURL('image/png');
}

/** Oblique close-up of one candidate with its box drawn, so the model can tell a tree from a terrace. */
export async function closeup(viewer: Viewer, r: Region, tag: string, px = 640): Promise<string> {
  const c = new THREE.Vector3(...r.center); const h = r.half;
  const rad = Math.hypot(h[0], h[1], h[2]);
  const dist = Math.max(7, rad * 3.0);
  // look from the side away from the cloud centre, so the object is in front of the site rather than behind it
  const bc = viewer.bounds().getCenter(new THREE.Vector3());
  const az = Math.atan2(c.y - bc.y, c.x - bc.x) + Math.PI / 5;
  const corners: THREE.Vector3[] = [];
  const q = new THREE.Quaternion(...r.quat);
  for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3((i & 1 ? h[0] : -h[0]), (i & 2 ? h[1] : -h[1]), (i & 4 ? h[2] : -h[2])).applyQuaternion(q).add(c));
  const w = px, hh = Math.round(px * 0.75);
  const { dataUrl, marks2d } = viewer.snapshotAt(c, dist, az, 32 * Math.PI / 180, w, hh, corners);
  const im = await loadImage(dataUrl);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = hh;
  const g = cv.getContext('2d')!; g.drawImage(im, 0, 0);
  g.strokeStyle = '#ff9a2e'; g.lineWidth = 2;
  const E = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const [a, b] of E) { g.beginPath(); g.moveTo(...marks2d[a]); g.lineTo(...marks2d[b]); g.stroke(); }
  g.font = 'bold 16px system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
  const tw = g.measureText(tag).width + 10; g.fillStyle = '#ff9a2e'; g.fillRect(6, 6, tw, 22); g.fillStyle = '#000'; g.fillText(tag, 11, 17);
  return cv.toDataURL('image/jpeg', 0.85);
}

/** Everything the provider call needs: candidates from the data, annotated renders, close-ups, the frame. */
export async function prepareForAI(viewer: Viewer, opts: { maxCandidates?: number; closeups?: number } = {}): Promise<AiPrep> {
  const grid = analyzeGrid(viewer);
  const candidates = components(grid).slice(0, opts.maxCandidates ?? 16).map((c, i) => ({ ...compRegion(c, `vegetation · ${c.cells.length} m²`), id: `C${i + 1}` }));
  const { images, frame } = renderForAI(viewer);
  images[0].dataUrl = await annotateTopDown(images[0].dataUrl, frame, candidates);
  images[0].detail = 'high'; images[1].detail = 'low';
  const nClose = Math.min(candidates.length, opts.closeups ?? 12);
  for (let i = 0; i < nClose; i++) images.push({ name: `closeup-${candidates[i].id}`, dataUrl: await closeup(viewer, candidates[i], candidates[i].id), detail: 'low' });
  const candCtx: AiCandidateCtx[] = candidates.map(r => ({ id: r.id, area: r.half[0] * r.half[1] * 4, height: r.half[2] * 2, x: r.center[0] - frame.originX, y: r.center[1] - frame.originY }));
  return { images, frame, candidates, candCtx, grid, closeups: nClose };
}

// ------------------------------------------------------------ providers
const ENDPOINTS = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5.5' },
  xai:    { url: 'https://api.x.ai/v1/chat/completions',       model: 'grok-4.3' },
};

export async function providerSuggest(provider: 'openai' | 'xai', model: string | undefined, key: string | null,
  images: AiImage[], context: any, callCloud: ((data: any) => Promise<any>) | null): Promise<AiResult> {
  // preferred: the Cloud Function that holds the keys
  if (callCloud) {
    try { const r: any = await callCloud({ provider, model, images, context }); return { candidates: [], additional: [], sections: [], ...r.data, via: 'cloud function' }; }
    catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!key) throw new Error(msg.includes('not set') || msg.includes('failed-precondition') ? `${msg} — or paste your own key below.` : msg);
    }
  }
  if (!key) throw new Error('No API key. Set the Firebase secret, or paste a key below.');
  const ep = ENDPOINTS[provider];
  const t0 = performance.now();
  const body = requestBody(provider, model || ep.model, images, context);
  const res = await fetch(ep.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${text.slice(0, 300)}`);
  const content = JSON.parse(text).choices?.[0]?.message?.content ?? '';
  return { ...parseResponse(content), via: 'direct', model: body.model, ms: performance.now() - t0 };
}

// ------------------------------------------------------------ mapping back to metres
/** Turn the model's verdicts into regions: confirmed candidates keep their data-derived boxes; added boxes are snapped to the grid. */
export function mapResult(r: AiParsed, prep: AiPrep, viewer: Viewer): Region[] {
  const out: Region[] = [];
  const { frame, grid } = prep; const b = viewer.bounds();
  const byId = new Map(prep.candidates.map(c => [c.id.toUpperCase(), c]));
  for (const d of r.candidates) {
    const c = byId.get(d.id.toUpperCase()); if (!c || !d.remove) continue;
    out.push({ ...c, id: uid(), label: `${d.label} (${pct(d.confidence)})` });
  }
  const MAXSIDE = 30;
  for (const s of r.additional) {
    let x0 = frame.originX + s.x0 * frame.extentX, x1 = frame.originX + s.x1 * frame.extentX;
    let y0 = frame.originY + (1 - s.y1) * frame.extentY, y1 = frame.originY + (1 - s.y0) * frame.extentY;
    // cells of the grid under the box
    const gx0 = Math.max(0, Math.floor((x0 - grid.b.min.x) / grid.cell)), gx1 = Math.min(grid.nx - 1, Math.floor((x1 - grid.b.min.x) / grid.cell));
    const gy0 = Math.max(0, Math.floor((y0 - grid.b.min.y) / grid.cell)), gy1 = Math.min(grid.ny - 1, Math.floor((y1 - grid.b.min.y) / grid.cell));
    const inRect = (g: number) => { const gx = g % grid.nx, gy = (g / grid.nx) | 0; return gx >= gx0 && gx <= gx1 && gy >= gy0 && gy <= gy1; };
    // 1) vegetation cells inside → one tight box per clump (skip clumps already covered by a confirmed candidate)
    const veg = components(grid, g => grid.veg[g] === 1 && inRect(g), 1);
    if (veg.length) {
      let n = 0;
      for (const c of veg) {
        if (n >= 4) break;
        const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
        if (out.some(o => Math.abs(o.center[0] - cx) <= o.half[0] && Math.abs(o.center[1] - cy) <= o.half[1])) continue;
        out.push({ ...compRegion(c, `${s.label} (${pct(s.confidence)})`), id: uid() }); n++;
      }
      if (n) continue;
      if (veg.every(c => out.some(o => Math.abs(o.center[0] - (c.x0 + c.x1) / 2) <= o.half[0] && Math.abs(o.center[1] - (c.y0 + c.y1) / 2) <= o.half[1]))) continue;
    }
    // 2) no colour signal (overexposed canopy, a car, noise): snap to rough-and-tall clumps under the box
    const rough = components(grid, g => grid.chaos[g] === 1 && inRect(g), 1);
    if (rough.length && rough[0].cells.length * grid.cell * grid.cell >= 2) {
      let n = 0;
      for (const c of rough) {
        if (n >= 3 || c.cells.length < 2) break;
        const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
        if (out.some(o => Math.abs(o.center[0] - cx) <= o.half[0] && Math.abs(o.center[1] - cy) <= o.half[1])) continue;
        out.push({ ...compRegion(c, `${s.label} (${pct(s.confidence)})`), id: uid() }); n++;
      }
      if (n) continue;
    }
    // 3) nothing structured: keep the model's footprint, shrink it to occupied cells, height from the data, cap the size
    let ox0 = Infinity, oy0 = Infinity, ox1 = -Infinity, oy1 = -Infinity; const zs: number[] = [], zs1: number[] = [];
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const g = gy * grid.nx + gx; if (grid.cnt[g] < 3) continue;
      ox0 = Math.min(ox0, grid.b.min.x + gx * grid.cell); ox1 = Math.max(ox1, grid.b.min.x + (gx + 1) * grid.cell);
      oy0 = Math.min(oy0, grid.b.min.y + gy * grid.cell); oy1 = Math.max(oy1, grid.b.min.y + (gy + 1) * grid.cell);
      zs.push(grid.zmin[g]); zs1.push(grid.zmax[g]);
    }
    if (!zs.length) continue;
    if (zs.length >= 4) { x0 = Math.max(x0, ox0); x1 = Math.min(x1, ox1); y0 = Math.max(y0, oy0); y1 = Math.min(y1, oy1); }
    if (x1 - x0 > MAXSIDE) { const cx = (x0 + x1) / 2; x0 = cx - MAXSIDE / 2; x1 = cx + MAXSIDE / 2; }
    if (y1 - y0 > MAXSIDE) { const cy = (y0 + y1) / 2; y0 = cy - MAXSIDE / 2; y1 = cy + MAXSIDE / 2; }
    zs.sort((a, c) => a - c); zs1.sort((a, c) => a - c);
    let z0: number, z1: number;
    if (s.zFrom != null && s.zTo != null) { z0 = frame.zMin + Math.min(s.zFrom, s.zTo); z1 = frame.zMin + Math.max(s.zFrom, s.zTo); }
    else { z0 = zs[Math.floor(zs.length * 0.05)] - 0.3; z1 = zs1[Math.min(zs1.length - 1, Math.floor(zs1.length * 0.95))] + 0.3; }
    out.push({ id: uid(), kind: 'box', role: 'pending', label: `${s.label}? (${pct(s.confidence)})`,
      center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], half: [(x1 - x0) / 2, (y1 - y0) / 2, Math.max(0.2, (z1 - z0) / 2)], radius: 0, quat: [0, 0, 0, 1] });
  }
  const span = Math.max(frame.extentX, frame.extentY) * 3;
  for (const s of r.sections) {
    const from = s.from ?? -1e3, to = s.to ?? 1e3;
    const z0 = frame.zMin + Math.min(from, to), z1 = frame.zMin + Math.max(from, to);
    out.push({ id: uid(), kind: 'slab', role: 'pending', label: `${s.label} (${pct(s.confidence)})`,
      center: [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (z0 + z1) / 2], half: [span, span, Math.max(0.05, (z1 - z0) / 2)], radius: 0, quat: [0, 0, 0, 1] });
  }
  return out;
}
