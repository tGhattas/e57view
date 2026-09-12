import './style.css';
import * as THREE from 'three';
import { Viewer, isTouch, isIOS, type Knobs, type Station, type GizmoMode } from './viewer';
import { REC, type Region } from './cells';
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
  revealed = false; gotRealLeaf = false; fromCache = false; cropped = false;
  (document.activeElement as HTMLElement | null)?.blur?.();
  $('drop').classList.add('hidden'); $('loading').classList.remove('hidden', 'over');
  $('ld-name').textContent = name; $('ld-stat').textContent = 'opening…'; $('ld-bar').style.width = '0%'; $('err').classList.add('hidden');
  viewer.clear();
  histogram = new Uint32Array(256); axisHist = [new Uint32Array(NB), new Uint32Array(NB), new Uint32Array(NB)]; axisCube = null;
  sections.length = 0; deletes.length = 0; cropUI.on = false;
  meshData = null; viewer.setMesh(null); document.body.classList.remove('has-mesh');
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
  viewer.setStations(meta.stations as Station[], s.translation);
  $('v-stations').textContent = meta.stations.length ? `${meta.stations.length} panoramas in this file` : 'No panoramas in this file';
  $('k-stations').parentElement!.classList.toggle('hidden', !meta.stations.length);
}
function onDone(stats: any, how: string) {
  if (!fromCache) robustBounds();
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
function cropReadouts() {
  const box = cropState.kind === 'box', slab = cropState.kind === 'slab';
  document.querySelectorAll('.box-only').forEach(el => (el as HTMLElement).style.display = box ? '' : 'none');
  $('v-cropsize').textContent = box ? `${(cropState.half[0] * 2).toFixed(1)} m` : slab ? `${(cropState.half[2] * 2).toFixed(2)} m thick` : `r ${cropState.radius.toFixed(1)} m`;
  $('v-cropsy').textContent = `${(cropState.half[1] * 2).toFixed(1)} m`; $('v-cropsz').textContent = `${(cropState.half[2] * 2).toFixed(1)} m`;
  const keeps = allRegions().filter(r => r.role === 'keep');
  const est = keeps.length && viewer.loaded ? viewer.cells.estimateKept(keeps) : 0;
  $('v-crop').textContent = cropped ? `cropped · ${fmt(viewer.loaded)} points in memory` : keeps.length ? `~${fmt(est)} of ${fmt(viewer.loaded)} points inside` : '—';
  $('v-sections').textContent = sections.length ? `${sections.length} section${sections.length > 1 ? 's' : ''} · union` : '—';
}
function updateCropUI(recenter = false) {
  if (recenter) { const b = viewer.bounds(); if (!b.isEmpty()) cropState.center = b.getCenter(new THREE.Vector3()).toArray() as any; }
  cropFromSliders(); syncRegions(); cropReadouts();
  if (cropUI.on) viewer.setActiveRegion('crop'); else if (viewer.activeRegion === 'crop') viewer.setActiveRegion(null);
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
const gizmoBtn = (id: string, m: GizmoMode) => $(id).addEventListener('click', () => { viewer.setGizmoMode(m); for (const b of ['k-cropmove', 'k-croprotate', 'k-cropresize']) $(b).classList.toggle('on', b === id); });
gizmoBtn('k-cropmove', 'translate'); gizmoBtn('k-croprotate', 'rotate'); gizmoBtn('k-cropresize', 'scale');
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
async function applyKeep() {
  const keeps = allRegions().filter(r => r.role === 'keep');
  if (!viewer.loaded || !keeps.length) return null;
  const est = viewer.cells.estimateKept(keeps);
  const what = keeps.length === 1 ? `the ${keeps[0].kind}` : `${keeps.length} keep regions`;
  const ans = await modal('Apply crop?', `<p>Everything outside ${what} will be dropped from memory — roughly <b>${fmt(est)}</b> of ${fmt(viewer.loaded)} points kept.</p><p>The file on disk is not touched. <b>Undo</b> puts the points back. <b>Save as…</b> writes a copy. AI suggestion tags are cleared (they come back if you undo). <b>Escape</b> cancels.</p>`,
    [{ label: 'Cancel', value: 'no' }, { label: 'Drop outside points', value: 'yes', cls: 'danger' }]);
  if (ans !== 'yes') return null;
  return commitApply(keeps, 'crop', res => `Crop · dropped ${fmt(res.dropped)}`, () => {
    cropped = true; cropUI.on = false; $<HTMLInputElement>('k-cropon').checked = false; sections.length = 0; deletes.length = 0;
    viewer.setActiveRegion(null);
  });
}
$('k-cropapply').addEventListener('click', () => { if (!cropUI.on && !sections.length) { cropUI.on = true; $<HTMLInputElement>('k-cropon').checked = true; updateCropUI(); } applyKeep(); });
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
    await viewer.undoRegions(e.undo, i => hist.fetch(e, i));
    viewer.restoreBounds(e.robust);
    restoreUi(e.before);
    hist.movedToRedo(e);
    $('v-loaded').textContent = `${fmt(viewer.loaded)} points in memory`;
    $('tb-points').textContent = `${fmt(viewer.loaded)} pts · undone`;
    updateHistUI(); viewer.fit(); viewer.touch();
    return e;
  } finally { hideBusy(); }
}
async function redoEdit() {
  const e = hist.peekRedo(); if (!e || !viewer.loaded) return null;
  busy('Redoing…'); await tick();
  try {
    const res = viewer.redoRegions(e.undo);
    viewer.restoreBounds(null);
    restoreUi(e.after);
    hist.movedToUndo(e);
    await hist.afterRedo(e);
    $('v-loaded').textContent = `${fmt(res.kept)} points in memory · ${fmt(res.dropped)} dropped`;
    $('tb-points').textContent = `${fmt(res.kept)} pts · redone`;
    updateHistUI(); viewer.fit(); viewer.touch();
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
    await hist.clear();
    updateHistUI(); updateCacheUI();
    $('v-export').textContent = `saved ${r.name} · ${fmt(r.count)} points · ${mb(r.bytes)}`;
    $('tb-points').textContent = `${fmt(r.count)} pts · saved`;
    if (currentFile) $('v-cache').textContent = cacheUpdated ? `saved ${r.name} · cache updated · undo cleared` : `saved ${r.name} · undo cleared`;
  } catch (e: any) { fail('Could not save: ' + (e?.message ?? e)); }
  finally { hideBusy(); }
}
async function confirmDiscardHistory(): Promise<boolean> {
  if (hist.undo.length + hist.redo.length === 0) return true;
  const ans = await modal('Discard unsaved history?',
    `<p>There is unsaved history (${hist.undo.length} undo, ${hist.redo.length} redo). Continuing replaces the loaded scan and discards it.</p>`,
    [{ label: 'Cancel', value: 'no' }, { label: 'Discard and continue', value: 'yes', cls: 'danger' }]);
  return ans === 'yes';
}
async function reloadScan() {
  if (!currentFile) return;
  if (hist.canUndo || hist.canRedo) {
    const ans = await modal('Reload the scan?', `<p>There is unsaved history (${hist.undo.length} undo, ${hist.redo.length} redo). Reload discards it and reads the scan again from ${fromCache ? 'the cache on this device' : 'disk'}.</p>`,
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
  anaWorker.postMessage({ type: 'start', cell, maxPoints: isTouch ? 8e6 : 30e6 });
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
  sfName = '';
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
      // patch the new normals into each leaf's records, in the order they were fed
      const nrm = r.data as Int8Array;
      let at = 0;
      viewer.cells.rewriteRecords((leaf) => {
        const recs = leaf.readback(viewer.cells.gl2);
        for (let i = 0; i < leaf.count; i++) {
          recs[i * REC + 10] = nrm[(at + i) * 3] & 0xff;
          recs[i * REC + 11] = nrm[(at + i) * 3 + 1] & 0xff;
          recs[i * REC + 12] = nrm[(at + i) * 3 + 2] & 0xff;
        }
        at += leaf.count;
        return recs;
      });
      $('v-analysis').textContent = `${note} · ${fmt(r.points)} points · ${secs}s`;
      viewer.touch();
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

$('k-annorm').addEventListener('click', () => analysis('normals', { k: anaUi.k, orient: false }, 'normals computed').catch(() => {}));
$('k-anorient').addEventListener('click', () => analysis('normals', { k: anaUi.k, orient: true }, 'normals computed and oriented').catch(() => {}));
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
    meshWorker.postMessage({ type: 'start', voxel, trunc, minWeight: opts.minW ?? MIN_W, stride, maxBytes: budget });
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
    viewer.setMesh(meshData);
    document.body.classList.toggle('has-mesh', !!meshData.idx.length);
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
  meshData = null; viewer.setMesh(null); document.body.classList.remove('has-mesh');
  sfName = ''; sfStats = null; document.body.classList.remove('has-sf', 'sf-filtering');
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
  for (const { leaf, recs } of viewer.cells.records()) {
    const n = Math.ceil(leaf.count / stride);
    const xyz = new Float64Array(n * 3), rgb = new Uint8Array(n * 3), inten = new Uint8Array(n), nrm = new Int8Array(n * 3);
    const u16 = new Uint16Array(recs.buffer, recs.byteOffset, (leaf.count * REC) >> 1); const k = leaf.size / 65536; let j = 0;
    for (let i = 0; i < leaf.count; i += stride) {
      const b = i * 7, o = i * REC;
      xyz[j * 3] = leaf.origin.x + u16[b] * k; xyz[j * 3 + 1] = leaf.origin.y + u16[b + 1] * k; xyz[j * 3 + 2] = leaf.origin.z + u16[b + 2] * k;
      rgb[j * 3] = recs[o + 6]; rgb[j * 3 + 1] = recs[o + 7]; rgb[j * 3 + 2] = recs[o + 8]; inten[j] = recs[o + 9];
      nrm[j * 3] = recs[o + 10] << 24 >> 24; nrm[j * 3 + 1] = recs[o + 11] << 24 >> 24; nrm[j * 3 + 2] = recs[o + 12] << 24 >> 24; j++;
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
  io.postMessage({ type: 'cache-start', key: cacheKey, meta: { name: currentFile.name, size: currentFile.size, lastModified: currentFile.lastModified, stride, scanMeta: meta, kept: viewer.loaded, histogram: Array.from(histogram), robust: r ? { lo: r.lo, hi: r.hi } : null } });
  await ioOnce('cache-ready');
  let n = 0;
  for (const { leaf, recs } of viewer.cells.records()) {
    const buf = recs.buffer as ArrayBuffer;
    io.postMessage({ type: 'cache-chunk', recs: buf, leaf: { count: leaf.count, origin: leaf.origin.toArray(), size: leaf.size, bmin: leaf.bmin.toArray(), bmax: leaf.bmax.toArray() } }, [buf]);
    if (++n % 6 === 0) await tick();
  }
  io.postMessage({ type: 'cache-finish' }); const done = await ioOnce('cache-done');
  hideBusy(); fromCache = true; $('v-cache').textContent = `cached · ${mb(done.bytes)} on this device`; updateCacheUI(); refreshCachedList();
}
function updateCacheUI() {
  const btn = $('k-cache'), rm = $('k-cacheremove');
  if (!currentFile) { $('v-cache').textContent = '—'; btn.classList.add('hidden'); rm.classList.add('hidden'); return; }
  if (fromCache) { $('v-cache').textContent = cropped ? 'cache holds the current (edited) points' : 'this scan is cached on this device'; btn.classList.add('hidden'); rm.classList.remove('hidden'); }
  else if (cropped) { $('v-cache').textContent = `not cached · caching now stores the edited ${fmt(viewer.loaded)} points (${mb(viewer.loaded * REC)})`; btn.classList.remove('hidden'); rm.classList.add('hidden'); }
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
      if (!(await confirmDiscardHistory())) return;
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
function applyPendingView() { if (!pendingView) return; try { viewer.setView(pendingView); if (pendingView.c !== undefined) { knobs.colorMode = pendingView.c; $<HTMLSelectElement>('k-color').value = String(pendingView.c); push(); } } catch {} pendingView = null; }
function applyUrlCommands() {
  const q = new URLSearchParams(location.search);
  const view = q.get('view');
  if (view === 'top') viewer.topDown();
  else if (view === 'fit') viewer.fit();
  const az = q.get('az'), el = q.get('el');
  if (az != null && el != null && isFinite(+az) && isFinite(+el)) viewer.setOrbit(+az, +el, q.get('dist') ? +q.get('dist')! : undefined);
}
try { if (location.hash.length > 2) pendingView = JSON.parse(atob(location.hash.slice(1))); } catch {}

// ------------------------------------------------------------------ agent link
const agent = new AgentLink({
  state: () => ({
    file: currentFile?.name ?? null, points: viewer.loaded, cells: viewer.cells.leafCount, cropped, fromCache,
    history: hist.steps,
    view: viewer.getView(), knobs, regions: allRegions(), measurements: viewer.measureList.map(m => ({ a: m.a.toArray(), b: m.b.toArray(), dist: m.dist })),
    stations: viewer.stations.length, bubble: viewer.bubble?.index ?? null, cached: cachedItems.map(c => ({ key: c.key, name: c.name, points: c.points })),
    translation: meta?.scans?.[0]?.translation ?? null, bounds: viewer.bounds().isEmpty() ? null : { min: viewer.bounds().min.toArray(), max: viewer.bounds().max.toArray() },
  }),
  screenshot: (a) => ({ png: viewer.snapshot(a.width ?? 1280).split(',')[1], view: viewer.getView(), size: [innerWidth, innerHeight] }),
  set_view: (a) => { if (a.preset === 'fit') viewer.fit(); else if (a.preset === 'top') viewer.topDown(); else if (a.pose) viewer.setView(a.pose); else if (a.orbit) viewer.setOrbit(a.orbit.azimuthDeg, a.orbit.elevationDeg, a.orbit.distance); viewer.render(); return viewer.getView(); },
  set: (s) => {
    const map: Record<string, (v: any) => void> = { colorMode: v => { knobs.colorMode = +v; $<HTMLSelectElement>('k-color').value = String(v); }, pointSize: v => knobs.size = +v, maxPx: v => knobs.maxPx = +v, edl: v => knobs.edl = !!v,
      edlStrength: v => knobs.edlStrength = +v, normalShade: v => knobs.normalShade = !!v, budget: v => knobs.budget = +v, density: v => knobs.density = +v, clipZMin: v => knobs.clipZMin = +v, clipZMax: v => knobs.clipZMax = +v, bright: v => knobs.bright = +v, gamma: v => knobs.gamma = +v };
    for (const [k, v] of Object.entries(s)) map[k]?.(v);
    push(); viewer.render(); return knobs;
  },
  regions: async (a) => {
    if (a.op === 'list') return allRegions();
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
    if (a.op === 'clear') { meshData = null; viewer.setMesh(null); document.body.classList.remove('has-mesh'); setDisplay('points'); viewer.render(); return { triangles: 0 }; }
    if (a.op === 'show') { setDisplay(a.mode === 'mesh' || a.mode === 'both' ? a.mode : 'points'); viewer.render(); return { display: viewer.display, triangles: viewer.mesh.triangles }; }
    if (a.op === 'build') {
      const st = await buildMesh({ voxel: a.voxelCm, smooth: a.smooth, trunc: a.fillGaps, confirm: false });
      viewer.render();
      return st ? { triangles: st.triangles, vertices: st.vertices, display: viewer.display } : { triangles: 0 };
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
  return false;
}
/** An agent reply is written into a Firestore document, so it must be small and plain.
 *  Undo records carry typed arrays and live GL handles; they would blow the 1 MiB limit
 *  and be rejected, leaving the caller with an error for work that actually succeeded. */
const HEAVY = new Set(['undo', 'recs', 'mask', 'leaf']);
function slim(v: any): any {
  return JSON.parse(JSON.stringify(v, (k, x) => {
    if (HEAVY.has(k) || ArrayBuffer.isView(x)) return undefined;
    return typeof x === 'number' && !isFinite(x) ? null : x;
  }) ?? 'null');
}
async function dispatchAgent(cmd: string, args: any = {}) {
  if (agentNeedsEdit(cmd, args) && !$<HTMLInputElement>('k-agentedits').checked)
    throw new Error(`"${cmd}" changes the scan or spends credit. This session is read-only: tick "Allow edits" in the Agent panel of the viewer tab.`);
  const wantShot = cmd === 'screenshot' || args?.shot === true || (args?.shot !== false && cmd !== 'state' && cmd !== 'pick');
  const raw = await agent.run(cmd, args);
  if (raw && typeof raw === 'object' && wantShot) delete (raw as any).png;   // don't ship the same frame twice
  let result = slim(raw);
  const size = JSON.stringify(result ?? null).length;
  if (size > 150_000) result = { note: `result omitted, ${size} characters is too large to return`, keys: Object.keys(raw ?? {}) };
  const out: any = { result };
  if (wantShot) {
    const b64 = viewer.snapshot(Math.min(1280, Number(args?.width) || 1024), 'jpeg').split(',')[1] || '';
    if (b64.length < 600_000) { out.shot = b64; out.mime = 'image/jpeg'; }
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
$('pick').addEventListener('click', pickFile); $('pick2').addEventListener('click', pickFile);
const testInput = document.createElement('input');
testInput.type = 'file'; testInput.id = 'file-input'; testInput.style.cssText = 'position:fixed;opacity:0;pointer-events:none;left:-9999px';
testInput.onchange = async () => {
  if (!testInput.files?.[0]) return;
  if (!(await confirmDiscardHistory())) return;
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
  if (!(await confirmDiscardHistory())) return;
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
  const defaultClosed = ['Tone', 'Clipping', 'measure', 'export', 'cache', 'sections', 'agent', 'surface', 'analysis', 'field'].includes(name);
  const stored = localStorage.getItem(key); g.classList.toggle('closed', stored ? stored === '1' : defaultClosed);
  h.addEventListener('click', () => { g.classList.toggle('closed'); localStorage.setItem(key, g.classList.contains('closed') ? '1' : '0'); });
});
viewer.onStats = () => {
  const s = viewer.stats;
  $('v-stats').textContent = `${fmt(s.pointsDrawn)} drawn · ${s.leavesDrawn}/${s.leavesVisible} cells · ${viewer.frameMs.toFixed(1)} ms`;
  if (viewer.fps) $('tb-fps').textContent = `${viewer.fps.toFixed(0)} fps`;
};

push();
refreshCachedList();
(function loop() { viewer.render(); requestAnimationFrame(loop); })();
(window as any).__viewer = viewer;
(window as any).__app = { openFile, openCached, writeCache, applyKeep, addSection, undoEdit, redoEdit, saveCurrent, hist, get meta() { return meta; }, get cacheKey() { return cacheKey; }, get regions() { return allRegions(); }, buildMesh, analysis, runAnalysis, maskTool, get sfStats() { return viewer.cells.scalarStats(); }, get meshData() { return meshData; } };
