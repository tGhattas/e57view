import './style.css';
import * as THREE from 'three';
import { Viewer, isTouch, isIOS, type Knobs, type Station, type GizmoMode } from './viewer';
import { REC, pointInRegion, type Region } from './cells';
import { AgentLink } from './agent';
import { History, cloneRegions } from './history';
import type { MeshData } from './meshview';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => Math.round(n).toLocaleString();
const mb = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`;
const uid = (p: string) => p + Math.random().toString(36).slice(2, 8);

const viewer = new Viewer($<HTMLCanvasElement>('gl'));
let worker: Worker | null = null;
const io = new Worker(new URL('./io-worker.ts', import.meta.url), { type: 'module' });
let currentFile: File | null = null;
let currentHandle: any = null;
let meta: any = null;
let histogram = new Uint32Array(256);
const NB = 1024;
let axisHist = [new Uint32Array(NB), new Uint32Array(NB), new Uint32Array(NB)];
let axisCube: { origin: number[]; size: number } | null = null;
let revealed = false, gotRealLeaf = false, fromCache = false, cropped = false;
let cacheKey = '';
let t0 = 0;
let sessionMod: typeof import('./session') | null = null;

const small = isTouch && Math.min(innerWidth, innerHeight) < 820;
const MEM_LIMIT = isTouch ? 700e6 : 3.2e9;

const knobs: Knobs = {
  colorMode: 0, size: 2.0, sizeMode: 1, round: true, maxPx: 7,
  edl: true, edlStrength: 0.32, edlRadius: 1.4, normalShade: false,
  bright: 1, gamma: 1, iMin: 0, iMax: 1, clipZMin: -1e9, clipZMax: 1e9,
  budget: 8_000_000, density: 2.0, movingQuality: 0.35, flySpeed: 2,
};

// ------------------------------------------------------------------ helpers
function hashKey(s: string) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0') + s.length.toString(16); }
function keyFor(f: File, stride: number) { return hashKey(`${f.name}|${f.size}|${f.lastModified}|${stride}`); }
const ioWaiters = new Map<string, (m: any) => void>();
function ioOnce(type: string): Promise<any> { return new Promise(res => ioWaiters.set(type, res)); }
let undoTail: Promise<unknown> = Promise.resolve();
function withUndoIo<T>(fn: () => Promise<T>): Promise<T> {
  const run = undoTail.then(fn, fn);
  undoTail = run.then(() => {}, () => {});
  return run;
}
function ioOnceUndo(type: string): Promise<any> {
  return new Promise((res, rej) => {
    ioWaiters.set(type, res);
    ioWaiters.set('__undo_err', (e: Error) => rej(e));
  });
}
io.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === 'error' && typeof m.op === 'string' && m.op.startsWith('undo-')) {
    for (const t of ['undo-written', 'undo-chunk', 'undo-dropped', 'undo-cleared']) ioWaiters.delete(t);
    const errW = ioWaiters.get('__undo_err');
    if (errW) { ioWaiters.delete('__undo_err'); errW(new Error(m.message)); }
    return;
  }
  const w = ioWaiters.get(m.type);
  if (w) {
    ioWaiters.delete(m.type);
    if (['undo-written', 'undo-chunk', 'undo-dropped', 'undo-cleared'].includes(m.type)) ioWaiters.delete('__undo_err');
    w(m); return;
  }
  if (['leaf', 'meta', 'plan', 'progress', 'done'].includes(m.type)) { onWorker(ev); return; }
  if (m.type === 'export-progress') { busy(`Writing ${fmt(m.written)} of ${fmt(exportTotal)} points…`, m.written / Math.max(exportTotal, 1)); return; }
  if (m.type === 'cache-progress') { busy(`Caching… ${mb(m.bytes)}`, m.bytes / Math.max(cacheBytesExpected, 1)); return; }
  if (m.type === 'error') { hideBusy(); fail(`${m.op}: ${m.message}`); }
};
function histBuf(recs: Uint8Array): ArrayBuffer {
  return recs.byteOffset === 0 && recs.byteLength === recs.buffer.byteLength
    ? recs.buffer as ArrayBuffer
    : recs.slice().buffer;
}
const histIo = {
  write(id: string, i: number, recs: Uint8Array) {
    return withUndoIo(async () => {
      const buf = histBuf(recs);
      io.postMessage({ type: 'undo-write', id, i, recs: buf }, [buf]);
      const m = await ioOnceUndo('undo-written');
      if (m.id !== id || m.i !== i) throw new Error('undo-write mismatch');
    });
  },
  read(id: string, i: number) {
    return withUndoIo(async () => {
      io.postMessage({ type: 'undo-read', id, i });
      const m = await ioOnceUndo('undo-chunk');
      if (m.id !== id || m.i !== i) throw new Error('undo-read mismatch');
      return new Uint8Array(m.recs);
    });
  },
  drop(id: string) {
    return withUndoIo(async () => {
      io.postMessage({ type: 'undo-drop', id });
      const m = await ioOnceUndo('undo-dropped');
      if (m.id !== id) throw new Error('undo-drop mismatch');
    });
  },
  clear() {
    return withUndoIo(async () => {
      io.postMessage({ type: 'undo-clear' });
      await ioOnceUndo('undo-cleared');
    });
  },
};
const hist = new History({ io: histIo });
void histIo.clear().catch(() => {});
function idb(): Promise<IDBDatabase> { return new Promise((res, rej) => { const r = indexedDB.open('e57view', 1); r.onupgradeneeded = () => r.result.createObjectStore('handles'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbPut(key: string, val: any) { try { const d = await idb(); d.transaction('handles', 'readwrite').objectStore('handles').put(val, key); } catch {} }
async function idbGet(key: string): Promise<any> { try { const d = await idb(); return await new Promise(res => { const r = d.transaction('handles').objectStore('handles').get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); } catch { return null; } }
function modal(title: string, bodyHtml: string, buttons: { label: string; cls?: string; value: string }[]): Promise<string> {
  return new Promise(res => {
    $('modal-title').textContent = title; $('modal-body').innerHTML = bodyHtml;
    const b = $('modal-btns'); b.innerHTML = '';
    for (const bt of buttons) { const el = document.createElement('button'); el.textContent = bt.label; el.className = bt.cls ?? 'ghost'; el.onclick = () => { $('modal').classList.add('hidden'); res(bt.value); }; b.appendChild(el); }
    $('modal').classList.remove('hidden'); (b.firstElementChild as HTMLButtonElement)?.focus();
  });
}
function busy(text: string, frac?: number) { $('busy').classList.remove('hidden'); $('busy-text').textContent = text; $('busy-bar').style.width = frac === undefined ? '0%' : `${Math.min(100, frac * 100).toFixed(0)}%`; }
function hideBusy() { $('busy').classList.add('hidden'); }
const tick = () => new Promise(r => setTimeout(r, 0));
function fail(msg: string) { const e = $('err'); e.textContent = msg; e.classList.remove('hidden'); $('loading').classList.add('hidden'); if (!revealed) $('drop').classList.remove('hidden'); }

// ------------------------------------------------------------------ opening files
function resetForLoad(name: string) {
  revealed = false; gotRealLeaf = false; fromCache = false; cropped = false; cacheNote = ''; clearDirty();
  (document.activeElement as HTMLElement | null)?.blur?.();
  $('drop').classList.add('hidden'); $('loading').classList.remove('hidden', 'over');
  $('ld-name').textContent = name; $('ld-stat').textContent = 'opening…'; $('ld-bar').style.width = '0%'; $('err').classList.add('hidden');
  viewer.clear();
  histogram = new Uint32Array(256); axisHist = [new Uint32Array(NB), new Uint32Array(NB), new Uint32Array(NB)]; axisCube = null;
  sections.length = 0; deletes.length = 0; cropUI.on = false; cropState.role = 'keep'; syncCropRoleUI();
  meshData = null; viewer.setMesh(null); document.body.classList.remove('has-mesh');
  viewer.setModel(new THREE.Matrix4()); viewer.setModelGizmo(false);
  sfName = ''; sfStats = null; document.body.classList.remove('has-sf', 'sf-filtering');
  ($('k-color-sf') as HTMLOptionElement).disabled = true; $<HTMLInputElement>('k-cropon').checked = false;
  void hist.clear();
  syncRegions(); updateMeasureList(); setTool('none'); renderSectionList(); updateHistUI();
  worker?.terminate(); worker = null;
  t0 = performance.now();
}
async function openFile(f: File, handle: any = null) {
  if (f.size < 48) { fail('That file is too small to be a scan.'); return; }
  currentFile = f; currentHandle = handle;
  resetForLoad(f.name);
  const stride = Number(($('k-load') as HTMLSelectElement).value) || 1;
  cacheKey = keyFor(f, stride);
  io.postMessage({ type: 'cache-has', key: cacheKey });
  const has = await ioOnce('cache-has');
  if (has.has) { fromCache = true; $('ld-stat').textContent = 'loading from cache…'; io.postMessage({ type: 'cache-read', key: cacheKey }); return; }
  const ext = f.name.toLowerCase().split('.').pop();
  const isImport = ext === 'ply' || ext === 'las' || ext === 'laz';
  worker = isImport ? new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' })
                    : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = onWorker;
  worker.onerror = e => fail(`Decoder crashed: ${e.message || 'out of memory?'} — try a smaller "In memory" fraction.`);
  worker.postMessage({ type: 'open', file: f, scanIndex: 0, stride, memLimit: MEM_LIMIT });
}

function onWorker(ev: MessageEvent) {
  const m = ev.data;
  if (m.type === 'meta') onMeta(m);
  else if (m.type === 'plan') $('ld-stat').textContent = m.stride > 1 ? `decoding — keeping 1 in ${m.stride}, ${fmt(m.willKeep)} points` : `decoding all ${fmt(m.willKeep)} points`;
  else if (m.type === 'preview') {
    const u8 = new Uint8Array(m.block);
    const u16 = new Uint16Array(m.block.byteLength >> 1); new Uint8Array(u16.buffer).set(u8.subarray(0, u16.length * 2));
    axisCube = { origin: m.meta.origin, size: m.meta.size };
    for (let i = 0; i < u8.length; i += REC) { histogram[u8[i + 9]]++; const b = i >> 1; axisHist[0][u16[b] >> 6]++; axisHist[1][u16[b + 1] >> 6]++; axisHist[2][u16[b + 2] >> 6]++; }
    if (!gotRealLeaf) viewer.addLeaf([m.block], m.count, m.meta, true);
    if (!revealed && viewer.loaded + m.count > 150_000) { robustBounds(); revealViewport(); }
    viewer.applyZRange();
  }
  else if (m.type === 'progress') {
    const total = meta.scans[0].points;
    if (m.phase === 0) {
      const pct = Math.min(100, (m.done / total) * 100); $('ld-bar').style.width = (pct * 0.85) + '%';
      const rate = m.done / (m.elapsed / 1000), eta = Math.max(0, (total - m.done) / rate);
      $('ld-stat').textContent = `decoding ${fmt(m.done)} · ${(rate/1e6).toFixed(1)} M pts/s · ${pct.toFixed(0)}% · ~${eta.toFixed(0)}s left`; $('tb-points').textContent = `decoding ${pct.toFixed(0)}%`;
    } else {
      const pct = fromCache ? (m.done / Math.max(m.total, 1)) * 100 : 85 + (m.done / Math.max(m.total, 1)) * 15;
      $('ld-bar').style.width = pct + '%';
      $('ld-stat').textContent = fromCache ? `reading cache ${mb(m.done)} / ${mb(m.total)}` : `building cells ${m.done} / ${m.total}`;
      $('tb-points').textContent = fromCache ? 'reading cache…' : 'building cells…';
    }
  }
  else if (m.type === 'leaf') { if (!gotRealLeaf) { gotRealLeaf = true; viewer.dropPreview(); } viewer.addLeaf(m.blocks, m.count, m.meta, false); viewer.applyZRange(); if (!revealed) revealViewport(); }
  else if (m.type === 'done') onDone(m.stats, m.fromCache ? 'from cache' : 'loaded');
  else if (m.type === 'error') fail(m.message);
}
function onMeta(m: any) {
  meta = m.meta;
  const s = meta.scans[0]; if (!s) return fail('This file contains no point clouds.');
  const b = s.bounds;
  $('ld-points').textContent = fmt(s.points);
  $('ld-extent').textContent = b ? `${(b[1]-b[0]).toFixed(1)} × ${(b[3]-b[2]).toFixed(1)} × ${(b[5]-b[4]).toFixed(1)} m` : '—';
  $('ld-sensor').textContent = [s.sensorVendor, s.sensorModel].filter(Boolean).join(' ') || '—';
  const bits = [s.cartesian ? 'XYZ' : 'spherical']; if (s.hasColor) bits.push('RGB'); if (s.hasIntensity) bits.push('intensity'); if (s.hasNormals) bits.push('normals');
  $('ld-fields').textContent = bits.join(' · ');
  if (s.name) $('ld-name').textContent = s.name;
  $('ld-stat').textContent = m.fromCache ? 'reading cached cells…' : `opened in ${m.openMs.toFixed(0)} ms · ${(m.bytesPulled/1e6).toFixed(1)} MB read · ${meta.stations.length} stations`;
  ($('k-nrm') as HTMLInputElement).disabled = !s.hasNormals;
  $('tb-name').textContent = currentFile?.name ?? meta.scans[0].name ?? 'cloud';
  if (m.histogram) histogram = Uint32Array.from(m.histogram);
  if (m.robust) viewer.setRobustBounds(m.robust.lo, m.robust.hi);
  // a cached scan reopens with the transform it was cached with (row-major in the meta)
  if (m.model && m.model.length === 16) viewer.setModel(fromRowMajor(m.model as number[]));
  updateTransformUI();
  viewer.setStations(meta.stations as Station[], s.translation);
  $('v-stations').textContent = meta.stations.length ? `${meta.stations.length} panoramas in this file` : 'No panoramas in this file';
  $('k-stations').parentElement!.classList.toggle('hidden', !meta.stations.length);
}
function onDone(stats: any, how: string) {
  if (!fromCache) robustBounds();
  retightenSoon();
  revealViewport(); viewer.applyZRange(); autoRangeIntensity(); syncZLabels();
  const secs = (performance.now() - t0) / 1000, total = meta.scans[0].points;
  $('tb-points').textContent = `${fmt(stats.kept)} pts · ${how} in ${secs.toFixed(1)}s`;
  $('v-loaded').textContent = `${fmt(stats.kept)} of ${fmt(total)} in memory (${((stats.kept/total)*100).toFixed(0)}%) · ${stats.leaves} cells` + (stats.droppedInvalid ? ` · ${fmt(stats.droppedInvalid)} invalid skipped` : '');
  $('loading').classList.add('hidden');
  drawHistogram(); viewer.fit(); applyPendingView(); applyUrlCommands(); updateCropUI(true);
  worker?.terminate(); worker = null;
  if (currentHandle) idbPut(cacheKey, currentHandle);
  updateCacheUI(); updateHistUI();
  if (!fromCache && localStorage.getItem('nocache:' + cacheKey) !== '1') setTimeout(offerCache, 600);
}
function revealViewport() {
  if (revealed) return; revealed = true; viewer.fit();
  $('topbar').classList.remove('hidden'); $('panel').classList.remove('hidden');
  if (isTouch) { $('panel').classList.add('peek'); $('toolbar').classList.remove('hidden'); }
  $('loading').classList.add('over');
}

// ------------------------------------------------------------------ bounds / histogram
function robustLoHi(): { lo: number[]; hi: number[] } | null {
  if (!axisCube) return null;
  const total = axisHist[0].reduce((a, b) => a + b, 0); if (!total) return null;
  const lo: number[] = [], hi: number[] = [];
  for (let a = 0; a < 3; a++) {
    const h = axisHist[a]; let acc = 0, l = 0, u = NB - 1;
    for (let i = 0; i < NB; i++) { acc += h[i]; if (acc >= total * 0.002) { l = i; break; } }
    acc = 0; for (let i = NB - 1; i >= 0; i--) { acc += h[i]; if (acc >= total * 0.002) { u = i; break; } }
    lo.push(axisCube.origin[a] + (l / NB) * axisCube.size); hi.push(axisCube.origin[a] + ((u + 1) / NB) * axisCube.size);
  }
  return { lo, hi };
}
function robustBounds() { const r = robustLoHi(); if (r) viewer.setRobustBounds(r.lo as any, r.hi as any); }
/** A cached scan reopens with the transform it was cached with, and a percentile box carried
 *  through a rotation is inflated. The leaves arrive through the upload queue, so measuring a
 *  tight one has to wait for them. */
function retightenSoon() {
  if (viewer.cells.model.equals(new THREE.Matrix4())) return;
  const t = setInterval(() => {
    if (viewer.cells.pendingCount) return;
    clearInterval(t); viewer.retightenBounds(); syncZLabels(); viewer.fit();
  }, 120);
  setTimeout(() => clearInterval(t), 20000);
}
function autoRangeIntensity() {
  const total = histogram.reduce((a, b) => a + b, 0); if (!total) return;
  let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) { acc += histogram[i]; if (acc >= total * 0.01) { lo = i; break; } }
  acc = 0; for (let i = 255; i >= 0; i--) { acc += histogram[i]; if (acc >= total * 0.02) { hi = i; break; } }
  knobs.iMin = lo / 255; knobs.iMax = Math.max(hi / 255, knobs.iMin + 0.02);
  $<HTMLInputElement>('k-imin').value = String(knobs.iMin); $<HTMLInputElement>('k-imax').value = String(knobs.iMax);
  $('v-irange').textContent = `${knobs.iMin.toFixed(2)} – ${knobs.iMax.toFixed(2)}`; push();
}
function drawHistogram() {
  const c = $<HTMLCanvasElement>('hist'); const g = c.getContext('2d')!; const w = c.width, h = c.height; g.clearRect(0, 0, w, h);
  const max = Math.max(...histogram); if (!max) return;
  g.fillStyle = '#2b7a84'; for (let x = 0; x < w; x++) { const i = Math.floor((x / w) * 256); const v = Math.pow(histogram[i] / max, 0.42) * h; g.fillRect(x, h - v, 1, v); }
  g.fillStyle = '#46c6d266'; g.fillRect(knobs.iMin * w, 0, Math.max(1, (knobs.iMax - knobs.iMin) * w), h);
}
function syncZLabels() {
  const b = viewer.bounds(); if (b.isEmpty()) return;
  const lo = b.min.z + Number($<HTMLInputElement>('k-zmin').value) * (b.max.z - b.min.z), hi = b.min.z + Number($<HTMLInputElement>('k-zmax').value) * (b.max.z - b.min.z);
  knobs.clipZMin = lo; knobs.clipZMax = hi; $('v-zmin').textContent = lo.toFixed(1); $('v-zmax').textContent = hi.toFixed(1);
}

// ------------------------------------------------------------------ knobs
function push() { viewer.setKnobs(knobs); }
/** Select a colour mode without ever landing on an option the UI has disabled.
 *  Mode 5 used to be Flat; Scalar field took that slot and Flat moved to 6, so a saved view
 *  link written before then asks for 5 meaning Flat. With no field loaded, 5 is that old
 *  link and maps to 6; with a field loaded it is what it says. Anything unselectable falls
 *  back to RGB rather than leaving the select and the renderer disagreeing. */
function setColorMode(c: number) {
  const sel = $<HTMLSelectElement>('k-color');
  if (c === 5 && !viewer.cells.hasScalarField) c = 6;
  const opt = Array.from(sel.options).find(o => Number(o.value) === c);
  if (!opt || opt.disabled) c = 0;
  knobs.colorMode = c; sel.value = String(c); push();
}
function bindRange(id: string, label: string, apply: (v: number) => void, digits = 2) {
  const el = $<HTMLInputElement>(id);
  const on = () => { const v = Number(el.value); apply(v); const l = document.getElementById(label); if (l) l.textContent = v.toFixed(digits); push(); };
  el.addEventListener('input', on); on();
}
bindRange('k-size', 'v-size', v => knobs.size = v, 1); bindRange('k-maxpx', 'v-maxpx', v => knobs.maxPx = v, 1);
bindRange('k-edlstr', 'v-edlstr', v => knobs.edlStrength = v); bindRange('k-edlrad', 'v-edlrad', v => knobs.edlRadius = v, 1);
bindRange('k-bright', 'v-bright', v => knobs.bright = v); bindRange('k-gamma', 'v-gamma', v => knobs.gamma = v);
bindRange('k-density', 'v-density', v => knobs.density = v); bindRange('k-moving', 'v-moving', v => knobs.movingQuality = v);
bindRange('k-flyspeed', 'v-flyspeed', v => knobs.flySpeed = v, 1);
const onSel = (id: string, f: (v: string) => void) => $(id).addEventListener('change', e => { f((e.target as HTMLSelectElement).value); push(); });
onSel('k-color', v => knobs.colorMode = Number(v)); onSel('k-sizemode', v => knobs.sizeMode = Number(v)); onSel('k-budget', v => knobs.budget = Number(v));
const onChk = (id: string, f: (v: boolean) => void) => $(id).addEventListener('change', e => { f((e.target as HTMLInputElement).checked); push(); });
onChk('k-round', v => knobs.round = v); onChk('k-edl', v => knobs.edl = v); onChk('k-nrm', v => knobs.normalShade = v);
for (const id of ['k-imin', 'k-imax']) $(id).addEventListener('input', () => {
  let lo = Number($<HTMLInputElement>('k-imin').value), hi = Number($<HTMLInputElement>('k-imax').value); if (hi < lo + 0.02) hi = lo + 0.02;
  knobs.iMin = lo; knobs.iMax = hi; $('v-irange').textContent = `${lo.toFixed(2)} – ${hi.toFixed(2)}`; drawHistogram(); push();
});
for (const id of ['k-zmin', 'k-zmax']) $(id).addEventListener('input', () => { syncZLabels(); push(); });
$('k-top').addEventListener('click', () => viewer.topDown());
$('k-fit').addEventListener('click', () => viewer.fit());
$('k-reload').addEventListener('click', () => reloadScan());

// ------------------------------------------------------------------ modes & tools
function setMode(fly: boolean) {
  viewer.setFly(fly);
  $('k-fly').classList.toggle('on', fly); $('k-orbit').classList.toggle('on', !fly); $('gl').classList.toggle('fly', fly);
  $('v-navhint').innerHTML = fly ? '<b>W A S D</b> move · <b>Q E</b> down/up · drag to look · scroll changes speed · <b>Shift</b> ×4 · double-click walks toward a point · <b>F</b> back to orbit'
                                 : 'Drag to orbit · scroll zooms toward the cursor · <b>double-click</b> a point to orbit around it · <b>F</b> to fly';
  $('joy').classList.toggle('hidden', !(fly && isTouch));
  updatePill(); syncToolbar();
}
$('k-fly').addEventListener('click', () => setMode(true)); $('k-orbit').addEventListener('click', () => setMode(false));
function setTool(t: 'none' | 'measure' | 'segment') {
  if (viewer.tool === 'segment' && t !== 'segment') endSegment();
  viewer.setTool(t);
  $('k-measure').classList.toggle('on', t === 'measure');
  $('k-segment').classList.toggle('on', t === 'segment');
  $('gl').classList.toggle('measure', t === 'measure');
  $('gl').classList.toggle('segment', t === 'segment');
  $('segbar').classList.toggle('hidden', t !== 'segment');
  $('seg').classList.toggle('hidden', t !== 'segment');
  if (t === 'segment') resetSegment();
  updatePill(); syncToolbar();
}
function updatePill() { const p = $('tb-tool'); const txt = viewer.bubble ? 'photo' : viewer.tool === 'measure' ? 'measure' : viewer.tool === 'segment' ? 'select' : viewer.fly.enabled ? 'fly' : ''; p.textContent = txt; p.classList.toggle('hidden', !txt); }
$('k-measure').addEventListener('click', () => setTool(viewer.tool === 'measure' ? 'none' : 'measure'));
$('k-measureclear').addEventListener('click', () => { viewer.clearMeasures(); updateMeasureList(); });
function updateMeasureList() {
  const ul = $('measure-list'); ul.innerHTML = '';
  for (const m of viewer.measureList) { const li = document.createElement('li'); const dz = m.b.z - m.a.z; li.innerHTML = `<b>${m.dist.toFixed(3)} m</b> · Δz ${dz >= 0 ? '+' : ''}${dz.toFixed(3)} m`; ul.appendChild(li); }
}
viewer.onClick = (world) => {
  if (viewer.tool === 'measure') updateMeasureList();
  const c = $('coord'); if (!world || !meta) { c.classList.add('hidden'); return; }
  const t = meta.scans[0].translation as number[];
  c.textContent = `E ${(world.x + t[0]).toFixed(3)}   N ${(world.y + t[1]).toFixed(3)}   Z ${(world.z + t[2]).toFixed(3)}   ·   local ${world.x.toFixed(2)}, ${world.y.toFixed(2)}, ${world.z.toFixed(2)}`;
  c.classList.remove('hidden');
};
function syncToolbar() {
  const cur = viewer.bubble ? 'photo' : viewer.tool === 'measure' ? 'measure' : viewer.fly.enabled ? 'fly' : 'orbit';
  document.querySelectorAll<HTMLButtonElement>('#toolbar button').forEach(b => b.classList.toggle('on', b.dataset.tool === cur));
  const photoBtn = document.querySelector<HTMLButtonElement>('#toolbar [data-tool="photo"]'); if (photoBtn) photoBtn.classList.toggle('hidden', !viewer.bubble);
}
document.querySelectorAll<HTMLButtonElement>('#toolbar button').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.tool;
  if (t === 'orbit') { setTool('none'); setMode(false); }
  else if (t === 'fly') { setTool('none'); setMode(true); }
  else if (t === 'measure') { setMode(false); setTool('measure'); }
  else if (t === 'segment') { setMode(false); setTool('segment'); }
  else if (t === 'crop') { setMode(false); setTool('none'); document.querySelector('[data-grp="crop"]')?.classList.remove('closed'); toggleSheet(true); cropUI.on = true; $<HTMLInputElement>('k-cropon').checked = true; updateCropUI(); }
  else if (t === 'photo') viewer.exitBubble();
}));
document.querySelectorAll<HTMLButtonElement>('#joy button').forEach(b => {
  const k = b.dataset.key!;
  const down = (e: Event) => { e.preventDefault(); viewer.fly.keys.add(k); };
  const up = () => viewer.fly.keys.delete(k);
  b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
});
$('tb-panel').addEventListener('click', () => { if (isSheet()) { toggleSheet(); return; } $('panel').classList.toggle('hidden'); viewer.resize(); viewer.touch(); });
addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
  if (!$('modal').classList.contains('hidden')) {
    if (e.key === 'Escape') { e.preventDefault(); ($('modal-btns').querySelector('button') as HTMLButtonElement | null)?.click(); }
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redoEdit() : undoEdit(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redoEdit(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrent(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openAnother(); return; }
  if (e.key === 'Tab') {
    const inUi = (e.target as HTMLElement | null)?.closest?.('#panel, #labels, #modal, #topbar, button, a');
    if (inUi) return;
    e.preventDefault(); $('panel').classList.toggle('hidden'); viewer.resize(); viewer.touch();
  }
  else if (e.key === 'f' || e.key === 'F') setMode(!viewer.fly.enabled);
  else if (e.key === 'm' || e.key === 'M') setTool(viewer.tool === 'measure' ? 'none' : 'measure');
  else if (e.key === 's' || e.key === 'S') setTool(viewer.tool === 'segment' ? 'none' : 'segment');
  else if (e.key === 'Enter' && viewer.tool === 'segment') { segHover = null; drawSegment(); }
  else if (e.key === 'Escape') cancelStarted();
  else if (e.key === 'Home') viewer.fit();
});

// ------------------------------------------------------------------ regions: crop and sections
const cropState: Region = { id: 'crop', kind: 'box', role: 'keep', center: [0, 0, 0], half: [10, 10, 10], radius: 10, quat: [0, 0, 0, 1] };
const cropUI = { on: false, frac: [0.35, 0.35, 0.35] };
const sections: Region[] = [];
/** Delete-role regions. No UI creates these; an agent can, through the regions command. */
const deletes: Region[] = [];
function allRegions(): Region[] { return [...(cropUI.on ? [cropState] : []), ...sections, ...deletes]; }
function syncRegions() { viewer.regionHide = $<HTMLInputElement>('k-crophide').checked; viewer.setRegions(allRegions()); }
function maxDim() { const b = viewer.bounds(); const s = b.isEmpty() ? new THREE.Vector3(50, 50, 50) : b.getSize(new THREE.Vector3()); return Math.max(s.x, s.y, s.z, 1); }
function cropFromSliders() {
  const md = maxDim();
  const half = cropUI.frac.map(f => Math.max(0.25, f * md * 0.5)) as [number, number, number];
  if (cropState.kind === 'box') cropState.half = half;
  else if (cropState.kind === 'sphere') { cropState.radius = half[0]; cropState.half = [half[0], half[0], half[0]]; }
  else { const span = md * 3; cropState.half = [span, span, Math.max(0.05, half[0] * 0.2)]; }
}
/** Regions that decide what survives: keep regions and delete regions, the crop among them
 *  whichever role it currently has. */
function cutRegions(): Region[] { return allRegions().filter(r => r.role === 'keep' || r.role === 'delete'); }
const removingInside = () => cropUI.on && cropState.role === 'delete';
/** The Keep inside / Remove inside pair, and the Apply button that follows it. */
function syncCropRoleUI() {
  const del = cropState.role === 'delete';
  $('k-cropkeep').classList.toggle('on', !del);
  $('k-cropdel').classList.toggle('on', del);
  $('k-cropapply').textContent = del ? 'Remove inside…' : 'Apply crop…';
}
function setCropRole(role: 'keep' | 'delete') {
  cropState.role = role;
  syncCropRoleUI();
  updateCropUI();
}
function cropReadouts() {
  const box = cropState.kind === 'box', slab = cropState.kind === 'slab';
  document.querySelectorAll('.box-only').forEach(el => (el as HTMLElement).style.display = box ? '' : 'none');
  $('v-cropsize').textContent = box ? `${(cropState.half[0] * 2).toFixed(1)} m` : slab ? `${(cropState.half[2] * 2).toFixed(2)} m thick` : `r ${cropState.radius.toFixed(1)} m`;
  $('v-cropsy').textContent = `${(cropState.half[1] * 2).toFixed(1)} m`; $('v-cropsz').textContent = `${(cropState.half[2] * 2).toFixed(1)} m`;
  const cuts = cutRegions();
  // estimateKept answers the same question either way: how many survive this set of regions
  const est = cuts.length && viewer.loaded ? viewer.cells.estimateKept(cuts) : 0;
  $('v-crop').textContent = cropped ? `cropped · ${fmt(viewer.loaded)} points in memory`
    : !cuts.length ? '—'
    : removingInside() ? `~${fmt(Math.max(0, viewer.loaded - est))} removed · ${fmt(est)} kept`
    : `~${fmt(est)} of ${fmt(viewer.loaded)} points inside`;
  $('v-sections').textContent = sections.length ? `${sections.length} section${sections.length > 1 ? 's' : ''} · union` : '—';
}
function updateCropUI(recenter = false) {
  if (recenter) { const b = viewer.bounds(); if (!b.isEmpty()) cropState.center = b.getCenter(new THREE.Vector3()).toArray() as any; }
  cropFromSliders(); syncRegions(); cropReadouts();
  if (cropUI.on) viewer.setActiveRegion('crop'); else if (viewer.activeRegion === 'crop') viewer.setActiveRegion(null);
  updateTransformUI();
  viewer.touch();
}
viewer.onRegionChange = (r) => {
  if (r.id === 'crop') {
    const md = maxDim();
    if (r.kind === 'slab') cropUI.frac[0] = Math.min(1, (r.half[2] * 2 / 0.2) / (md * 0.5) / 2);
    else cropUI.frac = r.half.map(h => Math.min(1, (h * 2) / md));
    $<HTMLInputElement>('k-cropsize').value = String(cropUI.frac[0]); $<HTMLInputElement>('k-cropsy').value = String(cropUI.frac[1] ?? cropUI.frac[0]); $<HTMLInputElement>('k-cropsz').value = String(cropUI.frac[2] ?? cropUI.frac[0]);
  }
  cropReadouts(); renderSectionList();
};
$('k-cropshape').addEventListener('change', e => { cropState.kind = (e.target as HTMLSelectElement).value as any; if (cropState.kind === 'sphere') cropState.quat = [0, 0, 0, 1]; updateCropUI(); });
$('k-cropon').addEventListener('change', e => { cropUI.on = (e.target as HTMLInputElement).checked; updateCropUI(); });
$('k-crophide').addEventListener('change', () => { syncRegions(); viewer.touch(); });
for (const [id, i] of [['k-cropsize', 0], ['k-cropsy', 1], ['k-cropsz', 2]] as [string, number][]) $(id).addEventListener('input', e => { cropUI.frac[i] = Number((e.target as HTMLInputElement).value); updateCropUI(); });
$('k-cropcentre').addEventListener('click', () => { cropState.center = viewer.controls.target.toArray() as any; cropUI.on = true; $<HTMLInputElement>('k-cropon').checked = true; updateCropUI(); });
/** One gizmo mode for whichever gizmo is attached — the crop region or the whole cloud —
 *  because only one of them is ever attached at a time. Both button rows follow it. */
const GIZMO_BTNS: [string, GizmoMode][] = [
  ['k-cropmove', 'translate'], ['k-croprotate', 'rotate'], ['k-cropresize', 'scale'],
  ['k-tmodemove', 'translate'], ['k-tmoderotate', 'rotate'], ['k-tmodescale', 'scale'],
];
function setGizmoMode(m: GizmoMode) {
  viewer.setGizmoMode(m);
  for (const [id, v] of GIZMO_BTNS) $(id).classList.toggle('on', v === m);
}
for (const [id, m] of GIZMO_BTNS) $(id).addEventListener('click', () => setGizmoMode(m));
function cancelCrop() {
  cropUI.on = false; $<HTMLInputElement>('k-cropon').checked = false;
  if (viewer.activeRegion === 'crop') viewer.setActiveRegion(null);
  updateCropUI();
}
function cancelStarted() {
  if (viewer.tool === 'segment') { if (segPts.length) { resetSegment(); return; } setTool('none'); return; }
  if (viewer.bubble) { viewer.exitBubble(); return; }
  if (viewer.tool !== 'none') { setTool('none'); return; }
  if (cropUI.on) { cancelCrop(); return; }
  viewer.setActiveRegion(null); renderSectionList();
}
/** Commit the crop: keep what is inside the region, or remove it, whichever mode it is in —
 *  together with any keep sections and any delete regions an agent has added. */
async function applyCrop() {
  const cuts = cutRegions();
  if (!viewer.loaded || !cuts.length) return null;
  const kept = viewer.cells.estimateKept(cuts);
  const gone = Math.max(0, viewer.loaded - kept);
  const removing = removingInside();
  const shape = cropUI.on ? `the ${cropState.kind}` : `${cuts.length} region${cuts.length > 1 ? 's' : ''}`;
  const tail = `<p>The file on disk is not touched. <b>Undo</b> puts the points back. <b>Save as…</b> writes a copy. <b>Escape</b> cancels.</p>`;
  const ans = removing
    ? await modal('Remove the points inside?',
        `<p>Everything inside ${shape} will be dropped from memory — roughly <b>${fmt(gone)}</b> points removed, <b>${fmt(kept)}</b> kept.</p>` + tail,
        [{ label: 'Cancel', value: 'no' }, { label: `Remove ${fmt(gone)}`, value: 'yes', cls: 'danger' }])
    : await modal('Apply crop?',
        `<p>Everything outside ${shape} will be dropped from memory — roughly <b>${fmt(gone)}</b> points removed, <b>${fmt(kept)}</b> of ${fmt(viewer.loaded)} kept.</p>` + tail,
        [{ label: 'Cancel', value: 'no' }, { label: 'Drop outside points', value: 'yes', cls: 'danger' }]);
  if (ans !== 'yes') return null;
  return commitApply(cuts, removing ? 'clean' : 'crop',
    res => `${removing ? 'Remove inside' : 'Crop'} · dropped ${fmt(res.dropped)}`, () => {
      cropped = true; cropUI.on = false; $<HTMLInputElement>('k-cropon').checked = false; sections.length = 0; deletes.length = 0;
      viewer.setActiveRegion(null);
    });
}
/** @deprecated the crop is not always a keep region; call applyCrop */
const applyKeep = applyCrop;
$('k-cropapply').addEventListener('click', () => { if (!cropUI.on && !sections.length) { cropUI.on = true; $<HTMLInputElement>('k-cropon').checked = true; updateCropUI(); } applyCrop(); });
$('k-cropkeep').addEventListener('click', () => setCropRole('keep'));
$('k-cropdel').addEventListener('click', () => setCropRole('delete'));
$('k-cropcancel').addEventListener('click', () => cancelCrop());

function snapUi() {
  return hist.snapshot({ cropped, cropOn: cropUI.on, crop: cropState, frac: cropUI.frac, sections, deletes });
}
function restoreUi(s: ReturnType<History['snapshot']>) {
  cropped = s.cropped;
  cropUI.on = s.cropOn; cropUI.frac = s.frac.slice();
  cropState.kind = s.crop.kind; cropState.role = s.crop.role;
  cropState.center = [...s.crop.center]; cropState.half = [...s.crop.half];
  cropState.radius = s.crop.radius; cropState.quat = [...s.crop.quat];
  $<HTMLInputElement>('k-cropon').checked = cropUI.on;
  $<HTMLSelectElement>('k-cropshape').value = cropState.kind;
  $<HTMLInputElement>('k-cropsize').value = String(cropUI.frac[0]);
  $<HTMLInputElement>('k-cropsy').value = String(cropUI.frac[1] ?? cropUI.frac[0]);
  $<HTMLInputElement>('k-cropsz').value = String(cropUI.frac[2] ?? cropUI.frac[0]);
  sections.length = 0; sections.push(...cloneRegions(s.sections));
  deletes.length = 0; deletes.push(...cloneRegions(s.deletes));
  syncCropRoleUI();
  syncRegions(); renderSectionList(); cropReadouts();
  if (cropUI.on) viewer.setActiveRegion('crop'); else if (viewer.activeRegion === 'crop') viewer.setActiveRegion(null);
  syncZLabels(); updateCacheUI(); updateHistUI(); viewer.touch();
}
async function commitApply(regions: Region[], kind: 'crop' | 'clean', label: string | ((res: { kept: number; dropped: number }) => string), after: () => void) {
  if (!regions.length || !viewer.loaded) return { kept: viewer.loaded, dropped: 0, undo: null };
  const before = snapUi();
  const robust = viewer.robust ? viewer.robust.clone() : viewer.cells.bounds.clone();
  busy(kind === 'crop' ? 'Cropping…' : 'Removing…'); await tick();
  const res = viewer.applyRegions(regions, true);
  if (!res.dropped) { hideBusy(); return res; }
  after();
  syncRegions();
  const afterSnap = snapUi();
  const lab = typeof label === 'function' ? label(res) : label;
  if (res.undo) await hist.push({ kind, label: lab, dropped: res.dropped, kept: res.kept, undo: res.undo, robust, before, after: afterSnap });
  hideBusy();
  $('v-loaded').textContent = `${fmt(res.kept)} points in memory · ${fmt(res.dropped)} dropped`;
  $('tb-points').textContent = `${fmt(res.kept)} pts · ${kind === 'crop' ? 'cropped' : 'cleaned'}`;
  if (kind === 'crop') updateCropUI(true); else updateCropUI();
  renderSectionList(); syncZLabels(); updateCacheUI(); updateHistUI(); viewer.fit();
  return res;
}
function updateHistUI() {
  const u = hist.canUndo, r = hist.canRedo, loaded = !!viewer.loaded;
  for (const id of ['k-undo', 'tb-undo']) { const b = $(id) as HTMLButtonElement; b.disabled = !u; b.title = u ? `Undo: ${hist.peekUndo()!.label}` : 'Nothing to undo'; }
  for (const id of ['k-redo', 'tb-redo']) { const b = $(id) as HTMLButtonElement; b.disabled = !r; b.title = r ? `Redo: ${hist.peekRedo()!.label}` : 'Nothing to redo'; }
  for (const id of ['k-save', 'tb-save']) { const b = $(id) as HTMLButtonElement; b.disabled = !loaded || !meta; }
  const bits: string[] = [];
  if (u || r) bits.push(`${hist.undo.length} undo · ${hist.redo.length} redo` + (hist.ram ? ` · ${mb(hist.ram)} in RAM` : hist.peekUndo()?.spilled || hist.peekRedo()?.spilled ? ' · spilled to disk' : '') + (hist.diskFail ? ' · disk unavailable, undo held in memory' : ''));
  else if (loaded) bits.push('no edits to undo');
  $('v-hist').textContent = bits.join(' · ') || '—';
}
async function undoEdit() {
  const e = hist.peekUndo(); if (!e || !viewer.loaded) return null;
  busy('Undoing…'); await tick();
  try {
    if (e.kind === 'transform') {
      viewer.setModel(new THREE.Matrix4().fromArray(e.transform!.prev));
      $('tb-points').textContent = `${fmt(viewer.loaded)} pts · transform undone`;
    } else if (e.kind === 'normals') {
      // swapNormals leaves the replaced bytes behind, so redo has something to put back
      await viewer.cells.swapNormals(e.normals!, i => hist.fetch(e, i));
      await hist.afterRedo(e);
      $('tb-points').textContent = `${fmt(viewer.loaded)} pts · normals restored`;
    } else {
      await viewer.undoRegions(e.undo!, i => hist.fetch(e, i));
      viewer.restoreBounds(e.robust);
      $('v-loaded').textContent = `${fmt(viewer.loaded)} points in memory`;
      $('tb-points').textContent = `${fmt(viewer.loaded)} pts · undone`;
    }
    restoreUi(e.before);
    hist.movedToRedo(e);
    updateHistUI(); updateTransformUI(); if (e.undo) viewer.fit(); viewer.touch();
    return e;
  } finally { hideBusy(); }
}
async function redoEdit() {
  const e = hist.peekRedo(); if (!e || !viewer.loaded) return null;
  busy('Redoing…'); await tick();
  try {
    if (e.kind === 'transform') {
      viewer.setModel(new THREE.Matrix4().fromArray(e.transform!.next));
      $('tb-points').textContent = `${fmt(viewer.loaded)} pts · ${e.label}`;
    } else if (e.kind === 'normals') {
      await viewer.cells.swapNormals(e.normals!, i => hist.fetch(e, i));
      await hist.afterRedo(e);
      $('tb-points').textContent = `${fmt(viewer.loaded)} pts · normals reapplied`;
    } else {
      const res = viewer.redoRegions(e.undo!);
      viewer.restoreBounds(null);
      await hist.afterRedo(e);
      $('v-loaded').textContent = `${fmt(res.kept)} points in memory · ${fmt(res.dropped)} dropped`;
      $('tb-points').textContent = `${fmt(res.kept)} pts · redone`;
    }
    restoreUi(e.after);
    hist.movedToUndo(e);
    updateHistUI(); updateTransformUI(); if (e.undo) viewer.fit(); viewer.touch();
    return e;
  } finally { hideBusy(); }
}
function exportFormat(): 'e57' | 'las' | 'ply' {
  const fromFile = (currentFile?.name ?? meta?.scans?.[0]?.name ?? '').toLowerCase().split('.').pop();
  if (fromFile === 'e57' || fromFile === 'las' || fromFile === 'ply') return fromFile;
  const sel = $<HTMLSelectElement>('k-fmt')?.value;
  if (sel === 'e57' || sel === 'las' || sel === 'ply') return sel;
  return 'e57';
}
async function pickSaveHandle(name: string, fmtSel: string): Promise<any | null | undefined> {
  const anyWin = window as any;
  if (!anyWin.showSaveFilePicker) return undefined; // no picker: caller will trigger a download
  try {
    return await anyWin.showSaveFilePicker({
      suggestedName: name,
      types: [{ description: fmtSel.toUpperCase() + ' point cloud', accept: { 'application/octet-stream': ['.' + fmtSel] } }],
    });
  } catch { return null; } // user cancelled
}
async function writeOutFile(r: { file: File; name: string; scratch: string }, handle: any | undefined) {
  if (handle) { const w = await handle.createWritable(); await r.file.stream().pipeTo(w); io.postMessage({ type: 'export-cleanup', name: r.scratch }); }
  else {
    const url = URL.createObjectURL(r.file); const a = document.createElement('a'); a.href = url; a.download = r.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { URL.revokeObjectURL(url); io.postMessage({ type: 'export-cleanup', name: r.scratch }); }, 10 * 60 * 1000);
  }
}
async function saveCurrent() {
  if (!viewer.loaded || !meta) {
    await modal('Nothing to save', '<p>Load a scan first. Save as writes a copy of the points now in memory — including any crop or clean-up — to a file you choose.</p>', [{ label: 'OK', value: 'ok', cls: 'primary' }]);
    return;
  }
  const fmtSel = exportFormat();
  const nU = hist.undo.length, nR = hist.redo.length;
  const parts = [
    `<p>Writes the <b>${fmt(viewer.loaded)}</b> points in memory to a <b>${fmtSel.toUpperCase()}</b> file you choose. The original file on disk is never overwritten.</p>`,
    (nU || nR) ? `<p><b>Undo (${nU}) and redo (${nR})</b> will be emptied after a successful save.</p>` : '',
    fromCache
      ? `<p>The cached copy on this device will be replaced by these ${fmt(viewer.loaded)} points.</p>`
      : `<p>This scan is not cached on this device, so nothing is written there.</p>`,
  ].filter(Boolean).join('');
  const ans = await modal('Save as…', parts, [{ label: 'Cancel', value: 'no' }, { label: 'Choose location…', value: 'yes', cls: 'primary' }]);
  if (ans !== 'yes') return;
  const base = (currentFile?.name ?? meta?.scans?.[0]?.name ?? 'scan').replace(/\.(e57|ply|las)$/i, '');
  const suggested = `${base}${cropped ? '-crop' : ''}.${fmtSel}`;
  const handle = await pickSaveHandle(suggested, fmtSel);
  if (handle === null) return;
  busy('Preparing file…');
  try {
    const r = await runExport(fmtSel, 1);
    busy('Saving…');
    await writeOutFile(r, handle);
    let cacheUpdated = false;
    if (currentFile && fromCache) { try { await writeCache(); cacheUpdated = true; } catch {} }
    cacheNote = '';
    await hist.clear();
    clearDirty();
    updateHistUI(); updateCacheUI();
    $('v-export').textContent = `saved ${r.name} · ${fmt(r.count)} points · ${mb(r.bytes)}`;
    $('tb-points').textContent = `${fmt(r.count)} pts · saved`;
    if (currentFile) $('v-cache').textContent = cacheUpdated ? `saved ${r.name} · cache updated · undo cleared` : `saved ${r.name} · undo cleared`;
  } catch (e: any) { fail('Could not save: ' + (e?.message ?? e)); }
  finally { hideBusy(); }
}
// -------------------------------------------------------- unsaved work
// One notion of "dirty", so every route to another scan asks the same question and names the
// same things. Point edits, normals and transforms are already recorded in the history — it
// is exactly the list of changes that have not been written to a file — and the two that are
// not (a scalar field, a reconstructed surface) are marked here. Cleared by Save as…, a
// reload and an open, because each of those makes what is in memory match what is on disk.
const dirtyMark = { field: '', surface: 0 };
function clearDirty() { dirtyMark.field = ''; dirtyMark.surface = 0; }
const triangles = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : fmt(n);
/** What would be lost if the loaded scan were replaced now, in plain words. */
function dirtyList(): string[] {
  const out: string[] = [];
  const kinds = hist.undo.map(e => e.kind);
  const edits = kinds.filter(k => k === 'crop' || k === 'clean').length;
  if (edits) out.push(`${edits} edit${edits > 1 ? 's' : ''}`);
  if (kinds.includes('normals')) out.push('computed normals');
  if (dirtyMark.field) out.push(`a scalar field (${dirtyMark.field})`);
  if (dirtyMark.surface) out.push(`a ${triangles(dirtyMark.surface)}-triangle surface`);
  if (kinds.includes('transform')) out.push('a transform');
  return out;
}
const isDirty = () => dirtyList().length > 0;

/** The one guard in front of replacing the loaded scan. Returns true to go ahead. */
async function confirmReplace(): Promise<boolean> {
  const lost = dirtyList();
  if (!lost.length) return true;
  const ans = await modal('Open another scan?',
    `<p>This scan has unsaved work: <b>${lost.join(' · ')}</b>.</p>` +
    `<p>Opening another scan discards it. The file on disk was never changed — <b>Save as…</b> writes a copy of what is in memory, including the crop and the transform, to a file you choose.</p>`,
    [{ label: 'Cancel', value: 'no' }, { label: 'Save as… first', value: 'save' }, { label: 'Open anyway', value: 'yes', cls: 'danger' }]);
  if (ans === 'save') {
    await saveCurrent();
    return !isDirty();          // a cancelled or failed save must not lose the work
  }
  return ans === 'yes';
}
async function reloadScan() {
  if (!currentFile) return;
  const lost = dirtyList();
  if (lost.length) {
    const ans = await modal('Reload the scan?',
      `<p>This scan has unsaved work: <b>${lost.join(' · ')}</b>. Reload discards it and reads the scan again from ${fromCache ? 'the cache on this device' : 'disk'}.</p>`,
      [{ label: 'Cancel', value: 'no' }, { label: 'Reload anyway', value: 'yes', cls: 'danger' }]);
    if (ans !== 'yes') return;
  }
  await hist.clear();
  if (currentFile) openFile(currentFile, currentHandle);
}
hist.onChange = () => updateHistUI();
$('k-undo').addEventListener('click', () => undoEdit());
$('k-redo').addEventListener('click', () => redoEdit());
$('k-save').addEventListener('click', () => saveCurrent());
$('tb-undo').addEventListener('click', () => undoEdit());
$('tb-redo').addEventListener('click', () => redoEdit());
$('tb-save').addEventListener('click', () => saveCurrent());

function addSection(center?: number[]) {
  const md = maxDim(); const c = center ?? viewer.controls.target.toArray();
  const r: Region = { id: uid('sec-'), kind: 'slab', role: 'keep', label: `Section ${sections.length + 1}`, center: c as any, half: [md * 3, md * 3, 1.5], radius: 0, quat: [0, 0, 0, 1] };
  sections.push(r); syncRegions(); viewer.setActiveRegion(r.id); renderSectionList(); cropReadouts(); return r;
}
$('k-secadd').addEventListener('click', () => addSection());
function renderSectionList() {
  const ul = $('sec-list'); ul.innerHTML = '';
  for (const s of sections) {
    const li = document.createElement('li'); li.classList.toggle('sel', viewer.activeRegion === s.id);
    li.innerHTML = `<span class="ok">${s.label}</span> <span class="mono">${(s.half[2] * 2).toFixed(2)} m thick · z ${s.center[2].toFixed(1)}</span><span class="x" title="Remove">✕</span>`;
    li.querySelector('.ok')!.addEventListener('click', () => { viewer.setActiveRegion(s.id); renderSectionList(); });
    li.querySelector('.x')!.addEventListener('click', () => { sections.splice(sections.indexOf(s), 1); syncRegions(); renderSectionList(); cropReadouts(); });
    ul.appendChild(li);
  }
}

// ------------------------------------------------------------------ cloud transform
// The points are never baked. They stay quantised in their original leaf cubes and the
// cloud carries a 4x4 matrix that every consumer applies: the vertex shader, the region and
// lasso tests, the mesher, the analyser and the exporters. So a transform costs nothing,
// loses no precision to requantisation, and undoes with two matrices instead of a copy of
// the cloud. Only a written file bakes it.

/** Row-major, the order a human writes a matrix and the order the Rust side expects. */
function rowMajor(m: THREE.Matrix4): number[] {
  const e = m.elements;   // three.js stores column-major
  return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]];
}
function fromRowMajor(v: number[]): THREE.Matrix4 {
  return new THREE.Matrix4().set(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11], v[12], v[13], v[14], v[15]);
}
const modelF32 = () => new Float32Array(rowMajor(viewer.cells.model));

function boundsCentre(): THREE.Vector3 {
  const b = viewer.bounds();
  return b.isEmpty() ? new THREE.Vector3() : b.getCenter(new THREE.Vector3());
}
/** `m` applied on top of whatever transform the cloud already carries. */
const thenModel = (m: THREE.Matrix4) => m.clone().multiply(viewer.cells.model);
/** A rotation (or any linear map) taken about a pivot rather than the origin. */
function about(pivot: THREE.Vector3, inner: THREE.Matrix4): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(inner)
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
}
function rotationMatrix(axis: string, deg: number, pivot: 'centre' | 'origin'): THREE.Matrix4 {
  const r = new THREE.Matrix4();
  const a = deg * Math.PI / 180;
  if (axis === 'x') r.makeRotationX(a); else if (axis === 'y') r.makeRotationY(a); else r.makeRotationZ(a);
  return thenModel(pivot === 'origin' ? r : about(boundsCentre(), r));
}

/** Push the undo step for a transform that has **already** been applied. */
async function pushTransformStep(prev: THREE.Matrix4, next: THREE.Matrix4, label: string) {
  if (prev.equals(next)) return null;
  const before = snapUi();
  const e = await hist.push({
    kind: 'transform', label, dropped: 0, kept: viewer.loaded, undo: null,
    transform: { prev: prev.elements.slice(), next: next.elements.slice() },
    robust: viewer.robust ? viewer.robust.clone() : viewer.cells.bounds.clone(),
    before, after: snapUi(),
  });
  cacheNote = 'cache holds the previous transform — Save as… updates it';
  updateTransformUI(); updateCacheUI(); updateHistUI();
  return e;
}
async function commitTransform(next: THREE.Matrix4, label: string) {
  if (!viewer.loaded) return null;
  const prev = viewer.cells.model.clone();
  if (prev.equals(next)) { updateTransformUI(); return null; }
  viewer.setModel(next);
  syncZLabels(); cropReadouts();
  const e = await pushTransformStep(prev, next, label);
  viewer.touch();
  return e;
}

/** Smallest-eigenvalue eigenvector of a symmetric 3x3 matrix, by cyclic Jacobi rotations —
 *  the normal of the plane that best fits the points the covariance came from. */
function leastEigenvector(c: number[][]): THREE.Vector3 {
  const a = c.map(r => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let p = 0, q = 1, off = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (Math.abs(a[i][j]) > off) { off = Math.abs(a[i][j]); p = i; q = j; }
    if (off < 1e-16) break;
    const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
    const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
    for (let k = 0; k < 3; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = cs * kp - sn * kq; a[k][q] = sn * kp + cs * kq; }
    for (let k = 0; k < 3; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = cs * pk - sn * qk; a[q][k] = sn * pk + cs * qk; }
    for (let k = 0; k < 3; k++) { const kp = v[k][p], kq = v[k][q]; v[k][p] = cs * kp - sn * kq; v[k][q] = sn * kp + cs * kq; }
  }
  const ev = [a[0][0], a[1][1], a[2][2]];
  let m = 0; for (let i = 1; i < 3; i++) if (ev[i] < ev[m]) m = i;
  return new THREE.Vector3(v[0][m], v[1][m], v[2][m]).normalize();
}
/** Normal of the plane fitting a uniform sample of the cloud, in world space. */
function samplePlaneNormal(): THREE.Vector3 | null {
  let n = 0, sx = 0, sy = 0, sz = 0;
  const chunks: Float64Array[] = [];
  for (const { leaf, recs, n: cnt } of viewer.cells.sample(600)) {
    const xyz = viewer.cells.transformRecordsInto(recs, cnt, leaf, new Float64Array(cnt * 3));
    chunks.push(xyz);
    for (let i = 0; i < cnt; i++) { sx += xyz[i * 3]; sy += xyz[i * 3 + 1]; sz += xyz[i * 3 + 2]; }
    n += cnt;
  }
  if (n < 16) return null;
  const mx = sx / n, my = sy / n, mz = sz / n;
  const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const xyz of chunks) {
    for (let i = 0; i < xyz.length; i += 3) {
      const d = [xyz[i] - mx, xyz[i + 1] - my, xyz[i + 2] - mz];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) c[a][b] += d[a] * d[b];
    }
  }
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) c[a][b] /= n;
  const nrm = leastEigenvector(c);
  return nrm.z < 0 ? nrm.negate() : nrm;    // keep the cloud the right way up
}
async function levelCloud() {
  if (!viewer.loaded) return null;
  busy('Fitting a plane…'); await tick();
  let nrm: THREE.Vector3 | null = null;
  try { nrm = samplePlaneNormal(); } finally { hideBusy(); }
  if (!nrm) { $('v-transform').textContent = 'not enough points to fit a plane'; return null; }
  const tilt = Math.acos(Math.min(1, Math.abs(nrm.z))) * 180 / Math.PI;
  const q = new THREE.Quaternion().setFromUnitVectors(nrm, new THREE.Vector3(0, 0, 1));
  const r = about(boundsCentre(), new THREE.Matrix4().makeRotationFromQuaternion(q));
  return commitTransform(thenModel(r), `Level · ${tilt.toFixed(2)}° off horizontal`);
}

function transformState() {
  const m = viewer.cells.model;
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  m.decompose(pos, q, sc);
  const ang = 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI;
  const ax = new THREE.Vector3(q.x, q.y, q.z);
  if (ax.lengthSq() > 1e-14) ax.normalize(); else ax.set(0, 0, 1);
  const b = viewer.bounds();
  return {
    matrix: rowMajor(m).map(v => +v.toFixed(9)), identity: m.equals(new THREE.Matrix4()),
    translation: pos.toArray().map(v => +v.toFixed(6)),
    rotationDeg: +ang.toFixed(4), rotationAxis: ax.toArray().map(v => +v.toFixed(6)),
    scale: sc.toArray().map(v => +v.toFixed(6)),
    globalShift: (meta?.scans?.[0]?.translation ?? null) as number[] | null,
    bounds: b.isEmpty() ? null : { min: b.min.toArray(), max: b.max.toArray() },
  };
}
function updateTransformUI() {
  const st = transformState();
  const bits: string[] = [];
  const [tx, ty, tz] = st.translation;
  if (Math.hypot(tx, ty, tz) > 1e-6) bits.push(`shift ${tx.toFixed(3)}, ${ty.toFixed(3)}, ${tz.toFixed(3)} m`);
  if (st.rotationDeg > 0.005) bits.push(`rotate ${st.rotationDeg.toFixed(2)}° about (${st.rotationAxis.map(v => v.toFixed(2)).join(', ')})`);
  if (st.scale.some(v => Math.abs(v - 1) > 1e-6)) bits.push(`scale ${st.scale.map(v => v.toFixed(4)).join(' / ')}`);
  $('v-transform').textContent = bits.length ? bits.join(' · ') : 'no transform';
  const t = st.globalShift;
  $('v-shift').textContent = t ? `E ${t[0].toFixed(3)}   N ${t[1].toFixed(3)}   Z ${t[2].toFixed(3)}` : '—';
  $<HTMLInputElement>('k-tdrag').checked = viewer.modelGizmo;
}

const num = (id: string) => { const v = Number($<HTMLInputElement>(id).value); return isFinite(v) ? v : 0; };
$('k-tmove').addEventListener('click', () => {
  const t = new THREE.Vector3(num('k-tx'), num('k-ty'), num('k-tz'));
  if (t.lengthSq() === 0) return;
  commitTransform(thenModel(new THREE.Matrix4().makeTranslation(t.x, t.y, t.z)),
    `Move ${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)} m`);
});
$('k-trot').addEventListener('click', () => {
  const deg = num('k-tdeg'), axis = $<HTMLSelectElement>('k-taxis').value;
  const pivot = $<HTMLSelectElement>('k-tabout').value === 'origin' ? 'origin' : 'centre';
  if (!deg) return;
  commitTransform(rotationMatrix(axis, deg, pivot), `Rotate ${deg.toFixed(1)}° about ${axis.toUpperCase()}`);
});
$('k-tscalego').addEventListener('click', () => {
  const f = num('k-tscale');
  if (!(f > 0) || Math.abs(f - 1) < 1e-9) return;
  commitTransform(thenModel(about(boundsCentre(), new THREE.Matrix4().makeScale(f, f, f))), `Scale ×${f}`);
});
$('k-tlevel').addEventListener('click', () => { levelCloud(); });
$('k-tcentre').addEventListener('click', () => {
  const c = boundsCentre();
  commitTransform(thenModel(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z)), 'Move centre to origin');
});
$('k-tmincorner').addEventListener('click', () => {
  const b = viewer.bounds(); if (b.isEmpty()) return;
  commitTransform(thenModel(new THREE.Matrix4().makeTranslation(-b.min.x, -b.min.y, -b.min.z)), 'Move min corner to origin');
});
$('k-treset').addEventListener('click', () => commitTransform(new THREE.Matrix4(), 'Reset transform'));
$('k-tdrag').addEventListener('change', e => {
  viewer.setModelGizmo((e.target as HTMLInputElement).checked);
  if (viewer.modelGizmo) { cropUI.on = false; $<HTMLInputElement>('k-cropon').checked = false; updateCropUI(); }
  updateTransformUI();
});
viewer.onModelDrag = (done, base) => {
  updateTransformUI();
  if (!done) { cropReadouts(); return; }
  syncZLabels();
  void pushTransformStep(base, viewer.cells.model.clone(), `Drag · ${viewer.gizmoMode}`);
};

/** Type a matrix in. Row-major because that is how one is written down and printed. */
async function matrixModal() {
  for (;;) {
    const cur = rowMajor(viewer.cells.model);
    const txt = [0, 4, 8, 12].map(i => cur.slice(i, i + 4).map(v => v.toFixed(6).padStart(12)).join(' ')).join('\n');
    const ans = await modal('Apply a matrix',
      `<p>Sixteen numbers, <b>row-major</b>: three rows of rotation/scale with a translation on the right, then <span class="mono">0 0 0 1</span>. Whitespace or commas, newlines optional. This replaces the current transform rather than adding to it.</p>` +
      `<textarea id="tm-txt" rows="5" spellcheck="false">${txt}</textarea>` +
      `<p class="hint mono">The points are not rewritten — this is the matrix they are drawn through.</p>`,
      [{ label: 'Cancel', value: 'no' }, { label: 'Copy matrix', value: 'copy' }, { label: 'Apply', value: 'yes', cls: 'primary' }]);
    const raw = ($('tm-txt') as HTMLTextAreaElement | null)?.value ?? '';
    if (ans === 'copy') { try { await navigator.clipboard.writeText(txt); } catch {} continue; }
    if (ans !== 'yes') return;
    const v = raw.trim().split(/[\s,;]+/).filter(Boolean).map(Number);
    if (v.length !== 16 || v.some(x => !isFinite(x))) {
      await modal('That is not a 4×4 matrix', `<p>Sixteen finite numbers are needed; this has <b>${v.length}</b>${v.some(x => !isFinite(x)) ? ', and some are not numbers' : ''}.</p>`,
        [{ label: 'Back', value: 'ok', cls: 'primary' }]);
      continue;
    }
    await commitTransform(fromRowMajor(v), 'Apply matrix');
    return;
  }
}
$('k-tmatrix').addEventListener('click', () => matrixModal());

/** The scan's own pose offset. Not a transform: it changes exported coordinates and the
 *  readout, and nothing on screen, because the viewer always works shifted to local. */
async function shiftModal() {
  const s = meta?.scans?.[0];
  if (!s) return;
  const t = (s.translation ?? [0, 0, 0]) as number[];
  const ans = await modal('Global shift',
    `<p>The offset added back to every point when a file is written, and the number shown as <b>E / N / Z</b> in the coordinate readout. The viewer draws everything shifted to local metres, so changing this moves nothing on screen.</p>` +
    `<div class="trio"><input id="gs-x" type="number" step="0.001" value="${t[0]}" aria-label="Easting"><input id="gs-y" type="number" step="0.001" value="${t[1]}" aria-label="Northing"><input id="gs-z" type="number" step="0.001" value="${t[2]}" aria-label="Z"></div>` +
    `<p class="hint mono">E · N · Z, metres. This is not undoable.</p>`,
    [{ label: 'Cancel', value: 'no' }, { label: 'Set', value: 'yes', cls: 'primary' }]);
  if (ans !== 'yes') return;
  const v = ['gs-x', 'gs-y', 'gs-z'].map(id => Number(($(id) as HTMLInputElement).value));
  if (v.some(x => !isFinite(x))) return;
  s.translation = v;
  cacheNote = fromCache ? 'cache holds the previous global shift — Save as… updates it' : cacheNote;
  updateTransformUI(); updateCacheUI();
}
$('k-tshift').addEventListener('click', () => shiftModal());

// ------------------------------------------------------------------ freehand selection
// A polygon traced on screen, then kept or cut. The points are tested in screen space, so
// what you draw is exactly what you get, from whatever angle you are looking.
let segPts: [number, number][] = [];
let segHover: [number, number] | null = null;
function resetSegment() { segPts = []; segHover = null; drawSegment(); }
function endSegment() { segPts = []; segHover = null; drawSegment(); $('segbar').classList.add('hidden'); $('seg').classList.add('hidden'); }
function drawSegment() {
  const line = $('seg-line') as unknown as SVGPolylineElement;
  const fill = $('seg-fill') as unknown as SVGPolygonElement;
  const pts = segHover ? [...segPts, segHover] : segPts;
  line.setAttribute('points', pts.map(p => p.join(',')).join(' ') + (segPts.length > 1 ? ' ' + segPts[0].join(',') : ''));
  fill.setAttribute('points', segPts.length > 2 ? segPts.map(p => p.join(',')).join(' ') : '');
  const ready = segPts.length >= 3;
  ($('seg-in') as HTMLButtonElement).disabled = !ready;
  ($('seg-out') as HTMLButtonElement).disabled = !ready;
  $('seg-hint').textContent = segPts.length === 0
    ? 'Click to trace a shape · Esc to cancel'
    : ready ? `${segPts.length} points · keep what is inside or outside` : `${segPts.length} of 3 points`;
}
{
  const gl = $('gl');
  gl.addEventListener('pointerdown', e => {
    if (viewer.tool !== 'segment' || (e as PointerEvent).button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const r = gl.getBoundingClientRect();
    segPts.push([(e as PointerEvent).clientX - r.left, (e as PointerEvent).clientY - r.top]);
    drawSegment();
  }, true);
  gl.addEventListener('pointermove', e => {
    if (viewer.tool !== 'segment' || !segPts.length) return;
    const r = gl.getBoundingClientRect();
    segHover = [(e as PointerEvent).clientX - r.left, (e as PointerEvent).clientY - r.top];
    drawSegment();
  });
  gl.addEventListener('dblclick', e => {
    if (viewer.tool !== 'segment') return;
    e.preventDefault(); e.stopPropagation();
    segHover = null; drawSegment();
  }, true);
}
async function applySegment(inside: boolean) {
  if (segPts.length < 3) return;
  const r = $('gl').getBoundingClientRect();
  const poly = segPts.slice();
  busy('Testing points against the shape…'); await tick();
  let masks: Uint8Array[];
  try { masks = viewer.polygonMask(poly, inside, r.width, r.height); }
  finally { hideBusy(); }
  endSegment();
  setTool('none');
  await commitMask(inside ? 'Keep inside the shape' : 'Keep outside the shape', masks, '', false);
}
$('seg-in').addEventListener('click', () => applySegment(true));
$('seg-out').addEventListener('click', () => applySegment(false));
$('seg-cancel').addEventListener('click', () => setTool('none'));
$('k-segment').addEventListener('click', () => setTool(viewer.tool === 'segment' ? 'none' : 'segment'));

// ------------------------------------------------------------------ neighbourhood analysis
const anaWorker = new Worker(new URL('./analysis-worker.ts', import.meta.url), { type: 'module' });
const anaWaiters = new Map<string, (m: any) => void>();
let anaError: string | null = null;
let anaAlive = true;
let sfName = '';
anaWorker.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === 'progress') {
    busy(m.total ? `${m.phase}… ${fmt(m.done)} of ${fmt(m.total)}` : `${m.phase}… ${fmt(m.done)} points`,
      m.total ? m.done / m.total : undefined);
    return;
  }
  if (m.type === 'error') {
    anaError = m.message ?? 'analysis failed';
    anaAlive = false;
    const rej = anaWaiters.get('error');
    anaWaiters.clear();
    rej?.(m);
    return;
  }
  const w = anaWaiters.get(m.type);
  if (w) { anaWaiters.delete(m.type); anaWaiters.delete('error'); w(m); }
};
function anaOnce(type: string): Promise<any> {
  if (anaError) return Promise.reject(new Error(anaError));
  return new Promise((res, rej) => {
    anaWaiters.set(type, res);
    anaWaiters.set('error', (m: any) => rej(new Error(m.message ?? 'analysis failed')));
  });
}

/** Feed every leaf to the analyser, run one operation, and hand back the flat result. */
async function runAnalysis(op: string, args: Record<string, any> = {}): Promise<any> {
  if (!viewer.loaded) throw new Error('nothing loaded');
  const counts: number[] = [];
  busy('Starting the analyser…'); await tick();
  anaAlive = true; anaError = null;
  // one grid cell per few points keeps the neighbour search in the 27 cells around a point
  const cell = Math.max(viewer.cells.medianSpacing * 2.5, 0.01);
  anaWorker.postMessage({ type: 'start', cell, maxPoints: isTouch ? 8e6 : 30e6, model: rowMajor(viewer.cells.model) });
  await anaOnce('ready');
  let n = 0;
  const total = viewer.cells.leafCount;
  for (const { leaf, recs } of viewer.cells.records()) {
    if (!anaAlive) break;
    counts.push(leaf.count);
    const buf = recs.buffer as ArrayBuffer;
    anaWorker.postMessage({ type: 'leaf', origin: leaf.origin.toArray(), size: leaf.size, recs: buf }, [buf]);
    if (++n % 8 === 0) { busy(`Reading cells… ${n} of ${total}`, n / Math.max(total, 1)); await tick(); }
  }
  anaWorker.postMessage({ type: 'run', op, ...args });
  const res = await anaOnce('result');
  return { ...res, counts };
}

/** Split a flat per-point array back into one piece per leaf. */
function perLeaf<T extends Float32Array | Uint8Array>(flat: T, counts: number[]): T[] {
  const out: T[] = [];
  let at = 0;
  for (const c of counts) { out.push(flat.subarray(at, at + c) as T); at += c; }
  return out;
}

function setScalarField(name: string, flat: Float32Array, counts: number[]) {
  viewer.cells.setScalarField(perLeaf(flat, counts).map(a => new Float32Array(a)));
  sfName = name;
  dirtyMark.field = name;
  document.body.classList.add('has-sf');
  ($('k-color-sf') as HTMLOptionElement).disabled = false;
  knobs.colorMode = 5;
  $<HTMLSelectElement>('k-color').value = '5';
  autoScalarRange();
  refreshScalarUI();
  viewer.touch();
}
function clearScalarField() {
  viewer.cells.clearScalarField();
  sfName = ''; dirtyMark.field = '';
  document.body.classList.remove('has-sf', 'sf-filtering');
  ($('k-color-sf') as HTMLOptionElement).disabled = true;
  ($('k-sffilter') as HTMLInputElement).checked = false;
  if (knobs.colorMode === 5) { knobs.colorMode = 0; $<HTMLSelectElement>('k-color').value = '0'; }
  viewer.sf.hi = -1;
  $('v-sfname').textContent = 'no field';
  viewer.touch();
}

// The four sliders work in percent of the field's own range, so one control suits a
// roughness in millimetres and a cluster label in the thousands.
let sfStats: { min: number; max: number; hist: Uint32Array; n: number } | null = null;
const sfPct = (id: string) => Number($<HTMLInputElement>(id).value) / 1000;
const sfValue = (id: string) => sfStats ? sfStats.min + sfPct(id) * (sfStats.max - sfStats.min) : 0;
const sfFmt = (v: number) => Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(2) : v.toFixed(3);

function autoScalarRange() {
  sfStats = viewer.cells.scalarStats();
  if (!sfStats) return;
  // 2nd to 98th percentile, so one wild value cannot flatten the ramp
  const { hist, n } = sfStats;
  let acc = 0, lo = 0, hi = hist.length - 1;
  for (let i = 0; i < hist.length; i++) { acc += hist[i]; if (acc >= n * 0.02) { lo = i; break; } }
  acc = 0;
  for (let i = hist.length - 1; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.02) { hi = i; break; } }
  $<HTMLInputElement>('k-sfmin').value = String(Math.round(lo / hist.length * 1000));
  $<HTMLInputElement>('k-sfmax').value = String(Math.round((hi + 1) / hist.length * 1000));
  $<HTMLInputElement>('k-sflo').value = $<HTMLInputElement>('k-sfmin').value;
  $<HTMLInputElement>('k-sfhi').value = $<HTMLInputElement>('k-sfmax').value;
}

function drawScalarHistogram() {
  const cv = $('sf-hist') as HTMLCanvasElement;
  const w = cv.clientWidth || 260, h = 52;
  cv.width = Math.round(w * devicePixelRatio); cv.height = Math.round(h * devicePixelRatio);
  const g = cv.getContext('2d')!;
  g.scale(devicePixelRatio, devicePixelRatio);
  g.clearRect(0, 0, w, h);
  if (!sfStats) return;
  const { hist } = sfStats;
  const peak = Math.max(1, ...Array.from(hist));
  const lo = sfPct('k-sfmin'), hi = sfPct('k-sfmax');
  for (let i = 0; i < hist.length; i++) {
    const x = i / hist.length * w, bw = Math.max(1, w / hist.length);
    const bh = Math.sqrt(hist[i] / peak) * (h - 6);
    const t = i / hist.length;
    g.fillStyle = t >= lo && t <= hi ? '#46c6d2' : '#2a3a40';
    g.fillRect(x, h - bh, bw, bh);
  }
}

function refreshScalarUI() {
  if (!sfStats) sfStats = viewer.cells.scalarStats();
  viewer.sf.min = sfValue('k-sfmin');
  viewer.sf.max = sfValue('k-sfmax');
  const filtering = $<HTMLInputElement>('k-sffilter').checked;
  document.body.classList.toggle('sf-filtering', filtering);
  viewer.sf.lo = filtering ? sfValue('k-sflo') : 0;
  viewer.sf.hi = filtering ? sfValue('k-sfhi') : -1;
  viewer.sf.hide = $<HTMLInputElement>('k-sfhide').checked;
  $('v-sfmin').textContent = sfFmt(viewer.sf.min);
  $('v-sfmax').textContent = sfFmt(viewer.sf.max);
  $('v-sflo').textContent = sfFmt(sfValue('k-sflo'));
  $('v-sfhi').textContent = sfFmt(sfValue('k-sfhi'));
  if (sfStats) $('v-sfname').textContent = `${sfName} · ${fmt(sfStats.n)} values · ${sfFmt(sfStats.min)} to ${sfFmt(sfStats.max)}`;
  drawScalarHistogram();
  viewer.touch();
}
for (const id of ['k-sfmin', 'k-sfmax', 'k-sflo', 'k-sfhi']) $(id).addEventListener('input', refreshScalarUI);
for (const id of ['k-sffilter', 'k-sfhide']) $(id).addEventListener('change', refreshScalarUI);
$('k-sfauto').addEventListener('click', () => { autoScalarRange(); refreshScalarUI(); });
$('k-sfclear').addEventListener('click', () => clearScalarField());

/** A removal driven by a per-point mask, with the same confirmation and undo as a crop. */
async function commitMask(label: string, masks: Uint8Array[], promptText: string, confirm = true) {
  let drop = 0, keepN = 0;
  for (const m of masks) for (let i = 0; i < m.length; i++) { if (m[i]) keepN++; else drop++; }
  if (!drop) { $('v-analysis').textContent = 'nothing matched — no points removed'; return null; }
  if (confirm) {
    const ans = await modal(label, promptText.replace('{n}', fmt(drop)).replace('{k}', fmt(keepN)),
      [{ label: 'Cancel', value: 'no' }, { label: `Remove ${fmt(drop)}`, value: 'yes', cls: 'danger' }]);
    if (ans !== 'yes') return null;
  }
  const before = snapUi();
  const robust = viewer.robust ? viewer.robust.clone() : viewer.cells.bounds.clone();
  busy('Removing…'); await tick();
  const res = viewer.cells.applyMask((_l, i) => masks[i] ?? null, true);
  viewer.restoreBounds(robust);
  cropped = true;
  if (res.undo) await hist.push({ kind: 'clean', label, dropped: res.dropped, kept: res.kept, undo: res.undo, robust, before, after: snapUi() });
  hideBusy();
  sfStats = null;
  if (viewer.cells.hasScalarField) refreshScalarUI();
  $('v-loaded').textContent = `${fmt(res.kept)} points in memory · ${fmt(res.dropped)} dropped`;
  $('tb-points').textContent = `${fmt(res.kept)} pts · cleaned`;
  updateCacheUI(); updateHistUI(); viewer.touch();
  return res;
}

const anaUi = { k: 16, sigma: 1.0, spacing: 0.1 };
function syncAnaLabels() {
  $('v-ank').textContent = String(anaUi.k);
  $('v-ansigma').textContent = anaUi.sigma.toFixed(1) + ' σ';
  $('v-anspace').textContent = anaUi.spacing.toFixed(2) + ' m';
}
$('k-ank').addEventListener('input', e => { anaUi.k = +(e.target as HTMLInputElement).value; syncAnaLabels(); });
$('k-ansigma').addEventListener('input', e => { anaUi.sigma = +(e.target as HTMLInputElement).value; syncAnaLabels(); });
$('k-anspace').addEventListener('input', e => { anaUi.spacing = +(e.target as HTMLInputElement).value; syncAnaLabels(); });

async function analysis(op: string, args: Record<string, any> = {}, note = '') {
  const t0 = performance.now();
  try {
    const r = await runAnalysis(op, args);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (r.kind === 'normals') {
      // patch the new normals into each leaf's records, in the order they were fed, keeping
      // the bytes that were there so the change is undoable like any other edit
      const before = snapUi();
      const prev = viewer.cells.writeNormals(r.data as Int8Array);
      await hist.push({
        kind: 'normals', label: note || 'Normals', dropped: 0, kept: viewer.loaded, undo: null,
        normals: prev, robust: viewer.robust ? viewer.robust.clone() : viewer.cells.bounds.clone(),
        before, after: snapUi(),
      });
      cacheNote = 'cache holds old normals — Save as… updates it';
      $('v-analysis').textContent = `${note} · ${fmt(r.points)} points · ${secs}s`;
      updateCacheUI(); updateHistUI(); viewer.touch();
    } else if (r.kind === 'field') {
      setScalarField(note || op, r.data as Float32Array, r.counts);
      const extra = r.components !== undefined ? ` · ${fmt(r.components)} clusters` : '';
      $('v-analysis').textContent = `${note} · ${fmt(r.points)} points${extra} · ${secs}s`;
    }
    return r;
  } catch (e: any) {
    $('v-analysis').textContent = 'failed: ' + (e?.message ?? e);
    throw e;
  } finally { hideBusy(); }
}

/** The scanner's own stations, in the frame the analyser sees (so through the model matrix,
 *  which `stationPositions` already applies). Empty when the file carries no panoramas. */
function viewpointList(): number[] {
  return viewer.stations.length ? viewer.stationPositions().flat() : [];
}
$('k-annorm').addEventListener('click', () => analysis('normals', { k: anaUi.k, orient: false }, 'normals computed').catch(() => {}));
$('k-anorient').addEventListener('click', () => {
  const vps = viewpointList();
  analysis('normals', { k: anaUi.k, orient: true, viewpoints: vps },
    vps.length ? `normals oriented toward ${vps.length / 3} stations` : 'normals computed and oriented').catch(() => {});
});
$('k-aninvert').addEventListener('click', () => analysis('invert', {}, 'normals inverted').catch(() => {}));
$('k-anfeatgo').addEventListener('click', () => {
  const sel = $<HTMLSelectElement>('k-anfeat');
  analysis('feature', { name: sel.value, k: anaUi.k, radius: anaUi.spacing }, sel.options[sel.selectedIndex].text).catch(() => {});
});
$('k-ancc').addEventListener('click', () =>
  analysis('components', { radius: anaUi.spacing, minPts: 16 }, 'Connected components').catch(() => {}));

async function maskTool(op: string, args: Record<string, any>, label: string, prompt: string) {
  try {
    const r = await runAnalysis(op, args);
    hideBusy();
    const masks = perLeaf(r.data as Uint8Array, r.counts);
    const extra = r.mean !== undefined ? `<p class="mono">mean neighbour distance ${r.mean.toFixed(4)} m · cut-off ${r.cut.toFixed(4)} m</p>` : '';
    await commitMask(label, masks, prompt + extra);
  } catch (e: any) {
    $('v-analysis').textContent = 'failed: ' + (e?.message ?? e);
  } finally { hideBusy(); }
}
$('k-ansor').addEventListener('click', () => maskTool('sor', { k: anaUi.k, sigma: anaUi.sigma }, 'Remove outliers',
  '<p>Points whose neighbours sit unusually far away are isolated specks. <b>{n}</b> of them will be dropped, leaving {k}.</p>'));
$('k-annoise').addEventListener('click', () => maskTool('noise', { k: anaUi.k, sigma: anaUi.sigma }, 'Remove noise',
  '<p>Points that sit too far off the local surface will be dropped: <b>{n}</b> of them, leaving {k}. Real edges are kept because they still fit a plane.</p>'));
$('k-andup').addEventListener('click', () => maskTool('duplicates', { tol: 0.001 }, 'Remove duplicates',
  '<p>Points within 1 mm of an earlier point add nothing. <b>{n}</b> will be dropped, leaving {k}.</p>'));
$('k-ansub').addEventListener('click', () => maskTool('subsample', { spacing: anaUi.spacing }, 'Thin the cloud',
  '<p>Keeps one point per cube of the chosen spacing, spreading the survivors evenly. <b>{n}</b> points will be dropped, leaving {k}.</p>'));

$('k-sfapply').addEventListener('click', async () => {
  if (!viewer.cells.hasScalarField) return;
  const lo = sfValue('k-sflo'), hi = sfValue('k-sfhi');
  const masks: Uint8Array[] = [];
  for (const l of viewer.cells.leavesForMask()) {
    const m = new Uint8Array(l.count);
    for (let i = 0; i < l.count; i++) {
      const v = l.sf ? l.sf[i] : NaN;
      m[i] = Number.isFinite(v) && v >= lo && v <= hi ? 1 : 0;
    }
    masks.push(m);
  }
  await commitMask('Keep only this range',
    masks, `<p>Keeps points whose <b>${sfName}</b> is between ${sfFmt(lo)} and ${sfFmt(hi)}. <b>{n}</b> points will be dropped, leaving {k}.</p>`);
});

// ------------------------------------------------------------------ surface reconstruction
const meshWorker = new Worker(new URL('./mesh-worker.ts', import.meta.url), { type: 'module' });
const meshWaiters = new Map<string, (m: any) => void>();
let meshData: MeshData | null = null;
let meshAlive = true;
let meshError: string | null = null;
meshWorker.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === 'progress') { busy(`Building the field… ${m.leaves} cells · ${mb(m.bytes)}`); return; }
  if (m.type === 'error') {
    // The worker can give up mid-stream, when nothing is awaiting it. Remember why, so the
    // next wait fails with the real reason instead of hanging forever.
    meshError = m.message ?? 'mesher failed';
    meshAlive = false;
    const rej = meshWaiters.get('error');
    meshWaiters.clear();
    rej?.(m);
    return;
  }
  const w = meshWaiters.get(m.type);
  if (w) { meshWaiters.delete(m.type); meshWaiters.delete('error'); w(m); }
};
function meshOnce(type: string): Promise<any> {
  if (meshError) return Promise.reject(new Error(meshError));
  return new Promise((res, rej) => {
    meshWaiters.set(type, res);
    meshWaiters.set('error', (m: any) => rej(new Error(m.message ?? 'mesher failed')));
  });
}
/** A voxel finer than the scan's own point spacing only reconstructs noise, so default to it. */
function defaultVoxelCm() {
  const sp = viewer.loaded ? viewer.cells.medianSpacing : 0.06;
  return Math.round(Math.min(60, Math.max(1, sp * 200)) * 2) / 2;
}
const MIN_W = 0.15;   // how much accumulated weight a voxel needs before it counts as surface
const meshUi = { voxel: 6, smooth: 2, trunc: 2 };
function syncMeshLabels() {
  $('v-mvox').textContent = `${meshUi.voxel.toFixed(1)} cm`;
  $('v-msmooth').textContent = String(meshUi.smooth);
  $('v-mtrunc').textContent = meshUi.trunc.toFixed(1);
}
for (const [id, key, f] of [['k-mvox', 'voxel', 1], ['k-msmooth', 'smooth', 1], ['k-mtrunc', 'trunc', 1]] as [string, 'voxel' | 'smooth' | 'trunc', number][]) {
  $(id).addEventListener('input', e => { (meshUi as any)[key] = Number((e.target as HTMLInputElement).value) * f; syncMeshLabels(); });
}
$('k-mflat').addEventListener('change', e => { viewer.meshFlat = (e.target as HTMLInputElement).checked; viewer.touch(); });
function setDisplay(d: 'points' | 'mesh' | 'both') {
  viewer.setDisplay(d);
  for (const [id, v] of [['k-disppoints', 'points'], ['k-dispmesh', 'mesh'], ['k-dispboth', 'both']] as [string, string][])
    $(id).classList.toggle('on', viewer.display === v);
  viewer.touch();
}
$('k-disppoints').addEventListener('click', () => setDisplay('points'));
$('k-dispmesh').addEventListener('click', () => setDisplay('mesh'));
$('k-dispboth').addEventListener('click', () => setDisplay('both'));

async function buildMesh(opts: { voxel?: number; smooth?: number; trunc?: number; minW?: number; confirm?: boolean } = {}) {
  if (!viewer.loaded) throw new Error('nothing loaded');
  const voxel = (opts.voxel ?? meshUi.voxel) / 100;
  const smooth = opts.smooth ?? meshUi.smooth;
  const trunc = opts.trunc ?? meshUi.trunc;
  // Averaging many points per voxel is what removes noise; past a few hundred per voxel
  // the extra points change nothing, so thin them and keep the wait sane.
  const target = isTouch ? 4e6 : 14e6;
  const stride = Math.max(1, Math.ceil(viewer.loaded / target));
  const used = Math.floor(viewer.loaded / stride);
  // Rough field size: each point covers about spacing², the band is a few voxels thick, and
  // bricks are only part full. Enough to warn before a minute of work ends in a dead tab.
  const sp = viewer.cells.medianSpacing;
  const area = used * sp * sp;
  const estBytes = (area / (voxel * voxel)) * (2 * trunc + 1) * 7 / 0.45;
  const budget = isTouch ? 260e6 : 900e6;
  if (opts.confirm !== false) {
    const ans = await modal('Build a surface?',
      `<p>Reconstructs a triangle surface from <b>${fmt(used)}</b> of ${fmt(viewer.loaded)} points at a <b>${(voxel * 100).toFixed(1)} cm</b> voxel.</p>` +
      `<p>The points stay exactly as they are; the surface is a separate object you can show, hide or save. Expect a few seconds to a minute.</p>` +
      (estBytes > budget
        ? `<p><b>This is likely to be too fine.</b> The field would need roughly <b>${mb(estBytes)}</b>, over the ${mb(budget)} this device allows. Raise Detail, or crop to a smaller area and build that.</p>`
        : `<p class="mono">field ≈ ${mb(estBytes)}</p>`),
      [{ label: 'Cancel', value: 'no' }, { label: 'Build', value: 'yes', cls: 'primary' }]);
    if (ans !== 'yes') return null;
  }
  const t0 = performance.now();
  busy('Starting the mesher…'); await tick();
  try {
    meshAlive = true; meshError = null;
    // the field is built in the cloud's current world, so a levelled floor gets a clean
    // axis-aligned isosurface rather than one sliced at an angle
    const builtWith = viewer.cells.model.clone();
    meshWorker.postMessage({ type: 'start', voxel, trunc, minWeight: opts.minW ?? MIN_W, stride, maxBytes: budget, model: rowMajor(builtWith) });
    await meshOnce('ready');
    let n = 0;
    const total = viewer.cells.leafCount;
    for (const { leaf, recs } of viewer.cells.records()) {
      if (!meshAlive) break;                       // the worker gave up; stop reading cells back
      const buf = recs.buffer as ArrayBuffer;
      meshWorker.postMessage({ type: 'leaf', origin: leaf.origin.toArray(), size: leaf.size, recs: buf }, [buf]);
      if (++n % 8 === 0) { busy(`Reading cells… ${n} of ${total}`, n / Math.max(total, 1)); await tick(); }
    }
    busy('Extracting the surface…'); await tick();
    meshWorker.postMessage({ type: 'build', smooth, iso: 1.0 });
    const done = await meshOnce('mesh');
    meshData = { pos: done.pos, nrm: done.nrm, col: done.col, idx: done.idx };
    const st0 = done.stats;
    viewer.setMesh(meshData, builtWith);
    document.body.classList.toggle('has-mesh', !!meshData.idx.length);
    dirtyMark.surface = done.stats.triangles || 0;
    meshInfo = {
      triangles: st0.triangles || 0, vertices: st0.vertices || 0,
      boundaryEdges: st0.boundaryEdges ?? 0, voxelCm: +(voxel * 100).toFixed(2),
      fromNormals: (st0.oriented ?? 0) > (st0.unoriented ?? 0) * 4,
    };
    setDisplay(meshData.idx.length ? 'mesh' : 'points');
    const st = done.stats;
    const mode = st.oriented > st.unoriented * 4 ? 'from normals' : 'density (no usable normals)';
    $('v-mesh').textContent = meshData.idx.length
      ? `${fmt(st.triangles)} triangles · ${fmt(st.vertices)} vertices · ${mb(viewer.mesh.bytes)} · ${mode} · ${((performance.now() - t0) / 1000).toFixed(1)}s`
      : 'no surface found — try a coarser Detail or more Fill gaps';
    return st;
  } catch (e: any) {
    $('v-mesh').textContent = 'failed: ' + (e?.message ?? e);
    throw e;
  } finally { hideBusy(); }
}
$('k-mbuild').addEventListener('click', () => buildMesh().catch(e => { $('v-mesh').textContent = 'failed: ' + (e?.message ?? e); }));
$('k-mclear').addEventListener('click', () => {
  meshData = null; meshInfo = null; viewer.setMesh(null); document.body.classList.remove('has-mesh');
  dirtyMark.surface = 0;
  sfName = ''; dirtyMark.field = ''; sfStats = null; document.body.classList.remove('has-sf', 'sf-filtering');
  ($('k-color-sf') as HTMLOptionElement).disabled = true;
  setDisplay('points'); $('v-mesh').textContent = '—';
});
$('k-msave').addEventListener('click', async () => {
  if (!meshData) return;
  const fmtSel = $<HTMLSelectElement>('k-mfmt').value as 'ply' | 'obj';
  const base = (currentFile?.name ?? 'scan').replace(/\.(e57|ply|las)$/i, '') + '-surface';
  const handle = await pickSaveHandle(`${base}.${fmtSel}`, fmtSel);
  if (handle === null) return;
  busy('Writing the surface…'); await tick();
  try {
    const t = (meta?.scans?.[0]?.translation ?? [0, 0, 0]) as [number, number, number];
    const blob = fmtSel === 'ply' ? viewer.mesh.toPly(meshData, t) : viewer.mesh.toObj(meshData, t);
    const file = new File([blob], `${base}.${fmtSel}`);
    await writeOutFile({ file, name: file.name, scratch: '' }, handle);
    $('v-mesh').textContent = `saved ${file.name} · ${mb(blob.size)}`;
  } catch (e: any) { fail('Could not save the surface: ' + (e?.message ?? e)); }
  finally { hideBusy(); }
});

// ------------------------------------------------------------------ export
let exportTotal = 0;
function* leafPoints(stride: number) {
  // A file is the one place the cloud's transform gets baked: the exporters add the global
  // shift on top, so the coordinates that land on disk are model * local + translation.
  const M = viewer.cells.model.elements;                       // column-major
  const rot = new THREE.Matrix3().setFromMatrix4(viewer.cells.model);
  const nv = new THREE.Vector3();
  for (const { leaf, recs } of viewer.cells.records()) {
    const n = Math.ceil(leaf.count / stride);
    const xyz = new Float64Array(n * 3), rgb = new Uint8Array(n * 3), inten = new Uint8Array(n), nrm = new Int8Array(n * 3);
    const u16 = new Uint16Array(recs.buffer, recs.byteOffset, (leaf.count * REC) >> 1); const k = leaf.size / 65536; let j = 0;
    for (let i = 0; i < leaf.count; i += stride) {
      const b = i * 7, o = i * REC;
      const lx = leaf.origin.x + u16[b] * k, ly = leaf.origin.y + u16[b + 1] * k, lz = leaf.origin.z + u16[b + 2] * k;
      xyz[j * 3] = M[0] * lx + M[4] * ly + M[8] * lz + M[12];
      xyz[j * 3 + 1] = M[1] * lx + M[5] * ly + M[9] * lz + M[13];
      xyz[j * 3 + 2] = M[2] * lx + M[6] * ly + M[10] * lz + M[14];
      rgb[j * 3] = recs[o + 6]; rgb[j * 3 + 1] = recs[o + 7]; rgb[j * 3 + 2] = recs[o + 8]; inten[j] = recs[o + 9];
      const a = recs[o + 10] << 24 >> 24, bb = recs[o + 11] << 24 >> 24, c = recs[o + 12] << 24 >> 24;
      if (a === 0 && bb === 0 && c === 127) { nrm[j * 3] = 0; nrm[j * 3 + 1] = 0; nrm[j * 3 + 2] = 127; }
      else {
        nv.set(a, bb, c).applyMatrix3(rot);
        if (nv.lengthSq() > 1e-12) nv.normalize().multiplyScalar(127);
        nrm[j * 3] = Math.max(-127, Math.min(127, Math.round(nv.x)));
        nrm[j * 3 + 1] = Math.max(-127, Math.min(127, Math.round(nv.y)));
        nrm[j * 3 + 2] = Math.max(-127, Math.min(127, Math.round(nv.z)));
      }
      j++;
    }
    yield { xyz: xyz.subarray(0, j * 3), rgb: rgb.subarray(0, j * 3), inten: inten.subarray(0, j), nrm: nrm.subarray(0, j * 3), count: j };
  }
}
async function runExport(fmtSel: 'e57' | 'las' | 'ply', stride: number): Promise<{ file: File; name: string; count: number; bytes: number; scratch: string }> {
  const base = (currentFile?.name ?? meta?.scans?.[0]?.name ?? 'scan').replace(/\.(e57|ply|las)$/i, '');
  const outName = `${base}${cropped ? '-crop' : ''}${stride > 1 ? '-1in' + stride : ''}.${fmtSel}`;
  const s = meta.scans[0]; exportTotal = Math.ceil(viewer.loaded / stride);
  io.postMessage({ type: 'export', format: fmtSel, name: outName, translation: s.translation, total: exportTotal, hasColor: !!s.hasColor, hasIntensity: !!s.hasIntensity, hasNormals: !!s.hasNormals });
  await ioOnce('export-ready');
  let sent = 0;
  for (const c of leafPoints(stride)) {
    const xyz = c.xyz.slice(), rgb = c.rgb.slice(), inten = c.inten.slice(), nrm = c.nrm.slice();
    io.postMessage({ type: 'export-chunk', xyz, rgb, inten, nrm, count: c.count }, [xyz.buffer, rgb.buffer, inten.buffer, nrm.buffer]);
    if (++sent % 8 === 0) await tick();
  }
  io.postMessage({ type: 'export-finish' });
  const done = await ioOnce('export-done');
  const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle(done.dir); const fh = await d.getFileHandle(done.name);
  return { file: await fh.getFile(), name: outName, count: done.count, bytes: done.bytes, scratch: done.name };
}
$('k-export').addEventListener('click', async () => {
  if (!viewer.loaded || !meta) return;
  const fmtSel = $<HTMLSelectElement>('k-fmt').value as any, stride = Number($<HTMLSelectElement>('k-expstride').value) || 1;
  const base = (currentFile?.name ?? 'scan').replace(/\.(e57|ply|las)$/i, '');
  const handle = await pickSaveHandle(`${base}${cropped ? '-crop' : ''}.${fmtSel}`, fmtSel);
  if (handle === null) return;
  busy('Preparing export…');
  try {
    const r = await runExport(fmtSel, stride);
    busy('Saving…');
    await writeOutFile(r, handle);
    $('v-export').textContent = `saved ${r.name} · ${fmt(r.count)} points · ${mb(r.bytes)}`;
  } catch (e: any) { fail('Could not save the export: ' + (e?.message ?? e)); }
  finally { hideBusy(); }
});

// ------------------------------------------------------------------ cache
let cacheBytesExpected = 0;
async function offerCache() {
  if (!viewer.loaded || cropped) return;
  const ans = await modal('Cache this scan on this device?',
    `<p><b>${currentFile?.name}</b> took ${((performance.now() - t0) / 1000).toFixed(0)} s to decode. Caching the decoded cells (${mb(viewer.loaded * REC)}) in the browser's private storage makes the next open take about a second.</p><p class="mono">Stays on this device. Nothing is uploaded. Remove it any time from the Cache group.</p>`,
    [{ label: 'Never for this file', value: 'never' }, { label: 'Not now', value: 'no' }, { label: 'Cache it', value: 'yes', cls: 'primary' }]);
  if (ans === 'never') localStorage.setItem('nocache:' + cacheKey, '1');
  if (ans === 'yes') await writeCache();
}
async function writeCache() {
  if (!currentFile || !meta) return;
  const stride = Number(($('k-load') as HTMLSelectElement).value) || 1; const r = robustLoHi();
  cacheBytesExpected = viewer.loaded * REC; busy('Caching…', 0);
  io.postMessage({ type: 'cache-start', key: cacheKey, meta: { name: currentFile.name, size: currentFile.size, lastModified: currentFile.lastModified, stride, scanMeta: meta, kept: viewer.loaded, histogram: Array.from(histogram), robust: r ? { lo: r.lo, hi: r.hi } : null, model: rowMajor(viewer.cells.model) } });
  await ioOnce('cache-ready');
  let n = 0;
  for (const { leaf, recs } of viewer.cells.records()) {
    const buf = recs.buffer as ArrayBuffer;
    io.postMessage({ type: 'cache-chunk', recs: buf, leaf: { count: leaf.count, origin: leaf.origin.toArray(), size: leaf.size, bmin: leaf.bmin.toArray(), bmax: leaf.bmax.toArray() } }, [buf]);
    if (++n % 6 === 0) await tick();
  }
  io.postMessage({ type: 'cache-finish' }); const done = await ioOnce('cache-done');
  hideBusy(); fromCache = true; cacheNote = ''; $('v-cache').textContent = `cached · ${mb(done.bytes)} on this device`; updateCacheUI(); refreshCachedList();
}
/** Why the on-device cache no longer matches what is in memory. Cleared by a save, a
 *  reload or a new file; shown by updateCacheUI so the user knows Save as… is needed. */
let cacheNote = '';
function updateCacheUI() {
  const btn = $('k-cache'), rm = $('k-cacheremove');
  if (!currentFile) { $('v-cache').textContent = '—'; btn.classList.add('hidden'); rm.classList.add('hidden'); return; }
  if (fromCache) { $('v-cache').textContent = cacheNote || (cropped ? 'cache holds the current (edited) points' : 'this scan is cached on this device'); btn.classList.add('hidden'); rm.classList.remove('hidden'); }
  else if (cropped || cacheNote) { $('v-cache').textContent = `not cached · caching now stores the edited ${fmt(viewer.loaded)} points (${mb(viewer.loaded * REC)})`; btn.classList.remove('hidden'); rm.classList.add('hidden'); }
  else { $('v-cache').textContent = `not cached · would take ${mb(viewer.loaded * REC)}`; btn.classList.remove('hidden'); rm.classList.add('hidden'); }
}
$('k-cache').addEventListener('click', () => writeCache());
$('k-cacheremove').addEventListener('click', async () => { io.postMessage({ type: 'cache-delete', key: cacheKey }); await ioOnce('cache-deleted'); fromCache = false; updateCacheUI(); refreshCachedList(); });
let cachedItems: any[] = [];
async function refreshCachedList() {
  io.postMessage({ type: 'cache-list' }); const r = await ioOnce('cache-list');
  const ul = $('cached-list'); ul.innerHTML = '';
  cachedItems = (r.items as any[]).sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));
  $('cached').classList.toggle('hidden', !cachedItems.length);
  for (const it of cachedItems) {
    const li = document.createElement('li'); const handle = await idbGet(it.key); if (handle) li.classList.add('openable');
    li.innerHTML = `<span class="nm" title="${it.name}">${it.name}</span><span class="meta">${fmt(it.points)} pts · ${mb(it.bytes)}${it.stride > 1 ? ' · 1 in ' + it.stride : ''}</span>`;
    const rm = document.createElement('button'); rm.className = 'ghost'; rm.textContent = 'Remove';
    rm.onclick = async (e) => { e.stopPropagation(); io.postMessage({ type: 'cache-delete', key: it.key }); await ioOnce('cache-deleted'); refreshCachedList(); };
    li.appendChild(rm);
    if (handle) li.querySelector('.nm')!.addEventListener('click', async () => {
      if (!(await confirmReplace())) return;
      openCached(it.key).catch(e => fail(String(e?.message ?? e)));
    });
    ul.appendChild(li);
  }
}
async function openCached(key: string) {
  const it = cachedItems.find(c => c.key === key); const handle = await idbGet(key);
  if (!it || !handle) throw new Error('no stored handle for that scan');
  const perm = await handle.requestPermission?.({ mode: 'read' }); if (perm && perm !== 'granted') throw new Error('permission denied');
  if (it.stride) $<HTMLSelectElement>('k-load').value = String(it.stride);
  await openFile(await handle.getFile(), handle);
}

// ------------------------------------------------------------------ stations / bubbles
$('k-stations').addEventListener('change', e => viewer.setStationsVisible((e.target as HTMLInputElement).checked));
async function enterStation(i: number) {
  if (!currentFile) throw new Error('panoramas need the original file (not available for cloud streams yet)');
  const st = viewer.stations[i]; if (!st) throw new Error('no such station');
  busy(`Loading panorama ${i + 1} of ${viewer.stations.length}… (${mb(st.bytes)})`);
  io.postMessage({ type: 'image', file: currentFile, index: st.image }); const r = await ioOnce('image');
  try { const bmp = await createImageBitmap(new Blob([r.bytes], { type: 'image/jpeg' }), { resizeWidth: isTouch ? 2048 : 4096, resizeQuality: 'high' } as any); viewer.enterBubble(i, bmp); $('bubble-ui').classList.remove('hidden'); updatePill(); syncToolbar(); }
  finally { hideBusy(); }
}
viewer.onStationClick = (i) => enterStation(i).catch(e => fail('Panorama failed: ' + (e?.message ?? e)));
viewer.onBubbleExit = () => { $('bubble-ui').classList.add('hidden'); updatePill(); syncToolbar(); };
$('k-bubble-exit').addEventListener('click', () => viewer.exitBubble());
bindRange('k-blend', 'v-blend', v => viewer.setPointAlpha(v));

// ------------------------------------------------------------------ view links
let pendingView: any = null;
$('k-viewlink').addEventListener('click', async () => {
  const v = viewer.getView(); const state = { p: v.p.map(n => +n.toFixed(3)), t: v.t.map(n => +n.toFixed(3)), c: knobs.colorMode, e: knobs.edl ? 1 : 0 };
  const u = new URL(location.href); u.hash = btoa(JSON.stringify(state));
  try { await navigator.clipboard.writeText(u.toString()); $('v-cache').textContent = 'view link copied'; } catch {}
});
function applyPendingView() { if (!pendingView) return; try { viewer.setView(pendingView); if (pendingView.c !== undefined) setColorMode(Number(pendingView.c)); } catch {} pendingView = null; }
function applyUrlCommands() {
  const q = new URLSearchParams(location.search);
  const view = q.get('view');
  if (view === 'top') viewer.topDown();
  else if (view === 'fit') viewer.fit();
  const az = q.get('az'), el = q.get('el');
  if (az != null && el != null && isFinite(+az) && isFinite(+el)) viewer.setOrbit(+az, +el, q.get('dist') ? +q.get('dist')! : undefined);
}
try { if (location.hash.length > 2) pendingView = JSON.parse(atob(location.hash.slice(1))); } catch {}

// ------------------------------------------------------------------ agent: 3D modelling aids
// What an agent needs to model from a scan is not more screenshots. It needs a *calibrated*
// image — one metre is this many pixels, and this pixel is that world point — measurements
// taken from the data rather than from the picture, and a straight answer about whether the
// points or the reconstructed surface is the better thing to trust. These commands are that.

/** Base64 characters per part. The HTTP relay puts a reply in one Firestore document, and
 *  that document is capped at 1 MiB, so anything bigger comes back in numbered parts. */
const PAGE = 560_000;
let pageKey = '';
let pageParts: string[] = [];
function pagePart(i: number, mime?: string) {
  const j = Math.max(0, Math.min(i, pageParts.length - 1));
  return { part: j, parts: pageParts.length, chars: pageParts[j].length, data: pageParts[j], ...(mime ? { mime } : {}) };
}
/** A part of a payload already built. Null when this is a fresh request. */
function pagedHit(key: string, part: number, mime?: string) {
  if (key !== pageKey || !pageParts.length || part <= 0) return null;
  return pagePart(part, mime);
}
function pagedSet(key: string, s: string, part = 0, mime?: string) {
  pageParts = [];
  for (let o = 0; o < s.length; o += PAGE) pageParts.push(s.slice(o, o + PAGE));
  if (!pageParts.length) pageParts = [''];
  pageKey = key;
  return pagePart(part, mime);
}
/** Wrap an image for a reply: whole when it fits a single part, paged when it does not. */
function image(key: string, b64: string, mime = 'image/jpeg', part = 0) {
  return b64.length <= PAGE
    ? { mime, part: 0, parts: 1, chars: b64.length, data: b64 }
    : pagedSet(key, b64, part, mime);
}

const r6 = (n: number) => +n.toFixed(6);
const arr6 = (a: number[]) => a.map(r6);
const globalShift = () => (meta?.scans?.[0]?.translation ?? [0, 0, 0]) as number[];
const toGlobal = (p: number[]) => { const t = globalShift(); return p.map((v, i) => r6(v + (t[i] ?? 0))); };
const clampPx = (v: any, d = 1024) => Math.max(64, Math.min(2048, Math.round(Number(v) || d)));

function boundsRecord() {
  const b = viewer.bounds();
  if (b.isEmpty()) return null;
  return {
    local: { min: arr6(b.min.toArray()), max: arr6(b.max.toArray()), size: arr6(b.getSize(new THREE.Vector3()).toArray()) },
    global: { min: toGlobal(b.min.toArray()), max: toGlobal(b.max.toArray()) },
  };
}
/** Fraction of points carrying a real normal, from a uniform sample of the cells. */
function normalFraction(): number {
  let n = 0, have = 0;
  for (const { recs, n: cnt } of viewer.cells.sample(400)) {
    for (let i = 0; i < cnt; i++) {
      const o = i * REC;
      const a = recs[o + 10] << 24 >> 24, b = recs[o + 11] << 24 >> 24, c = recs[o + 12] << 24 >> 24;
      n++; if (!(a === 0 && b === 0 && c === 127)) have++;
    }
  }
  return n ? r6(have / n) : 0;
}

/** What the last build produced, for `state.surface` and the source recommendation. */
let meshInfo: { triangles: number; vertices: number; boundaryEdges: number; voxelCm: number; fromNormals: boolean } | null = null;
function surfaceRecord() {
  if (!meshData || !meshInfo) return null;
  const holeRatio = meshInfo.triangles ? meshInfo.boundaryEdges / meshInfo.triangles : 1;
  return { ...meshInfo, holeRatio: r6(holeRatio), display: viewer.display };
}
/** Points or surface — and why. An agent that measures the wrong one produces a wrong model. */
function recommendedSource(): { source: 'points' | 'mesh'; reason: string } {
  const s = surfaceRecord();
  if (!s) return { source: 'points', reason: 'No surface has been reconstructed. Measure the points: section and contour give plans and elevations, fitplane gives planes, inside gives counts.' };
  if (!s.fromNormals) return { source: 'points', reason: 'The surface came from a density isosurface because the points carry no usable normals, so it is rounder than what was scanned. Run analysis normals with orient, rebuild, then ask again.' };
  if (s.holeRatio >= 0.2) return { source: 'points', reason: `The surface has ${fmt(s.boundaryEdges)} boundary edges to ${fmt(s.triangles)} triangles (hole ratio ${s.holeRatio.toFixed(2)}), so it is too open to measure against. Raise fillGaps or use a coarser voxel, or measure the points.` };
  return { source: 'mesh', reason: `The surface was built from oriented normals at a ${s.voxelCm} cm voxel and is nearly closed (hole ratio ${s.holeRatio.toFixed(2)}), so it averages out scanner noise and is the better thing to measure.` };
}

function stateRecord() {
  const sf = viewer.cells.hasScalarField ? viewer.cells.scalarStats() : null;
  return {
    units: 'm' as const,
    file: currentFile?.name ?? null, points: viewer.loaded, cells: viewer.cells.leafCount,
    cropped, fromCache, dirty: isDirty(), unsaved: dirtyList(),
    history: hist.steps,
    bounds: boundsRecord(), translation: globalShift(),
    medianSpacing: r6(viewer.cells.medianSpacing),
    hasNormals: normalFraction(),
    scalarField: sf ? { name: sfName, min: r6(sf.min), max: r6(sf.max), values: sf.n } : null,
    surface: surfaceRecord(),
    stations: viewer.stations.length,
    transform: transformState(),
    recommendedSource: recommendedSource(),
    view: viewer.getView(), camera: viewer.cameraRecord(), knobs,
    regions: allRegions(),
    measurements: viewer.measureList.map(m => ({ a: arr6(m.a.toArray()), b: arr6(m.b.toArray()), dist: r6(m.dist) })),
    bubble: viewer.bubble?.index ?? null,
    cached: cachedItems.map(c => ({ key: c.key, name: c.name, points: c.points })),
  };
}

// ------------------------------------------------------------------ calibrated views
const PRESETS: Record<string, [number, number, number]> = {
  top: [0, 0, -1], bottom: [0, 0, 1], front: [0, 1, 0], back: [0, -1, 0],
  left: [-1, 0, 0], right: [1, 0, 0], iso: [-0.62, -0.62, -0.48],
};
/** The camera of the most recent calibrated render, so `probe` can re-establish exactly it
 *  even after the user has moved the view. */
let lastRender: { label: string; run: <T>(fn: (m: any) => T) => T } | null = null;

function runView<T>(a: any, fn: (m: any) => T): T {
  if (!viewer.loaded) throw new Error('nothing loaded');
  const name = String(a.preset ?? 'current').toLowerCase();
  const px = clampPx(a.width);
  const dir = PRESETS[name];
  if (!dir) {
    if (name !== 'current') throw new Error(`preset: current | ${Object.keys(PRESETS).join(' | ')}`);
    const saved = viewer.getView();
    try { viewer.renderClean(); return fn(null); } finally { viewer.setView(saved); }
  }
  const f = new THREE.Vector3(...dir).normalize();
  const bb = viewer.bounds().clone();
  if (a.ortho === false) {
    // a plain look from that direction: not measurable, but it is what a person would frame
    const saved = viewer.getView();
    const c = bb.getCenter(new THREE.Vector3());
    const radius = Math.max(bb.getBoundingSphere(new THREE.Sphere()).radius, 0.5);
    const dist = radius / Math.sin((viewer.camera.fov * Math.PI / 180) / 2) * 1.05;
    try {
      viewer.setView({ p: c.clone().addScaledVector(f, -dist).toArray(), t: c.toArray() });
      viewer.renderClean();
      return fn(null);
    } finally { viewer.setView(saved); }
  }
  return viewer.withOrtho({ forward: f, bb, px }, m => { viewer.renderClean(); return fn(m); });
}

function runSection<T>(a: any, fn: (m: any, info: any) => T): T {
  if (!viewer.loaded) throw new Error('nothing loaded');
  const b = viewer.bounds();
  if (b.isEmpty()) throw new Error('nothing loaded');
  const axis = String(a.axis ?? 'z').toLowerCase();
  const i = axis === 'x' ? 0 : axis === 'y' ? 1 : axis === 'z' ? 2 : -1;
  if (i < 0) throw new Error("axis: 'x' | 'y' | 'z'");
  const centre = b.getCenter(new THREE.Vector3());
  const at = Number(a.at ?? centre.getComponent(i));
  if (!isFinite(at)) throw new Error('at must be a number, in metres in the local frame');
  const th = Math.max(1e-3, Number(a.thickness ?? Math.max(0.1, viewer.cells.medianSpacing * 8)));
  const px = clampPx(a.width);
  // the slab as a keep region, so the points outside it vanish in the shader, and as a clip
  // box so the surface is cut the same way
  const half = b.getSize(new THREE.Vector3()).multiplyScalar(0.5).addScalar(1);
  half.setComponent(i, th / 2);
  const sc = centre.clone(); sc.setComponent(i, at);
  const region: Region = {
    id: 'sec-view', kind: 'box', role: 'keep',
    center: sc.toArray() as [number, number, number], half: half.toArray() as [number, number, number],
    radius: half.x, quat: [0, 0, 0, 1],
  };
  const bb = b.clone();
  bb.min.setComponent(i, at - th / 2); bb.max.setComponent(i, at + th / 2);
  const f = new THREE.Vector3(); f.setComponent(i, -1);
  viewer.setRegions([region]); viewer.regionHide = true;
  viewer.meshClip = { min: bb.min.clone(), max: bb.max.clone() };
  try {
    return viewer.withOrtho({ forward: f, bb, px }, m => {
      viewer.renderClean();
      return fn(m, { axis, at: r6(at), thickness: r6(th), surfaceIncluded: viewer.display !== 'points' });
    });
  } finally {
    viewer.meshClip = null;
    viewer.regionHide = $<HTMLInputElement>('k-crophide').checked;
    syncRegions(); viewer.touch();
  }
}

// ------------------------------------------------------------------ rasters
/** Max coordinate along `axis` per cell, over a uniform sample — a height model, fast enough
 *  on 18 million points because the leaves are shuffled and a prefix of each is a sample. */
function heightmapCmd(a: any) {
  if (!viewer.loaded) throw new Error('nothing loaded');
  const axis = String(a.axis ?? 'z').toLowerCase();
  const iAx = axis === 'x' ? 0 : axis === 'y' ? 1 : axis === 'z' ? 2 : -1;
  if (iAx < 0) throw new Error("axis: 'x' | 'y' | 'z'");
  const [uAx, vAx] = [[1, 2], [0, 2], [0, 1]][iAx];
  const b = viewer.bounds();
  if (b.isEmpty()) throw new Error('nothing loaded');
  const res = Math.max(16, Math.min(1024, Math.round(Number(a.resolution) || 512)));
  const size = b.getSize(new THREE.Vector3()).toArray(), mn = b.min.toArray();
  const su = Math.max(size[uAx], 1e-3), sv = Math.max(size[vAx], 1e-3);
  const mpp = Math.max(su, sv) / res;
  const w = Math.max(1, Math.round(su / mpp)), h = Math.max(1, Math.round(sv / mpp));
  const grid = new Float32Array(w * h).fill(-Infinity);
  let sampled = 0;
  for (const { leaf, recs, n: cnt } of viewer.cells.sample(Math.max(200, Math.min(20000, Math.round(Number(a.perCell) || 6000))))) {
    const xyz = viewer.cells.transformRecordsInto(recs, cnt, leaf, new Float64Array(cnt * 3));
    for (let i = 0; i < cnt; i++) {
      const u = Math.floor((xyz[i * 3 + uAx] - mn[uAx]) / mpp);
      const v = Math.floor((xyz[i * 3 + vAx] - mn[vAx]) / mpp);
      if (u < 0 || v < 0 || u >= w || v >= h) continue;
      const k = (h - 1 - v) * w + u;                 // image rows run top to bottom
      const q = xyz[i * 3 + iAx];
      if (q > grid[k]) grid[k] = q;
      sampled++;
    }
  }
  let lo = Infinity, hi = -Infinity, filled = 0;
  for (const g of grid) if (isFinite(g)) { filled++; if (g < lo) lo = g; if (g > hi) hi = g; }
  if (!filled) throw new Error('no points fell in the raster');
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const span = Math.max(hi - lo, 1e-9);
  for (let k = 0; k < grid.length; k++) {
    const g = grid[k];
    const q = isFinite(g) ? Math.round(((g - lo) / span) * 254) + 1 : 0;   // 0 means no data
    img.data[k * 4] = q; img.data[k * 4 + 1] = q; img.data[k * 4 + 2] = q; img.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const b64 = cv.toDataURL('image/png').split(',')[1] ?? '';
  const names = ['x', 'y', 'z'];
  return {
    axis, measured: names[iAx], sampled, filledCells: filled, cells: w * h,
    zMin: r6(lo), zMax: r6(hi),
    mapping: {
      width: w, height: h, metresPerPixel: r6(mpp),
      axes: [names[uAx], names[vAx]],
      originX: r6(mn[uAx]), originY: r6(mn[vAx]),
      extentX: r6(w * mpp), extentY: r6(h * mpp),
      note: `pixel (0,0) is the top left; world ${names[uAx]} = originX + (x + 0.5) * metresPerPixel, world ${names[vAx]} = originY + (height - 0.5 - y) * metresPerPixel. Grey 0 means no data; 1..255 maps linearly onto [zMin, zMax].`,
    },
    translation: globalShift(),
    image: image('heightmap', b64, 'image/png', Math.round(Number(a.part) || 0)),
  };
}

/** Ramer-Douglas-Peucker: drop the vertices that do not change the shape by more than `tol`.
 *
 *  A closed ring has to be cut first. The algorithm keeps the two endpoints and measures every
 *  other vertex against the line between them — and on a ring those endpoints are the same
 *  point, so that line has no length and the whole outline collapses to a single vertex. Split
 *  it at the vertex furthest from the start and simplify the two halves. */
function simplify(line: number[][], tol: number): number[][] {
  if (line.length < 3) return line;
  const closed = Math.hypot(line[0][0] - line[line.length - 1][0], line[0][1] - line[line.length - 1][1]) < tol * 1e-3 + 1e-9;
  if (closed && line.length > 4) {
    let far = 1, best = -1;
    for (let i = 1; i < line.length - 1; i++) {
      const d = Math.hypot(line[i][0] - line[0][0], line[i][1] - line[0][1]);
      if (d > best) { best = d; far = i; }
    }
    const a = rdp(line.slice(0, far + 1), tol), b = rdp(line.slice(far), tol);
    return a.concat(b.slice(1));
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

/** Marching squares over the occupancy of a horizontal slab: the footprint primitive. */
function contourCmd(a: any) {
  if (!viewer.loaded) throw new Error('nothing loaded');
  const b = viewer.bounds();
  if (b.isEmpty()) throw new Error('nothing loaded');
  const z = Number(a.z ?? b.getCenter(new THREE.Vector3()).z);
  if (!isFinite(z)) throw new Error('z must be a number, in metres in the local frame');
  const th = Math.max(1e-3, Number(a.thickness ?? Math.max(0.15, viewer.cells.medianSpacing * 10)));
  const res = Math.max(16, Math.min(1024, Math.round(Number(a.resolution) || 400)));
  const size = b.getSize(new THREE.Vector3());
  // A raster cell finer than the point spacing leaves gaps a wall cannot be traced through,
  // so the cell size has a floor of a couple of spacings whatever resolution is asked for.
  const mpp = Math.max(Math.max(size.x, size.y) / res, viewer.cells.medianSpacing * 2.5, 1e-3);
  const w = Math.max(5, Math.ceil(size.x / mpp) + 5), h = Math.max(5, Math.ceil(size.y / mpp) + 5);
  // two empty rings of cells around the data, so the outline of something touching the edge
  // of the cloud still has cells on both sides to be traced between
  const x0 = b.min.x - 2 * mpp, y0 = b.min.y - 2 * mpp;
  const occ = new Uint8Array(w * h);
  let inSlab = 0;
  // Every point of every cell the slab touches, not a sample: a thin slab holds a small
  // fraction of the cloud, so a uniform sample of the cloud is a sparse sample of the slab
  // and the outline comes back as confetti. Cells the slab misses are never read back, which
  // is what keeps this affordable — a 30 cm slab of a building touches few of them.
  const lb = new THREE.Box3();
  for (const leaf of viewer.cells.leavesForMask()) {
    viewer.cells.leafBox(leaf, lb);
    if (lb.max.z < z - th / 2 || lb.min.z > z + th / 2) continue;
    const recs = leaf.readback(viewer.cells.gl2);
    const cnt = leaf.count;
    const xyz = viewer.cells.transformRecordsInto(recs, cnt, leaf, new Float64Array(cnt * 3));
    for (let i = 0; i < cnt; i++) {
      const pz = xyz[i * 3 + 2];
      if (pz < z - th / 2 || pz > z + th / 2) continue;
      const u = Math.round((xyz[i * 3] - x0) / mpp), v = Math.round((xyz[i * 3 + 1] - y0) / mpp);
      if (u < 0 || v < 0 || u >= w || v >= h) continue;
      occ[v * w + u] = 1; inSlab++;
    }
  }
  // Optional: grow the occupancy by one cell. Not needed when the raster cell is a couple of
  // point spacings across, because then a wall fills its cells without gaps — but a sparse or
  // patchy scan traces into confetti without it, at the cost of a cell of thickness each side.
  if (a.dilate === true) {
    const grown = new Uint8Array(occ);
    for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
      if (!occ[v * w + u]) continue;
      for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
        const uu = u + du, vv = v + dv;
        if (uu >= 0 && vv >= 0 && uu < w && vv < h) grown[vv * w + uu] = 1;
      }
    }
    occ.set(grown);
  }
  if (!inSlab) return { z: r6(z), thickness: r6(th), inSlab: 0, polylines: [], note: 'no points in that slab' };
  // corner values are 0 or 1, so every crossing is exactly at an edge midpoint
  const segs: number[][] = [];
  for (let v = 0; v < h - 1; v++) for (let u = 0; u < w - 1; u++) {
    const code = (occ[v * w + u] ? 1 : 0) | (occ[v * w + u + 1] ? 2 : 0)
               | (occ[(v + 1) * w + u + 1] ? 4 : 0) | (occ[(v + 1) * w + u] ? 8 : 0);
    if (code === 0 || code === 15) continue;
    const ab = [u + 0.5, v], bc = [u + 1, v + 0.5], cd = [u + 0.5, v + 1], da = [u, v + 0.5];
    const push = (p: number[], q: number[]) => segs.push([p[0], p[1], q[0], q[1]]);
    switch (code) {
      case 1: case 14: push(da, ab); break;
      case 2: case 13: push(ab, bc); break;
      case 3: case 12: push(da, bc); break;
      case 4: case 11: push(bc, cd); break;
      case 6: case 9: push(ab, cd); break;
      case 7: case 8: push(da, cd); break;
      case 5: push(da, ab); push(bc, cd); break;      // saddle, resolved one way
      case 10: push(ab, bc); push(cd, da); break;
    }
  }
  // stitch the segments into polylines through their shared endpoints
  const key = (x: number, y: number) => `${Math.round(x * 2)},${Math.round(y * 2)}`;
  const node = new Map<string, { p: number[]; to: string[] }>();
  for (const [x1, y1, x2, y2] of segs) {
    const k1 = key(x1, y1), k2 = key(x2, y2);
    if (!node.has(k1)) node.set(k1, { p: [x1, y1], to: [] });
    if (!node.has(k2)) node.set(k2, { p: [x2, y2], to: [] });
    node.get(k1)!.to.push(k2); node.get(k2)!.to.push(k1);
  }
  const used = new Set<string>();
  const ek = (p: string, q: string) => p < q ? p + '|' + q : q + '|' + p;
  const keys = [...node.keys()].sort((p, q) => node.get(p)!.to.length - node.get(q)!.to.length);
  let lines: number[][][] = [];
  for (const s of keys) {
    for (const first of node.get(s)!.to) {
      if (used.has(ek(s, first))) continue;
      const line: number[][] = [node.get(s)!.p];
      let cur = s, nxt: string | undefined = first;
      while (nxt) {
        used.add(ek(cur, nxt));
        line.push(node.get(nxt)!.p);
        const n2: string = nxt;
        const opts = node.get(n2)!.to.filter(t => !used.has(ek(n2, t)));
        cur = n2; nxt = opts[0];
        if (line.length > 400_000) break;
      }
      if (line.length >= 3) lines.push(line);
    }
  }
  // grid units to metres, then simplify until the reply is a sensible size
  lines = lines.map(l => l.map(([gx, gy]) => [x0 + gx * mpp, y0 + gy * mpp]));
  let tol = mpp * 0.75, simplified = lines.map(l => simplify(l, tol));
  const budget = Math.max(500, Math.min(40_000, Math.round(Number(a.maxVertices) || 12_000)));
  const count = (ls: number[][][]) => ls.reduce((n, l) => n + l.length, 0);
  while (count(simplified) > budget && tol < mpp * 64) { tol *= 2; simplified = lines.map(l => simplify(l, tol)); }
  const bx = new THREE.Box3();
  const v2 = new THREE.Vector3();
  for (const l of simplified) for (const [x, y] of l) bx.expandByPoint(v2.set(x, y, z));
  const closed = simplified.filter(l => Math.hypot(l[0][0] - l[l.length - 1][0], l[0][1] - l[l.length - 1][1]) < mpp * 1.5).length;
  return {
    z: r6(z), thickness: r6(th), inSlab,
    raster: { width: w, height: h, metresPerPixel: r6(mpp), originX: r6(x0), originY: r6(y0), dilated: a.dilate === true },
    simplifyTolerance: r6(tol),
    polylines: simplified.map(l => l.map(([x, y]) => [r6(x), r6(y)])),
    vertices: count(simplified), closedPolylines: closed,
    bounds: bx.isEmpty() ? null : { min: arr6([bx.min.x, bx.min.y]), max: arr6([bx.max.x, bx.max.y]) },
    frame: 'local metres; add translation for global coordinates',
    translation: globalShift(),
  };
}

// ------------------------------------------------------------------ geometry from the points
function regionFrom(o: any, id = 'probe-box'): Region {
  if (!o || !Array.isArray(o.center) || !Array.isArray(o.half)) throw new Error('box: { center:[x,y,z], half:[x,y,z], quat?:[x,y,z,w] }');
  const half = o.half.map((v: any) => Math.max(1e-4, Math.abs(Number(v))));
  return {
    id, kind: 'box', role: 'keep',
    center: o.center.map(Number) as [number, number, number],
    half: half as [number, number, number], radius: half[0],
    quat: (o.quat ?? [0, 0, 0, 1]).map(Number) as [number, number, number, number],
  };
}
/** Best-fit plane by PCA, over the points inside a box or over a list handed in. */
function fitPlaneCmd(a: any) {
  let pts: number[][] = [];
  let counted = 0, sampledEvery = 1;
  if (Array.isArray(a.points) && a.points.length) {
    pts = a.points.map((p: any) => p.map(Number));
    counted = pts.length;
  } else {
    if (!viewer.loaded) throw new Error('nothing loaded');
    const r = regionFrom(a.box, 'fit-box');
    // a coarse count first, so a wall of ten million points is sampled rather than copied
    const est = viewer.cells.countInside(r, 16);
    sampledEvery = Math.max(1, Math.ceil(est / 500_000));
    const reach = Math.hypot(r.half[0], r.half[1], r.half[2]);
    const wanted = new THREE.Box3(
      new THREE.Vector3(...r.center).addScalar(-reach),
      new THREE.Vector3(...r.center).addScalar(reach));
    const p = new THREE.Vector3(), lb = new THREE.Box3();
    for (const leaf of viewer.cells.leavesForMask()) {
      if (!viewer.cells.leafBox(leaf, lb).intersectsBox(wanted)) continue;
      const recs = leaf.readback(viewer.cells.gl2);
      const xyz = viewer.cells.transformRecordsInto(recs, leaf.count, leaf, new Float64Array(leaf.count * 3));
      for (let i = 0; i < leaf.count; i += sampledEvery) {
        p.set(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
        if (!pointInRegion(p, r)) continue;
        counted++;
        pts.push([p.x, p.y, p.z]);
      }
    }
  }
  if (pts.length < 3) throw new Error(`need at least 3 points inside; found ${pts.length}`);
  let mx = 0, my = 0, mz = 0;
  for (const q of pts) { mx += q[0]; my += q[1]; mz += q[2]; }
  const n = pts.length; mx /= n; my /= n; mz /= n;
  const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const q of pts) {
    const d = [q[0] - mx, q[1] - my, q[2] - mz];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i][j] += d[i] * d[j];
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i][j] /= n;
  const nrm = leastEigenvector(c);
  if (nrm.z < 0) nrm.negate();                      // report the upward-facing normal
  let ss = 0, worst = 0;
  for (const q of pts) {
    const d = (q[0] - mx) * nrm.x + (q[1] - my) * nrm.y + (q[2] - mz) * nrm.z;
    ss += d * d; worst = Math.max(worst, Math.abs(d));
  }
  const rms = Math.sqrt(ss / n);
  const dip = Math.acos(Math.min(1, Math.abs(nrm.z))) * 180 / Math.PI;
  // azimuth of the down-dip direction, clockwise from +Y
  const dipDir = (Math.atan2(-nrm.x, -nrm.y) * 180 / Math.PI + 360) % 360;
  return {
    normal: arr6(nrm.toArray()),
    centroid: arr6([mx, my, mz]), centroidGlobal: toGlobal([mx, my, mz]),
    rms: r6(rms), worst: r6(worst),
    dipDeg: r6(dip), dipDirectionDeg: r6(dip < 0.01 ? 0 : dipDir),
    orientation: dip < 5 ? 'horizontal' : dip > 85 ? 'vertical' : 'inclined',
    points: n, pointsInside: counted, sampledEvery,
    plane: `(p - centroid) · normal = 0`,
  };
}

// ------------------------------------------------------------------ agent link
const agent = new AgentLink({
  state: () => stateRecord(),
  screenshot: (a) => ({ png: viewer.snapshot(a.width ?? 1280).split(',')[1], view: viewer.getView(), size: [innerWidth, innerHeight], camera: viewer.cameraRecord() }),
  /** A calibrated image: orthographic by default, so the mapping it comes with is exact. */
  view: (a) => runView(a, (map) => {
    const label = String(a.preset ?? 'current').toLowerCase();
    lastRender = { label, run: (fn) => runView(a, fn) };
    const px = map ? Math.max(map.width, map.height) : clampPx(a.width);
    const b64 = viewer.snapshot(px, 'jpeg').split(',')[1] ?? '';
    return {
      preset: label, ortho: !!map, mapping: map, camera: viewer.cameraRecord(),
      bounds: boundsRecord(), translation: globalShift(),
      colorMode: knobs.colorMode, recommendedSource: recommendedSource(),
      image: image('view:' + label, b64, 'image/jpeg', Math.round(Number(a.part) || 0)),
    };
  }),
  /** A plan or an elevation: only one slab, orthographic, with the same mapping record. */
  section: (a) => runSection(a, (map, info) => {
    lastRender = { label: `section ${info.axis}=${info.at}`, run: (fn) => runSection(a, fn) };
    const px = map ? Math.max(map.width, map.height) : clampPx(a.width);
    const b64 = viewer.snapshot(px, 'jpeg').split(',')[1] ?? '';
    return {
      ...info, mapping: map, camera: viewer.cameraRecord(), translation: globalShift(),
      points: viewer.loaded,
      image: image('section', b64, 'image/jpeg', Math.round(Number(a.part) || 0)),
    };
  }),
  /** World points under pixels of the last view or section, re-rendering that exact camera. */
  probe: (a) => {
    const pixels = a.pixels as any[];
    if (!Array.isArray(pixels) || !pixels.length) throw new Error('pixels: [[x,y], …] of the most recent view or section');
    if (!lastRender) throw new Error('take a view or a section first — probe works on its pixels');
    const r = lastRender;
    return r.run((map) => ({
      of: r.label, mapping: map, translation: globalShift(),
      points: pixels.map((q: any) => {
        const x = Number(q?.[0]), y = Number(q?.[1]);
        const w = isFinite(x) && isFinite(y) ? viewer.pickWorld(x, y) : null;
        return w ? { pixel: [x, y], local: arr6(w.toArray()), global: toGlobal(w.toArray()) } : null;
      }),
    }));
  },
  heightmap: (a) => heightmapCmd(a),
  contour: (a) => contourCmd(a),
  fitplane: (a) => fitPlaneCmd(a),
  distance: (a) => {
    const A = (a.a ?? []).map(Number), B = (a.b ?? []).map(Number);
    if (A.length !== 3 || B.length !== 3 || [...A, ...B].some((v: number) => !isFinite(v))) throw new Error('a and b: [x,y,z] in local metres');
    const d = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
    return {
      a: arr6(A), b: arr6(B), aGlobal: toGlobal(A), bGlobal: toGlobal(B),
      distance: r6(d), dz: r6(B[2] - A[2]),
      horizontal: r6(Math.hypot(B[0] - A[0], B[1] - A[1])), units: 'm',
    };
  },
  inside: (a) => {
    if (!viewer.loaded) throw new Error('nothing loaded');
    const r = regionFrom(a.box, 'inside-box');
    const res = viewer.cells.insideExact(r);
    return {
      box: { center: arr6(r.center), half: arr6(r.half), quat: r.quat },
      count: res.count, of: viewer.loaded,
      bounds: res.min ? { local: { min: arr6(res.min), max: arr6(res.max!) }, global: { min: toGlobal(res.min), max: toGlobal(res.max!) } } : null,
      exact: true,
    };
  },
  set_view: (a) => { if (a.preset === 'fit') viewer.fit(); else if (a.preset === 'top') viewer.topDown(); else if (a.pose) viewer.setView(a.pose); else if (a.orbit) viewer.setOrbit(a.orbit.azimuthDeg, a.orbit.elevationDeg, a.orbit.distance); viewer.render(); return viewer.getView(); },
  set: (s) => {
    const map: Record<string, (v: any) => void> = { colorMode: v => setColorMode(+v), pointSize: v => knobs.size = +v, maxPx: v => knobs.maxPx = +v, edl: v => knobs.edl = !!v,
      edlStrength: v => knobs.edlStrength = +v, normalShade: v => knobs.normalShade = !!v, budget: v => knobs.budget = +v, density: v => knobs.density = +v, clipZMin: v => knobs.clipZMin = +v, clipZMax: v => knobs.clipZMax = +v, bright: v => knobs.bright = +v, gamma: v => knobs.gamma = +v };
    for (const [k, v] of Object.entries(s)) map[k]?.(v);
    push(); viewer.render(); return knobs;
  },
  regions: async (a) => {
    if (a.op === 'list') return allRegions();
    if (a.op === 'mode') {
      // which way the crop region cuts: keep what is inside it, or remove it
      setCropRole(a.role === 'delete' ? 'delete' : 'keep');
      cropUI.on = true; $<HTMLInputElement>('k-cropon').checked = true;
      updateCropUI(); viewer.render();
      return { crop: cropState, mode: cropState.role === 'delete' ? 'remove inside' : 'keep inside' };
    }
    if (a.op === 'clear') { sections.length = 0; deletes.length = 0; cropUI.on = false; $<HTMLInputElement>('k-cropon').checked = false; syncRegions(); renderSectionList(); return []; }
    if (a.op === 'add' || a.op === 'update') {
      const r: Region = { id: a.region.id ?? uid(a.region.role === 'keep' ? 'sec-' : 'ai-'), kind: a.region.kind, role: a.region.role ?? 'keep', center: a.region.center, half: a.region.half ?? [1, 1, 1], radius: a.region.radius ?? (a.region.half?.[0] ?? 1), quat: a.region.quat ?? [0, 0, 0, 1], label: a.region.label };
      if (r.kind === 'slab') { const md = maxDim(); r.half = [md * 3, md * 3, r.half[2]]; }
      const pool = r.role === 'keep' ? sections : deletes; const i = pool.findIndex(x => x.id === r.id);
      if (i >= 0) pool[i] = r; else pool.push(r);
      syncRegions(); renderSectionList(); viewer.setActiveRegion(r.id); viewer.render(); return r;
    }
    if (a.op === 'remove') { for (const pool of [sections, deletes]) { const i = pool.findIndex(x => x.id === a.id); if (i >= 0) pool.splice(i, 1); } if (a.id === 'crop') cropUI.on = false; syncRegions(); renderSectionList(); viewer.render(); return allRegions(); }
    if (a.op === 'apply') {
      const keeps = allRegions().filter(r => r.role === 'keep');
      const dels = allRegions().filter(r => r.role === 'delete');
      const r = await commitApply([...keeps, ...dels], keeps.length ? 'crop' : 'clean', 'Agent apply', () => {
        cropped = true; sections.length = 0; cropUI.on = false; $<HTMLInputElement>('k-cropon').checked = false;
        if (keeps.length) deletes.length = 0;
        else for (const d of dels) { const i = deletes.indexOf(d); if (i >= 0) deletes.splice(i, 1); }
      });
      return { kept: r.kept, dropped: r.dropped, points: viewer.loaded };
    }
    throw new Error('bad op');
  },
  pick: (a) => viewer.pickWorld(a.x, a.y)?.toArray() ?? null,
  measure: (a) => {
    if (a.clear) { viewer.clearMeasures(); updateMeasureList(); return { cleared: true }; }
    const A = a.a ? new THREE.Vector3(...a.a) : a.pxA ? viewer.pickWorld(a.pxA[0], a.pxA[1]) : null;
    const B = a.b ? new THREE.Vector3(...a.b) : a.pxB ? viewer.pickWorld(a.pxB[0], a.pxB[1]) : null;
    if (!A || !B) throw new Error('need two points (a/b in metres or pxA/pxB on screen)');
    const d = viewer.measureBetween(A, B); updateMeasureList(); viewer.render(); return { a: A.toArray(), b: B.toArray(), dist: d, dz: B.z - A.z };
  },
  export: async (a) => {
    const r = await runExport(a.format, a.stride ?? 1);
    const transferId = (Math.random() * 0xffffffff) >>> 0; const CH = 4 * 1024 * 1024; let seq = 0;
    for (let off = 0; off < r.file.size; off += CH) { const buf = new Uint8Array(await r.file.slice(off, off + CH).arrayBuffer()); agent.sendChunk(transferId, seq++, buf); await tick(); }
    io.postMessage({ type: 'export-cleanup', name: r.scratch });
    return { transferId, count: r.count, bytes: r.bytes, name: r.name };
  },
  open: async (a) => {
    if (a.stride) $<HTMLSelectElement>('k-load').value = String(a.stride);
    if (a.cached) await openCached(a.cached); else throw new Error('give cached: <key>');
    await new Promise<void>(res => { const iv = setInterval(() => { if (/(loaded|from cache|streamed) in/.test($('tb-points').textContent || '')) { clearInterval(iv); res(); } }, 200); });
    return { points: viewer.loaded };
  },
  surface: async (a) => {
    if (a.op === 'clear') { meshData = null; meshInfo = null; dirtyMark.surface = 0; viewer.setMesh(null); document.body.classList.remove('has-mesh'); setDisplay('points'); viewer.render(); return { triangles: 0 }; }
    if (a.op === 'show') { setDisplay(a.mode === 'mesh' || a.mode === 'both' ? a.mode : 'points'); viewer.render(); return { display: viewer.display, triangles: viewer.mesh.triangles }; }
    if (a.op === 'build') {
      const st = await buildMesh({ voxel: a.voxelCm, smooth: a.smooth, trunc: a.fillGaps, confirm: false });
      viewer.render();
      return st ? { triangles: st.triangles, vertices: st.vertices, display: viewer.display, surface: surfaceRecord(), recommendedSource: recommendedSource() } : { triangles: 0 };
    }
    if (a.op === 'export') {
      if (!meshData) throw new Error('no surface: run surface build first');
      const fmtSel = a.format === 'obj' ? 'obj' : 'ply';
      const part = Math.round(Number(a.part) || 0);
      const key = `surface:${fmtSel}:${meshInfo?.triangles ?? 0}`;
      const hit = pagedHit(key, part);
      if (hit) return { format: fmtSel, ...hit, ...surfaceRecord() };
      const t = globalShift() as [number, number, number];
      const blob = fmtSel === 'ply' ? viewer.mesh.toPly(meshData, t) : viewer.mesh.toObj(meshData, t);
      const buf = new Uint8Array(await blob.arrayBuffer());
      let raw = '';
      for (let i = 0; i < buf.length; i += 0x8000) raw += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const out = pagedSet(key, btoa(raw), part);
      return {
        format: fmtSel, bytes: buf.length, ...out, ...surfaceRecord(),
        note: 'base64 of the file; the cloud transform and the global shift are already baked into the coordinates. Concatenate the parts in order, then decode.',
      };
    }
    throw new Error('bad op');
  },
  history: async (a) => {
    if (a.op === 'status') return hist.steps;
    if (a.op === 'undo') return undoEdit().then(e => e ? { undone: e.label, points: viewer.loaded } : { undone: null });
    if (a.op === 'redo') return redoEdit().then(e => e ? { redone: e.label, points: viewer.loaded } : { redone: null });
    if (a.op === 'save') { await saveCurrent(); return { points: viewer.loaded, cached: fromCache, history: hist.steps }; }
    throw new Error('bad op');
  },
  transform: async (a) => {
    const op = a.op ?? 'get';
    if (op === 'get') return transformState();
    if (!viewer.loaded) throw new Error('nothing loaded');
    if (op === 'level') { await levelCloud(); viewer.render(); return transformState(); }
    let next: THREE.Matrix4, label: string;
    if (op === 'set') {
      const v = (a.matrix ?? []).map(Number);
      if (v.length !== 16 || v.some((x: number) => !isFinite(x))) throw new Error('matrix: 16 finite numbers, row-major');
      next = fromRowMajor(v); label = 'Apply matrix';
    } else if (op === 'translate') {
      const t = (a.translation ?? [0, 0, 0]).map(Number);
      next = thenModel(new THREE.Matrix4().makeTranslation(t[0] || 0, t[1] || 0, t[2] || 0));
      label = `Move ${t.map((n: number) => (n || 0).toFixed(2)).join(', ')} m`;
    } else if (op === 'rotate') {
      const deg = Number(a.degrees ?? 0), axis = String(a.axis ?? 'z').toLowerCase();
      if (!isFinite(deg)) throw new Error('degrees must be a number');
      next = rotationMatrix(axis, deg, a.about === 'origin' ? 'origin' : 'centre');
      label = `Rotate ${deg.toFixed(1)}° about ${axis.toUpperCase()}`;
    } else if (op === 'scale') {
      const f = Number(a.factor ?? 1);
      if (!(f > 0)) throw new Error('factor must be greater than zero');
      next = thenModel(about(boundsCentre(), new THREE.Matrix4().makeScale(f, f, f)));
      label = `Scale ×${f}`;
    } else if (op === 'reset') { next = new THREE.Matrix4(); label = 'Reset transform'; }
    else throw new Error('bad op');
    await commitTransform(next, label);
    viewer.render();
    return transformState();
  },
  stations: async (a) => { if (a.enter === -1) viewer.exitBubble(); else if (a.enter !== undefined) await enterStation(a.enter); viewer.render(); return { stations: viewer.stationPositions(), bubble: viewer.bubble?.index ?? null }; },
});
agent.onStatus = (s) => { $('v-agent').textContent = s; };
// The MCP server is a plain file the user runs; the page can only hand it over.
$('k-mcpget').addEventListener('click', () => {
  const a = document.createElement('a'); a.href = '/mcp.mjs'; a.download = 'e57view-mcp.mjs';
  document.body.appendChild(a); a.click(); a.remove();
  $('v-agent').textContent = 'downloaded e57view-mcp.mjs · register it with the command below';
});
$('k-mcpcopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('v-mcp').textContent ?? ''); $('v-agent').textContent = 'install commands copied'; }
  catch { $('v-agent').textContent = 'select the text below and copy it'; }
});
$('k-agent').addEventListener('change', e => { const on = (e.target as HTMLInputElement).checked; localStorage.setItem('agent', on ? '1' : '0'); on ? agent.start() : agent.stop(); });
if (new URLSearchParams(location.search).get('agent') === '1' || localStorage.getItem('agent') === '1') { $<HTMLInputElement>('k-agent').checked = true; agent.start(); }

/** Commands a remote session may run only when this tab has ticked Allow edits:
 *  anything that drops points, writes a file, loads another scan or spends provider credit. */
function agentNeedsEdit(cmd: string, a: any = {}): boolean {
  if (cmd === 'open') return true;
  if (cmd === 'regions') return a.op === 'apply';
  if (cmd === 'surface') return a.op === 'build';
  if (cmd === 'history') return a.op !== 'status';
  if (cmd === 'transform') return (a.op ?? 'get') !== 'get';
  return false;
}
/** An agent reply is written into a Firestore document, so it must be small and plain.
 *  Undo records carry typed arrays and live GL handles; they would blow the 1 MiB limit
 *  and be rejected, leaving the caller with an error for work that actually succeeded. */
const HEAVY = new Set(['undo', 'recs', 'mask', 'leaf']);
/** Commands that answer with their own image, or with a payload no screenshot should share. */
const OWN_IMAGE = new Set(['view', 'section', 'heightmap']);
const NO_SHOT = new Set(['state', 'pick', 'probe', 'fitplane', 'contour', 'distance', 'inside']);
/** A Firestore document holds one reply and is capped at 1 MiB. */
const RESULT_CAP = 700_000;
function slim(v: any): any {
  return JSON.parse(JSON.stringify(v, (k, x) => {
    if (HEAVY.has(k) || ArrayBuffer.isView(x)) return undefined;
    return typeof x === 'number' && !isFinite(x) ? null : x;
  }) ?? 'null');
}
async function dispatchAgent(cmd: string, args: any = {}) {
  if (agentNeedsEdit(cmd, args) && !$<HTMLInputElement>('k-agentedits').checked)
    throw new Error(`"${cmd}" changes the scan or spends credit. This session is read-only: tick "Allow edits" in the Agent panel of the viewer tab.`);
  const noShot = NO_SHOT.has(cmd) || OWN_IMAGE.has(cmd) || (cmd === 'surface' && args?.op === 'export');
  const wantShot = cmd === 'screenshot' || args?.shot === true || (args?.shot !== false && !noShot);
  const raw = await agent.run(cmd, args);
  if (raw && typeof raw === 'object' && wantShot) delete (raw as any).png;   // don't ship the same frame twice
  let result = slim(raw);
  // A command that answers with its own single-part image rides the existing shot channel, so
  // the result JSON stays small and every transport looks the same.
  let lifted: string | null = null, liftedMime = 'image/jpeg';
  if (result?.image?.parts === 1 && typeof result.image.data === 'string') {
    lifted = raw.image.data; liftedMime = raw.image.mime ?? 'image/jpeg';
    // drop the key rather than setting it undefined: the relay writes this into Firestore,
    // which rejects an undefined field outright
    const { data: _drop, ...rest } = result.image;
    result = { ...result, image: { ...rest, inShot: true } };
  }
  const size = JSON.stringify(result ?? null).length;
  if (size > RESULT_CAP) result = { note: `result omitted, ${size} characters is over the ${RESULT_CAP} a relayed reply can carry. Ask for it in parts (part: 0, 1, …) or with a smaller width/resolution.`, keys: Object.keys(raw ?? {}) };
  const out: any = { result };
  if (lifted) { out.shot = lifted; out.mime = liftedMime; }
  else if (wantShot) {
    const b64 = viewer.snapshot(Math.min(1280, Number(args?.width) || 1024), 'jpeg').split(',')[1] || '';
    if (b64.length < PAGE) { out.shot = b64; out.mime = 'image/jpeg'; }
  }
  return out;
}
let stopSession: (() => void) | null = null;
let agentSid: string | null = null;
let agentToken: string | null = null;      // memory + sessionStorage only, so the tab can revoke itself
let agentSticky = 0;                                   // hold a message the watcher must not overwrite
function agentStatus(text: string, sticky = 0) {
  if (!sticky && Date.now() < agentSticky) return;
  agentSticky = sticky ? Date.now() + sticky : 0;
  $('v-agenturl').textContent = text;
}
function updateAgentUI() {
  $('k-agentstop').classList.toggle('hidden', !agentSid);
  ($('k-agentedits') as HTMLInputElement).disabled = !agentSid;
}
async function startRemoteSession(sid: string) {
  const m = sessionMod ?? await import('./session'); sessionMod = m;
  await m.ensureAuth();
  stopSession?.();
  agentSid = sid;
  if (!agentToken) { try { agentToken = sessionStorage.getItem('agent-token:' + sid); } catch {} }
  stopSession = m.watchAgentSession(sid, dispatchAgent, s => agentStatus(s));
  updateAgentUI();
}
$('k-agenturl').addEventListener('click', async () => {
  try {
    const m = sessionMod ?? await import('./session'); sessionMod = m;
    const edits = $<HTMLInputElement>('k-agentedits').checked;
    const { sid, token, expiresAt } = await m.createAgentSession(edits);
    agentToken = token;
    try { sessionStorage.setItem('agent-token:' + sid, token); } catch {}
    await startRemoteSession(sid);
    // The page URL carries the session id only. The token goes to the agent alone, so a
    // leaked link (history, referrer, analytics) grants nothing.
    const page = new URL(location.origin + location.pathname);
    page.searchParams.set('session', sid);
    const blob = [
      `# e57view agent session — expires ${new Date(expiresAt).toLocaleString()}`,
      `# ${edits ? 'Edits allowed.' : 'Read-only: tick "Allow edits" in the viewer to permit crop, clean and save.'}`,
      `# Keep this tab open. The token below is the credential; it is shown once and is not in the URL.`,
      '',
      `Viewer page: ${page}`,
      '',
      `curl -s ${location.origin}/agent \\`,
      `  -H 'Authorization: Bearer ${token}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '${JSON.stringify({ session: sid, cmd: 'state' })}'`,
    ].join('\n');
    await navigator.clipboard.writeText(blob);
    agentStatus(`session ${sid} copied with its token · ${edits ? 'edits allowed' : 'read-only'}`, 8000);
  } catch (e: any) { agentStatus('failed: ' + (e?.message ?? e), 8000); }
});
$('k-agentstop').addEventListener('click', async () => {
  if (!agentSid) return;
  const sid = agentSid;
  stopSession?.(); stopSession = null; agentSid = null; agentToken = null;
  try { sessionStorage.removeItem('agent-token:' + sid); } catch {}
  updateAgentUI();
  try { await sessionMod?.stopAgentSession(sid); agentStatus('session stopped · its token no longer works', 8000); }
  catch (e: any) { agentStatus('stopped locally, but the record remains: ' + (e?.message ?? e), 8000); }
});
$('k-agentedits').addEventListener('change', async e => {
  const on = (e.target as HTMLInputElement).checked;
  if (agentSid) { try { await sessionMod?.setAgentEdits(agentSid, on); } catch {} }
});
updateAgentUI();
// Close the window, lose the token. A beacon survives unload where a normal request does
// not; bfcache (persisted) is a pause, not a close, so it must not revoke.
addEventListener('pagehide', (e) => {
  if ((e as PageTransitionEvent).persisted || !agentSid) return;
  const sid = agentSid;
  try {
    if (agentToken && navigator.sendBeacon) {
      const body = JSON.stringify({ session: sid, token: agentToken, cmd: 'revoke' });
      navigator.sendBeacon('/agent', new Blob([body], { type: 'application/json' }));
    } else sessionMod?.stopAgentSession(sid);
  } catch {}
});
const sessionParam = new URLSearchParams(location.search).get('session');
if (sessionParam) import('./session').then(m => { sessionMod = m; startRemoteSession(sessionParam); }).catch(e => agentStatus('session: ' + ((e as any)?.message ?? e)));

// ------------------------------------------------------------------ entry
async function pickFile() {
  const anyWin = window as any;
  if (anyWin.showOpenFilePicker) {
    try { const [h] = await anyWin.showOpenFilePicker({ types: [{ description: 'Point cloud', accept: { 'application/octet-stream': ['.e57', '.ply', '.las'] } }] }); openFile(await h.getFile(), h); } catch {}
    return;
  }
  const inp = document.createElement('input'); inp.type = 'file'; if (!isIOS) inp.accept = '.e57,.ply,.las';
  inp.onchange = () => inp.files?.[0] && openFile(inp.files[0]); inp.click();
}
/** Open another scan: the same picker the start screen uses, behind the unsaved-work guard. */
async function openAnother() { if (await confirmReplace()) await pickFile(); }
$('pick').addEventListener('click', pickFile); $('pick2').addEventListener('click', pickFile);
$('tb-open').addEventListener('click', () => openAnother());
$('k-open').addEventListener('click', () => openAnother());
const testInput = document.createElement('input');
testInput.type = 'file'; testInput.id = 'file-input'; testInput.style.cssText = 'position:fixed;opacity:0;pointer-events:none;left:-9999px';
testInput.onchange = async () => {
  if (!testInput.files?.[0]) return;
  if (!(await confirmReplace())) return;
  openFile(testInput.files[0]);
};
document.body.appendChild(testInput);
const drop = $('drop');
for (const t of ['dragenter', 'dragover']) addEventListener(t, e => { e.preventDefault(); drop.classList.add('drag'); });
addEventListener('dragleave', e => { e.preventDefault(); drop.classList.remove('drag'); });
addEventListener('drop', async e => {
  e.preventDefault(); drop.classList.remove('drag');
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (!f) return;
  if (!(await confirmReplace())) return;
  openFile(f);
});
addEventListener('beforeunload', e => {
  if (hist.undo.length + hist.redo.length === 0) return;
  e.preventDefault();
  (e as any).returnValue = '';
});

// ------------------------------------------------------------------ device defaults, sheet, groups
(function deviceDefaults() {
  const load = $<HTMLSelectElement>('k-load'), budget = $<HTMLSelectElement>('k-budget');
  if (small) { load.value = '10'; budget.value = '1000000'; } else if (isTouch) { load.value = '4'; budget.value = '2000000'; } else { load.value = '1'; budget.value = '8000000'; }
  knobs.budget = Number(budget.value);
  if (isTouch) {
    $('drop-lede').textContent = 'Pick a scan from Files. Nothing is uploaded — it is read straight off your device.';
    $('drop-hint').textContent = '.e57 · .ply · .las · large files stay on device';
    $('panel').classList.add('peek');
    $('v-navhint').innerHTML = 'One finger orbits · two fingers pan and zoom · <b>double-tap</b> a point to orbit around it';
  }
  if (isIOS || isTouch) $('scan-card').classList.remove('hidden');
})();
const panelEl = $('panel');
const isSheet = () => getComputedStyle(panelEl).borderTopLeftRadius !== '0px' && isTouch;
function toggleSheet(force?: boolean) { const peek = force !== undefined ? !force : !panelEl.classList.contains('peek'); panelEl.classList.toggle('peek', peek); viewer.resize(); viewer.touch(); }
$('grabber').addEventListener('click', () => toggleSheet());
{ let y0 = 0, moved = false; const g = $('grabber');
  g.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; moved = false; }, { passive: true });
  g.addEventListener('touchmove', e => { if (Math.abs(e.touches[0].clientY - y0) > 24) moved = true; }, { passive: true });
  g.addEventListener('touchend', e => { if (!moved) return; toggleSheet((e.changedTouches[0].clientY - y0) < 0); }); }
addEventListener('orientationchange', () => setTimeout(() => { viewer.resize(); viewer.fit(); }, 260));
document.querySelectorAll<HTMLElement>('#panel .grp').forEach((g, i) => {
  const h = g.querySelector('h3'); if (!h) return;
  const name = g.dataset.grp ?? h.textContent ?? String(i); const key = 'grp:' + name;
  const defaultClosed = ['Tone', 'Clipping', 'measure', 'export', 'cache', 'sections', 'agent', 'surface', 'analysis', 'field', 'transform'].includes(name);
  const stored = localStorage.getItem(key); g.classList.toggle('closed', stored ? stored === '1' : defaultClosed);
  h.addEventListener('click', () => { g.classList.toggle('closed'); localStorage.setItem(key, g.classList.contains('closed') ? '1' : '0'); });
});
viewer.onStats = () => {
  const s = viewer.stats;
  $('v-stats').textContent = `${fmt(s.pointsDrawn)} drawn · ${s.leavesDrawn}/${s.leavesVisible} cells · ${viewer.frameMs.toFixed(1)} ms`;
  if (viewer.fps) $('tb-fps').textContent = `${viewer.fps.toFixed(0)} fps`;
};

push();
updateTransformUI();
refreshCachedList();
(function loop() { viewer.render(); requestAnimationFrame(loop); })();
(window as any).__viewer = viewer;
(window as any).__app = { openFile, openCached, writeCache, applyKeep, applyCrop, setCropRole, get cropState() { return cropState; }, addSection, undoEdit, redoEdit, saveCurrent, hist,
  commitTransform, transformState, levelCloud, rowMajor, fromRowMajor, runExport, updateTransformUI,
  dirtyList, isDirty, openAnother, confirmReplace,
  stateRecord, recommendedSource, surfaceRecord, heightmapCmd, contourCmd, fitPlaneCmd, dispatchAgent,
  get cacheNote() { return cacheNote; }, get meta() { return meta; }, get cacheKey() { return cacheKey; }, get regions() { return allRegions(); }, buildMesh, analysis, runAnalysis, maskTool, get sfStats() { return viewer.cells.scalarStats(); }, get meshData() { return meshData; } };
