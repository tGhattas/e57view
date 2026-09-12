import './style.css';
import * as THREE from 'three';
import { Viewer, isTouch, isIOS, type Knobs, type Station, type GizmoMode } from './viewer';
import { REC, pointInRegion, simplifyRing, PRISM_MAX_V, type Region } from './cells';
import { AgentLink } from './agent';
import { History, cloneRegions } from './history';
import { blankState, type Entity } from './entities';
import { sniff, asciiGuess, ASCII_EXT } from '../shared/importers.mjs';
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
/** Set when layers have been merged, because that is an unsaved change with no undo step. */
let mergedNote = '';
/** The global shift of the first layer loaded. Everything is drawn in that layer's local
 *  frame, so a layer added afterwards is placed by the difference between its own shift and
 *  this one — which is the only information two separate files carry about where they sit
 *  relative to each other. */
let frameOrigin: number[] | null = null;
let pendingAdd = false;
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

// ------------------------------------------------------------- the active entity
// These module variables *are* the active entity's state while it is active. Swapping them in
// and out around a switch keeps a hundred single-cloud call sites unchanged, and makes the two
// functions below the only place that has to know what an entity remembers.
function captureActive() {
  const st = viewer.active.state;
  st.meta = meta; st.file = currentFile; st.handle = currentHandle; st.cacheKey = cacheKey;
  st.fromCache = fromCache; st.cropped = cropped;
  st.histogram = histogram; st.axisHist = axisHist; st.axisCube = axisCube;
  st.sfName = sfName; st.meshData = meshData; st.meshInfo = meshInfo;
  st.dirtyField = dirtyMark.field; st.dirtySurface = dirtyMark.surface;
}
function restoreActive() {
  const st = viewer.active.state;
  meta = st.meta; currentFile = st.file; currentHandle = st.handle; cacheKey = st.cacheKey;
  fromCache = st.fromCache; cropped = st.cropped;
  histogram = st.histogram; axisHist = st.axisHist; axisCube = st.axisCube;
  sfName = st.sfName; meshData = st.meshData; meshInfo = st.meshInfo;
  dirtyMark.field = st.dirtyField; dirtyMark.surface = st.dirtySurface;
}

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
function resetForLoad(name: string, keepOthers = false) {
  if (!keepOthers) {
    // Open file… replaces everything: other layers go, and so does the shared history
    for (const e of viewer.entities.slice()) if (e.id !== viewer.activeId) viewer.removeEntity(e.id);
    viewer.active.name = 'Scan 1';
    void hist.clear();
    mergedNote = ''; frameOrigin = null;
  }
  revealed = viewer.loadedAll > 0 && keepOthers; gotRealLeaf = false; fromCache = false; cropped = false; cacheNote = ''; clearDirty(!keepOthers);
  (document.activeElement as HTMLElement | null)?.blur?.();
  $('drop').classList.add('hidden'); $('loading').classList.remove('hidden', 'over');
  $('ld-name').textContent = name; $('ld-stat').textContent = 'opening…'; $('ld-bar').style.width = '0%'; $('err').classList.add('hidden');
  viewer.clear();
  viewer.active.state = blankState();
  histogram = new Uint32Array(256); axisHist = [new Uint32Array(NB), new Uint32Array(NB), new Uint32Array(NB)]; axisCube = null;
  sections.length = 0; deletes.length = 0; cropUI.on = false; cropState.role = 'keep'; syncCropRoleUI();
  prismFull.clear(); countCache.clear();
  meshData = null; viewer.setMesh(null); document.body.classList.remove('has-mesh');
  viewer.setModel(new THREE.Matrix4()); viewer.setModelGizmo(false);
  sfName = ''; sfStats = null; document.body.classList.remove('has-sf', 'sf-filtering');
  ($('k-color-sf') as HTMLOptionElement).disabled = true; $<HTMLInputElement>('k-cropon').checked = false;
  syncRegions(); updateMeasureList(); setTool('none'); renderSectionList(); updateHistUI(); renderLayers();
  worker?.terminate(); worker = null;
  t0 = performance.now();
}
async function openFile(f: File, handle: any = null, add = false) {
  if (f.size < 48) { fail('That file is too small to be a scan.'); return; }
  if (add) {
    // a new layer, activated so the load lands in it, with the others left alone
    captureActive();
    const e = viewer.addEntity(f.name.replace(/\.[^.]+$/, ''));
    viewer.activeId = e.id;
    restoreActive();
  }
  currentFile = f; currentHandle = handle;
  pendingAdd = add;
  resetForLoad(f.name, add);
  const stride = Number(($('k-load') as HTMLSelectElement).value) || 1;
  cacheKey = keyFor(f, stride);
  io.postMessage({ type: 'cache-has', key: cacheKey });
  const has = await ioOnce('cache-has');
  if (has.has) { fromCache = true; $('ld-stat').textContent = 'loading from cache…'; io.postMessage({ type: 'cache-read', key: cacheKey }); return; }
  // what kind of file this is, decided from its first bytes rather than its name
  let kind: string | null = null;
  try {
    const head = new Uint8Array(await f.slice(0, 256).arrayBuffer());
    kind = sniff(f.name, () => head);
  } catch { kind = null; }
  if (!kind) { fail(`e57view does not recognise ${f.name}. It reads E57, PLY, LAS, LAZ, PTX and plain text (${ASCII_EXT.map(e => '.' + e).join(' ')}).`); return; }
  let ascii: { map: any; delim: string; skip: number } | null = null;
  if (kind === 'ascii') {
    ascii = await askColumns(f);
    if (!ascii) { $('loading').classList.add('hidden'); if (!revealed) $('drop').classList.remove('hidden'); return; }
  }
  const isImport = kind !== 'e57';
  worker = isImport ? new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' })
                    : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = onWorker;
  worker.onerror = e => fail(`Decoder crashed: ${e.message || 'out of memory?'} — try a smaller "In memory" fraction.`);
  worker.postMessage({ type: 'open', file: f, scanIndex: 0, stride, memLimit: MEM_LIMIT, kind, ...(ascii ?? {}) });
}

/** Plain text says nothing about itself, so the first twenty lines are shown with a guess at
 *  what each column is and the chance to correct it. The guess is right for the common
 *  shapes — a header row, or the PTS convention of x y z intensity r g b — and the dialog is
 *  there for everything else. */
const ASCII_FIELDS: [string, string][] = [
  ['x', 'X / Easting'], ['y', 'Y / Northing'], ['z', 'Z / Height'],
  ['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['i', 'Intensity'],
  ['nx', 'Normal X'], ['ny', 'Normal Y'], ['nz', 'Normal Z'],
];
async function askColumns(f: File): Promise<{ map: any; delim: string; skip: number } | null> {
  let g: ReturnType<typeof asciiGuess>;
  try {
    const head = new TextDecoder('latin1').decode(new Uint8Array(await f.slice(0, 96 * 1024).arrayBuffer()));
    g = asciiGuess(head);
  } catch (e: any) { fail('Could not read that text file: ' + (e?.message ?? e)); return null; }
  const names = { ',': 'comma', ';': 'semicolon', '\t': 'tab', ' ': 'whitespace' } as Record<string, string>;
  const rows = g.sample.slice(0, 20);
  const head = (g.header ?? Array.from({ length: g.cols }, (_, i) => `column ${i + 1}`));
  const table = `<div class="cols"><table><tr>${head.map((h, i) => `<th>${i}: ${h}</th>`).join('')}</tr>`
    + rows.slice(0, 6).map(r => `<tr>${Array.from({ length: g.cols }, (_, i) => `<td>${r[i] ?? ''}</td>`).join('')}</tr>`).join('') + '</table></div>';
  const opts = (sel: number) => `<option value="-1">—</option>` + Array.from({ length: g.cols }, (_, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${i}: ${(head[i] ?? '').slice(0, 14)}</option>`).join('');
  const body = `<p>Separated by <b>${names[g.delim] ?? g.delim}</b>${g.header ? ', with a header row' : ''} · ${fmt(g.lines)} lines.</p>`
    + table
    + `<div class="colmap">${ASCII_FIELDS.map(([k, label]) => `<label><span>${label}</span><select id="cm-${k}">${opts((g.map as any)[k])}</select></label>`).join('')}</div>`
    + `<p class="hint mono">X, Y and Z are required. Colours may be 0-255 or 0-1; either is recognised.</p>`;
  const ans = await modal(`Columns in ${f.name}`, body, [{ label: 'Cancel', value: 'no' }, { label: 'Open', value: 'yes', cls: 'primary' }]);
  if (ans !== 'yes') return null;
  const map: any = {};
  for (const [k] of ASCII_FIELDS) map[k] = Number(($(`cm-${k}`) as HTMLSelectElement | null)?.value ?? -1);
  if ([map.x, map.y, map.z].some(v => !(v >= 0))) { fail('X, Y and Z are needed to read a text file.'); return null; }
  return { map, delim: g.delim, skip: g.header ? 1 : 0 };
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
  updateNames();
  if (m.histogram) histogram = Uint32Array.from(m.histogram);
  if (m.robust) viewer.setRobustBounds(m.robust.lo, m.robust.hi);
  // a cached scan reopens with the transform it was cached with (row-major in the meta)
  const shift = (s.translation ?? [0, 0, 0]) as number[];
  if (m.model && m.model.length === 16) viewer.setModel(fromRowMajor(m.model as number[]));
  else if (!frameOrigin) frameOrigin = [...shift];
  else if (pendingAdd) {
    // two files only agree about the world through their own global shifts; place this one
    // relative to the first layer's frame so both are comparable
    const d = shift.map((v, i) => v - (frameOrigin![i] ?? 0));
    if (d.some(v => Math.abs(v) > 1e-9)) viewer.setModel(new THREE.Matrix4().makeTranslation(d[0], d[1], d[2]));
    $('v-layers').textContent = `placed by its global shift · ${d.map(v => v.toFixed(3)).join(', ')} m from ${layerName(viewer.entities[0])}`;
  }
  pendingAdd = false;
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
  if (meta?.scans?.[0]?.hasClassification) afterUploads(() => {
    const n = buildClassificationField();
    if (n) $('v-analysis').textContent = `Classification read from the file · ${n} classes · colour by it with Colour → Scalar field`;
  });
  drawHistogram(); viewer.fit(); applyPendingView(); applyUrlCommands(); updateCropUI(true);
  worker?.terminate(); worker = null;
  if (currentHandle) idbPut(cacheKey, currentHandle);
  updateCacheUI(); updateHistUI();
  renderLayers(); updateNames();          // the row's point count is only final now
  if (!fromCache && localStorage.getItem('nocache:' + cacheKey) !== '1') setTimeout(offerCache, 600);
}
/** LAS and LAZ carry a classification per point, which rides in the record's spare byte.
 *  Turn it into a scalar field, but leave the colour mode alone: arriving at a scan painted
 *  by class is a surprise, and the field is one click away in the panel. */
function buildClassificationField(): number {
  let distinct = new Set<number>();
  const per: Float32Array[] = [];
  for (const l of viewer.cells.leavesForMask()) {
    const recs = l.readback(viewer.cells.gl2);
    const a = new Float32Array(l.count);
    for (let i = 0; i < l.count; i++) { const c = recs[i * REC + 13]; a[i] = c; if (distinct.size < 40) distinct.add(c); }
    per.push(a);
  }
  if (distinct.size < 2) return 0;
  const was = knobs.colorMode;
  viewer.cells.setScalarField(per);
  sfName = 'Classification'; dirtyMark.field = '';
  document.body.classList.add('has-sf');
  ($('k-color-sf') as HTMLOptionElement).disabled = false;
  autoScalarRange(); refreshScalarUI();
  setColorMode(was);
  return distinct.size;
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
/** Leaves reach the GPU through an upload queue that drains a frame at a time, so anything
 *  that has to read them back has to wait for it. */
function afterUploads(fn: () => void, timeoutMs = 20000) {
  const t = setInterval(() => {
    if (viewer.pendingUploads) return;
    clearInterval(t); fn();
  }, 120);
  setTimeout(() => clearInterval(t), timeoutMs);
}
/** A cached scan reopens with the transform it was cached with, and a percentile box carried
 *  through a rotation is inflated; measure a tight one once the leaves are here. */
function retightenSoon() {
  if (viewer.cells.model.equals(new THREE.Matrix4())) return;
  afterUploads(() => { viewer.retightenBounds(); syncZLabels(); viewer.fit(); });
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
function setTool(t: 'none' | 'measure' | 'segment' | 'place') {
  if (viewer.tool === 'segment' && t !== 'segment') endSegment();
  viewer.setTool(t);
  $('k-measure').classList.toggle('on', t === 'measure');
  $('k-segment').classList.toggle('on', t === 'segment');
  $('k-place').classList.toggle('on', t === 'place');
  $('gl').classList.toggle('measure', t === 'measure');
  $('gl').classList.toggle('segment', t === 'segment');
  $('gl').classList.toggle('place', t === 'place');
  $('segbar').classList.toggle('hidden', t !== 'segment');
  $('seg').classList.toggle('hidden', t !== 'segment');
  $('placebar').classList.toggle('hidden', t !== 'place');
  if (t === 'segment') resetSegment();
  if (t === 'place') $('place-hint').textContent = `Click a point to place a ${$<HTMLSelectElement>('k-newshape').value} · Esc cancels`;
  updatePill(); syncToolbar();
}
function updatePill() { const p = $('tb-tool'); const txt = viewer.bubble ? 'photo' : viewer.tool === 'measure' ? 'measure' : viewer.tool === 'place' ? 'place' : viewer.tool === 'segment' ? 'outline' : viewer.fly.enabled ? 'fly' : ''; p.textContent = txt; p.classList.toggle('hidden', !txt); }
$('k-measure').addEventListener('click', () => setTool(viewer.tool === 'measure' ? 'none' : 'measure'));
$('k-measureclear').addEventListener('click', () => { viewer.clearMeasures(); updateMeasureList(); });
function updateMeasureList() {
  const ul = $('measure-list'); ul.innerHTML = '';
  for (const m of viewer.measureList) { const li = document.createElement('li'); const dz = m.b.z - m.a.z; li.innerHTML = `<b>${m.dist.toFixed(3)} m</b> · Δz ${dz >= 0 ? '+' : ''}${dz.toFixed(3)} m`; ul.appendChild(li); }
}
viewer.onClick = (world, cx, cy) => {
  if (viewer.tool === 'place') {
    if (!world) { $('place-hint').textContent = 'that click missed the cloud — aim at a surface · Esc cancels'; return; }
    placeRegion(world, $<HTMLSelectElement>('k-newshape').value as 'box' | 'sphere');
    setTool('none');
    return;
  }
  void cx; void cy;
  if (viewer.tool === 'measure') updateMeasureList();
  const c = $('coord'); if (!world || !meta) { c.classList.add('hidden'); return; }
  const t = meta.scans[0].translation as number[];
  c.textContent = `E ${(world.x + t[0]).toFixed(3)}   N ${(world.y + t[1]).toFixed(3)}   Z ${(world.z + t[2]).toFixed(3)}   ·   local ${world.x.toFixed(2)}, ${world.y.toFixed(2)}, ${world.z.toFixed(2)}`;
  c.classList.remove('hidden');
};
function syncToolbar() {
  const cur = viewer.bubble ? 'photo' : viewer.tool === 'measure' ? 'measure' : viewer.tool === 'place' || viewer.tool === 'segment' ? 'segment' : viewer.fly.enabled ? 'fly' : 'orbit';
  document.querySelectorAll<HTMLButtonElement>('#toolbar button').forEach(b => b.classList.toggle('on', b.dataset.tool === cur));
  const photoBtn = document.querySelector<HTMLButtonElement>('#toolbar [data-tool="photo"]'); if (photoBtn) photoBtn.classList.toggle('hidden', !viewer.bubble);
}
document.querySelectorAll<HTMLButtonElement>('#toolbar button').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.tool;
  if (t === 'orbit') { setTool('none'); setMode(false); }
  else if (t === 'fly') { setTool('none'); setMode(true); }
  else if (t === 'measure') { setMode(false); setTool('measure'); }
  else if (t === 'segment') { setMode(false); setTool('place'); }
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
  else if (e.key === 's') setTool(viewer.tool === 'place' ? 'none' : 'place');
  else if (e.key === 'S') setTool(viewer.tool === 'segment' ? 'none' : 'segment');   // shift: the outline tool
  else if (e.key === 'Enter' && viewer.tool === 'segment') { segHover = null; drawSegment(); if (segPts.length >= 3) createPrismRegion(); }
  else if (e.key === 'Escape') cancelStarted();
  else if (e.key === 'Home') viewer.fit();
});

// ------------------------------------------------------------------ layers
const layerName = (e: Entity) => e.name || e.id;
function activateEntity(id: string) {
  if (id === viewer.activeId) return;
  if (worker) { $('v-layers').textContent = 'a scan is still loading — wait for it to finish'; return; }
  captureActive();
  viewer.setActiveEntity(id);
  restoreActive();
  afterEntitySwitch();
}
/** Everything that describes "the" cloud has to be repointed at the newly active one. */
function afterEntitySwitch() {
  viewer.setMesh(meshData, viewer.active.state.meshBase.clone());
  document.body.classList.toggle('has-mesh', !!meshData?.idx.length);
  setDisplay(meshData?.idx.length ? viewer.display : 'points');
  viewer.setStations((meta?.stations ?? []) as Station[], meta?.scans?.[0]?.translation ?? [0, 0, 0]);
  $('k-stations').parentElement!.classList.toggle('hidden', !(meta?.stations?.length));
  const hasSf = viewer.cells.hasScalarField;
  document.body.classList.toggle('has-sf', hasSf);
  ($('k-color-sf') as HTMLOptionElement).disabled = !hasSf;
  if (!hasSf && knobs.colorMode === 5) setColorMode(0);
  sfStats = hasSf ? viewer.cells.scalarStats() : null;
  if (hasSf) refreshScalarUI(); else { $('v-sfname').textContent = 'no field'; viewer.sf.hi = -1; }
  ($('k-nrm') as HTMLInputElement).disabled = !(meta?.scans?.[0]?.hasNormals);
  drawHistogram();
  renderLayers(); updateNames(); updateCropUI(); updateTransformUI(); updateCacheUI(); updateHistUI();
  syncZLabels(); cropReadouts(); renderSectionList(); viewer.touch();
}
function updateNames() {
  $('tb-name').textContent = currentFile?.name ?? meta?.scans?.[0]?.name ?? 'cloud';
  const many = viewer.entities.length > 1;
  $('tb-layer').textContent = many ? layerName(viewer.active) : '';
  $('tb-layer').classList.toggle('hidden', !many);
}
function renderLayers() {
  const ul = $('layer-list'); ul.innerHTML = '';
  for (const e of viewer.entities) {
    const li = document.createElement('li');
    li.classList.toggle('act', e.id === viewer.activeId);
    li.innerHTML = `<span class="eye${e.visible ? ' on' : ''}" title="Show or hide">${e.visible ? '◉' : '○'}</span>`
      + `<span class="nm" title="Click to make active, double-click to rename">${layerName(e)}</span> `
      + `<span class="mono">${fmt(e.points)} pts</span>`
      + (viewer.entities.length > 1 ? `<span class="x" title="Remove this layer">✕</span>` : '');
    li.querySelector('.eye')!.addEventListener('click', ev => {
      ev.stopPropagation();
      e.visible = !e.visible;
      viewer.applyZRange(); renderLayers(); syncZLabels(); viewer.touch();
    });
    const nm = li.querySelector('.nm') as HTMLElement;
    nm.addEventListener('click', () => activateEntity(e.id));
    nm.addEventListener('dblclick', async () => {
      const ans = await modal('Rename layer',
        `<p>What should this layer be called?</p><input id="ln-name" type="text" value="${layerName(e)}">`,
        [{ label: 'Cancel', value: 'no' }, { label: 'Rename', value: 'yes', cls: 'primary' }]);
      const v = ($('ln-name') as HTMLInputElement | null)?.value?.trim();
      if (ans === 'yes' && v) { e.name = v; renderLayers(); updateNames(); refreshRegisterUI(); }
    });
    li.querySelector('.x')?.addEventListener('click', async ev => {
      ev.stopPropagation();
      await removeLayer(e);
    });
    ul.appendChild(li);
  }
  const vis = viewer.visibleEntities.length;
  $('v-layers').textContent = viewer.entities.length === 1
    ? `one layer · ${fmt(viewer.loaded)} points`
    : `${viewer.entities.length} layers · ${vis} visible · ${fmt(viewer.loadedAll)} points in all · active: ${layerName(viewer.active)}`;
  $<HTMLInputElement>('k-layertint').checked = viewer.active.tint.on;
  $<HTMLInputElement>('k-layercolor').value = viewer.active.tint.color;
  ($('k-layermerge') as HTMLButtonElement).disabled = viewer.visibleEntities.length < 2;
  refreshRegisterUI();
}
async function removeLayer(e: Entity, ask = true) {
  if (viewer.entities.length <= 1) return;
  const own = hist.undo.some(h => h.entity === e.id) || !!e.state.dirtyField || !!e.state.dirtySurface;
  if (own && ask) {
    const ans = await modal('Remove this layer?',
      `<p><b>${layerName(e)}</b> has unsaved work. Removing it drops its points and everything done to them; the file on disk is untouched.</p>`,
      [{ label: 'Cancel', value: 'no' }, { label: 'Remove anyway', value: 'yes', cls: 'danger' }]);
    if (ans !== 'yes') return;
  }
  if (e.id === viewer.activeId) captureActive();
  const wasActive = e.id === viewer.activeId;
  // its history steps can never be applied again once its leaves are gone
  hist.undo = hist.undo.filter(h => h.entity !== e.id);
  hist.redo = hist.redo.filter(h => h.entity !== e.id);
  viewer.removeEntity(e.id);
  if (wasActive) { restoreActive(); afterEntitySwitch(); }
  else { renderLayers(); updateHistUI(); }
  viewer.touch();
}
$('k-layeradd').addEventListener('click', () => addFile());
/** Add a scan alongside the ones already open. Never warns: nothing is replaced. */
async function addFile() {
  const anyWin = window as any;
  if (anyWin.showOpenFilePicker) {
    try { const [h] = await anyWin.showOpenFilePicker({ types: [{ description: 'Point cloud', accept: { 'application/octet-stream': ['.e57', '.ply', '.las', '.laz', '.ptx', ...ASCII_EXT.map(e => '.' + e)] } }] }); openFile(await h.getFile(), h, true); } catch {}
    return;
  }
  const inp = document.createElement('input'); inp.type = 'file'; if (!isIOS) inp.accept = ['.e57', '.ply', '.las', '.laz', '.ptx', ...ASCII_EXT.map(e => '.' + e)].join(',');
  inp.onchange = () => inp.files?.[0] && openFile(inp.files[0], null, true); inp.click();
}
$('k-layertint').addEventListener('change', e => {
  viewer.active.tint.on = (e.target as HTMLInputElement).checked;
  renderLayers(); viewer.touch();
});
$('k-layercolor').addEventListener('input', e => {
  viewer.active.tint.color = (e.target as HTMLInputElement).value;
  if (viewer.active.tint.on) viewer.touch();
});
$('k-layerclone').addEventListener('click', () => cloneActive());
/** A copy of the active layer, sharing nothing: its own leaves, its own model matrix. */
function cloneActive(): Entity | null {
  if (!viewer.loaded) return null;
  captureActive();
  const src = viewer.active;
  const e = viewer.addEntity(`${layerName(src)} copy`);
  for (const { leaf, recs } of src.cells.records()) {
    const buf = recs.slice();
    e.cells.enqueue([buf.buffer as ArrayBuffer], leaf.count, {
      origin: leaf.origin.toArray() as [number, number, number], size: leaf.size,
      bmin: leaf.bmin.toArray() as [number, number, number], bmax: leaf.bmax.toArray() as [number, number, number],
    });
  }
  e.cells.flushUploads(Infinity);
  e.cells.setModel(src.cells.model);
  e.robust = src.robust ? src.robust.clone() : null;
  e.state = { ...blankState(), meta: src.state.meta, file: src.state.file, handle: src.state.handle, cropped: true };
  e.tint = { on: true, color: '#f2b544' };
  viewer.activeId = e.id;
  restoreActive();
  afterEntitySwitch();
  $('v-layers').textContent = `cloned ${layerName(src)} · ${fmt(e.points)} points`;
  return e;
}
$('k-layermerge').addEventListener('click', () => mergeIntoActive());
/** Append every other visible layer's points into the active one.
 *
 *  Each source leaf is read through its own model matrix and back through the active layer's,
 *  so the geometry that was on screen is the geometry that lands. The leaf cube is rebuilt
 *  around the transformed points, because a rotated cube is not a cube — which costs one
 *  requantisation at 16 bits over the new cube, well under a tenth of a millimetre for a leaf
 *  of a few metres. Scalar fields are dropped: the merged points have no values, and a field
 *  that covers some of a cloud is worse than none. */
async function mergeIntoActive(confirm = true) {
  captureActive();
  const active = viewer.active;
  const others = viewer.visibleEntities.filter(e => e !== active);
  if (!others.length) return null;
  const adding = others.reduce((n, e) => n + e.points, 0);
  if (confirm) {
    const ans = await modal('Merge layers?',
      `<p><b>${fmt(adding)}</b> points from ${others.length === 1 ? `<b>${layerName(others[0])}</b>` : `${others.length} layers`} will be appended to <b>${layerName(active)}</b>, through each layer's own transform so the geometry is preserved.</p>`
      + `<p>Those layers are then removed. Any scalar field is dropped, because the added points have no values. <b>This one cannot be undone</b> — save a copy first if you want the parts back.</p>`,
      [{ label: 'Cancel', value: 'no' }, { label: `Merge ${fmt(adding)} points`, value: 'yes', cls: 'danger' }]);
    if (ans !== 'yes') return null;
  }
  busy('Merging layers…'); await tick();
  const inv = active.cells.model.clone().invert();
  const p = new THREE.Vector3(), nv = new THREE.Vector3();
  let added = 0;
  for (const src of others) {
    const m = inv.clone().multiply(src.cells.model);        // source local -> active local
    const rot = new THREE.Matrix3().setFromMatrix4(m);
    for (const { leaf, recs } of src.cells.records()) {
      const n = leaf.count;
      if (!n) continue;
      const xyz = new Float64Array(n * 3);
      const u16 = new Uint16Array(recs.buffer, recs.byteOffset, (n * REC) >> 1);
      const k = leaf.size / 65536;
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < n; i++) {
        const b = i * 7;
        p.set(leaf.origin.x + u16[b] * k, leaf.origin.y + u16[b + 1] * k, leaf.origin.z + u16[b + 2] * k).applyMatrix4(m);
        xyz[i * 3] = p.x; xyz[i * 3 + 1] = p.y; xyz[i * 3 + 2] = p.z;
        for (let a = 0; a < 3; a++) { const q = xyz[i * 3 + a]; if (q < mn[a]) mn[a] = q; if (q > mx[a]) mx[a] = q; }
      }
      const side = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-3) * 1.0001;
      const out = new Uint8Array(n * REC);
      const o16 = new Uint16Array(out.buffer);
      const inv65536 = 65535 / side;
      for (let i = 0; i < n; i++) {
        const b = i * 7, so = i * REC;
        for (let a = 0; a < 3; a++) o16[b + a] = Math.max(0, Math.min(65535, Math.round((xyz[i * 3 + a] - mn[a]) * inv65536)));
        out[so + 6] = recs[so + 6]; out[so + 7] = recs[so + 7]; out[so + 8] = recs[so + 8]; out[so + 9] = recs[so + 9];
        const a0 = recs[so + 10] << 24 >> 24, a1 = recs[so + 11] << 24 >> 24, a2 = recs[so + 12] << 24 >> 24;
        if (a0 === 0 && a1 === 0 && a2 === 127) { out[so + 12] = 127; }
        else {
          nv.set(a0, a1, a2).applyMatrix3(rot);
          if (nv.lengthSq() > 1e-12) nv.normalize().multiplyScalar(127);
          out[so + 10] = Math.max(-127, Math.min(127, Math.round(nv.x))) & 0xff;
          out[so + 11] = Math.max(-127, Math.min(127, Math.round(nv.y))) & 0xff;
          out[so + 12] = Math.max(-127, Math.min(127, Math.round(nv.z))) & 0xff;
        }
      }
      active.cells.enqueue([out.buffer as ArrayBuffer], n, {
        origin: mn as [number, number, number], size: side,
        bmin: mn as [number, number, number], bmax: mx as [number, number, number],
      });
      added += n;
    }
  }
  active.cells.flushUploads(Infinity);
  active.cells.clearScalarField();
  sfName = ''; dirtyMark.field = ''; sfStats = null;
  document.body.classList.remove('has-sf', 'sf-filtering');
  ($('k-color-sf') as HTMLOptionElement).disabled = true;
  if (knobs.colorMode === 5) setColorMode(0);
  const names = others.map(layerName);
  for (const e of others) {
    hist.undo = hist.undo.filter(h => h.entity !== e.id);
    hist.redo = hist.redo.filter(h => h.entity !== e.id);
    viewer.removeEntity(e.id);
  }
  cropped = true;
  mergedNote = `a merge of ${names.length + 1} layers`;
  active.robust = null;                    // the union is a different shape; measure it again
  viewer.retightenBounds();
  captureActive();
  hideBusy();
  afterEntitySwitch();
  viewer.fit();
  $('v-layers').textContent = `merged ${names.join(', ')} into ${layerName(active)} · ${fmt(added)} points added, ${fmt(active.points)} in all · fields dropped`;
  $('tb-points').textContent = `${fmt(active.points)} pts · merged`;
  return { added, total: active.points };
}
viewer.onEntitiesChange = () => { renderLayers(); updateNames(); };

// ------------------------------------------------------------------ registration
// Coarse first, fine second, and neither of them touches the reference. Match centres and
// match scales are two lines of arithmetic on the model matrix; ICP is the one that needs the
// reference's own surfaces, so it runs in the analyser worker where the spatial grid lives.
const regUi = { maxDist: 6, maxIter: 30 };
function refEntity(): Entity | null {
  const id = $<HTMLSelectElement>('k-regref').value;
  return viewer.entities.find(e => e.id === id && e.id !== viewer.activeId) ?? null;
}
function refreshRegisterUI() {
  const sel = $<HTMLSelectElement>('k-regref');
  const others = viewer.entities.filter(e => e.id !== viewer.activeId);
  const want = others.map(e => e.id).join('|');
  if (sel.dataset.ids !== want) {
    sel.innerHTML = '';
    for (const e of others) { const o = document.createElement('option'); o.value = e.id; o.textContent = layerName(e); sel.appendChild(o); }
    sel.dataset.ids = want;
  }
  const ready = others.length > 0 && viewer.loaded > 0;
  for (const id of ['k-regcentres', 'k-regscales', 'k-regicp', 'k-regdistance']) ($(id) as HTMLButtonElement).disabled = !ready;
  if (!ready) $('v-register').textContent = others.length ? 'load some points first' : 'add a second layer to register against';
}
for (const [id, key, lab, dig] of [['k-regdist', 'maxDist', 'v-regdist', 1], ['k-regiter', 'maxIter', 'v-regiter', 0]] as [string, 'maxDist' | 'maxIter', string, number][]) {
  $(id).addEventListener('input', e => { regUi[key] = Number((e.target as HTMLInputElement).value); $(lab).textContent = regUi[key].toFixed(dig); });
  $(lab).textContent = regUi[key].toFixed(dig);
}
function matchCentres() {
  const ref = refEntity(); if (!ref || !viewer.loaded) return null;
  const a = viewer.measuredBox(viewer.active).getCenter(new THREE.Vector3());
  const b = viewer.measuredBox(ref).getCenter(new THREE.Vector3());
  const d = b.clone().sub(a);
  $('v-register').textContent = `centres matched · moved ${d.length().toFixed(3)} m`;
  return commitTransform(thenModel(new THREE.Matrix4().makeTranslation(d.x, d.y, d.z)), `Match centres · ${d.length().toFixed(2)} m`);
}
function matchScales() {
  const ref = refEntity(); if (!ref || !viewer.loaded) return null;
  const sa = viewer.measuredBox(viewer.active).getSize(new THREE.Vector3()), sb = viewer.measuredBox(ref).getSize(new THREE.Vector3());
  const parts = [sa.x > 1e-6 ? sb.x / sa.x : 1, sa.y > 1e-6 ? sb.y / sa.y : 1, sa.z > 1e-6 ? sb.z / sa.z : 1];
  const f = parts.reduce((n, v) => n + v, 0) / 3;
  if (!(f > 0) || Math.abs(f - 1) < 1e-9) { $('v-register').textContent = 'scales already match'; return null; }
  const spread = Math.max(...parts) / Math.min(...parts);
  $('v-register').textContent = `scales matched · x${f.toFixed(5)} (per axis ${parts.map(v => v.toFixed(4)).join(', ')})`
    + (spread > 1.02 ? ' — the per-axis ratios disagree, so this is a rotation rather than a scale difference; undo it and use ICP' : '');
  return commitTransform(thenModel(about(boundsCentre(), new THREE.Matrix4().makeScale(f, f, f))), `Match scales · x${f.toFixed(4)}`);
}
$('k-regcentres').addEventListener('click', () => matchCentres());
$('k-regscales').addEventListener('click', () => matchScales());

/** Feed the analyser the active layer, then the reference, then run one registration op. */
async function runRegister(op: 'icp' | 'distance_to', args: Record<string, any> = {}) {
  const ref = refEntity();
  if (!ref) throw new Error('no reference layer');
  if (!viewer.loaded) throw new Error('nothing loaded');
  busy('Starting the analyser…'); await tick();
  anaAlive = true; anaError = null;
  const cell = Math.max(viewer.cells.medianSpacing * 2.5, 0.01);
  const cap = isTouch ? 8e6 : 30e6;
  anaWorker.postMessage({ type: 'start', cell, maxPoints: cap, model: rowMajor(viewer.cells.model) });
  await anaOnce('ready');
  const counts: number[] = [];
  let n = 0;
  const total = viewer.cells.leafCount;
  for (const { leaf, recs } of viewer.cells.records()) {
    if (!anaAlive) break;
    counts.push(leaf.count);
    const buf = recs.buffer as ArrayBuffer;
    anaWorker.postMessage({ type: 'leaf', origin: leaf.origin.toArray(), size: leaf.size, recs: buf }, [buf]);
    if (++n % 8 === 0) { busy(`Reading the moving layer… ${n} of ${total}`, n / Math.max(total, 1)); await tick(); }
  }
  // the reference is subsampled when it is bigger than the analyser will hold
  const refStride = Math.max(1, Math.ceil(ref.points / cap));
  const refModel = rowMajor(ref.cells.model);
  let m = 0;
  const refTotal = ref.cells.leafCount;
  for (const { leaf, recs } of ref.cells.records()) {
    if (!anaAlive) break;
    const buf = recs.buffer as ArrayBuffer;
    anaWorker.postMessage({ type: 'ref', origin: leaf.origin.toArray(), size: leaf.size, recs: buf, model: refModel, stride: refStride }, [buf]);
    if (++m % 8 === 0) { busy(`Reading ${layerName(ref)}… ${m} of ${refTotal}`, m / Math.max(refTotal, 1)); await tick(); }
  }
  anaWorker.postMessage({ type: 'run', op, ...args });
  const res = await anaOnce('result');
  return { ...res, counts, refStride, refName: layerName(ref) };
}

async function runIcp() {
  const ref = refEntity(); if (!ref) return null;
  try {
    const t0 = performance.now();
    const r = await runRegister('icp', { maxIter: regUi.maxIter, maxDist: regUi.maxDist, sample: isTouch ? 60000 : 200000 });
    hideBusy();
    const rms = r.rms as number, overlap = r.overlap as number;
    if (!(r.matrix?.length === 16)) throw new Error('ICP did not converge on any pairs — try Match centres first, or a larger max distance');
    const next = fromRowMajor(r.matrix as number[]).multiply(viewer.cells.model);
    await commitTransform(next, `ICP: RMS ${(rms * 1000).toFixed(1)} mm, ${(overlap * 100).toFixed(0)}% overlap`);
    const note = r.refStride > 1 ? ` · reference subsampled 1 in ${r.refStride}` : '';
    $('v-register').textContent = `ICP onto ${r.refName} · ${r.iterations} iterations · RMS ${(rms * 1000).toFixed(2)} mm (from ${((r.rmsHistory?.[0] ?? rms) * 1000).toFixed(2)} mm) · ${(overlap * 100).toFixed(0)}% overlap · ${((performance.now() - t0) / 1000).toFixed(1)}s${note}`;
    return r;
  } catch (e: any) {
    $('v-register').textContent = 'ICP failed: ' + (e?.message ?? e);
    throw e;
  } finally { hideBusy(); }
}
$('k-regicp').addEventListener('click', () => { runIcp().catch(() => {}); });

async function distanceToReference(signed = false) {
  const ref = refEntity(); if (!ref) return null;
  try {
    const r = await runRegister('distance_to', { signed });
    hideBusy();
    setScalarField(`Distance to ${layerName(ref)}`, r.data as Float32Array, r.counts);
    const s = viewer.cells.scalarStats();
    const note = r.refStride > 1 ? ` · reference subsampled 1 in ${r.refStride}` : '';
    $('v-register').textContent = `distance to ${r.refName}${signed ? ' (signed)' : ''} · ${s ? `${(s.min * 1000).toFixed(1)} to ${(s.max * 1000).toFixed(1)} mm` : 'no values'} · ${fmt(r.points)} points${note}`;
    return r;
  } catch (e: any) {
    $('v-register').textContent = 'distance failed: ' + (e?.message ?? e);
    throw e;
  } finally { hideBusy(); }
}
$('k-regdistance').addEventListener('click', () => { distanceToReference(false).catch(() => {}); });

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
/** True when the apply set has nothing to keep, so Apply removes rather than crops. That is
 *  the honest rule whatever put the regions there — the crop box in Remove mode, a drawn
 *  region toggled to Remove, or a delete region an agent added. */
function removingInside(): boolean {
  const cuts = cutRegions();
  return cuts.length > 0 && !cuts.some(r => r.role === 'keep');
}
/** The Keep inside / Remove inside pair. The Apply button's own label follows the whole set
 *  and is written by cropReadouts. */
function syncCropRoleUI() {
  const del = cropState.role === 'delete';
  $('k-cropkeep').classList.toggle('on', !del);
  $('k-cropdel').classList.toggle('on', del);
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
  $('k-cropapply').textContent = removingInside() ? 'Remove inside…' : 'Apply crop…';
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
  updateTransformUI(); syncPrismUI();
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
  if (viewer.tool === 'place') { setTool('none'); return; }
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
  const shape = cuts.length === 1 ? `the ${cuts[0].kind === 'prism' ? 'drawn region' : cuts[0].kind}` : `${cuts.length} regions`;
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
  if (res.undo) await hist.push({ kind, entity: viewer.activeId, label: lab, dropped: res.dropped, kept: res.kept, undo: res.undo, robust, before, after: afterSnap });
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
  const e = hist.peekUndo(); if (!e) return null;
  // a step belongs to one layer; putting it back means going there first
  if (e.entity && e.entity !== viewer.activeId) activateEntity(e.entity);
  if (!viewer.loaded && e.kind !== 'transform') return null;
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
  const e = hist.peekRedo(); if (!e) return null;
  // a step belongs to one layer; putting it back means going there first
  if (e.entity && e.entity !== viewer.activeId) activateEntity(e.entity);
  if (!viewer.loaded && e.kind !== 'transform') return null;
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
function exportFormat(): 'e57' | 'las' | 'ply' | 'laz' {
  const fromFile = (currentFile?.name ?? meta?.scans?.[0]?.name ?? '').toLowerCase().split('.').pop();
  if (fromFile === 'e57' || fromFile === 'las' || fromFile === 'ply' || fromFile === 'laz') return fromFile;
  const sel = $<HTMLSelectElement>('k-fmt')?.value;
  if (sel === 'e57' || sel === 'las' || sel === 'ply' || sel === 'laz') return sel;
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
  const base = (currentFile?.name ?? meta?.scans?.[0]?.name ?? 'scan').replace(/\.(e57|ply|las|laz|ptx|txt|xyz|pts|asc|csv|neu)$/i, '');
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
    updateHistUI(); updateCacheUI(); renderLayers();
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
function clearDirty(all = true) {
  dirtyMark.field = ''; dirtyMark.surface = 0;
  if (!all) return;
  mergedNote = '';
  for (const e of viewer.entities) { e.state.dirtyField = ''; e.state.dirtySurface = 0; }
}
const triangles = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : fmt(n);
/** What would be lost if the loaded scan were replaced now, in plain words. */
function dirtyList(): string[] {
  captureActive();                   // so the active layer's own marks are up to date
  const out: string[] = [];
  const kinds = hist.undo.map(e => e.kind);
  const edits = kinds.filter(k => k === 'crop' || k === 'clean').length;
  if (edits) out.push(`${edits} edit${edits > 1 ? 's' : ''}`);
  if (kinds.includes('normals')) out.push('computed normals');
  const many = viewer.entities.length > 1;
  for (const e of viewer.entities) {
    const on = many ? ` on ${layerName(e)}` : '';
    if (e.state.dirtyField) out.push(`a scalar field (${e.state.dirtyField})${on}`);
    if (e.state.dirtySurface) out.push(`a ${triangles(e.state.dirtySurface)}-triangle surface${on}`);
  }
  if (kinds.includes('transform')) out.push('a transform');
  if (mergedNote) out.push(mergedNote);
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
/** The depth a prism was created with — the one that spans the whole cloud — so the slider
 *  can work in fractions of it. */
const prismFull = new Map<string, number>();
function activePrism(): Region | null {
  const r = allRegions().find(x => x.id === viewer.activeRegion);
  return r && r.kind === 'prism' ? r : null;
}
function syncPrismUI() {
  const r = activePrism();
  document.body.classList.toggle('has-prism', !!r);
  if (!r) return;
  const full = Math.max(prismFull.get(r.id) ?? r.half[2], 1e-6);
  $<HTMLInputElement>('k-prismdepth').value = String(Math.min(1, Math.max(0.004, r.half[2] / full)));
  $('v-prismdepth').textContent = `${(r.half[2] * 2).toFixed(2)} m`;
}
$('k-prismdepth').addEventListener('input', e => {
  const r = activePrism(); if (!r) return;
  const full = Math.max(prismFull.get(r.id) ?? r.half[2], 1e-6);
  r.half = [r.half[0], r.half[1], Math.max(0.005, Number((e.target as HTMLInputElement).value) * full)];
  syncRegions(); syncPrismUI(); cropReadouts(); renderSectionList(); viewer.touch();
});

/** Points inside a region, for the list. Exact enough to be useful and never computed while
 *  a gizmo is moving, because that would read cells back from the GPU every frame. */
const countCache = new Map<string, number>();
function regionCount(r: Region): number {
  if (!viewer.loaded) return 0;
  if (viewer.gizmoBusy) return countCache.get(r.id) ?? viewer.cells.estimateInside(r);
  const n = viewer.cells.countInside(r, 16);
  countCache.set(r.id, n);
  return n;
}
function renderSectionList() {
  const ul = $('sec-list'); ul.innerHTML = '';
  for (const s of sections) {
    const li = document.createElement('li'); li.classList.toggle('sel', viewer.activeRegion === s.id);
    const what = s.kind === 'prism' ? `drawn · ${s.poly?.length ?? 0} sides · ${(s.half[2] * 2).toFixed(2)} m deep`
      : s.kind === 'slab' ? `${(s.half[2] * 2).toFixed(2)} m thick · z ${s.center[2].toFixed(1)}`
      : s.kind === 'sphere' ? `r ${s.radius.toFixed(2)} m` : `box ${(s.half[0] * 2).toFixed(2)} m`;
    li.innerHTML = `<span class="ok">${s.label ?? s.kind}</span> <span class="mono">${what} · ~${fmt(regionCount(s))} pts</span>`
      + `<span class="x" title="Remove this region">✕</span>`
      + `<span class="rr${s.role === 'delete' ? ' del' : ''}" title="Keep what is inside, or remove it">${s.role === 'delete' ? 'Remove' : 'Keep'}</span>`;
    li.querySelector('.ok')!.addEventListener('click', () => { viewer.setActiveRegion(s.id); renderSectionList(); syncRegionButtons(); });
    li.querySelector('.rr')!.addEventListener('click', () => {
      s.role = s.role === 'delete' ? 'keep' : 'delete';
      syncRegions(); renderSectionList(); cropReadouts(); viewer.touch();
    });
    li.querySelector('.x')!.addEventListener('click', () => {
      sections.splice(sections.indexOf(s), 1); prismFull.delete(s.id); countCache.delete(s.id);
      if (viewer.activeRegion === s.id) viewer.setActiveRegion(null);
      syncRegions(); renderSectionList(); cropReadouts();
    });
    ul.appendChild(li);
  }
  syncPrismUI(); syncRegionButtons();
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
    kind: 'transform', entity: viewer.activeId, label, dropped: 0, kept: viewer.loaded, undo: null,
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

// ------------------------------------------------------------------ placing a region
// The common gesture is not tracing an outline round a thing, it is pointing at the thing and
// then making the shape big enough. So: click a point, get a small box or sphere centred
// exactly there, and enlarge it however you like — handles, sliders, Grow, Alt-scroll, or
// Fit to contents, which grows until it stops finding new points and then tightens onto them.

/** A region small enough to be obviously a starting point, and big enough to hold something. */
function startSize(): number {
  const b = viewer.bounds();
  const span = b.isEmpty() ? 10 : Math.max(...b.getSize(new THREE.Vector3()).toArray());
  return Math.max(0.25, viewer.cells.medianSpacing * 6, span * 0.02);
}
function activeRegion(): Region | null {
  return allRegions().find(r => r.id === viewer.activeRegion) ?? null;
}
function syncRegionButtons() {
  const r = activeRegion();
  document.body.classList.toggle('has-region', !!r && r.id !== 'crop');
}
/** Create a region centred on a world point and hand it to the gizmo, ready to resize. */
function placeRegion(at: THREE.Vector3, kind: 'box' | 'sphere' = 'box', size?: number): Region {
  const h = Math.max(1e-3, (size ?? startSize()) / 2);
  const r: Region = {
    id: uid(kind === 'sphere' ? 'sph-' : 'box-'), kind, role: 'keep',
    label: `Region ${sections.length + 1}`,
    center: at.toArray() as [number, number, number],
    half: [h, h, h], radius: h, quat: [0, 0, 0, 1],
  };
  sections.push(r);
  syncRegions();
  viewer.setActiveRegion(r.id);
  setGizmoMode('scale');                 // the next thing anyone does is make it bigger
  renderSectionList(); cropReadouts(); syncRegionButtons(); viewer.touch();
  return r;
}
$('k-place').addEventListener('click', () => setTool(viewer.tool === 'place' ? 'none' : 'place'));
$('place-cancel').addEventListener('click', () => setTool('none'));
$('k-newshape').addEventListener('change', () => { if (viewer.tool === 'place') setTool('place'); });

/** Scale the active region about its own centre. */
function scaleRegion(f: number) {
  const r = activeRegion(); if (!r) return null;
  if (r.kind === 'prism') {
    if (r.poly) r.poly = r.poly.map(v => [v[0] * f, v[1] * f] as [number, number]);
    r.half = [r.half[0] * f, r.half[1] * f, r.half[2] * f];
  } else if (r.kind === 'sphere') {
    r.radius = Math.max(0.01, r.radius * f); r.half = [r.radius, r.radius, r.radius];
  } else {
    r.half = r.half.map(h => Math.max(0.01, h * f)) as [number, number, number];
  }
  if (r.id === 'crop') { const md = maxDim(); cropUI.frac = r.half.map(h => Math.min(1, (h * 2) / md)) as number[]; }
  syncRegions(); renderSectionList(); cropReadouts(); syncPrismUI(); viewer.touch();
  return r;
}
$('k-grow').addEventListener('click', () => scaleRegion(1.5));
$('k-shrink').addEventListener('click', () => scaleRegion(1 / 1.5));
// Alt (Option) and the wheel: the gesture everyone already has in their fingers. Captured
// before OrbitControls sees it, or the camera would dolly at the same time.
$('gl').addEventListener('wheel', e => {
  if (!e.altKey || !activeRegion()) return;
  e.preventDefault(); e.stopPropagation();
  scaleRegion(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { capture: true, passive: false });

/** Grow the active region until it stops finding new points, then tighten onto what it holds.
 *  Two iterations of a count per axis is enough to reach the edge of an object; the exact
 *  bounding box of the contained points is what makes the result tight rather than merely big. */
async function fitToContents() {
  const r = activeRegion(); if (!r || !viewer.loaded) return null;
  busy('Growing to fit…'); await tick();
  try {
    const count = () => viewer.cells.countInside(r, 8);
    const axes = r.kind === 'sphere' ? [0] : [0, 1, 2];
    for (const a of axes) {
      for (let i = 0; i < 8; i++) {
        const before = count();
        if (r.kind === 'sphere') { r.radius *= 1.5; r.half = [r.radius, r.radius, r.radius]; }
        else r.half[a] *= 1.5;
        const after = count();
        if (after <= before * 1.02) break;         // nothing new came in: this is the edge
      }
    }
    const inside = viewer.cells.insideExact(r);
    if (inside.count && inside.min && inside.max) {
      // a margin of a point spacing, but never a large fraction of the thing being fitted:
      // a sparse cloud's spacing estimate can be tens of centimetres
      const extent = Math.max(...inside.max.map((v, i) => v - inside.min![i]), 0.01);
      const pad = Math.max(0.005, Math.min(viewer.cells.medianSpacing, extent * 0.02));
      const c = inside.min.map((v, i) => (v + inside.max![i]) / 2);
      r.center = c as [number, number, number];
      if (r.kind === 'sphere') {
        r.radius = Math.max(0.01, Math.hypot(...inside.max.map((v, i) => (v - inside.min![i]) / 2)) + pad);
        r.half = [r.radius, r.radius, r.radius];
      } else {
        r.half = inside.max.map((v, i) => Math.max(0.01, (v - inside.min![i]) / 2 + pad)) as [number, number, number];
      }
    }
    syncRegions(); renderSectionList(); cropReadouts(); viewer.touch();
    $('v-crop').textContent = `fitted · ${fmt(viewer.cells.insideExact(r).count)} points inside`;
    return r;
  } finally { hideBusy(); }
}
$('k-fitcontents').addEventListener('click', () => { fitToContents(); });

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
  for (const id of ['seg-region', 'seg-in', 'seg-out']) ($(id) as HTMLButtonElement).disabled = !ready;
  $('seg-hint').textContent = segPts.length === 0
    ? 'Click to trace a shape · Esc to cancel'
    : ready ? `${segPts.length} points · Enter makes it a region you can orbit around` : `${segPts.length} of 3 points`;
}
/** The shader keeps every active outline in one fixed uniform array, so this is its size. */
const MAX_PRISMS = 4;
/** Turn the traced outline into a prism region: a bounding shape like the box, visible from
 *  any angle, movable, and applied later with everything else. Drawing cuts nothing. */
async function createPrismRegion() {
  if (segPts.length < 3) return null;
  if (allRegions().filter(r => r.kind === 'prism').length >= MAX_PRISMS) {
    await modal('Four drawn regions at a time',
      `<p>Every active outline lives in one fixed array in the vertex shader, so four regions of up to ${PRISM_MAX_V} sides each are what fits. Remove one from the Sections list, or apply what you have.</p>`,
      [{ label: 'OK', value: 'ok', cls: 'primary' }]);
    return null;
  }
  const rect = $('gl').getBoundingClientRect();
  const poly = segPts.slice();
  let r: Region;
  try { r = viewer.prismFromScreen(poly, rect.width, rect.height, uid('pri-')); }
  catch (e: any) { $('v-crop').textContent = 'could not build a region: ' + (e?.message ?? e); return null; }
  r.label = `Region ${sections.length + 1}`;
  prismFull.set(r.id, r.half[2]);
  sections.push(r);
  setTool('none');
  syncRegions(); viewer.setActiveRegion(r.id); renderSectionList(); cropReadouts(); viewer.touch();
  return r;
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
/** The one-shot path: cut immediately from this view without making a region. Kept because it
 *  is the quickest way to take out something obvious, and because an agent uses it. */
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
  await commitMask(inside ? 'Keep inside the shape' : 'Remove inside the shape', masks, '', false);
}
$('seg-region').addEventListener('click', () => createPrismRegion());
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
  if (res.undo) await hist.push({ kind: 'clean', entity: viewer.activeId, label, dropped: res.dropped, kept: res.kept, undo: res.undo, robust, before, after: snapUi() });
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
        kind: 'normals', entity: viewer.activeId, label: note || 'Normals', dropped: 0, kept: viewer.loaded, undo: null,
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
async function runExport(fmtSel: 'e57' | 'las' | 'ply' | 'laz', stride: number): Promise<{ file: File; name: string; count: number; bytes: number; scratch: string }> {
  const base = (currentFile?.name ?? meta?.scans?.[0]?.name ?? 'scan').replace(/\.(e57|ply|las|laz|ptx|txt|xyz|pts|asc|csv|neu)$/i, '');
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

function entityList() {
  return viewer.entities.map(e => {
    const b = e.bounds();
    return {
      id: e.id, name: e.name, visible: e.visible, active: e.id === viewer.activeId,
      points: e.points, cells: e.cells.leafCount,
      file: e.state.file?.name ?? null,
      medianSpacing: e.cells.total ? r6(e.cells.medianSpacing) : null,
      transform: rowMajor(e.cells.model).map(r6),
      tint: e.tint.on ? e.tint.color : null,
      bounds: b.isEmpty() ? null : { min: arr6(b.min.toArray()), max: arr6(b.max.toArray()) },
      surface: e.state.meshInfo ? { triangles: e.state.meshInfo.triangles } : null,
      scalarField: e.state.sfName || null,
    };
  });
}
/** Point the Register group's reference selector at a layer, by id or by name. */
function setReference(idOrName: any) {
  refreshRegisterUI();
  const e = viewer.entities.find(x => x.id === String(idOrName) || x.name === String(idOrName));
  if (!e) throw new Error(`no such layer: ${idOrName}`);
  if (e.id === viewer.activeId) throw new Error('the reference cannot be the active layer — activate the other one first');
  $<HTMLSelectElement>('k-regref').value = e.id;
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
    entities: entityList(), active: viewer.activeId,
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
  let tol = mpp * 0.75, simplified = lines.map(l => simplifyRing(l, tol));
  const budget = Math.max(500, Math.min(40_000, Math.round(Number(a.maxVertices) || 12_000)));
  const count = (ls: number[][][]) => ls.reduce((n, l) => n + l.length, 0);
  while (count(simplified) > budget && tol < mpp * 64) { tol *= 2; simplified = lines.map(l => simplifyRing(l, tol)); }
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
    if (a.op === 'place') {
      // point at a thing and get a small shape there, the same gesture the panel offers
      let at: THREE.Vector3 | null = null;
      if (Array.isArray(a.at) && a.at.length === 3) at = new THREE.Vector3(...a.at.map(Number));
      else if (Array.isArray(a.pixel) && a.pixel.length === 2) { viewer.render(); at = viewer.pickWorld(Number(a.pixel[0]), Number(a.pixel[1])); }
      if (!at) throw new Error('at: [x,y,z] in local metres, or pixel: [x,y] over a point of the cloud');
      const r = placeRegion(at, a.kind === 'sphere' ? 'sphere' : 'box', a.size !== undefined ? Number(a.size) : undefined);
      if (a.role === 'delete') { r.role = 'delete'; syncRegions(); renderSectionList(); }
      viewer.render();
      return { region: r, pointsInside: viewer.cells.insideExact(r).count, startSize: r.kind === 'sphere' ? r.radius * 2 : r.half[0] * 2 };
    }
    if (a.op === 'grow') {
      const id = a.id ?? viewer.activeRegion;
      if (id && id !== viewer.activeRegion) viewer.setActiveRegion(String(id));
      const f = Number(a.factor ?? 1.5);
      if (!(f > 0)) throw new Error('factor must be greater than zero');
      const r = scaleRegion(f);
      if (!r) throw new Error('no active region to grow');
      viewer.render();
      return { region: r, pointsInside: viewer.cells.insideExact(r).count };
    }
    if (a.op === 'fit') {
      const id = a.id ?? viewer.activeRegion;
      if (id && id !== viewer.activeRegion) viewer.setActiveRegion(String(id));
      const r = await fitToContents();
      if (!r) throw new Error('no active region to fit');
      viewer.render();
      return { region: r, pointsInside: viewer.cells.insideExact(r).count };
    }
    if (a.op === 'lasso') {
      // the same construction the UI uses: an outline from the current camera, extruded
      const px = a.pixels;
      if (!Array.isArray(px) || px.length < 3) throw new Error('pixels: [[x,y], …], at least three');
      const rect = $('gl').getBoundingClientRect();
      const r = viewer.prismFromScreen(px.map((q: any) => [Number(q[0]), Number(q[1])] as [number, number]),
        Number(a.width) || rect.width, Number(a.height) || rect.height, a.id ?? uid('pri-'), Number(a.depth) || undefined);
      r.role = a.role === 'delete' ? 'delete' : 'keep';
      r.label = a.label ?? `Region ${sections.length + 1}`;
      prismFull.set(r.id, r.half[2]);
      sections.push(r);
      syncRegions(); viewer.setActiveRegion(r.id); renderSectionList(); cropReadouts(); viewer.render();
      return { region: r, pointsInside: viewer.cells.insideExact(r).count };
    }
    if (a.op === 'add' || a.op === 'update') {
      const r: Region = { id: a.region.id ?? uid(a.region.role === 'keep' ? 'sec-' : 'ai-'), kind: a.region.kind, role: a.region.role ?? 'keep', center: a.region.center, half: a.region.half ?? [1, 1, 1], radius: a.region.radius ?? (a.region.half?.[0] ?? 1), quat: a.region.quat ?? [0, 0, 0, 1], label: a.region.label };
      if (r.kind === 'slab') { const md = maxDim(); r.half = [md * 3, md * 3, r.half[2]]; }
      if (r.kind === 'prism') {
        const poly = (a.region.poly ?? []).map((q: any) => [Number(q[0]), Number(q[1])] as [number, number]);
        if (poly.length < 3) throw new Error('a prism needs poly: [[x,y], …] in its own local XY plane, metres');
        r.poly = poly.slice(0, PRISM_MAX_V);
        r.half = [r.half[0], r.half[1], r.half[2]];
        prismFull.set(r.id, r.half[2]);
      }
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
  entities: async (a) => {
    const op = String(a.op ?? 'list');
    const pick = (id: any) => {
      const e = viewer.entities.find(x => x.id === String(id) || x.name === String(id));
      if (!e) throw new Error(`no such layer: ${id}. Have: ${viewer.entities.map(x => `${x.id} (${x.name})`).join(', ')}`);
      return e;
    };
    if (op === 'list') return { entities: entityList(), active: viewer.activeId };
    if (op === 'add') throw new Error('a file has to be chosen in the viewer (Layers -> Add file…), or opened from the on-device cache with the open command');
    if (op === 'activate') { activateEntity(pick(a.id).id); viewer.render(); return { active: viewer.activeId, entities: entityList() }; }
    if (op === 'show' || op === 'hide') {
      pick(a.id).visible = op === 'show';
      viewer.applyZRange(); syncZLabels(); renderLayers(); viewer.render();
      return { entities: entityList() };
    }
    if (op === 'rename') {
      if (!a.name) throw new Error('name is required');
      pick(a.id).name = String(a.name); renderLayers(); updateNames(); refreshRegisterUI();
      return { entities: entityList() };
    }
    if (op === 'remove') { await removeLayer(pick(a.id), false); viewer.render(); return { entities: entityList(), active: viewer.activeId }; }
    if (op === 'clone') { const e = cloneActive(); viewer.render(); return { cloned: e?.id ?? null, entities: entityList(), active: viewer.activeId }; }
    if (op === 'merge') { const r = await mergeIntoActive(false); viewer.render(); return { ...(r ?? {}), entities: entityList(), active: viewer.activeId }; }
    throw new Error('bad op');
  },
  register: async (a) => {
    const op = String(a.op ?? '');
    if (a.reference !== undefined) setReference(a.reference);
    if (!refEntity()) throw new Error('reference: the id or name of another layer is required');
    if (op === 'centres' || op === 'centers') { await matchCentres(); viewer.render(); return { transform: transformState(), note: $('v-register').textContent }; }
    if (op === 'scales') { await matchScales(); viewer.render(); return { transform: transformState(), note: $('v-register').textContent }; }
    if (op === 'icp') {
      if (a.maxDistance !== undefined) regUi.maxDist = Math.max(1, Number(a.maxDistance));
      if (a.maxIterations !== undefined) regUi.maxIter = Math.max(1, Math.round(Number(a.maxIterations)));
      const r = await runIcp();
      viewer.render();
      return {
        rms: r?.rms ?? null, rmsMm: r ? +(r.rms * 1000).toFixed(3) : null, overlap: r?.overlap ?? null,
        iterations: r?.iterations ?? null, rmsHistory: r?.rmsHistory ?? null, matrix: r?.matrix ?? null,
        transform: transformState(), note: $('v-register').textContent,
      };
    }
    throw new Error("op: 'centres' | 'scales' | 'icp'");
  },
  distance_to: async (a) => {
    if (a.reference !== undefined) setReference(a.reference);
    const ref = refEntity();
    if (!ref) throw new Error('reference: the id or name of another layer is required');
    const r = await distanceToReference(!!a.signed);
    const s = viewer.cells.scalarStats();
    viewer.render();
    return {
      reference: layerName(ref), signed: !!a.signed, points: r?.points ?? 0,
      field: s ? { name: sfName, min: r6(s.min), max: r6(s.max), values: s.n } : null,
      note: $('v-register').textContent,
    };
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
  if (cmd === 'entities') return ['add', 'remove', 'clone', 'merge'].includes(String(a.op ?? 'list'));
  if (cmd === 'register' || cmd === 'distance_to') return true;
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
    try { const [h] = await anyWin.showOpenFilePicker({ types: [{ description: 'Point cloud', accept: { 'application/octet-stream': ['.e57', '.ply', '.las', '.laz', '.ptx', ...ASCII_EXT.map(e => '.' + e)] } }] }); openFile(await h.getFile(), h); } catch {}
    return;
  }
  const inp = document.createElement('input'); inp.type = 'file'; if (!isIOS) inp.accept = ['.e57', '.ply', '.las', '.laz', '.ptx', ...ASCII_EXT.map(e => '.' + e)].join(',');
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
// the same seam for the other door: adding a scan alongside instead of replacing everything
const addTestInput = document.createElement('input');
addTestInput.type = 'file'; addTestInput.id = 'file-add'; addTestInput.style.cssText = 'position:fixed;opacity:0;pointer-events:none;left:-9999px';
addTestInput.onchange = () => { if (addTestInput.files?.[0]) openFile(addTestInput.files[0], null, true); };
document.body.appendChild(addTestInput);
const drop = $('drop');
for (const t of ['dragenter', 'dragover']) addEventListener(t, e => { e.preventDefault(); drop.classList.add('drag'); });
addEventListener('dragleave', e => { e.preventDefault(); drop.classList.remove('drag'); });
addEventListener('drop', async e => {
  e.preventDefault(); drop.classList.remove('drag');
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (!f) return;
  // Shift adds the scan as another layer; without it the drop replaces everything, so it
  // asks about unsaved work first
  const add = (e as DragEvent).shiftKey && viewer.loadedAll > 0;
  if (!add && !(await confirmReplace())) return;
  openFile(f, null, add);
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
  const defaultClosed = ['Tone', 'Clipping', 'measure', 'export', 'cache', 'sections', 'agent', 'surface', 'analysis', 'field', 'transform', 'register'].includes(name);
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
renderLayers(); updateNames();
refreshCachedList();
(function loop() { viewer.render(); requestAnimationFrame(loop); })();
(window as any).__viewer = viewer;
(window as any).__app = { openFile, openCached, writeCache, applyKeep, applyCrop, setCropRole, get cropState() { return cropState; }, addSection, undoEdit, redoEdit, saveCurrent, hist,
  commitTransform, transformState, levelCloud, rowMajor, fromRowMajor, runExport, updateTransformUI,
  dirtyList, isDirty, openAnother, confirmReplace,
  stateRecord, recommendedSource, surfaceRecord, heightmapCmd, contourCmd, fitPlaneCmd, dispatchAgent,
  createPrismRegion, placeRegion, scaleRegion, fitToContents, activeRegion, startSize, buildClassificationField,
  get sections() { return sections; }, renderSectionList, regionCount, syncRegions,
  activateEntity, cloneActive, mergeIntoActive, renderLayers, entityList, setReference,
  matchCentres, matchScales, runIcp, distanceToReference, removeLayer, addFile,
  get entities() { return viewer.entities; }, get activeId() { return viewer.activeId; },
  get cacheNote() { return cacheNote; }, get meta() { return meta; }, get cacheKey() { return cacheKey; }, get regions() { return allRegions(); }, buildMesh, analysis, runAnalysis, maskTool, get sfStats() { return viewer.cells.scalarStats(); }, get meshData() { return meshData; } };
