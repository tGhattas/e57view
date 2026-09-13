// SPDX-License-Identifier: GPL-3.0-only
import './style.css';
import * as THREE from 'three';
import { Viewer, isTouch, isIOS, type Knobs, type Station, type GizmoMode } from './viewer';
import { REC, pointInRegion, simplifyRing, PRISM_MAX_V, type Region } from './cells';
import { AgentLink } from './agent';
import { History, cloneRegions } from './history';
import { blankState, type Entity } from './entities';
import { sniff, asciiGuess, ASCII_EXT } from '../shared/importers.mjs';
import { sniffMesh, parseMesh, meshToStl, MESH_EXT } from '../shared/meshio.mjs';
import { measureMesh, flipMesh, smoothMesh, decimateMesh, samplePoints, recomputeNormals, type MeshMeasure } from './meshops';
import type { MeshData } from './meshview';

/** True only in the desktop build, and only when the shell is actually there. The build flag
 *  alone would be a lie in `vite preview`; the Tauri global alone would drag the shell module
 *  into the web bundle. Both, and the web build never carries a byte of it. */
declare const __DESKTOP__: boolean;
export const DESKTOP = __DESKTOP__ && typeof (window as any).__TAURI__ !== 'undefined';
let shell: typeof import('./desktop') | null = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => Math.round(n).toLocaleString();
const mb = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
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
  st.sfName = sfName; st.meshData = meshData; st.meshInfo = meshInfo; st.meshFile = meshFile;
  st.dirtyField = dirtyMark.field; st.dirtySurface = dirtyMark.surface;
}
function restoreActive() {
  const st = viewer.active.state;
  meta = st.meta; currentFile = st.file; currentHandle = st.handle; cacheKey = st.cacheKey;
  fromCache = st.fromCache; cropped = st.cropped;
  histogram = st.histogram; axisHist = st.axisHist; axisCube = st.axisCube;
  sfName = st.sfName; meshData = st.meshData; meshInfo = st.meshInfo; meshFile = st.meshFile;
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
  meshData = null; meshFile = ''; viewer.setMesh(null); document.body.classList.toggle('has-mesh', viewer.anyMesh);
  viewer.setModel(new THREE.Matrix4()); viewer.setModelGizmo(false);
  sfName = ''; sfStats = null; document.body.classList.remove('has-sf', 'sf-filtering');
  ($('k-color-sf') as HTMLOptionElement).disabled = true; $<HTMLInputElement>('k-cropon').checked = false;
  syncRegions(); updateMeasureList(); setTool('none'); renderSectionList(); updateHistUI(); renderLayers();
  worker?.terminate(); worker = null;
  t0 = performance.now();
}
async function openFile(f: File, handle: any = null, add = false) {
  if (f.size < 48) { fail('That file is too small to be a scan.'); return; }
  // A file with faces in it is a mesh, and a mesh is a layer of its own kind. PLY is the one
  // format that can be either, so the decision is made on the header rather than the name.
  try {
    const head = new Uint8Array(await f.slice(0, 65536).arrayBuffer());
    if (looksLikeMesh(f.name, head)) {
      if (!add) {
        for (const e of viewer.entities.slice()) if (e.id !== viewer.activeId) viewer.removeEntity(e.id);
        viewer.clear();
        viewer.active.state = blankState(); viewer.active.name = 'Scan 1';
        viewer.setMesh(null); viewer.setModel(new THREE.Matrix4()); viewer.setModelGizmo(false);
        void hist.clear(); mergedNote = ''; frameOrigin = null; clearDirty(true);
        meshData = null; meshInfo = null; meshFile = ''; meta = null; currentFile = null; currentHandle = null;
        document.body.classList.remove('has-mesh', 'has-sf', 'sf-filtering');
        sections.length = 0; deletes.length = 0; cropUI.on = false; cropState.role = 'keep'; syncCropRoleUI();
        prismFull.clear(); countCache.clear();
        syncRegions(); updateMeasureList(); setTool('none'); renderSectionList(); updateHistUI();
      }
      $('drop').classList.add('hidden'); $('err').classList.add('hidden');
      try { await importMesh(f); } catch (e: any) { fail('Could not read that mesh: ' + (e?.message ?? e)); return; }
      $('loading').classList.add('hidden');
      renderLayers(); updateNames(); updateCacheUI();
      return;
    }
  } catch { /* unreadable head: fall through and let the cloud path report it */ }
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
  // A browser hands back a FileSystemHandle; the desktop shell has something better — the
  // path itself, which survives a restart with no permission prompt.
  if (currentHandle) idbPut(cacheKey, currentHandle);
  else if (DESKTOP && (currentFile as any)?.path) idbPut(cacheKey, { __path: (currentFile as any).path });
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
  // Each layer keeps its own uploaded surface, so switching re-points the UI rather than
  // re-uploading anything.
  document.body.classList.toggle('has-mesh', viewer.anyMesh);
  setDisplay(viewer.anyMesh ? viewer.display : 'points');
  refreshMeshUI();
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
      + `<span class="mono">${e.isMesh ? `${fmt(e.mesh.triangles)} tris` : `${fmt(e.points)} pts`}</span>`
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
  refreshRegisterUI(); refreshVolumeRefs(); refreshMeshUI();
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
  if (DESKTOP && shell) {
    const paths = await shell.openDialog({ title: 'Add a layer', multiple: true });
    for (const p of paths) await openPath(p, true);
    return;
  }
  const anyWin = window as any;
  if (anyWin.showOpenFilePicker) {
    try { const [h] = await anyWin.showOpenFilePicker({ types: [{ description: 'Point cloud', accept: { 'application/octet-stream': ['.e57', '.ply', '.las', '.laz', '.ptx', '.obj', '.stl', ...ASCII_EXT.map(e => '.' + e)] } }] }); openFile(await h.getFile(), h, true); } catch {}
    return;
  }
  const inp = document.createElement('input'); inp.type = 'file'; if (!isIOS) inp.accept = ['.e57', '.ply', '.las', '.laz', '.ptx', '.obj', '.stl', ...ASCII_EXT.map(e => '.' + e)].join(',');
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
  const cap = anaCap();
  anaWorker.postMessage({ type: 'start', cell, maxPoints: cap, model: rowMajor(viewer.cells.model) });
  await anaOnce('ready');
  const counts: number[] = [];
  let n = 0, base = 0;
  const total = viewer.cells.leafCount;
  for (const { leaf, recs } of viewer.cells.records()) {
    if (!anaAlive) break;
    counts.push(leaf.count);
    const buf = recs.buffer as ArrayBuffer;
    anaWorker.postMessage({ type: 'leaf', origin: leaf.origin.toArray(), size: leaf.size, recs: buf, base }, [buf]);
    base += leaf.count;
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
    // Measuring to another cloud is a per-point question, so a cloud too big to index at
    // once is measured a tile at a time, with only the part of the reference each tile can
    // reach fed alongside it.
    const r = viewer.cells.total > anaCap()
      ? { refName: layerName(ref), ...await runTiled('distance_to', { signed }, ref) }
      : await runRegister('distance_to', { signed });
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
  // No guard on the point count: an edit that removed *everything* is exactly the one that
  // most needs undoing, and refusing because the layer is empty left no way back.
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
  if (DESKTOP && shell) {
    // a real Save dialog, and a path the shell writes to — the browser's download fallback
    // would land the file in Downloads with no say in it
    const p = await shell.saveDialog(name, [fmtSel]);
    return p ? { __path: p } : null;
  }
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
  if (handle?.__path && shell) {
    await shell.writeBlobTo(r.file, handle.__path, (done, total) => busy(`Writing ${mb(done)} of ${mb(total)}…`, done / Math.max(total, 1)));
    io.postMessage({ type: 'export-cleanup', name: r.scratch });
    return;
  }
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
/** How many points the analyser will hold at once. A driver lowers it to provoke the refusal
 *  on a cloud small enough to build in a test. */
let anaMaxPoints = 0;
const anaCap = () => anaMaxPoints || (isTouch ? 8e6 : 30e6);
let anaError: string | null = null;
/** "Tile 3 of 8 · " while a tiled run is going, so a long wait says where it has got to. */
let anaTile = '';
/** The largest WebAssembly heap any tile of the last run needed, in bytes. */
let anaHeap = 0;
let anaAlive = true;
let sfName = '';
anaWorker.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === 'progress') {
    busy(m.total ? `${anaTile}${m.phase}… ${fmt(m.done)} of ${fmt(m.total)}` : `${anaTile}${m.phase}… ${fmt(m.done)} points`,
      m.total ? m.done / m.total : undefined);
    return;
  }
  if (m.type === 'error') {
    // Keep the first one. A refusal part-way through the feed is followed by whatever the
    // leaves still in flight do, and those are consequences, not the reason.
    anaError ??= m.message ?? 'analysis failed';
    anaAlive = false;
    const rej = anaWaiters.get('error');
    anaWaiters.clear();
    rej?.(m);
    return;
  }
  if (m.type === 'result' && m.heap) anaHeap = Math.max(anaHeap, m.heap);
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

/** Feed every leaf to the analyser, run one operation, and hand back the flat result.
 *  Only for what a tile cannot answer on its own: connected components, and the shape fits. */
async function runWhole(op: string, args: Record<string, any> = {}): Promise<any> {
  if (!viewer.loaded) throw new Error('nothing loaded');
  const counts: number[] = [];
  busy('Starting the analyser…'); await tick();
  anaAlive = true; anaError = null;
  // one grid cell per few points keeps the neighbour search in the 27 cells around a point
  const cell = Math.max(viewer.cells.medianSpacing * 2.5, 0.01);
  anaWorker.postMessage({ type: 'start', cell, maxPoints: anaCap(), model: rowMajor(viewer.cells.model) });
  await anaOnce('ready');
  let n = 0, base = 0;
  const total = viewer.cells.leafCount;
  for (const { leaf, recs } of viewer.cells.records()) {
    if (!anaAlive) break;
    counts.push(leaf.count);
    const buf = recs.buffer as ArrayBuffer;
    anaWorker.postMessage({ type: 'leaf', origin: leaf.origin.toArray(), size: leaf.size, recs: buf, base }, [buf]);
    base += leaf.count;
    if (++n % 8 === 0) { busy(`Reading cells… ${n} of ${total}`, n / Math.max(total, 1)); await tick(); }
  }
  anaWorker.postMessage({ type: 'run', op, ...args });
  const res = await anaOnce('result');
  return { ...res, counts };
}

// ------------------------------------------------------------------ tiling
//
// The analyser holds one spatial index over everything it is given, and there is a limit to
// how big that can get in a 32-bit WebAssembly heap. It used to refuse anything past the
// limit, which on a 73.8M point scan meant the Clean tools did not run at all.
//
// Every one of these operations is local: what happens to a point is decided by the points
// within a few centimetres of it. So the cloud is cut into spatial tiles, each small enough
// to index, and each tile is fed its own leaves followed by the leaves around it as context.
// The context points are searched but not answered for, which is what makes a tile's edge
// come out the same as the middle. Points are settled by their place in the file wherever a
// rule needs a winner, so two tiles looking at the same pair agree.
//
// SOR is the exception that needs the whole cloud: its threshold is the mean and standard
// deviation of every point's mean neighbour distance. It runs in two passes, the first
// adding up the tiles' sums and the second applying one threshold.
type TileBox = { lo: [number, number, number]; hi: [number, number, number]; n: number };
type Tile = { core: number[]; halo: number[]; points: number; fed: number };

/** Split the leaves into groups that fit, each with the leaves around it noted as context. */
function planTiles(boxes: TileBox[], budget: number, halo: number): Tile[] {
  const count = (g: number[]) => g.reduce((n, i) => n + boxes[i].n, 0);
  const boxOf = (g: number[]) => {
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const i of g) for (let a = 0; a < 3; a++) {
      if (boxes[i].lo[a] < lo[a]) lo[a] = boxes[i].lo[a];
      if (boxes[i].hi[a] > hi[a]) hi[a] = boxes[i].hi[a];
    }
    return { lo, hi };
  };
  /** Cut a group in two across its longest side, where half of its points are. Half the
   *  points rather than half the leaves, because a scan is far denser near the scanner. */
  const halve = (g: number[]): number[][] => {
    if (g.length < 2) return [g];
    const b = boxOf(g);
    let ax = 0;
    for (let a = 1; a < 3; a++) if (b.hi[a] - b.lo[a] > b.hi[ax] - b.lo[ax]) ax = a;
    const mid = (i: number) => (boxes[i].lo[ax] + boxes[i].hi[ax]) * 0.5;
    const sorted = [...g].sort((p, q) => mid(p) - mid(q));
    const half = count(g) / 2;
    let acc = 0, at = 0;
    while (at < sorted.length - 1) { acc += boxes[sorted[at]].n; at++; if (acc >= half) break; }
    return [sorted.slice(0, at), sorted.slice(at)];
  };
  const near = (core: number[]) => {
    const b = boxOf(core);
    const inCore = new Set(core);
    const out: number[] = [];
    for (let i = 0; i < boxes.length; i++) {
      if (inCore.has(i)) continue;
      const q = boxes[i];
      if (q.hi[0] < b.lo[0] - halo || q.lo[0] > b.hi[0] + halo) continue;
      if (q.hi[1] < b.lo[1] - halo || q.lo[1] > b.hi[1] + halo) continue;
      if (q.hi[2] < b.lo[2] - halo || q.lo[2] > b.hi[2] + halo) continue;
      out.push(i);
    }
    return out;
  };
  const queue: number[][] = [boxes.map((_, i) => i)];
  const tiles: Tile[] = [];
  let guard = 0;
  while (queue.length && guard++ < 4096) {
    const core = queue.shift()!;
    if (!core.length) continue;
    const own = count(core);
    // leave room for the context points before even looking at them
    if (own > budget * 0.6 && core.length > 1) { queue.unshift(...halve(core)); continue; }
    const ring = near(core);
    const fed = own + count(ring);
    if (fed > budget && core.length > 1) { queue.unshift(...halve(core)); continue; }
    core.sort((a, b) => a - b);
    tiles.push({ core, halo: ring, points: own, fed });
  }
  return tiles;
}

/** How far outside a tile the searches of the points inside it reach. */
function haloFor(op: string, args: Record<string, any>, cell: number): number {
  const knnReach = cell * 8;                       // the grid holds a few points per cell
  switch (op) {
    case 'duplicates': return Math.max((args.tol ?? 0.001) * 16, cell);
    case 'subsample': return Math.max((args.spacing ?? cell) * 2, cell);
    case 'noise': return args.useKnn ? knnReach : Math.max(Number(args.radius ?? cell) * 3, cell);
    case 'feature': return args.name === 'neighbours' ? Math.max(Number(args.radius ?? cell) * 2, cell) : knnReach;
    case 'invert': return 0;
    case 'distance_to': case 'distance_to_mesh': return 0;   // measured against something else
    default: return knnReach;                      // sor, normals
  }
}

const TILED_OPS = new Set(['sor', 'noise', 'duplicates', 'subsample', 'feature', 'normals', 'invert', 'distance_to', 'distance_to_mesh']);
/** True when this operation gives the same answer tile by tile as it does whole. */
function tileable(op: string, args: Record<string, any>): boolean {
  if (op === 'normals') {
    // Orienting normals without a viewpoint is a vote taken over the whole neighbour graph,
    // and two tiles can vote differently. With a viewpoint, or with the scanner's stations,
    // the decision is made per point and tiles cannot disagree.
    return !args.orient || !!args.viewpoint || (args.viewpoints?.length ?? 0) >= 3;
  }
  return TILED_OPS.has(op);
}

/** The leaves of the active cloud, their boxes and where each one starts in the cloud. */
function leafPlan() {
  const cells = viewer.cells;
  const leaves = cells.leavesForMask();
  const counts = leaves.map(l => l.count);
  const offs: number[] = [];
  let at = 0;
  for (const c of counts) { offs.push(at); at += c; }
  const boxes: TileBox[] = leaves.map(l => ({
    lo: [l.bmin.x, l.bmin.y, l.bmin.z], hi: [l.bmax.x, l.bmax.y, l.bmax.z], n: l.count,
  }));
  return { cells, leaves, counts, offs, boxes, total: at };
}

/** Run one operation over the cloud a tile at a time, and put the answer back together. */
async function runTiled(op: string, args: Record<string, any> = {}, ref: Entity | null = null): Promise<any> {
  if (!viewer.loaded) throw new Error('nothing loaded');
  const { cells, leaves, counts, offs, boxes, total } = leafPlan();
  anaHeap = 0;
  const cell = Math.max(cells.medianSpacing * 2.5, 0.01);
  const budget = anaCap();
  // leaf boxes are in the cloud's own frame; the reach is a distance on screen
  const scale = cells.modelScale || 1;
  const tiles = total <= budget
    ? [{ core: leaves.map((_, i) => i), halo: [] as number[], points: total, fed: total }]
    : planTiles(boxes, budget, haloFor(op, args, cell) / scale);
  const model = rowMajor(cells.model);
  const refModel = ref ? rowMajor(ref.cells.model) : null;
  const refLeaves = ref ? ref.cells.leavesForMask() : [];
  const reach = Math.max(cell * 200, 2);
  let refStride = 1;
  const t0 = performance.now();

  /** Feed one tile and run one thing over it. */
  const onTile = async (t: Tile, ti: number, run: Record<string, any>) => {
    anaAlive = true; anaError = null;
    anaTile = tiles.length > 1 ? `Tile ${ti + 1} of ${tiles.length} · ` : '';
    anaWorker.postMessage({ type: 'start', cell, maxPoints: Math.max(budget * 2, t.fed + 1), model });
    await anaOnce('ready');
    let n = 0;
    const feed = t.core.length + t.halo.length;
    for (const i of t.core.concat(t.halo)) {
      if (!anaAlive) break;
      const context = n >= t.core.length;
      const recs = leaves[i].readback(cells.gl2);
      const buf = recs.buffer as ArrayBuffer;
      anaWorker.postMessage({ type: 'leaf', origin: leaves[i].origin.toArray(), size: leaves[i].size, recs: buf, base: offs[i], context }, [buf]);
      if (++n % 8 === 0) { busy(`${anaTile}Reading cells… ${n} of ${feed}`, n / Math.max(feed, 1)); await tick(); }
    }
    // the reference cloud, only the part of it this tile can reach
    if (ref && refModel) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const i of t.core) for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], boxes[i].lo[a]); hi[a] = Math.max(hi[a], boxes[i].hi[a]);
      }
      const box = new THREE.Box3(new THREE.Vector3(lo[0], lo[1], lo[2]), new THREE.Vector3(hi[0], hi[1], hi[2]))
        .applyMatrix4(cells.model).expandByScalar(reach);
      const want = refLeaves.filter(l => box.intersectsBox(
        new THREE.Box3(l.bmin.clone(), l.bmax.clone()).applyMatrix4(ref.cells.model)));
      const refPts = want.reduce((s, l) => s + l.count, 0);
      const stride = Math.max(1, Math.ceil(refPts / Math.max(1, budget - t.points)));
      let m = 0;
      for (const l of want) {
        if (!anaAlive) break;
        const recs = l.readback(ref.cells.gl2);
        const buf = recs.buffer as ArrayBuffer;
        anaWorker.postMessage({ type: 'ref', origin: l.origin.toArray(), size: l.size, recs: buf, model: refModel, stride }, [buf]);
        if (++m % 8 === 0) { busy(`${anaTile}Reading the reference… ${m} of ${want.length}`, m / Math.max(want.length, 1)); await tick(); }
      }
      if (!want.length) throw new Error('no reference cloud was fed');
      refStride = Math.max(refStride, stride);
    }
    anaWorker.postMessage({ type: 'run', outLen: t.points, ...run });
    const res = await anaOnce('result');
    anaWorker.postMessage({ type: 'done' });
    return res;
  };

  /** Copy a tile's answer back into the array that covers the whole cloud. */
  const scatter = (t: Tile, part: any, full: any, per = 1) => {
    let at = 0;
    for (const i of t.core) {
      full.set(part.subarray(at * per, (at + counts[i]) * per), offs[i] * per);
      at += counts[i];
    }
  };

  try {
    let out: any = { op, points: total, counts, tiles: tiles.length };
    if (op === 'sor' && tiles.length > 1) {
      // pass one: the cloud's mean and standard deviation, added up over the tiles
      let sum = 0, sum2 = 0, cnt = 0;
      for (let i = 0; i < tiles.length; i++) {
        const r = await onTile(tiles[i], i, { op: 'sor_stats', knn: args.knn ?? args.k ?? 6 });
        sum += r.sum; sum2 += r.sum2; cnt += r.count;
      }
      const mean = sum / Math.max(cnt, 1);
      const sd = Math.sqrt(Math.abs(sum2 / Math.max(cnt, 1) - mean * mean));
      const cut = mean + Number(args.sigma ?? 1) * sd;
      // pass two: one threshold, every tile
      const full = new Uint8Array(total);
      for (let i = 0; i < tiles.length; i++) {
        const r = await onTile(tiles[i], i, { op: 'sor_cut', knn: args.knn ?? args.k ?? 6, cut });
        scatter(tiles[i], r.data, full);
      }
      out.kind = 'mask'; out.data = full; out.mean = mean; out.cut = cut;
      out.params = { knn: args.knn ?? args.k ?? 6, nSigma: Number(args.sigma ?? 1) };
    } else {
      let full: any = null;
      for (let i = 0; i < tiles.length; i++) {
        const r = await onTile(tiles[i], i, { op, ...args });
        if (!full) {
          out.kind = r.kind;
          full = r.kind === 'mask' ? new Uint8Array(total)
            : r.kind === 'normals' ? new Int8Array(total * 3)
            : new Float32Array(total);
          for (const k of ['mean', 'cut', 'params', 'components', 'refStride']) if (r[k] !== undefined) out[k] = r[k];
        }
        scatter(tiles[i], r.data, full, r.kind === 'normals' ? 3 : 1);
      }
      out.data = full;
    }
    out.ms = performance.now() - t0;
    out.heap = anaHeap;
    if (ref) out.refStride = refStride;
    return out;
  } finally { anaTile = ''; }
}

/** Run one operation, whole or a tile at a time, whichever this cloud needs. */
async function runAnalysis(op: string, args: Record<string, any> = {}): Promise<any> {
  if (!viewer.loaded) throw new Error('nothing loaded');
  if (tileable(op, args)) return runTiled(op, args);
  return runWhole(op, args);
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

// CloudCompare's defaults where the filters share a setting with it: nSigma 1.0, a sphere
// neighbourhood for the noise filter, a relative threshold, isolated points kept. Neighbours
// is 16 rather than its 8 because the same slider also drives the feature computations,
// where 8 is too few to be stable.
const anaUi = {
  k: 16, sigma: 1.0, spacing: 0.1,
  noiseKnn: false, noiseRadius: 0.15, noiseAbsolute: false, noiseAbsError: 0.02, noiseRip: false,
};
function syncAnaLabels() {
  $('v-ank').textContent = String(anaUi.k);
  const k2 = $<HTMLInputElement>('k-ank2');
  if (k2) { k2.value = String(anaUi.k); $('v-ank2').textContent = String(anaUi.k); }
  const k1 = $<HTMLInputElement>('k-ank');
  if (k1 && +k1.value !== anaUi.k) k1.value = String(anaUi.k);
  $('v-ansigma').textContent = anaUi.sigma.toFixed(1) + ' σ';
  $('v-anspace').textContent = anaUi.spacing.toFixed(2) + ' m';
  $('v-annradius').textContent = anaUi.noiseRadius.toFixed(2) + ' m';
  $('v-annabs').textContent = anaUi.noiseAbsError.toFixed(3) + ' m';
  // only one of the two pairs applies at a time; dim the other rather than hide it, so the
  // value it would use is still visible
  $('k-annradius').closest('label')!.classList.toggle('dim', anaUi.noiseKnn);
  $('k-annabs').closest('label')!.classList.toggle('dim', !anaUi.noiseAbsolute);
}
// Neighbours appears in both Analysis and Clean, because both need it and neither should send
// you to the other group to change it. One value, two sliders, repainted together.
for (const id of ['k-ank', 'k-ank2']) {
  $(id)?.addEventListener('input', e => { anaUi.k = +(e.target as HTMLInputElement).value; syncAnaLabels(); });
}
$('k-ansigma').addEventListener('input', e => { anaUi.sigma = +(e.target as HTMLInputElement).value; syncAnaLabels(); });
$('k-anspace').addEventListener('input', e => { anaUi.spacing = +(e.target as HTMLInputElement).value; syncAnaLabels(); });
$('k-annbmode').addEventListener('change', e => { anaUi.noiseKnn = (e.target as HTMLSelectElement).value === 'knn'; syncAnaLabels(); });
$('k-anerrmode').addEventListener('change', e => { anaUi.noiseAbsolute = (e.target as HTMLSelectElement).value === 'absolute'; syncAnaLabels(); });
$('k-annradius').addEventListener('input', e => { anaUi.noiseRadius = +(e.target as HTMLInputElement).value; syncAnaLabels(); });
$('k-annabs').addEventListener('input', e => { anaUi.noiseAbsError = +(e.target as HTMLInputElement).value; syncAnaLabels(); });
$('k-annrip').addEventListener('change', e => { anaUi.noiseRip = (e.target as HTMLInputElement).checked; });
/** Everything the noise filter needs, in the shape both the panel and an agent send. */
function noiseArgs(over: Record<string, any> = {}) {
  return {
    knn: anaUi.k, sigma: anaUi.sigma,
    useKnn: anaUi.noiseKnn, radius: anaUi.noiseRadius,
    useAbsoluteError: anaUi.noiseAbsolute, absoluteError: anaUi.noiseAbsError,
    removeIsolated: anaUi.noiseRip,
    ...over,
  };
}

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
  const note = (t: string, kind = '') => {
    const el = $('v-clean') ?? $('v-analysis');
    el.textContent = t;
    el.className = 'statusline' + (kind ? ' ' + kind : '');
  };
  try {
    const before = viewer.loaded;
    const r = await runAnalysis(op, args);
    hideBusy();
    const masks = perLeaf(r.data as Uint8Array, r.counts);
    const extra = r.mean !== undefined ? `<p class="mono">mean neighbour distance ${r.mean.toFixed(4)} m · cut-off ${r.cut.toFixed(4)} m</p>` : '';
    const res = await commitMask(label, masks, prompt + extra);
    if (!res) { note('nothing removed'); return; }
    const pct = before ? (res.dropped / before) * 100 : 0;
    note(`removed ${fmt(res.dropped)} points, ${pct.toFixed(1)}%, undo with ${isMac ? '⌘Z' : 'Ctrl+Z'}`, 'ok');
  } catch (e: any) {
    note('failed: ' + (e?.message ?? e), 'err');
  } finally { hideBusy(); }
}
$('k-ansor').addEventListener('click', () => maskTool('sor', { knn: anaUi.k, sigma: anaUi.sigma }, 'Remove outliers',
  '<p>Each point\'s mean distance to its nearest neighbours is measured, and points further out than the mean plus your <b>Strictness</b> in standard deviations are dropped: <b>{n}</b> of them, leaving {k}.</p>'
  + '<p class="hint">This is a single threshold over the whole cloud, so a handful of very distant points can raise it far enough to let nearer outliers through. Same algorithm and defaults as CloudCompare\'s SOR filter.</p>'));
$('k-annoise').addEventListener('click', () => maskTool('noise', noiseArgs(), 'Remove noise',
  '<p>A plane is fitted to the points around each point, and the point is dropped if it sits further off that plane than the spread of its own neighbours allows: <b>{n}</b> of them, leaving {k}. Real edges survive because they still fit a plane.</p>'
  + '<p class="hint">The threshold is local, so smooth areas are judged strictly and rough ones loosely. Same algorithm and defaults as CloudCompare\'s noise filter.</p>'));
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

// ------------------------------------------------------------------ raster, contours, volume
// A 2.5D height model over a regular grid, which is what a terrain question turns into: a
// contour is a level set of it, and a volume is the difference between two of them, one cell
// area at a time.

interface Raster { grid: Float32Array; w: number; h: number; cell: number; ox: number; oy: number; lo: number; hi: number; axis: number; filled: number; sampled: number }
const rasterUi = { cell: 0.25, interval: 0.5 };
for (const [id, key, lab, f] of [['k-rcell', 'cell', 'v-rcell', (v: number) => `${v.toFixed(2)} m`],
                                 ['k-cint', 'interval', 'v-cint', (v: number) => `${v.toFixed(2)} m`]] as [string, 'cell' | 'interval', string, (v: number) => string][]) {
  $(id).addEventListener('input', e => { rasterUi[key] = Number((e.target as HTMLInputElement).value); $(lab).textContent = f(rasterUi[key]); });
  $(lab).textContent = f(rasterUi[key]);
}

/** Build a raster from an entity's points. Every statistic is one pass; "field" reads the
 *  entity's scalar field, so a raster of roughness or of a distance field costs no more than
 *  a raster of height. */
function buildRaster(e: Entity, opts: { cell?: number; stat?: string; axis?: string; fill?: string; box?: THREE.Box3 } = {}): Raster | null {
  const cell = Math.max(0.005, opts.cell ?? rasterUi.cell);
  const stat = opts.stat ?? 'max';
  const axisName = (opts.axis ?? 'z').toLowerCase();
  const iAx = axisName === 'x' ? 0 : axisName === 'y' ? 1 : 2;
  const [uAx, vAx] = [[1, 2], [0, 2], [0, 1]][iAx];
  const b = opts.box ?? e.bounds();
  if (b.isEmpty()) return null;
  const mn = b.min.toArray(), size = b.getSize(new THREE.Vector3()).toArray();
  const w = Math.max(1, Math.min(2048, Math.ceil(Math.max(size[uAx], cell) / cell)));
  const h = Math.max(1, Math.min(2048, Math.ceil(Math.max(size[vAx], cell) / cell)));
  const grid = new Float32Array(w * h).fill(NaN);
  const sum = stat === 'mean' || stat === 'field' ? new Float64Array(w * h) : null;
  const cnt = new Uint32Array(w * h);
  let sampled = 0;
  for (const leaf of e.cells.leavesForMask()) {
    const recs = leaf.readback(e.cells.gl2);
    const xyz = e.cells.transformRecordsInto(recs, leaf.count, leaf, new Float64Array(leaf.count * 3));
    for (let i = 0; i < leaf.count; i++) {
      const u = Math.floor((xyz[i * 3 + uAx] - mn[uAx]) / cell);
      const v = Math.floor((xyz[i * 3 + vAx] - mn[vAx]) / cell);
      if (u < 0 || v < 0 || u >= w || v >= h) continue;
      const k = v * w + u;
      const q = stat === 'field' ? (leaf.sf ? leaf.sf[i] : NaN) : xyz[i * 3 + iAx];
      sampled++;
      if (stat === 'density') { cnt[k]++; continue; }
      if (!isFinite(q)) continue;
      cnt[k]++;
      if (sum) sum[k] += q;
      else if (!isFinite(grid[k])) grid[k] = q;
      else if (stat === 'min') grid[k] = Math.min(grid[k], q);
      else grid[k] = Math.max(grid[k], q);
    }
  }
  if (stat === 'density') for (let k = 0; k < grid.length; k++) grid[k] = cnt[k] || NaN;
  else if (sum) for (let k = 0; k < grid.length; k++) grid[k] = cnt[k] ? sum[k] / cnt[k] : NaN;
  let filled = 0;
  for (const g of grid) if (isFinite(g)) filled++;
  if (!filled) return null;
  const fill = opts.fill ?? 'none';
  if (fill !== 'none') fillEmpty(grid, w, h, fill === 'idw');
  let lo = Infinity, hi = -Infinity;
  for (const g of grid) if (isFinite(g)) { if (g < lo) lo = g; if (g > hi) hi = g; }
  return { grid, w, h, cell, ox: mn[uAx], oy: mn[vAx], lo, hi, axis: iAx, filled, sampled };
}
/** Fill the holes a scan leaves: nearest value, or inverse-distance over the nearest few.
 *  A single expanding-ring search per empty cell, capped, because a hole in the middle of a
 *  car park should not be filled from the far side of the site. */
function fillEmpty(grid: Float32Array, w: number, h: number, idw: boolean, maxRing = 12) {
  const src = Float32Array.from(grid);
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
    const k = v * w + u;
    if (isFinite(src[k])) continue;
    let best = NaN, bestD = Infinity, wsum = 0, vsum = 0, found = 0;
    for (let r = 1; r <= maxRing && (idw ? found < 8 : !isFinite(best)); r++) {
      for (let dv = -r; dv <= r; dv++) for (let du = -r; du <= r; du++) {
        if (Math.max(Math.abs(du), Math.abs(dv)) !== r) continue;
        const uu = u + du, vv = v + dv;
        if (uu < 0 || vv < 0 || uu >= w || vv >= h) continue;
        const q = src[vv * w + uu];
        if (!isFinite(q)) continue;
        const d = Math.hypot(du, dv);
        if (idw) { const wt = 1 / (d * d); wsum += wt; vsum += q * wt; found++; }
        else if (d < bestD) { bestD = d; best = q; }
      }
    }
    grid[k] = idw ? (wsum ? vsum / wsum : NaN) : best;
  }
}

let raster: Raster | null = null;
let contours: { z: number; pts: number[][] }[] = [];
function rasterStat() { return $<HTMLSelectElement>('k-rstat').value; }
async function rasterize() {
  if (!viewer.loaded) return null;
  busy('Rasterizing…'); await tick();
  try {
    const t0 = performance.now();
    const stat = rasterStat();
    if (stat === 'field' && !viewer.cells.hasScalarField) { $('v-raster').textContent = 'no scalar field on this layer to rasterize'; return null; }
    raster = buildRaster(viewer.active, { cell: rasterUi.cell, stat, axis: $<HTMLSelectElement>('k-raxis').value, fill: $<HTMLSelectElement>('k-rfill').value });
    if (!raster) { $('v-raster').textContent = 'nothing fell in the raster'; return null; }
    viewer.setRaster(raster);
    viewer.setRasterVisible($<HTMLInputElement>('k-rshow').checked);
    document.body.classList.add('has-raster');
    const unit = stat === 'density' ? ' points' : ' m';
    $('v-raster').textContent = `${raster.w} x ${raster.h} cells of ${raster.cell} m · ${fmt(raster.filled)} filled of ${fmt(raster.w * raster.h)} · ${raster.lo.toFixed(3)} to ${raster.hi.toFixed(3)}${unit} · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    viewer.touch();
    return raster;
  } catch (e: any) { $('v-raster').textContent = 'failed: ' + (e?.message ?? e); return null; }
  finally { hideBusy(); }
}
$('k-rasterize').addEventListener('click', () => rasterize());
$('k-rshow').addEventListener('change', e => viewer.setRasterVisible((e.target as HTMLInputElement).checked));

/** The raster as a PNG, plus the world file that says where each pixel is on the ground. */
function rasterPng(r: Raster): { png: Blob; pgw: string } {
  const cv = document.createElement('canvas'); cv.width = r.w; cv.height = r.h;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(r.w, r.h);
  const span = Math.max(r.hi - r.lo, 1e-9);
  for (let v = 0; v < r.h; v++) for (let u = 0; u < r.w; u++) {
    const g = r.grid[v * r.w + u];
    const k = ((r.h - 1 - v) * r.w + u) * 4;          // PNG rows run top to bottom
    const q = isFinite(g) ? Math.round(((g - r.lo) / span) * 254) + 1 : 0;
    img.data[k] = q; img.data[k + 1] = q; img.data[k + 2] = q; img.data[k + 3] = isFinite(g) ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
  const t = (meta?.scans?.[0]?.translation ?? [0, 0, 0]) as number[];
  const [uAx, vAx] = [[1, 2], [0, 2], [0, 1]][r.axis];
  // a world file is six lines: x and y pixel size, two rotations, and the centre of the
  // top-left pixel — in the global frame, because that is the only frame a GIS knows
  const pgw = [r.cell, 0, 0, -r.cell,
    r.ox + t[uAx] + r.cell / 2,
    r.oy + t[vAx] + (r.h - 0.5) * r.cell].map(v => v.toFixed(6)).join('\n') + '\n';
  const bin = atob(cv.toDataURL('image/png').split(',')[1]);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return { png: new Blob([buf], { type: 'image/png' }), pgw };
}
$('k-rsavepng').addEventListener('click', async () => {
  if (!raster) return;
  const base = (currentFile?.name ?? 'scan').replace(/\.[^.]+$/, '') + '-raster';
  const { png, pgw } = rasterPng(raster);
  const h1 = await pickSaveHandle(`${base}.png`, 'png');
  if (h1 === null) return;
  await writeOutFile({ file: new File([png], `${base}.png`), name: `${base}.png`, scratch: '' }, h1);
  const h2 = await pickSaveHandle(`${base}.pgw`, 'pgw');
  if (h2 !== null) await writeOutFile({ file: new File([pgw], `${base}.pgw`), name: `${base}.pgw`, scratch: '' }, h2);
  $('v-raster').textContent = `saved ${base}.png and its world file · ${raster.w} x ${raster.h} cells of ${raster.cell} m`;
});

/** Marching squares at a real level, interpolating where each edge crosses it — which is
 *  what makes a contour smooth rather than staircased. */
function contourAt(r: Raster, level: number): number[][][] {
  const segs: number[][] = [];
  const g = (u: number, v: number) => r.grid[v * r.w + u];
  for (let v = 0; v < r.h - 1; v++) for (let u = 0; u < r.w - 1; u++) {
    const q = [g(u, v), g(u + 1, v), g(u + 1, v + 1), g(u, v + 1)];
    if (q.some(x => !isFinite(x))) continue;
    let code = 0;
    for (let i = 0; i < 4; i++) if (q[i] >= level) code |= 1 << i;
    if (code === 0 || code === 15) continue;
    const lerp = (a: number, b: number) => (level - a) / ((b - a) || 1e-12);
    const e = [
      [u + lerp(q[0], q[1]), v],                 // bottom
      [u + 1, v + lerp(q[1], q[2])],             // right
      [u + lerp(q[3], q[2]), v + 1],             // top
      [u, v + lerp(q[0], q[3])],                 // left
    ];
    const push = (a: number, b: number) => segs.push([e[a][0], e[a][1], e[b][0], e[b][1]]);
    switch (code) {
      case 1: case 14: push(3, 0); break;
      case 2: case 13: push(0, 1); break;
      case 3: case 12: push(3, 1); break;
      case 4: case 11: push(1, 2); break;
      case 6: case 9: push(0, 2); break;
      case 7: case 8: push(3, 2); break;
      case 5: push(3, 0); push(1, 2); break;
      case 10: push(0, 1); push(2, 3); break;
    }
  }
  return stitch(segs).map(l => l.map(([u, v]) => [r.ox + (u + 0.5) * r.cell, r.oy + (v + 0.5) * r.cell]));
}
/** Join segments into polylines through their shared endpoints. */
function stitch(segs: number[][]): number[][][] {
  const key = (x: number, y: number) => `${Math.round(x * 512)},${Math.round(y * 512)}`;
  const node = new Map<string, { p: number[]; to: string[] }>();
  for (const [x1, y1, x2, y2] of segs) {
    const k1 = key(x1, y1), k2 = key(x2, y2);
    if (k1 === k2) continue;
    if (!node.has(k1)) node.set(k1, { p: [x1, y1], to: [] });
    if (!node.has(k2)) node.set(k2, { p: [x2, y2], to: [] });
    node.get(k1)!.to.push(k2); node.get(k2)!.to.push(k1);
  }
  const used = new Set<string>();
  const ek = (a: string, b: string) => a < b ? a + '|' + b : b + '|' + a;
  const keys = [...node.keys()].sort((a, b) => node.get(a)!.to.length - node.get(b)!.to.length);
  const out: number[][][] = [];
  for (const s of keys) for (const first of node.get(s)!.to) {
    if (used.has(ek(s, first))) continue;
    const line = [node.get(s)!.p];
    let cur = s, nxt: string | undefined = first;
    while (nxt) {
      used.add(ek(cur, nxt));
      line.push(node.get(nxt)!.p);
      const n2: string = nxt;
      nxt = node.get(n2)!.to.find((t: string) => !used.has(ek(n2, t)));
      cur = n2;
      if (line.length > 200_000) break;
    }
    if (line.length >= 2) out.push(line);
  }
  return out;
}
async function drawContours(interval?: number) {
  const iv = Math.max(0.001, interval ?? rasterUi.interval);
  if (!raster) { await rasterize(); }
  if (!raster) return null;
  busy('Tracing contours…'); await tick();
  try {
    const t0 = performance.now();
    contours = [];
    const first = Math.ceil(raster.lo / iv) * iv;
    let vertices = 0;
    for (let z = first; z <= raster.hi + 1e-9 && contours.length < 400; z += iv) {
      for (const l of contourAt(raster, z)) {
        const simple = simplifyRing(l, raster.cell * 0.4);
        contours.push({ z, pts: simple });
        vertices += simple.length;
      }
    }
    viewer.setContours(contours, raster.axis);
    document.body.classList.toggle('has-contours', contours.length > 0);
    const levels = new Set(contours.map(c => +c.z.toFixed(4))).size;
    $('v-contours').textContent = `${contours.length} polylines over ${levels} levels at ${iv} m · ${fmt(vertices)} vertices · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    viewer.touch();
    return contours;
  } finally { hideBusy(); }
}
$('k-contours').addEventListener('click', () => drawContours());

/** A minimal DXF of LWPOLYLINEs at their own elevations. Every CAD package reads this. */
function contoursDxf(): string {
  const t = (meta?.scans?.[0]?.translation ?? [0, 0, 0]) as number[];
  const [uAx, vAx] = [[1, 2], [0, 2], [0, 1]][raster?.axis ?? 2];
  const iAx = raster?.axis ?? 2;
  const out: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  for (const c of contours) {
    out.push('0', 'LWPOLYLINE', '8', 'CONTOURS', '100', 'AcDbEntity', '100', 'AcDbPolyline',
      '90', String(c.pts.length), '70', '0', '38', (c.z + t[iAx]).toFixed(4));
    for (const [x, y] of c.pts) out.push('10', (x + t[uAx]).toFixed(4), '20', (y + t[vAx]).toFixed(4));
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n') + '\n';
}
function contoursGeoJson(): string {
  const t = (meta?.scans?.[0]?.translation ?? [0, 0, 0]) as number[];
  const [uAx, vAx] = [[1, 2], [0, 2], [0, 1]][raster?.axis ?? 2];
  const iAx = raster?.axis ?? 2;
  return JSON.stringify({
    type: 'FeatureCollection',
    features: contours.map(c => ({
      type: 'Feature',
      properties: { elevation: +(c.z + t[iAx]).toFixed(4) },
      geometry: { type: 'LineString', coordinates: c.pts.map(([x, y]) => [+(x + t[uAx]).toFixed(4), +(y + t[vAx]).toFixed(4), +(c.z + t[iAx]).toFixed(4)]) },
    })),
  });
}
async function saveContours(kind: 'dxf' | 'geojson') {
  if (!contours.length) return;
  const base = (currentFile?.name ?? 'scan').replace(/\.[^.]+$/, '') + '-contours';
  const name = `${base}.${kind === 'dxf' ? 'dxf' : 'geojson'}`;
  const text = kind === 'dxf' ? contoursDxf() : contoursGeoJson();
  const h = await pickSaveHandle(name, kind);
  if (h === null) return;
  await writeOutFile({ file: new File([text], name), name, scratch: '' }, h);
  $('v-contours').textContent = `saved ${name} · ${contours.length} polylines · coordinates are global`;
}
$('k-cdxf').addEventListener('click', () => saveContours('dxf'));
$('k-cgeojson').addEventListener('click', () => saveContours('geojson'));

/** 2.5D volume between the active layer and a reference — another layer, or a flat plane. */
function measureVolume(opts: { cell?: number; reference?: string | null; plane?: number } = {}) {
  if (!viewer.loaded) return null;
  const cell = opts.cell ?? rasterUi.cell;
  const refId = opts.reference !== undefined ? opts.reference : $<HTMLSelectElement>('k-vref').value;
  const ref = refId && refId !== 'plane' ? viewer.entities.find(e => e.id === refId) : null;
  // both rasters must be over the same cells, or the subtraction is meaningless
  const box = viewer.active.bounds().clone();
  if (ref) box.union(ref.bounds());
  // The reference is hole-filled, the active layer is not, and the asymmetry is deliberate.
  // A cell the reference happens to have no point in is not a cell with no ground under it,
  // and dropping it drops that cell's volume silently — a reference sampled more coarsely than
  // the cell size came out at a quarter of the right answer. But filling the *active* layer
  // invents surface past its own edge, which adds volume that was never scanned.
  const a = buildRaster(viewer.active, { cell, stat: 'max', axis: 'z', box });
  if (!a) return null;
  const plane = opts.plane !== undefined ? Number(opts.plane) : Number($<HTMLInputElement>('k-vplane').value);
  const b = ref ? buildRaster(ref, { cell, stat: 'max', axis: 'z', box, fill: 'idw' }) : null;
  const area = cell * cell;
  let cut = 0, fill = 0, cells = 0;
  const diff = new Float32Array(a.grid.length).fill(NaN);
  for (let k = 0; k < a.grid.length; k++) {
    const av = a.grid[k];
    const bv = b ? b.grid[k] : plane;
    if (!isFinite(av) || !isFinite(bv)) continue;
    const d = av - bv;
    diff[k] = d; cells++;
    if (d > 0) fill += d * area; else cut += -d * area;
  }
  const res = { added: fill, removed: cut, net: fill - cut, cells, area: cells * area, cell,
                reference: ref ? layerName(ref) : `a plane at z = ${plane}` };
  let dlo = 0, dhi = 0;
  for (const d of diff) if (isFinite(d)) { if (d < dlo) dlo = d; if (d > dhi) dhi = d; }
  raster = { ...a, grid: diff, lo: dlo, hi: dhi, filled: cells };
  viewer.setRaster(raster);
  document.body.classList.add('has-raster');
  $('v-volume').textContent = `against ${res.reference} · added ${res.added.toFixed(3)} m³ · removed ${res.removed.toFixed(3)} m³ · net ${res.net.toFixed(3)} m³ · over ${res.area.toFixed(2)} m² of ${fmt(cells)} cells`;
  viewer.touch();
  return res;
}
function refreshVolumeRefs() {
  const sel = $<HTMLSelectElement>('k-vref');
  const others = viewer.entities.filter(e => e.id !== viewer.activeId);
  const want = 'plane|' + others.map(e => e.id).join('|');
  if (sel.dataset.ids === want) return;
  sel.innerHTML = '<option value="plane">a flat plane</option>';
  for (const e of others) { const o = document.createElement('option'); o.value = e.id; o.textContent = layerName(e); sel.appendChild(o); }
  sel.dataset.ids = want;
}
$('k-volume').addEventListener('click', () => measureVolume());

// ------------------------------------------------------------------ fitting and detection
// A fit answers with an RMS as well as its parameters, because the parameters alone are never
// enough: a cylinder fitted to a flat wall has a radius and an axis and means nothing, and
// the residual is the only thing that says so.

const fitUi = { tol: 0.02, minPts: 2000 };
for (const [id, key, lab, f] of [['k-dettol', 'tol', 'v-dettol', (v: number) => `${v.toFixed(3)} m`],
                                 ['k-detmin', 'minPts', 'v-detmin', (v: number) => fmt(v)]] as [string, 'tol' | 'minPts', string, (v: number) => string][]) {
  $(id).addEventListener('input', e => { fitUi[key] = Number((e.target as HTMLInputElement).value); $(lab).textContent = f(fitUi[key]); });
  $(lab).textContent = f(fitUi[key]);
}

/** The points a fit should work on: the active region's contents, or the whole layer. Sampled
 *  when there are more than the fit can usefully use — a plane is no better fitted from ten
 *  million points than from half a million, and the transfer is the expensive part. */
function fitPoints(max = 400_000): { xyz: Float32Array; nrm: Float32Array; count: number; inRegion: boolean; box: THREE.Box3 } {
  const r = activeRegion();
  const box = new THREE.Box3();
  const est = r ? viewer.cells.countInside(r, 8) : viewer.loaded;
  const stride = Math.max(1, Math.ceil(est / max));
  const xs: number[] = [], ns: number[] = [];
  const p = new THREE.Vector3(), nv = new THREE.Vector3();
  const lb = new THREE.Box3();
  const reach = r ? Math.hypot(r.half[0], r.half[1], r.half[2]) + (r.kind === 'sphere' ? r.radius : 0) : 0;
  const want = r ? new THREE.Box3(new THREE.Vector3(...r.center).addScalar(-reach), new THREE.Vector3(...r.center).addScalar(reach)) : null;
  const rot = new THREE.Matrix3().setFromMatrix4(viewer.cells.model);
  for (const leaf of viewer.cells.leavesForMask()) {
    if (want && !viewer.cells.leafBox(leaf, lb).intersectsBox(want)) continue;
    const recs = leaf.readback(viewer.cells.gl2);
    const xyz = viewer.cells.transformRecordsInto(recs, leaf.count, leaf, new Float64Array(leaf.count * 3));
    for (let i = 0; i < leaf.count; i += stride) {
      p.set(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
      if (r && !pointInRegion(p, r)) continue;
      xs.push(p.x, p.y, p.z);
      box.expandByPoint(p);
      const o = i * REC;
      const a = recs[o + 10] << 24 >> 24, b = recs[o + 11] << 24 >> 24, c = recs[o + 12] << 24 >> 24;
      if (a === 0 && b === 0 && c === 127) ns.push(0, 0, 0);
      else { nv.set(a, b, c).applyMatrix3(rot); if (nv.lengthSq() > 1e-12) nv.normalize(); ns.push(nv.x, nv.y, nv.z); }
    }
  }
  return { xyz: new Float32Array(xs), nrm: new Float32Array(ns), count: xs.length / 3, inRegion: !!r, box };
}

let lastFit: any = null;
async function fitShape(kind: 'plane' | 'sphere' | 'cylinder' | 'circle') {
  if (!viewer.loaded) return null;
  busy('Reading the points…'); await tick();
  try {
    const pts = fitPoints();
    if (pts.count < 8) { $('v-fit').textContent = `only ${pts.count} points there — place a region over something first`; return null; }
    busy(`Fitting a ${kind} to ${fmt(pts.count)} points…`); await tick();
    anaError = null; anaAlive = true;
    const xyz = pts.xyz.buffer as ArrayBuffer, nrm = pts.nrm.buffer as ArrayBuffer;
    anaWorker.postMessage({ type: 'fit', kind, xyz, nrm }, [xyz, nrm]);
    const r = JSON.parse((await anaOnce('fit')).json);
    if (r.error) { $('v-fit').textContent = r.error; return null; }
    r.size = Math.max(...pts.box.getSize(new THREE.Vector3()).toArray(), 0.1) * 1.1;
    if (kind === 'cylinder' && !r.length) r.length = r.size;
    lastFit = r;
    viewer.setPrimitive(r);
    const mm = (v: number) => `${(v * 1000).toFixed(2)} mm`;
    const v3 = (a: number[]) => a.map(v => v.toFixed(4)).join(', ');
    $('v-fit').textContent = kind === 'plane'
      ? `plane · normal ${v3(r.normal)} · through ${v3(r.centroid)} · RMS ${mm(r.rms)} · worst ${mm(r.worst)} · ${fmt(r.points)} points`
      : kind === 'sphere' ? `sphere · centre ${v3(r.centre)} · r ${r.radius.toFixed(4)} m · RMS ${mm(r.rms)} · ${fmt(r.points)} points`
      : kind === 'cylinder' ? `cylinder · axis ${v3(r.axis)} · through ${v3(r.centre)} · r ${r.radius.toFixed(4)} m · ${r.length.toFixed(3)} m long · RMS ${mm(r.rms)} · ${fmt(r.points)} points`
      : `circle · centre ${v3(r.centre)} · r ${r.radius.toFixed(4)} m · normal ${v3(r.normal)} · RMS ${mm(r.rms)} · ${fmt(r.points)} points`;
    viewer.touch();
    return r;
  } catch (e: any) { $('v-fit').textContent = 'fit failed: ' + (e?.message ?? e); return null; }
  finally { hideBusy(); }
}
$('k-fitplane').addEventListener('click', () => fitShape('plane'));
$('k-fitsphere').addEventListener('click', () => fitShape('sphere'));
$('k-fitcyl').addEventListener('click', () => fitShape('cylinder'));
$('k-fitcircle').addEventListener('click', () => fitShape('circle'));
$('k-fitclear').addEventListener('click', () => { viewer.setPrimitive(null); lastFit = null; $('v-fit').textContent = '—'; });

/** Distance from a point to a detected shape, the same measure the detector used. */
function shapeDistance(sh: any, x: number, y: number, z: number): number {
  if (sh.shape === 'plane') return Math.abs((x - sh.centroid[0]) * sh.normal[0] + (y - sh.centroid[1]) * sh.normal[1] + (z - sh.centroid[2]) * sh.normal[2]);
  if (sh.shape === 'sphere') return Math.abs(Math.hypot(x - sh.centre[0], y - sh.centre[1], z - sh.centre[2]) - sh.radius);
  const d = [x - sh.centre[0], y - sh.centre[1], z - sh.centre[2]];
  const t = d[0] * sh.axis[0] + d[1] * sh.axis[1] + d[2] * sh.axis[2];
  return Math.abs(Math.hypot(d[0] - t * sh.axis[0], d[1] - t * sh.axis[1], d[2] - t * sh.axis[2]) - sh.radius);
}
let shapes: any[] = [];
/** Label every point of the layer by the nearest detected shape within tolerance.
 *
 *  The detector works on a sample, because RANSAC does not need ten million points to find a
 *  wall. Classifying all of them afterwards against the few shapes it found is both cheaper
 *  and more honest than pretending the sample's labels covered everything. */
function applyShapeField(tol: number): number {
  if (!shapes.length) return 0;
  let claimed = 0;
  const per: Float32Array[] = [];
  for (const leaf of viewer.cells.leavesForMask()) {
    const recs = leaf.readback(viewer.cells.gl2);
    const xyz = viewer.cells.transformRecordsInto(recs, leaf.count, leaf, new Float64Array(leaf.count * 3));
    const a = new Float32Array(leaf.count);
    for (let i = 0; i < leaf.count; i++) {
      let best = tol, at = -1;
      for (let k = 0; k < shapes.length; k++) {
        const d = shapeDistance(shapes[k], xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
        if (d <= best) { best = d; at = k; }
      }
      a[i] = at < 0 ? NaN : at;
      if (at >= 0) claimed++;
    }
    per.push(a);
  }
  viewer.cells.setScalarField(per);
  sfName = `Shape (${shapes.length})`;
  dirtyMark.field = sfName;
  document.body.classList.add('has-sf');
  ($('k-color-sf') as HTMLOptionElement).disabled = false;
  setColorMode(5);
  autoScalarRange(); refreshScalarUI();
  return claimed;
}
function renderShapeList() {
  const ul = $('det-list'); ul.innerHTML = '';
  document.body.classList.toggle('has-shapes', shapes.length > 0);
  shapes.forEach((sh, i) => {
    const li = document.createElement('li');
    const what = sh.shape === 'plane' ? `normal ${sh.normal.map((v: number) => v.toFixed(2)).join(', ')}`
      : sh.shape === 'sphere' ? `r ${sh.radius.toFixed(3)} m`
      : `r ${sh.radius.toFixed(3)} m, axis ${sh.axis.map((v: number) => v.toFixed(2)).join(', ')}`;
    li.innerHTML = `<span class="ok">${i}: ${sh.shape}</span> <span class="mono">${what} · ${fmt(sh.points)} pts · RMS ${(sh.rms * 1000).toFixed(1)} mm</span>`;
    li.querySelector('.ok')!.addEventListener('click', () => {
      // narrow the field's value filter to this one shape, which is what "highlight" means
      // when the highlight is a scalar field
      $<HTMLInputElement>('k-sffilter').checked = true;
      const lo = sfStats ? (i - 0.4 - sfStats.min) / Math.max(sfStats.max - sfStats.min, 1e-9) : 0;
      const hi = sfStats ? (i + 0.4 - sfStats.min) / Math.max(sfStats.max - sfStats.min, 1e-9) : 1;
      $<HTMLInputElement>('k-sflo').value = String(Math.round(Math.max(0, lo) * 1000));
      $<HTMLInputElement>('k-sfhi').value = String(Math.round(Math.min(1, hi) * 1000));
      refreshScalarUI();
      viewer.setPrimitive({ ...sh, size: Math.max(...viewer.bounds().getSize(new THREE.Vector3()).toArray()) * 0.5, length: sh.length ?? Math.max(...viewer.bounds().getSize(new THREE.Vector3()).toArray()) * 0.5 });
    });
    ul.appendChild(li);
  });
}
async function detectShapes(opts: { tol?: number; minPts?: number; kinds?: string } = {}) {
  if (!viewer.loaded) return null;
  const tol = opts.tol ?? fitUi.tol, minPts = Math.round(opts.minPts ?? fitUi.minPts);
  const kinds = opts.kinds ?? $<HTMLSelectElement>('k-detkinds').value;
  busy('Reading the points…'); await tick();
  const t0 = performance.now();
  try {
    const pts = fitPoints(500_000);
    if (pts.count < minPts) { $('v-fit').textContent = `only ${fmt(pts.count)} points — fewer than the ${fmt(minPts)} a shape needs`; return null; }
    busy(`Looking for shapes in ${fmt(pts.count)} points…`); await tick();
    anaError = null; anaAlive = true;
    const xyz = pts.xyz.buffer as ArrayBuffer, nrm = pts.nrm.buffer as ArrayBuffer;
    // the minimum support scales with the sample, or a stride would silently rule everything out
    const sampled = Math.max(20, Math.round(minPts * pts.count / Math.max(viewer.loaded, 1)));
    anaWorker.postMessage({ type: 'detect', xyz, nrm, tol, minPts: sampled, maxShapes: 12, kinds, trials: 400 }, [xyz, nrm]);
    const res = await anaOnce('detect');
    shapes = JSON.parse(res.json).shapes ?? [];
    renderShapeList();
    if (!shapes.length) { $('v-fit').textContent = `no shape had ${fmt(minPts)} points within ${tol} m`; return []; }
    busy('Labelling the points…'); await tick();
    const claimed = applyShapeField(tol);
    $('v-fit').textContent = `${shapes.length} shape${shapes.length > 1 ? 's' : ''} · ${fmt(claimed)} of ${fmt(viewer.loaded)} points claimed · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    viewer.touch();
    return shapes;
  } catch (e: any) { $('v-fit').textContent = 'detection failed: ' + (e?.message ?? e); return null; }
  finally { hideBusy(); }
}
$('k-detect').addEventListener('click', () => { detectShapes(); });
/** Keep or remove the points a shape claimed, through the same mask machinery as everything
 *  else, so it undoes like any other edit. */
async function applyShapeMask(keep: boolean) {
  if (!shapes.length || !viewer.cells.hasScalarField) return null;
  const masks: Uint8Array[] = [];
  for (const l of viewer.cells.leavesForMask()) {
    const m = new Uint8Array(l.count);
    for (let i = 0; i < l.count; i++) {
      const inlier = !!l.sf && Number.isFinite(l.sf[i]);
      m[i] = (inlier === keep) ? 1 : 0;
    }
    masks.push(m);
  }
  return commitMask(keep ? 'Keep only the detected shapes' : 'Remove the detected shapes', masks,
    `<p>${keep ? 'Everything not claimed by one of the detected shapes' : 'Every point claimed by a detected shape'} will be dropped: <b>{n}</b> of them, leaving {k}.</p>`);
}
$('k-detkeep').addEventListener('click', () => applyShapeMask(true));
$('k-detremove').addEventListener('click', () => applyShapeMask(false));

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
    const ans = await modal('Build a mesh from the points?',
      `<p>Reconstructs a triangle mesh from <b>${fmt(used)}</b> of ${fmt(viewer.loaded)} points at a <b>${(voxel * 100).toFixed(1)} cm</b> voxel.</p>` +
      `<p>The points stay exactly as they are. The mesh is a separate object you can show, hide, measure or export. Expect a few seconds to a minute.</p>` +
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
    document.body.classList.toggle('has-mesh', viewer.anyMesh);
    meshNote('');                                     // the build result is the line above
    refreshMeshUI();
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
      : 'no mesh found, so try a coarser Detail or more Fill gaps';
    return st;
  } catch (e: any) {
    $('v-mesh').textContent = 'failed: ' + (e?.message ?? e);
    throw e;
  } finally { hideBusy(); }
}
$('k-mbuild').addEventListener('click', () => buildMesh().catch(e => { $('v-mesh').textContent = 'failed: ' + (e?.message ?? e); }));
$('k-mclear').addEventListener('click', () => {
  meshData = null; meshInfo = null; meshFile = ''; viewer.setMesh(null);
  document.body.classList.toggle('has-mesh', viewer.anyMesh);
  dirtyMark.surface = 0; refreshMeshUI(); renderLayers();
  sfName = ''; dirtyMark.field = ''; sfStats = null; document.body.classList.remove('has-sf', 'sf-filtering');
  ($('k-color-sf') as HTMLOptionElement).disabled = true;
  setDisplay('points'); $('v-mesh').textContent = '—'; meshNote('');
});


// ------------------------------------------------------------------ meshes as layers
//
// A mesh is a layer like a cloud is. That is the whole of Part 12: the renderer already drew
// a surface, but only the active layer's and only one built from the active layer's points.
// Importing PLY, OBJ and STL means a layer can now be triangles with no points at all, which
// is why `Entity` owns a `MeshView` and the draw loop walks every visible one.
let meshFile = '';
const meshSettings = { iterations: 5, taubin: true, cellCm: 10, sampleMode: 'count' as 'count' | 'density', sampleVal: 200000 };

/** Write the mesh line, and show it. Only `refreshMeshUI` hides it, and only when it has
 *  nothing to say, so every other writer goes through here or its text never appears. */
function meshNote(text: string, kind: '' | 'ok' | 'err' = '') {
  const el = $('v-meshinfo');
  el.textContent = text;
  el.className = 'statusline' + (kind ? ' ' + kind : '') + (text.trim() ? '' : ' hidden');
}
/** Every layer that has triangles. */
function meshEntities(): Entity[] { return viewer.entities.filter(e => e.mesh.hasMesh); }
/** The world matrix the active layer's triangles are drawn through. */
function meshModel(): THREE.Matrix4 { return viewer.mesh.model.clone(); }

function refreshMeshUI() {
  const sel = $<HTMLSelectElement>('k-meshref');
  const list = meshEntities();
  const want = list.map(e => e.id).join('|');
  if (sel.dataset.ids !== want) {
    sel.innerHTML = '';
    for (const e of list) { const o = document.createElement('option'); o.value = e.id; o.textContent = layerName(e); sel.appendChild(o); }
    sel.dataset.ids = want;
  }
  ($('k-meshdist') as HTMLButtonElement).disabled = !list.length || !viewer.loaded;
  const have = !!meshData?.idx.length;
  for (const id of ['k-meshmeasure', 'k-meshflip', 'k-meshsmooth', 'k-meshdecim', 'k-meshsample', 'k-meshsave'])
    ($(id) as HTMLButtonElement).disabled = !have;
  // This line reports the last thing done to a mesh, and where an imported one came from. It
  // does not repeat the triangle count: that is the build line under Build from points, and
  // the same numbers twice a few centimetres apart is not two pieces of information.
  const info = $('v-meshinfo');
  if (!have && !list.length) meshNote('no mesh yet');
  else if (have && !(info.textContent ?? '').trim()) meshNote(meshFile ? `from ${meshFile}` : '');
}
function syncMeshOpLabels() {
  $('v-meshiter').textContent = String(meshSettings.iterations);
  $('v-meshcell').textContent = `${meshSettings.cellCm.toFixed(1)} cm`;
}
$('k-meshiter').addEventListener('input', e => { meshSettings.iterations = Number((e.target as HTMLInputElement).value); syncMeshOpLabels(); });
$('k-meshcell').addEventListener('input', e => { meshSettings.cellCm = Number((e.target as HTMLInputElement).value); syncMeshOpLabels(); });
$('k-meshtaubin').addEventListener('change', e => { meshSettings.taubin = (e.target as HTMLInputElement).checked; });
$('k-meshsmode').addEventListener('change', e => {
  meshSettings.sampleMode = (e.target as HTMLSelectElement).value as 'count' | 'density';
  const v = $<HTMLInputElement>('k-meshsval');
  v.value = String(meshSettings.sampleVal = meshSettings.sampleMode === 'count' ? 200000 : 2000);
});
$('k-meshsval').addEventListener('change', e => { meshSettings.sampleVal = Math.max(1, Number((e.target as HTMLInputElement).value) || 1); });
syncMeshOpLabels();

/** Does this file hold triangles? A PLY can be either, and the header says which. */
function looksLikeMesh(name: string, head: Uint8Array): 'ply' | 'obj' | 'stl' | null {
  const k = sniffMesh(name, head);
  if (k !== 'ply') return k;
  const text = new TextDecoder('latin1').decode(head);
  const m = /element\s+face\s+(\d+)/.exec(text);
  return m && Number(m[1]) > 0 ? 'ply' : null;
}

/** Open a PLY, OBJ or STL as a layer of triangles.
 *
 *  The mesh comes back in a local frame with its shift reported separately, the same contract
 *  the cloud importers use, and lands through the layer's model matrix rather than being
 *  baked — so a mesh and a scan of the same building can be nudged onto each other with the
 *  transform tools exactly like two scans. */
async function importMesh(f: File): Promise<Entity | null> {
  busy(`Reading ${f.name}…`); await tick();
  try {
    const buf = await f.arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(65536, buf.byteLength));
    const kind = sniffMesh(f.name, head);
    if (!kind) throw new Error(`${f.name} is not a mesh e57view reads. It takes PLY, OBJ and STL.`);
    const raw = parseMesh(kind, buf);
    const nv = raw.pos.length / 3;
    const data: MeshData = {
      pos: raw.pos,
      nrm: raw.nrm.length === nv * 3 ? raw.nrm : new Float32Array(nv * 3),
      col: raw.col.length === nv * 3 ? raw.col : new Uint8Array(nv * 3).fill(200),
      idx: raw.idx,
    };
    let withNormal = 0;
    for (let i = 0; i < nv; i++) if (Math.abs(data.nrm[i * 3]) + Math.abs(data.nrm[i * 3 + 1]) + Math.abs(data.nrm[i * 3 + 2]) > 1e-6) withNormal++;
    const hadNormals = withNormal > nv * 0.5;
    if (!hadNormals) data.nrm = recomputeNormals(data);

    captureActive();
    // an empty viewer has one placeholder layer; fill that rather than leaving it behind
    const reuse = viewer.entities.length === 1 && !viewer.entities[0].hasContent;
    const name = f.name.replace(/\.[^.]+$/, '');
    const e = reuse ? viewer.active : viewer.addEntity(name);
    e.name = name;
    viewer.activeId = e.id;
    restoreActive();

    if (!frameOrigin) frameOrigin = [...raw.origin];
    const d = raw.origin.map((v, i) => v - frameOrigin![i]);
    meshData = data; meshFile = f.name;
    currentFile = f; currentHandle = null; cacheKey = ''; fromCache = false; cropped = false;
    histogram = new Uint32Array(256); axisCube = null;
    meta = {
      scans: [{ name: f.name, points: 0, translation: frameOrigin.slice(), cartesian: true,
                hasColor: raw.col.length === nv * 3, hasIntensity: false, hasNormals: hadNormals, bounds: null }],
      stations: [],
    };
    viewer.setMesh(data, new THREE.Matrix4());
    viewer.setModel(new THREE.Matrix4().makeTranslation(d[0], d[1], d[2]));
    const st = measureMesh(data, e.mesh.model);
    meshInfo = { triangles: st.triangles, vertices: st.vertices, boundaryEdges: st.boundaryEdges, voxelCm: 0, fromNormals: hadNormals };
    dirtyMark.surface = 0;              // it came from a file, so nothing is unsaved yet
    captureActive();
    document.body.classList.add('has-mesh');
    viewer.setDisplay(viewer.loadedAll > 0 ? 'both' : 'mesh');
    revealViewport();
    afterEntitySwitch();
    viewer.applyZRange(); syncZLabels(); viewer.fit();
    const note = raw.badIndices ? ` · ${fmt(raw.badIndices)} faces dropped for indices past the end` : '';
    meshNote(`${f.name} · ${fmt(st.triangles)} triangles · ${fmt(st.vertices)} vertices`
      + ` · ${hadNormals ? 'normals from the file' : 'normals computed'}${d.some(v => Math.abs(v) > 1e-9) ? ` · placed ${d.map(v => v.toFixed(2)).join(', ')} m from ${layerName(viewer.entities[0])}` : ''}${note}`);
    $('tb-points').textContent = `${fmt(st.triangles)} triangles · ${kind.toUpperCase()}`;
    return e;
  } finally { hideBusy(); }
}
$('k-meshopen').addEventListener('click', () => pickMeshFile());
async function pickMeshFile() {
  if (DESKTOP && shell) {
    const [p] = await shell.openDialog({ title: 'Import a mesh', extensions: [...MESH_EXT] });
    if (p) await openPath(p, true);
    return;
  }
  const anyWin = window as any;
  const accept = MESH_EXT.map(x => '.' + x);
  if (anyWin.showOpenFilePicker) {
    try {
      const [h] = await anyWin.showOpenFilePicker({ types: [{ description: 'Mesh', accept: { 'application/octet-stream': accept } }] });
      await importMesh(await h.getFile()).catch((e: any) => fail('Could not read that mesh: ' + (e?.message ?? e)));
    } catch {}
    return;
  }
  const inp = document.createElement('input'); inp.type = 'file'; if (!isIOS) inp.accept = accept.join(',');
  inp.onchange = () => { const f = inp.files?.[0]; if (f) importMesh(f).catch((e: any) => fail('Could not read that mesh: ' + (e?.message ?? e))); };
  inp.click();
}

/** Swap the active layer's triangles for a new set, keeping the frame they are drawn in. */
function replaceMesh(next: MeshData) {
  const base = viewer.active.state.meshBase.clone();
  meshData = next;
  viewer.setMesh(next, base);
  const st = measureMesh(next, viewer.mesh.model);
  meshInfo = { triangles: st.triangles, vertices: st.vertices, boundaryEdges: st.boundaryEdges, voxelCm: meshInfo?.voxelCm ?? 0, fromNormals: meshInfo?.fromNormals ?? false };
  dirtyMark.surface = st.triangles;      // edited triangles are unsaved work
  captureActive();
  renderLayers();
  viewer.touch();
  return st;
}

/** Area, volume and how closed the mesh is, in the world it is drawn in. */
function measureActiveMesh(): MeshMeasure | null {
  if (!meshData?.idx.length) return null;
  const st = measureMesh(meshData, meshModel());
  const vol = st.closed
    ? `volume ${st.volume.toFixed(3)} m³`
    : `volume ${st.volume.toFixed(3)} m³ (open: ${fmt(st.boundaryEdges)} boundary edges, so this is only what the divergence sum gives)`;
  meshNote(`${fmt(st.triangles)} triangles · ${fmt(st.vertices)} vertices · area ${st.area.toFixed(3)} m² · ${vol}`
    + (st.nonManifoldEdges ? ` · ${fmt(st.nonManifoldEdges)} non-manifold edges` : '')
    + (st.degenerate ? ` · ${fmt(st.degenerate)} zero-area triangles` : ''));
  return st;
}
$('k-meshmeasure').addEventListener('click', () => measureActiveMesh());
$('k-meshflip').addEventListener('click', () => {
  if (!meshData?.idx.length) return;
  const st = replaceMesh(flipMesh(meshData));
  meshNote(`flipped ${fmt(st.triangles)} triangles · the other side is now the front`);
});
$('k-meshsmooth').addEventListener('click', () => smoothActiveMesh());
function smoothActiveMesh(opts: { iterations?: number; taubin?: boolean } = {}) {
  if (!meshData?.idx.length) return null;
  const it = Math.max(1, Math.round(opts.iterations ?? meshSettings.iterations));
  const taubin = opts.taubin ?? meshSettings.taubin;
  const before = measureMesh(meshData, meshModel());
  const t0 = performance.now();
  const st = replaceMesh(smoothMesh(meshData, it, 0.5, taubin ? -0.53 : 0));
  const dv = before.volume > 1e-9 ? ((st.volume - before.volume) / before.volume) * 100 : 0;
  meshNote(`${taubin ? 'Taubin' : 'Laplacian'} × ${it} · area ${before.area.toFixed(3)} → ${st.area.toFixed(3)} m²`
    + ` · volume ${dv >= 0 ? '+' : ''}${dv.toFixed(2)}% · ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return { ...st, volumeChangePct: dv, iterations: it, taubin };
}
$('k-meshdecim').addEventListener('click', () => decimateActiveMesh());
function decimateActiveMesh(opts: { cellCm?: number } = {}) {
  if (!meshData?.idx.length) return null;
  const cm = Math.max(0.1, opts.cellCm ?? meshSettings.cellCm);
  const before = measureMesh(meshData, meshModel());
  const t0 = performance.now();
  // the cell is given in world centimetres; the vertices live in the layer's local frame
  const scale = viewer.cells.modelScale || 1;
  const st = replaceMesh(decimateMesh(meshData, (cm / 100) / scale));
  meshNote(`vertex clustering at ${cm.toFixed(1)} cm · ${fmt(before.triangles)} → ${fmt(st.triangles)} triangles`
    + ` (${((st.triangles / Math.max(before.triangles, 1)) * 100).toFixed(1)}%) · area ${before.area.toFixed(3)} → ${st.area.toFixed(3)} m²`
    + ` · ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return { ...st, before: before.triangles, cellCm: cm };
}

/** Turn arbitrary world-space points into octree leaves on a renderer.
 *
 *  Points are binned onto a coarse grid first. Handing the renderer one leaf holding points
 *  from everywhere would still draw correctly, but every leaf's box would cover the whole
 *  model, so the level-of-detail pass could never reject one — and the 16-bit quantisation
 *  inside a leaf would be spread over the whole extent instead of a few metres. */
function enqueueWorldPoints(cells: typeof viewer.cells, xyz: Float64Array, rgb: Uint8Array, nrm: Float32Array | null, intensity = 180) {
  const n = xyz.length / 3;
  if (!n) return 0;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const v = xyz[i * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
  const span = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-3);
  const side = Math.max(1, Math.ceil(Math.cbrt(n / 40000)));
  const cell = span / side;
  const bins = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const gx = Math.min(side - 1, Math.floor((xyz[i * 3] - mn[0]) / cell));
    const gy = Math.min(side - 1, Math.floor((xyz[i * 3 + 1] - mn[1]) / cell));
    const gz = Math.min(side - 1, Math.floor((xyz[i * 3 + 2] - mn[2]) / cell));
    const k = (gx * side + gy) * side + gz;
    let b = bins.get(k); if (!b) { b = []; bins.set(k, b); }
    b.push(i);
  }
  let made = 0;
  for (const list of bins.values()) {
    for (let at = 0; at < list.length; at += 400_000) {
      const part = list.slice(at, at + 400_000);
      const c = part.length;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const i of part) for (let a = 0; a < 3; a++) { const v = xyz[i * 3 + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
      const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-3) * 1.0001;
      const out = new Uint8Array(c * REC);
      const o16 = new Uint16Array(out.buffer);
      const q = 65535 / size;
      for (let j = 0; j < c; j++) {
        const i = part[j], b = j * 7, o = j * REC;
        for (let a = 0; a < 3; a++) o16[b + a] = Math.max(0, Math.min(65535, Math.round((xyz[i * 3 + a] - lo[a]) * q)));
        out[o + 6] = rgb[i * 3]; out[o + 7] = rgb[i * 3 + 1]; out[o + 8] = rgb[i * 3 + 2];
        out[o + 9] = intensity;
        if (nrm) {
          out[o + 10] = Math.max(-127, Math.min(127, Math.round(nrm[i * 3] * 127))) & 0xff;
          out[o + 11] = Math.max(-127, Math.min(127, Math.round(nrm[i * 3 + 1] * 127))) & 0xff;
          out[o + 12] = Math.max(-127, Math.min(127, Math.round(nrm[i * 3 + 2] * 127))) & 0xff;
        } else out[o + 12] = 127;         // the "no normal" placeholder
      }
      cells.enqueue([out.buffer as ArrayBuffer], c, {
        origin: lo as [number, number, number], size,
        bmin: lo as [number, number, number], bmax: hi as [number, number, number],
      });
      made++;
    }
  }
  cells.flushUploads(Infinity);
  return made;
}

$('k-meshsample').addEventListener('click', () => sampleMeshPoints().catch(e => { meshNote('sampling failed: ' + (e?.message ?? e)); }));
/** Scatter points over the active layer's triangles into a new point layer. */
async function sampleMeshPoints(opts: { count?: number; density?: number } = {}) {
  if (!meshData?.idx.length) throw new Error('the active layer has no mesh');
  const model = meshModel();
  const st = measureMesh(meshData, model);
  let count = opts.count ?? 0;
  const density = opts.density ?? (meshSettings.sampleMode === 'density' ? meshSettings.sampleVal : 0);
  if (!count) count = density > 0 ? Math.round(density * st.area) : meshSettings.sampleVal;
  count = Math.max(1, Math.min(40e6, Math.round(count)));
  busy(`Sampling ${fmt(count)} points…`); await tick();
  try {
    const s = samplePoints(meshData, model, count);
    captureActive();
    const src = viewer.active;
    const e = viewer.addEntity(`${layerName(src)} points`);
    enqueueWorldPoints(e.cells, s.xyz, s.rgb, s.nrm);
    e.state = { ...blankState(), meta: src.state.meta, cropped: true };
    e.robust = null;
    e.tint = { on: false, color: '#8fd48f' };
    viewer.activeId = e.id;
    restoreActive();
    viewer.retightenBounds();
    afterEntitySwitch();
    viewer.applyZRange(); syncZLabels();
    const dens = s.count / Math.max(s.area, 1e-9);
    meshNote(`sampled ${fmt(s.count)} points over ${s.area.toFixed(3)} m² · ${dens.toFixed(1)} points per m²`
      + ` · mean spacing ${(Math.sqrt(1 / dens) * 100).toFixed(1)} cm`);
    $('tb-points').textContent = `${fmt(s.count)} pts · sampled from a mesh`;
    return { points: s.count, area: r6(s.area), density: r6(dens), layer: e.id, name: e.name };
  } finally { hideBusy(); }
}

$('k-meshdist').addEventListener('click', () => distanceToMesh().catch(e => { meshNote('distance failed: ' + (e?.message ?? e)); }));
/** Distance from every point of the active cloud to the nearest triangle of a mesh layer.
 *
 *  Point-to-triangle, not point-to-nearest-vertex: on a coarse mesh those differ by most of a
 *  triangle, and it is the triangle that represents the surface. The result is a scalar field
 *  on the cloud, so the ramp, the histogram and the filter all work on it like any other. */
async function distanceToMesh(opts: { mesh?: string; signed?: boolean } = {}) {
  if (!viewer.loaded) throw new Error('the active layer has no points to measure');
  const id = opts.mesh ?? $<HTMLSelectElement>('k-meshref').value;
  const target = viewer.entities.find(e => e.id === id && e.mesh.hasMesh)
    ?? meshEntities().find(e => e.id !== viewer.activeId) ?? meshEntities()[0];
  if (!target) throw new Error('no layer has a mesh');
  const md = target.state.meshData;
  if (!md?.idx.length) throw new Error(`${layerName(target)} has no triangles in memory`);
  const signed = opts.signed ?? $<HTMLInputElement>('k-meshsigned').checked;
  // the mesh goes to the worker in world coordinates, where the cloud's points already are
  const M = target.mesh.model;
  const pos = new Float32Array(md.pos.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < md.pos.length; i += 3) {
    v.set(md.pos[i], md.pos[i + 1], md.pos[i + 2]).applyMatrix4(M);
    pos[i] = v.x; pos[i + 1] = v.y; pos[i + 2] = v.z;
  }
  try {
    const r = await runAnalysis('distance_to_mesh', { meshPos: pos, meshIdx: md.idx, signed });
    hideBusy();
    setScalarField(`Distance to ${layerName(target)}`, r.data as Float32Array, r.counts);
    const s = viewer.cells.scalarStats();
    meshNote(`distance to ${layerName(target)}${signed ? ' (signed)' : ''} · `
      + (s ? `${(s.min * 1000).toFixed(1)} to ${(s.max * 1000).toFixed(1)} mm over ${fmt(s.n)} values` : 'no values')
      + ` · ${fmt(r.points)} points`);
    return { points: r.points, mesh: target.id, meshName: target.name, signed, stats: s ? { min: r6(s.min), max: r6(s.max), values: s.n } : null };
  } finally { hideBusy(); }
}

/** Write the active layer's mesh out. The transform is baked here, as it is for a cloud: a
 *  file is the one place "do not bake" has to end. */
function meshBlob(fmtSel: 'ply' | 'obj' | 'stl'): Blob {
  const t = (meta?.scans?.[0]?.translation ?? [0, 0, 0]) as [number, number, number];
  if (fmtSel === 'ply') return viewer.mesh.toPly(meshData!, t);
  if (fmtSel === 'obj') return viewer.mesh.toObj(meshData!, t);
  const M = viewer.mesh.model;
  const v = new THREE.Vector3();
  return new Blob([meshToStl(meshData!.pos, meshData!.idx, (x, y, z, out) => {
    v.set(x, y, z).applyMatrix4(M);
    out[0] = v.x + t[0]; out[1] = v.y + t[1]; out[2] = v.z + t[2];
  })], { type: 'application/octet-stream' });
}
$('k-meshsave').addEventListener('click', () => saveMesh().catch(e => { meshNote('save failed: ' + (e?.message ?? e)); }));
async function saveMesh(fmtIn?: 'ply' | 'obj' | 'stl') {
  if (!meshData?.idx.length) throw new Error('the active layer has no mesh');
  const fmtSel = fmtIn ?? ($<HTMLSelectElement>('k-meshfmt').value as 'ply' | 'obj' | 'stl');
  // an imported mesh keeps its own name; a reconstructed one is named after the scan it came
  // from, with -mesh, so the two do not collide in a downloads folder
  const base = meshFile
    ? meshFile.replace(/\.(ply|obj|stl)$/i, '')
    : (currentFile?.name ?? 'scan').replace(/\.(e57|ply|las|laz|ptx|txt|xyz|pts|asc|csv|neu)$/i, '') + '-mesh';
  const handle = await pickSaveHandle(`${base}.${fmtSel}`, fmtSel);
  if (handle === null) return null;
  busy('Writing the mesh…'); await tick();
  try {
    const blob = meshBlob(fmtSel);
    const file = new File([blob], `${base}.${fmtSel}`);
    await writeOutFile({ file, name: file.name, scratch: '' }, handle);
    dirtyMark.surface = 0; captureActive();
    meshNote(`saved ${file.name} · ${mb(blob.size)} · ${fmt(meshData.idx.length / 3)} triangles`);
    return { name: file.name, bytes: blob.size, triangles: meshData.idx.length / 3 };
  } finally { hideBusy(); }
}

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
  hideBusy(); fromCache = true; cacheNote = '';
  // so the cached scan can be reopened later: a path on the desktop, a handle in a browser
  if (currentHandle) idbPut(cacheKey, currentHandle);
  else if (DESKTOP && (currentFile as any)?.path) idbPut(cacheKey, { __path: (currentFile as any).path });
  $('v-cache').textContent = `cached · ${mb(done.bytes)} on this device`; updateCacheUI(); await refreshCachedList();
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
  const it = cachedItems.find(c => c.key === key);
  if (!it) { await refreshCachedList(); }
  const item = it ?? cachedItems.find(c => c.key === key);
  if (!item) throw new Error(`nothing cached under ${key}`);
  const handle = await idbGet(key);
  if (!handle) throw new Error('no stored handle for that scan');
  if (item.stride) $<HTMLSelectElement>('k-load').value = String(item.stride);
  // the desktop build stored a path: rebuild the file-shaped thing from it
  if (handle.__path) {
    if (!shell) throw new Error('that scan was cached by the desktop app');
    await openFile(await shell.nativeFile(handle.__path) as unknown as File, null);
    return;
  }
  const perm = await handle.requestPermission?.({ mode: 'read' }); if (perm && perm !== 'granted') throw new Error('permission denied');
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
    local: { min: arr6(b.min.toArray()), max: arr6(b.max.toArray()), size: arr6(b.getSize(new THREE.Vector3()).toArray()), centre: arr6(b.getCenter(new THREE.Vector3()).toArray()) },
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
      kind: e.isMesh ? 'mesh' as const : 'points' as const,
      surface: e.state.meshInfo ? { triangles: e.state.meshInfo.triangles, vertices: e.state.meshInfo.vertices, boundaryEdges: e.state.meshInfo.boundaryEdges, file: e.state.meshFile || null } : null,
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


// ------------------------------------------------------------------ scripts
//
// A script is a list of `{cmd, args}` steps run in order against this tab, with each step's
// result available to the next. It exists because the round trip is the expensive part: an
// agent measuring a building makes twenty calls that each wait on a relay, and nineteen of
// them are decided entirely by the previous answer. Sending the whole plan once turns that
// into one wait.
//
// The variables are deliberately small: `$last` is the previous step's result, `$layers` and
// `$active` are the layer list and the active id refreshed before every step, and a step with
// `save: "name"` binds its own result under that name. Dotted paths index into them, so
// `$last.bounds.min.2` is a number and `$layers.1.id` is a layer. That is enough to write the
// scripts people actually want and not enough to be a programming language, which is the
// right side of that line to be on.
const SCRIPT_MAX_STEPS = 80;

/** Follow a dotted path into a result. Array indices are plain numbers: `layers.0.id`. */
function scriptPath(root: any, path: string, whole: string) {
  let v = root;
  for (const part of path ? path.split('.') : []) {
    if (v === null || v === undefined) throw new Error(`${whole} does not exist: "${part}" has nothing before it`);
    v = Array.isArray(v) && /^\d+$/.test(part) ? v[Number(part)] : v[part];
  }
  if (v === undefined) throw new Error(`${whole} is not in the result`);
  return v;
}
/** Replace `$name.path` (whole value) and `${name.path}` (inside text) throughout an argument. */
function scriptSubst(v: any, vars: Record<string, any>): any {
  if (typeof v === 'string') {
    const whole = /^\$([A-Za-z_][\w]*)((?:\.[\w]+)*)$/.exec(v);
    const look = (name: string, rest: string, src: string) => {
      if (!(name in vars)) throw new Error(`no variable $${name}. Available: ${Object.keys(vars).map(k => '$' + k).join(', ')}`);
      return scriptPath(vars[name], rest.replace(/^\./, ''), src);
    };
    if (whole) return look(whole[1], whole[2], v);
    return v.replace(/\$\{([A-Za-z_][\w]*)((?:\.[\w]+)*)\}/g, (_m, n, r) => {
      const got = look(n, r, `\${${n}${r}}`);
      return typeof got === 'object' ? JSON.stringify(got) : String(got);
    });
  }
  if (Array.isArray(v)) return v.map(x => scriptSubst(x, vars));
  if (v && typeof v === 'object') {
    const out: any = {};
    for (const [k, x] of Object.entries(v)) out[k] = scriptSubst(x, vars);
    return out;
  }
  return v;
}
/** A step's own picture would be megabytes of base64 in a reply that is meant to be numbers. */
function scriptTrim(r: any): any {
  if (!r || typeof r !== 'object') return r;
  const out: any = { ...r };
  if (typeof out.png === 'string') out.png = `<${out.png.length} characters of PNG, omitted: ask for the picture with its own view or screenshot call>`;
  if (out.image && typeof out.image.data === 'string') out.image = { ...out.image, data: `<${out.image.data.length} characters, omitted>` };
  return out;
}

/** Run a list of steps in order. Returns one record per step, in order, whatever happened. */
async function runScript(a: any): Promise<any> {
  const raw = a?.steps ?? a?.script ?? a;
  const steps: any[] = Array.isArray(raw) ? raw : [];
  if (!steps.length) throw new Error('script needs steps: an array of { cmd, args } objects');
  if (steps.length > SCRIPT_MAX_STEPS) throw new Error(`${steps.length} steps is over the ${SCRIPT_MAX_STEPS} a script may hold`);
  const stopOnError = a?.stopOnError !== false;
  const vars: Record<string, any> = { ...(a?.vars ?? {}) };
  const out: any[] = [];
  let failed = 0;
  const t0 = performance.now();
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] ?? {};
    const cmd = String(st.cmd ?? '');
    const label = st.label ? String(st.label) : undefined;
    const rec: any = { i, cmd, ...(label ? { label } : {}) };
    const s0 = performance.now();
    try {
      if (!cmd) throw new Error('a step needs a cmd');
      if (cmd === 'script') throw new Error('a script cannot run a script');
      // refreshed every step, because a step can add, remove or activate a layer
      vars.layers = entityList(); vars.active = viewer.activeId;
      const args = scriptSubst(st.args ?? {}, vars);
      agentSource = 'script';
      const r = slim(await agent.run(cmd, args));
      vars.last = r;
      if (st.save) vars[String(st.save)] = r;
      rec.ok = true;
      rec.result = scriptTrim(r);
    } catch (e: any) {
      rec.ok = false;
      rec.error = String(e?.message ?? e);
      failed++;
    }
    rec.ms = Math.round(performance.now() - s0);
    out.push(rec);
    if (!rec.ok && stopOnError) { rec.stopped = true; break; }
  }
  viewer.render();
  const ran = out.length;
  $('v-script').textContent = `${ran} of ${steps.length} step${steps.length === 1 ? '' : 's'} · ${failed ? `${failed} failed` : 'all ok'} · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  return {
    ok: failed === 0, ran, of: steps.length, failed, stopOnError,
    ms: Math.round(performance.now() - t0),
    steps: out,
    variables: Object.keys(vars).map(k => '$' + k),
    note: failed && stopOnError ? 'stopped at the first failure; pass stopOnError:false to run the rest anyway' : undefined,
  };
}

const SCRIPT_EXAMPLE = `[
  { "cmd": "set_view", "args": { "preset": "fit" } },
  { "cmd": "state", "args": {}, "save": "s" },
  { "cmd": "fitplane", "args": { "box": { "center": "$s.bounds.local.centre", "half": [20, 20, 0.08] } } }
]`;
$('k-script').addEventListener('click', async () => {
  const prev = localStorage.getItem('script') ?? SCRIPT_EXAMPLE;
  const ans = await modal('Run a script',
    `<p>A JSON array of <b>{ "cmd", "args" }</b> steps, run in order against this tab. A step may carry <b>"save": "name"</b>; later steps read <b>$last</b>, <b>$layers</b>, <b>$active</b> and any saved name, with dotted paths — <span class="mono">$last.area</span>, <span class="mono">$layers.0.id</span>.</p>`
    + `<textarea id="sc-text" rows="12" spellcheck="false" style="width:100%;font:12px ui-monospace,monospace">${prev.replace(/</g, '&lt;')}</textarea>`
    + `<label class="row"><span>Stop at the first error</span><input type="checkbox" id="sc-stop" checked></label>`,
    [{ label: 'Cancel', value: 'no' }, { label: 'Run', value: 'yes', cls: 'primary' }]);
  const text = ($('sc-text') as HTMLTextAreaElement | null)?.value ?? '';
  const stop = ($('sc-stop') as HTMLInputElement | null)?.checked ?? true;
  if (ans !== 'yes') return;
  localStorage.setItem('script', text);
  let steps: any;
  try { steps = JSON.parse(text); } catch (e: any) { $('v-script').textContent = 'that is not valid JSON: ' + (e?.message ?? e); return; }
  busy('Running the script…'); await tick();
  let r: any;
  try { r = await runScript({ steps, stopOnError: stop }); }
  catch (e: any) { hideBusy(); $('v-script').textContent = 'script failed: ' + (e?.message ?? e); return; }
  finally { hideBusy(); }
  const rows = r.steps.map((s: any) => `<tr><td class="mono">${s.i}</td><td class="mono">${s.cmd}</td><td>${s.ok ? 'ok' : `<b>${String(s.error).replace(/</g, '&lt;')}</b>`}</td><td class="mono">${s.ms} ms</td></tr>`).join('');
  await modal(r.ok ? 'Script finished' : 'Script stopped',
    `<p>${r.ran} of ${r.of} steps · ${r.failed ? `${r.failed} failed` : 'all ok'} · ${(r.ms / 1000).toFixed(1)}s</p>`
    + `<div class="cols"><table>${rows}</table></div>`
    + `<p class="hint">The full result of every step is in the console as <span class="mono">__lastScript</span>.</p>`,
    [{ label: 'Close', value: 'ok', cls: 'primary' }]);
  (window as any).__lastScript = r;
});

// ------------------------------------------------------------------ agent link
/** How many commands an agent has run in this tab, and when the last one was. Counting here
 *  rather than in one transport catches both: the WebSocket path calls a handler directly and
 *  the HTTP relay goes through `dispatchAgent`, and both end up in this object. */
const agentCalls = { n: 0, last: 0 };
function counted<T extends Record<string, any>>(handlers: T): T {
  const out: any = {};
  for (const [k, fn] of Object.entries(handlers)) {
    out[k] = async (a: any) => {
      agentCalls.n++; agentCalls.last = Date.now();
      const entry = logStart(k, a);
      refreshAgentState();
      try {
        const r = await (fn as any)(a);
        logEnd(entry, r, null);
        return r;
      } catch (e) {
        logEnd(entry, null, e);
        throw e;
      } finally {
        // back to the default, so the next call has to say where it came from rather than
        // inheriting the last one's answer
        agentSource = 'agent';
        refreshAgentState();
      }
    };
  }
  return out;
}
const agent = new AgentLink(counted({
  state: () => stateRecord(),
  /** What has been run against this tab. Read-only, and it never leaves the tab otherwise. */
  log: (a) => logRecord(a),
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
    // a path is the desktop build's own door: there is a real file system there, and asking
    // an agent to go through the cache for a file it can name would be theatre
    if (a.path) {
      if (!DESKTOP || !shell) throw new Error('path only works in the desktop app; in a browser tab open the file there, or give cached: <key>');
      await openPath(String(a.path), !!a.add);
    }
    else if (a.cached) await openCached(a.cached);
    else throw new Error(DESKTOP ? 'give path: <file> or cached: <key>' : 'give cached: <key>');
    // Wait for the upload queue as well as the decode. Leaves reach the GPU a frame at a
    // time, so `loaded` lags the loader by a second or two — long enough for an agent's next
    // command to measure a cloud that is still arriving.
    await new Promise<void>(res => { const iv = setInterval(() => { if (/(loaded|from cache|streamed) in/.test($('tb-points').textContent || '')) { clearInterval(iv); res(); } }, 200); });
    await new Promise<void>(res => afterUploads(res));
    return { points: viewer.loaded, cached: fromCache, file: currentFile?.name ?? null };
  },
  analysis: async (a) => {
    const op = String(a.op ?? '');
    if (!viewer.loaded) throw new Error('nothing loaded');
    const k = a.neighbours !== undefined ? Number(a.neighbours) : anaUi.k;
    const sigma = a.nSigma !== undefined ? Number(a.nSigma) : anaUi.sigma;
    /** An argument an agent did not give falls back to CloudCompare's default, not to
     *  whatever the panel happens to be showing. An agent cannot see the panel, and a filter
     *  that behaves differently depending on a control somebody left switched is not a filter
     *  anybody can reason about. */
    const ccDefault = (given: any, fallback: any): any => (given === undefined ? fallback : given);
    if (op === 'normals') {
      const r = await analysis('normals', { k, orient: a.orient !== false, viewpoints: viewpointList() }, 'Normals');
      viewer.render();
      return { points: r?.points ?? viewer.loaded, hasNormals: normalFraction() };
    }
    if (op === 'invert') { await analysis('invert', {}, 'normals inverted'); viewer.render(); return { hasNormals: normalFraction() }; }
    if (op === 'feature') {
      const name = String(a.feature ?? 'roughness');
      const r = await analysis('feature', { name, k, radius: a.radius !== undefined ? Number(a.radius) : anaUi.spacing }, name);
      viewer.render();
      const st = viewer.cells.scalarStats();
      return { field: sfName, points: r?.points ?? viewer.loaded, range: st ? [r6(st.min), r6(st.max)] : null };
    }
    if (op === 'components') {
      const r = await analysis('components', { radius: a.radius !== undefined ? Number(a.radius) : anaUi.spacing, minPts: Number(a.minPoints ?? 16) }, 'Connected components');
      viewer.render();
      return { field: sfName, components: r?.components ?? null, points: r?.points ?? viewer.loaded };
    }
    // the four that remove points, all through the same undoable mask
    const before = viewer.loaded;
    let args: Record<string, any>;
    let label: string;
    // CloudCompare's filter dialogs default to 8 neighbours; its panel slider here is 16
    // because the same slider drives the feature computations, where 8 is too few to be
    // steady. An agent asking for neither gets the filter's own default.
    const filterK = a.neighbours !== undefined ? Number(a.neighbours) : 8;
    if (op === 'sor') { args = { knn: filterK, sigma }; label = 'Remove outliers'; }
    else if (op === 'noise') {
      args = {
        knn: filterK, sigma,
        useKnn: ccDefault(a.neighbourhood, 'radius') === 'knn',
        // omitted, the worker sizes it from the cloud the way CloudCompare does
        ...(a.radius !== undefined ? { radius: Number(a.radius) } : {}),
        useAbsoluteError: ccDefault(a.threshold, 'relative') === 'absolute',
        absoluteError: Number(ccDefault(a.absoluteError, 0)),
        removeIsolated: !!ccDefault(a.removeIsolated, false),
      };
      label = 'Remove noise';
    }
    else if (op === 'duplicates') { args = { tol: Number(a.tolerance ?? 0.001) }; label = 'Remove duplicates'; }
    else if (op === 'subsample') { args = { spacing: Number(a.spacing ?? anaUi.spacing) }; label = 'Thin the cloud'; }
    else throw new Error(`unknown analysis op: ${op}. Use normals, invert, feature, components, sor, noise, duplicates or subsample.`);
    const r = await runAnalysis(op, args);
    hideBusy();
    // no modal for an agent: the gate is "Allow edits", and it undoes like any other edit
    await commitMask(label, perLeaf(r.data as Uint8Array, r.counts), '', false);
    viewer.render();
    return {
      op, removed: before - viewer.loaded, kept: viewer.loaded, of: before,
      // how many spatial tiles it took, so a slow run on a big cloud explains itself
      ...(r.tiles && r.tiles > 1 ? { tiles: r.tiles } : {}),
      ...(r.mean !== undefined ? { meanNeighbourDistance: r6(r.mean), cutOff: r6(r.cut) } : {}),
      ...(r.params ? { params: r.params } : {}),
      note: $('v-analysis').textContent,
    };
  },
  cache: async (a) => {
    const op = String(a.op ?? 'list');
    if (op === 'list') { await refreshCachedList(); return { cached: cachedItems.map(c => ({ key: c.key, name: c.name, points: c.points, bytes: c.bytes })) }; }
    if (op === 'write') {
      if (!viewer.loaded || !currentFile) throw new Error('nothing loaded to cache');
      const t0 = performance.now();
      await writeCache();
      return { key: cacheKey, points: viewer.loaded, ms: Math.round(performance.now() - t0), note: $('v-cache').textContent };
    }
    if (op === 'drop') {
      const key = String(a.key ?? cacheKey);
      io.postMessage({ type: 'cache-delete', key });
      await ioOnce('cache-deleted');
      await refreshCachedList();
      return { dropped: key, cached: cachedItems.map(c => c.key) };
    }
    throw new Error(`unknown cache op: ${op}. Use list, write or drop.`);
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
  volume: async (a) => {
    if (!viewer.loaded) throw new Error('nothing loaded');
    let reference: string | null = 'plane';
    if (a.reference !== undefined && a.reference !== null && a.reference !== 'plane') {
      const e = viewer.entities.find(x => x.id === String(a.reference) || x.name === String(a.reference));
      if (!e) throw new Error(`no such layer: ${a.reference}`);
      if (e.id === viewer.activeId) throw new Error('the reference cannot be the active layer');
      reference = e.id;
    }
    const r = measureVolume({ cell: a.cell !== undefined ? Number(a.cell) : undefined, reference, plane: a.plane !== undefined ? Number(a.plane) : undefined });
    if (!r) throw new Error('nothing fell in the raster');
    viewer.render();
    return { ...r, added: r6(r.added), removed: r6(r.removed), net: r6(r.net), area: r6(r.area), units: 'm³', note: $('v-volume').textContent };
  },
  mesh: async (a) => {
    const op = String(a.op ?? 'measure');
    if (op === 'list') {
      return {
        meshes: meshEntities().map(e => ({ id: e.id, name: e.name, triangles: e.mesh.triangles, vertices: e.mesh.vertices, visible: e.visible, active: e.id === viewer.activeId, file: e.state.meshFile || null })),
        active: viewer.activeId, activeHasMesh: !!meshData?.idx.length,
      };
    }
    if (op === 'import') throw new Error('a mesh file has to be chosen in the viewer (Mesh -> Import mesh…); a page cannot open a file an agent names');
    if (op === 'show') { setDisplay(a.mode === 'mesh' || a.mode === 'both' ? a.mode : 'points'); viewer.render(); return { display: viewer.display, triangles: viewer.mesh.triangles }; }
    if (!meshData?.idx.length) throw new Error('the active layer has no mesh — activate a mesh layer first, or build a surface');
    if (op === 'measure') {
      const st = measureActiveMesh()!;
      return {
        triangles: st.triangles, vertices: st.vertices,
        area: r6(st.area), volume: r6(st.volume), closed: st.closed,
        boundaryEdges: st.boundaryEdges, nonManifoldEdges: st.nonManifoldEdges, degenerate: st.degenerate,
        bounds: { min: arr6(st.bbox.min), max: arr6(st.bbox.max) },
        units: 'm', note: st.closed ? 'closed mesh: the volume is the enclosed volume'
          : 'open mesh: the volume is only the divergence sum, which is not an enclosed volume — close the holes or treat it as area only',
      };
    }
    if (op === 'flip') { const st = replaceMesh(flipMesh(meshData)); viewer.render(); return { triangles: st.triangles, flipped: true }; }
    if (op === 'smooth') {
      const r = smoothActiveMesh({ iterations: a.iterations !== undefined ? Number(a.iterations) : undefined, taubin: a.taubin !== undefined ? !!a.taubin : undefined })!;
      viewer.render();
      return { triangles: r.triangles, vertices: r.vertices, area: r6(r.area), volume: r6(r.volume), volumeChangePct: r6(r.volumeChangePct), iterations: r.iterations, taubin: r.taubin };
    }
    if (op === 'decimate') {
      const r = decimateActiveMesh({ cellCm: a.cellCm !== undefined ? Number(a.cellCm) : a.cell !== undefined ? Number(a.cell) * 100 : undefined })!;
      viewer.render();
      return { triangles: r.triangles, before: r.before, vertices: r.vertices, area: r6(r.area), cellCm: r.cellCm, method: 'vertex clustering' };
    }
    if (op === 'sample') {
      const r = await sampleMeshPoints({ count: a.count !== undefined ? Number(a.count) : undefined, density: a.density !== undefined ? Number(a.density) : undefined });
      viewer.render();
      return { ...r, entities: entityList(), active: viewer.activeId };
    }
    if (op === 'distance') {
      let id: string | undefined;
      if (a.mesh !== undefined && a.mesh !== null) {
        const e = viewer.entities.find(x => (x.id === String(a.mesh) || x.name === String(a.mesh)) && x.mesh.hasMesh);
        if (!e) throw new Error(`no mesh layer called ${a.mesh}. Have: ${meshEntities().map(x => `${x.id} (${x.name})`).join(', ') || 'none'}`);
        id = e.id;
      }
      const r = await distanceToMesh({ mesh: id, signed: a.signed !== undefined ? !!a.signed : undefined });
      viewer.render();
      return { ...r, field: sfName, note: 'point-to-triangle distance, written as a scalar field on the active layer' };
    }
    if (op === 'save') {
      const fmtSel = (String(a.format ?? 'ply').toLowerCase()) as 'ply' | 'obj' | 'stl';
      if (!['ply', 'obj', 'stl'].includes(fmtSel)) throw new Error('format must be ply, obj or stl');
      const blob = meshBlob(fmtSel);
      const base = (meshFile || currentFile?.name || 'mesh').replace(/\.(ply|obj|stl|e57|las|laz)$/i, '');
      const transferId = (Math.random() * 0xffffffff) >>> 0; const CH = 4 * 1024 * 1024; let seq = 0;
      for (let off = 0; off < blob.size; off += CH) { const buf = new Uint8Array(await blob.slice(off, off + CH).arrayBuffer()); agent.sendChunk(transferId, seq++, buf); await tick(); }
      return { transferId, name: `${base}.${fmtSel}`, bytes: blob.size, triangles: meshData.idx.length / 3 };
    }
    throw new Error(`unknown mesh op: ${op}. Use list, measure, flip, smooth, decimate, sample, distance, show or save.`);
  },
  fit: async (a) => {
    if (a.box) { const r = regionFrom(a.box, 'fit-region'); sections.push(r); syncRegions(); viewer.setActiveRegion(r.id); renderSectionList(); }
    const kind = String(a.shape ?? 'plane');
    if (!['plane', 'sphere', 'cylinder', 'circle'].includes(kind)) throw new Error("shape: 'plane' | 'sphere' | 'cylinder' | 'circle'");
    const r = await fitShape(kind as any);
    if (a.box) { const i = sections.findIndex(x => x.id === 'fit-region'); if (i >= 0) sections.splice(i, 1); syncRegions(); renderSectionList(); }
    viewer.render();
    if (!r) throw new Error($('v-fit').textContent || 'the fit failed');
    return { ...r, note: $('v-fit').textContent };
  },
  detect: async (a) => {
    const r = await detectShapes({ tol: a.tolerance !== undefined ? Number(a.tolerance) : undefined,
      minPts: a.minPoints !== undefined ? Number(a.minPoints) : undefined,
      kinds: Array.isArray(a.shapes) ? a.shapes.join(',') : a.shapes });
    viewer.render();
    if (!r) throw new Error($('v-fit').textContent || 'detection failed');
    return { shapes: r, field: sfName, note: $('v-fit').textContent };
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
  script: (a) => runScript(a),
  stations: async (a) => { if (a.enter === -1) viewer.exitBubble(); else if (a.enter !== undefined) await enterStation(a.enter); viewer.render(); return { stations: viewer.stationPositions(), bubble: viewer.bubble?.index ?? null }; },
}));
// In the desktop build the bridge is inside the app, so AgentLink's advice about starting a
// Node server is wrong there; `refreshBridge` owns that line instead.
// The connection state is the line above; this one is for one-off messages, so a transient
// "copied" is not immediately overwritten by a repeat of what the status line already says.
agent.onStatus = () => refreshAgentState();
agent.onSource = (s) => { agentSource = s; };
function agentNote(text: string) {
  const el = $('v-agent');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}
// The MCP server is a plain file the user runs; the page can only hand it over.
$('k-mcpget').addEventListener('click', () => {
  const a = document.createElement('a'); a.href = '/mcp.mjs'; a.download = 'e57view-mcp.mjs';
  document.body.appendChild(a); a.click(); a.remove();
  agentNote('downloaded e57view-mcp.mjs, now register it below');
});

/** The running binary's own path, from the shell. Empty until the bridge first answers, which
 *  is why `mcpTarget` has a per-platform fallback rather than a macOS path. */
let bridgeExe = '';

// ------------------------------------------------------------------ MCP client setup
//
// One MCP server, six ways of being told about it. Every client here speaks the same
// protocol to the same binary; what differs is a command line or the path of a JSON file, and
// getting that wrong is the whole of most people's first hour. So the panel asks which client
// and writes the exact thing to paste, for whichever build is running.
//
// The command being registered differs between the two builds, and that is the only place the
// difference shows: the desktop app registers *itself* (`e57view --mcp`, no Node anywhere),
// while the web build registers the one-file Node server it hands you.
type McpSnippet = { label: string; text: string };
type McpClient = { id: string; name: string; snippets: (t: McpTarget) => McpSnippet[] };
interface McpTarget { command: string; args: string[]; shell: string; download: string | null }

/** The path of the thing to register. On the desktop that is this binary — taken from the
 *  shell rather than assumed, because it is under /Applications on macOS, Program Files on
 *  Windows and /usr/bin on a Linux package. */
function mcpTarget(): McpTarget {
  if (DESKTOP) {
    const exe = bridgeExe || defaultExePath();
    return { command: exe, args: ['--mcp'], shell: `${q(exe)} --mcp`, download: null };
  }
  // The page cannot know where you will save the file, so the shell form uses $PWD and the
  // JSON and TOML forms carry a path to replace. Saying so beats a snippet that silently
  // points at nothing.
  const abs = '/absolute/path/to/e57view-mcp.mjs';
  return {
    command: 'node',
    args: [abs],
    shell: `node "$PWD/e57view-mcp.mjs"`,
    download: `curl -fsSL ${location.origin}/mcp.mjs -o e57view-mcp.mjs`,
  };
}
function defaultExePath(): string {
  const p = navigator.platform || '';
  const ua = navigator.userAgent || '';
  if (/Win/i.test(p) || /Windows/i.test(ua)) return 'C:\\Program Files\\e57view\\e57view.exe';
  if (/Linux/i.test(p) && !/Android/i.test(ua)) return '/usr/bin/e57view';
  return '/Applications/e57view.app/Contents/MacOS/e57view';
}
/** Quote a path for the shell the user is going to paste into, and only when it needs it.
 *
 *  The Windows case is not a detail: `cmd` and PowerShell do **not** treat a backslash inside
 *  a quoted string as an escape, so the POSIX habit of doubling them turns
 *  `C:\Program Files\e57view\e57view.exe` into a path that does not exist. A path with a
 *  backslash in it is therefore quoted verbatim, with only a literal quote doubled. */
const q = (s: string) => {
  if (!/[\s"'\\$`]/.test(s)) return s;
  if (s.includes('\\')) return `"${s.replace(/"/g, '""')}"`;
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
};
/** The `mcpServers` object Claude Desktop, Cursor, Gemini CLI and Windsurf all take. */
const mcpJsonFor = (t: McpTarget) =>
  JSON.stringify({ mcpServers: { e57view: { command: t.command, args: t.args } } }, null, 2);
/** A TOML basic string takes the same escapes as JSON, so this is right on Windows too. */
const tomlStr = (s: string) => JSON.stringify(s);

const MCP_CLIENTS: McpClient[] = [
  {
    id: 'claude-code', name: 'Claude Code',
    snippets: (t) => [{ label: 'In a terminal', text: `claude mcp add e57view -- ${t.shell}` }],
  },
  {
    // `codex mcp add` arrived in Codex CLI 0.36.0; before that the config file was the only way,
    // so both forms are shown rather than assuming which one someone can use.
    id: 'codex', name: 'Codex CLI',
    snippets: (t) => [
      { label: 'In a terminal — Codex CLI 0.36 or newer', text: `codex mcp add e57view -- ${t.shell}` },
      {
        label: 'Or by hand, in ~/.codex/config.toml',
        text: `[mcp_servers.e57view]\ncommand = ${tomlStr(t.command)}\nargs = [${t.args.map(tomlStr).join(', ')}]`,
      },
    ],
  },
  { id: 'cursor', name: 'Cursor', snippets: (t) => [{ label: 'In .cursor/mcp.json (or ~/.cursor/mcp.json for every project)', text: mcpJsonFor(t) }] },
  { id: 'claude-desktop', name: 'Claude Desktop', snippets: (t) => [{ label: 'In claude_desktop_config.json', text: mcpJsonFor(t) }] },
  { id: 'gemini', name: 'Gemini CLI', snippets: (t) => [{ label: 'In ~/.gemini/settings.json (or .gemini/settings.json in a project)', text: mcpJsonFor(t) }] },
  { id: 'windsurf', name: 'Windsurf', snippets: (t) => [{ label: 'In ~/.codeium/windsurf/mcp_config.json', text: mcpJsonFor(t) }] },
];

/** Every block shown for one client and one target. Pure, so a driver can check the desktop
 *  forms without a desktop window — the snippets are the thing that has to be right, and they
 *  do not depend on which build is rendering them. */
function mcpBlocks(clientId: string, t: McpTarget): McpSnippet[] {
  const client = MCP_CLIENTS.find(c => c.id === clientId) ?? MCP_CLIENTS[0];
  const blocks: McpSnippet[] = [];
  if (t.download) blocks.push({ label: 'or paste this in a terminal', text: t.download });
  blocks.push(...client.snippets(t));
  return blocks;
}
/** A target for an arbitrary executable path, which is what the desktop build has. */
function mcpDesktopTarget(exe: string): McpTarget {
  return { command: exe, args: ['--mcp'], shell: `${q(exe)} --mcp`, download: null };
}

function renderMcpSetup() {
  const sel = $<HTMLSelectElement>('k-mcpclient');
  const t = mcpTarget();
  const blocks = mcpBlocks(sel.value, t);
  // The download line belongs to step 1, which has its own button; the registration snippets
  // belong to step 2. Rendering both into one container put the curl line under "Your agent",
  // where it read as part of the registration.
  renderClientChips();
  const dl = $('mcp-dl');
  if (dl) dl.innerHTML = '';
  const host = $('mcp-snips');
  host.innerHTML = '';
  blocks.forEach((b, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'snipwrap';
    const label = document.createElement('p');
    label.className = 'hint sniplabel';
    label.textContent = b.label;
    const pre = document.createElement('pre');
    pre.className = 'snip';
    pre.id = i === 0 ? 'v-mcp' : `v-mcp-${i}`;
    pre.dataset.snip = String(i);
    pre.textContent = b.text;
    const copy = document.createElement('button');
    copy.className = 'ghost snipcopy';
    copy.id = i === 0 ? 'k-mcpcopy' : `k-mcpcopy-${i}`;
    copy.dataset.copy = String(i);
    copy.textContent = 'Copy';
    // exactly what is shown, not a regenerated approximation of it
    copy.addEventListener('click', async () => {
      const text = pre.textContent ?? '';
      try { await navigator.clipboard.writeText(text); agentNote(`copied: ${b.label.toLowerCase()}`); }
      catch { agentNote('could not reach the clipboard, so select the text and copy it'); }
    });
    wrap.append(label, pre, copy);
    (i === 0 && t.download && dl ? dl : host).appendChild(wrap);
  });
}
$('k-mcpclient').addEventListener('change', () => {
  localStorage.setItem('mcp-client', $<HTMLSelectElement>('k-mcpclient').value);
  renderMcpSetup();
});
{
  const saved = localStorage.getItem('mcp-client');
  if (saved && MCP_CLIENTS.some(c => c.id === saved)) $<HTMLSelectElement>('k-mcpclient').value = saved;
}

/** The picker as chips. The `<select>` is still the state and still fires `change`, so nothing
 *  downstream knows the difference; six client names do not fit in a 118px select, and
 *  truncating the one thing the user is choosing between is the wrong trade. */
function renderClientChips() {
  const host = $('mcp-clients');
  const sel = $<HTMLSelectElement>('k-mcpclient');
  host.innerHTML = '';
  for (const c of MCP_CLIENTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c.name;
    b.dataset.client = c.id;
    b.className = c.id === sel.value ? 'on' : '';
    b.setAttribute('aria-pressed', String(c.id === sel.value));
    b.addEventListener('click', () => {
      sel.value = c.id;
      sel.dispatchEvent(new Event('change'));
    });
    host.appendChild(b);
  }
}

// ------------------------------------------------------------------ the three tabs
type AgentTab = 'mcp' | 'http' | 'script' | 'log';
function showAgentTab(which: AgentTab) {
  const t: AgentTab = (which === 'http' && DESKTOP) ? 'mcp' : which;
  for (const name of ['mcp', 'http', 'script', 'log'] as AgentTab[]) {
    $(`tab-${name}`)?.classList.toggle('on', name === t);
    $(`pane-${name}`)?.classList.toggle('hidden', name !== t);
  }
  localStorage.setItem('agent-tab', t);
  if (t === 'log') paintLog();          // the list is only built while it is on screen
}
for (const name of ['mcp', 'http', 'script', 'log'] as AgentTab[]) {
  $(`tab-${name}`)?.addEventListener('click', () => showAgentTab(name));
}
showAgentTab((localStorage.getItem('agent-tab') as AgentTab) || 'mcp');
renderMcpSetup();
$('k-agent').addEventListener('change', e => {
  const on = (e.target as HTMLInputElement).checked;
  localStorage.setItem('agent', on ? '1' : '0');
  on ? agent.start() : agent.stop();
  refreshAgentState();
});
if (!DESKTOP && (new URLSearchParams(location.search).get('agent') === '1' || localStorage.getItem('agent') === '1')) { $<HTMLInputElement>('k-agent').checked = true; agent.start(); }

/** Commands a remote session may run only when this tab has ticked Allow edits:
 *  anything that drops points, writes a file, loads another scan or spends provider credit. */
// ------------------------------------------------------------------ the log
//
// Three ways in and no record of what came through any of them. "What did it just do?" was
// answerable only by watching the panel while it happened. Every command an agent runs over
// any path is kept here, newest first, with what it was given, what came back and how long it
// took. Nothing is written to disk: this is what happened in this tab, and it goes with it.
type LogEntry = {
  id: number; at: number; source: string; cmd: string; args: any; edit: boolean;
  state: 'pending' | 'ok' | 'error'; ms: number; error?: string; reply?: any;
};
const LOG_MAX = 500;
const agentLog: LogEntry[] = [];
let logId = 0;
const logOpen = new Set<number>();
/** Who is calling right now. Each entry point sets this immediately before it calls a
 *  handler, and the handler puts it back to `agent` when it is done, so a call that says
 *  nothing about itself is never attributed to whoever called last. */
let agentSource = 'agent';
let logDirty = false;

/** The arguments on one line: long strings cut, big arrays counted, binary sized. */
function logArgs(a: any): string {
  const short = (v: any): any => {
    if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 37)}…` : v;
    if (ArrayBuffer.isView(v)) return `…${Math.max(1, Math.round((v as any).byteLength / 1024))}KB`;
    if (Array.isArray(v)) return v.length > 6 ? `[${v.length} items]` : v.map(short);
    if (v && typeof v === 'object') {
      const o: any = {};
      for (const [k, x] of Object.entries(v)) o[k] = short(x);
      return o;
    }
    return v;
  };
  let s = '';
  try { s = JSON.stringify(short(a) ?? {}) ?? ''; } catch { s = '(arguments could not be read)'; }
  return s === '{}' ? '' : s;
}
const logTime = (t: number) => new Date(t).toTimeString().slice(0, 8);
function logStart(cmd: string, args: any): LogEntry {
  const e: LogEntry = {
    id: ++logId, at: Date.now(), source: agentSource, cmd, args,
    edit: agentNeedsEdit(cmd, args ?? {}), state: 'pending', ms: 0,
  };
  agentLog.unshift(e);
  while (agentLog.length > LOG_MAX) { const drop = agentLog.pop(); if (drop) logOpen.delete(drop.id); }
  paintLog();
  return e;
}
function logEnd(e: LogEntry, reply: any, err: any) {
  e.ms = Date.now() - e.at;
  e.state = err ? 'error' : 'ok';
  if (err) e.error = String(err?.message ?? err);
  // The reply is kept for the detail view, so it has to be small: a screenshot's base64 is
  // larger than every other entry in the log put together. scriptTrim already knows where the
  // pictures are, and anything still over the limit is stored as its own size.
  else {
    try {
      const r = scriptTrim(slim(reply));
      const text = JSON.stringify(r ?? null);
      e.reply = text && text.length > 20000 ? { note: `${text.length} characters, not kept` } : r;
    } catch { e.reply = null; }
  }
  paintLog();
}
/** One line per entry, the way it goes into a bug report. */
function logText(e: LogEntry): string {
  const tail = e.state === 'pending' ? 'running' : e.state === 'ok' ? `ok ${e.ms} ms` : `error ${e.error}`;
  return `${logTime(e.at)}  ${e.source}  ${e.cmd}${e.edit ? ' [edit]' : ''}  ${logArgs(e.args)}  ${tail}`;
}
function paintLog() {
  if (logDirty) return;
  logDirty = true;
  requestAnimationFrame(() => {
    logDirty = false;
    const badge = $('v-logcount');
    if (badge) badge.textContent = String(agentCalls.n);
    const list = $('log-list');
    if (!list || $('pane-log')?.classList.contains('hidden')) return;
    if (!agentLog.length) {
      list.innerHTML = '<p class="empty">Nothing yet. Commands an agent runs over the MCP bridge, an HTTP session or a script all appear here.</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const e of agentLog) {
      const row = document.createElement('button');
      row.className = 'logrow' + (e.state === 'ok' ? ' ok' : e.state === 'error' ? ' err' : '');
      row.type = 'button';
      const args = logArgs(e.args);
      const tail = e.state === 'pending' ? 'running' : e.state === 'ok' ? `${e.ms} ms` : 'failed';
      row.innerHTML = `<span class="t"></span><span class="src"></span><span class="cmd"></span>`
        + (e.edit ? '<span class="logtag">edit</span>' : '') + `<span class="args"></span><span class="ms"></span>`;
      (row.querySelector('.t') as HTMLElement).textContent = logTime(e.at);
      (row.querySelector('.src') as HTMLElement).textContent = e.source;
      (row.querySelector('.cmd') as HTMLElement).textContent = e.cmd;
      (row.querySelector('.args') as HTMLElement).textContent = e.state === 'error' ? (e.error ?? '') : args;
      (row.querySelector('.ms') as HTMLElement).textContent = tail;
      row.addEventListener('click', () => {
        logOpen.has(e.id) ? logOpen.delete(e.id) : logOpen.add(e.id);
        paintLog();
      });
      frag.appendChild(row);
      if (logOpen.has(e.id)) {
        const d = document.createElement('div');
        d.className = 'logdetail';
        const pre = document.createElement('pre');
        const reply = e.state === 'pending' ? 'still running' : e.error ?? JSON.stringify(e.reply ?? null, null, 1);
        pre.textContent = `args\n${JSON.stringify(slim(e.args) ?? {}, null, 1)}\n\nreply\n${reply}`;
        const copy = document.createElement('button');
        copy.className = 'ghost';
        copy.textContent = 'Copy';
        copy.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          try { await navigator.clipboard.writeText(`${logText(e)}\n\n${pre.textContent}`); copy.textContent = 'Copied'; }
          catch { copy.textContent = 'could not reach the clipboard'; }
          setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
        });
        d.append(pre, copy);
        frag.appendChild(d);
      }
    }
    list.replaceChildren(frag);
    const line = $('v-log');
    if (line) {
      const bad = agentLog.filter(e => e.state === 'error').length;
      line.textContent = `${agentLog.length} of the last ${LOG_MAX} shown · ${agentCalls.n} run in this tab`
        + (bad ? ` · ${bad} failed` : '');
      line.className = 'statusline' + (bad ? ' err' : agentLog.length ? ' ok' : '');
    }
  });
}
$('k-logclear')?.addEventListener('click', () => { agentLog.length = 0; logOpen.clear(); paintLog(); });
$('k-logcopy')?.addEventListener('click', async () => {
  const btn = $('k-logcopy');
  const text = agentLog.length
    ? [...agentLog].reverse().map(logText).join('\n')
    : 'no commands have been run in this tab';
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
  catch { btn.textContent = 'could not reach the clipboard'; }
  setTimeout(() => { btn.textContent = 'Copy log'; }, 2000);
});
/** The log as an agent reads it. Read-only: this is the one command that answers with what
 *  the other commands did. */
function logRecord(a: any = {}) {
  const limit = Math.max(1, Math.min(Number(a?.limit ?? 20) || 20, 200));
  const withReplies = a?.replies === true;
  return {
    calls: agentCalls.n, kept: agentLog.length, of: LOG_MAX,
    entries: agentLog.slice(0, limit).map(e => ({
      at: new Date(e.at).toISOString(), source: e.source, cmd: e.cmd,
      args: slim(e.args) ?? {}, edit: e.edit, outcome: e.state, ms: e.ms,
      ...(e.error ? { error: e.error } : {}),
      ...(withReplies && e.reply !== undefined ? { reply: e.reply } : {}),
    })),
  };
}
paintLog();

function agentNeedsEdit(cmd: string, a: any = {}): boolean {
  if (cmd === 'open') return true;
  if (cmd === 'regions') return a.op === 'apply';
  if (cmd === 'surface') return a.op === 'build';
  if (cmd === 'history') return a.op !== 'status';
  if (cmd === 'transform') return (a.op ?? 'get') !== 'get';
  if (cmd === 'entities') return ['add', 'remove', 'clone', 'merge'].includes(String(a.op ?? 'list'));
  if (cmd === 'register' || cmd === 'distance_to') return true;
  if (cmd === 'detect' || cmd === 'volume') return true;               // real time, and it writes a scalar field
  // reading a mesh's numbers is free; editing it, sampling it into a new layer or measuring a
  // cloud against it is not
  if (cmd === 'mesh') return !['list', 'measure', 'show'].includes(String(a.op ?? 'measure'));
  if (cmd === 'cache') return String(a.op ?? 'list') !== 'list';
  if (cmd === 'analysis') return true;      // every op either removes points or writes a field
  // a script is exactly as privileged as the steps in it
  if (cmd === 'script') {
    const steps = Array.isArray(a?.steps) ? a.steps : Array.isArray(a) ? a : [];
    return steps.some((st: any) => agentNeedsEdit(String(st?.cmd ?? ''), st?.args ?? {}));
  }
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
  agentSource = 'HTTP';
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
let agentExpires = 0;
let agentSticky = 0;                                   // hold a message the watcher must not overwrite
function agentStatus(text: string, sticky = 0, kind: '' | 'ok' | 'busy' | 'err' = '') {
  if (!sticky && Date.now() < agentSticky) return;
  agentSticky = sticky ? Date.now() + sticky : 0;
  // when it expires, put the line back to whatever the state is; nothing else was going to
  if (sticky) setTimeout(refreshAgentState, sticky + 60);
  const el = $('v-agenturl');
  el.textContent = text;
  el.className = 'statusline' + (kind ? ' ' + kind : '');
}
/** The connection text for the running session, written fresh each time so a session flipped
 *  to edits copies as edits allowed. The token lives in `agentToken` for the life of the
 *  session, because this page owns the session and there is no other way to hand the
 *  instructions over a second time. Stop and pagehide clear it. */
function connectionText(): string {
  if (!agentSid || !agentToken) return '';
  const edits = editsAllowed();
  const page = new URL(location.origin + location.pathname);
  page.searchParams.set('session', agentSid);
  return [
    `# ${edits ? 'EDITS ALLOWED: this session may crop, delete, transform and save.' : 'READ-ONLY: this session may look and measure, and nothing else.'}`,
    `# Change that with "Allow edits" on the HTTP tab of the viewer's Agent panel.`,
    `#`,
    `# e57view agent session, expires ${new Date(agentExpires).toLocaleString()}`,
    `# Keep this tab open. The token below is the credential. It is shown once and is not in the URL.`,
    '',
    `Viewer page: ${page}`,
    '',
    `curl -s ${location.origin}/agent \\`,
    `  -H 'Authorization: Bearer ${agentToken}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${JSON.stringify({ session: agentSid, cmd: 'state' })}'`,
  ].join('\n');
}
/** The same thing with the token reduced to its last four characters, for the screen. */
function connectionPreview(): string {
  if (!agentSid || !agentToken) return '';
  const page = new URL(location.origin + location.pathname);
  page.searchParams.set('session', agentSid);
  return `${page}\nBearer ...${agentToken.slice(-4)}`;
}
function updateAgentUI() {
  const live = !!agentSid;
  $('http-idle')?.classList.toggle('hidden', live);
  $('http-live')?.classList.toggle('hidden', !live);
  $('k-agentstop').classList.toggle('hidden', !live);
  document.body.classList.toggle('has-session', live);
  const two = $<HTMLInputElement>('k-agentedits2');
  if (two) two.checked = editsAllowed();
  refreshAgentState();
}
/** The one thing people were missing: what a running session is allowed to do. */
function paintAccessBadge() {
  const b = $('v-access');
  if (!b) return;
  const on = editsAllowed();
  b.textContent = on ? 'EDITS ALLOWED' : 'READ-ONLY';
  b.className = 'badge' + (on ? ' edits' : '');
  $('v-accessnote').textContent = on
    ? 'The agent can crop, delete, transform and save over this session.'
    : 'The agent can look and measure. It cannot change or save anything.';
}

// ---------------------------------------------------------------- what is connected
//
// Three ways in, and before this there was one flat list of controls for all of them, so
// which one you were looking at was a guess. Each option now carries its own pill, and this
// is the one line that says what is actually connected right now.
/** What the desktop shell last told us about its bridge. Empty in the web build. */
const desktopBridge = { port: 0, agents: 0 };
const hms = (ms: number) => {
  if (ms <= 0) return 'expired';
  // round to whole minutes first, or 7 h 59.7 m prints as "7 h 60 m"
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h} h ${m} m` : `${m} m`;
};
function refreshAgentState() {
  // ---- the local MCP bridge
  let mcp: 'off' | 'waiting' | 'on';
  if (DESKTOP) mcp = desktopBridge.port ? 'on' : 'waiting';
  else if (!$<HTMLInputElement>('k-agent').checked) mcp = 'off';
  else mcp = agent.connected ? 'on' : 'waiting';
  const calls = agentCalls.n ? ` · ${agentCalls.n} command${agentCalls.n > 1 ? 's' : ''} run` : '';
  const line = $('v-mcppill');
  if (line) {
    const attached = DESKTOP && desktopBridge.agents
      ? ` · ${desktopBridge.agents} agent${desktopBridge.agents > 1 ? 's' : ''} attached` : '';
    line.textContent = mcp === 'on'
      ? `listening on 127.0.0.1:${DESKTOP ? desktopBridge.port : 7337}${attached}${calls}`
      : mcp === 'waiting' ? 'waiting for the server on 127.0.0.1:7337'
      : 'not connected';
    line.className = 'statusline' + (mcp === 'on' ? ' ok' : mcp === 'waiting' ? ' busy' : '');
  }

  // ---- the hosted HTTP session
  const live = !!agentSid;
  const edits = live && editsAllowed();
  // One line, one format. It used to say "expires in 8 h 0 m" and, underneath, "listening ·
  // edits allowed · expires in 8.0 h": the same facts twice.
  if (live && Date.now() >= agentSticky) {
    const left = agentExpires ? ` · expires in ${hms(agentExpires - Date.now())}` : '';
    agentStatus(`live · ${edits ? 'edits allowed' : 'read-only'}${left}`, 0, edits ? 'err' : 'busy');
  }
  const conn = $('v-agentconn');
  if (conn) conn.textContent = connectionPreview();

  // ---- a dot on each tab, so a live path shows without opening it
  $('tab-mcp')?.classList.toggle('live', mcp === 'on');
  $('tab-mcp')?.classList.toggle('warn', mcp === 'waiting');
  $('tab-http')?.classList.toggle('live', live && !edits);
  $('tab-http')?.classList.toggle('warn', live && edits);
  paintAccessBadge();
}
setInterval(refreshAgentState, 30000);        // so the expiry clock ticks down
async function startRemoteSession(sid: string) {
  const m = sessionMod ?? await import('./session'); sessionMod = m;
  await m.ensureAuth();
  stopSession?.();
  agentSid = sid;
  if (!agentToken) { try { agentToken = sessionStorage.getItem('agent-token:' + sid); } catch {} }
  stopSession = m.watchAgentSession(sid, dispatchAgent, s => {
    // back to waiting: repaint from the state, but do not push aside a confirmation that is
    // still up. The first snapshot lands a moment after the session starts, and clearing the
    // hold here ate the "Copied" line every time.
    if (!s) { refreshAgentState(); return; }
    agentStatus(s, /^session /.test(s) ? 8000 : 2000, /^session /.test(s) ? 'err' : 'busy');
  });
  updateAgentUI();
}
$('k-agenturl').addEventListener('click', async () => {
  try {
    const m = sessionMod ?? await import('./session'); sessionMod = m;
    const edits = $<HTMLInputElement>('k-agentedits').checked;
    const { sid, token, expiresAt } = await m.createAgentSession(edits);
    agentExpires = expiresAt;
    agentToken = token;
    try { sessionStorage.setItem('agent-token:' + sid, token); } catch {}
    await startRemoteSession(sid);
    // The page URL carries the session id only. The token goes to the agent alone, so a
    // leaked link (history, referrer, analytics) grants nothing.
    const page = new URL(location.origin + location.pathname);
    page.searchParams.set('session', sid);
    const blob = connectionText();
    await navigator.clipboard.writeText(blob);
    agentStatus(`Copied · ${edits ? 'edits allowed' : 'read-only session'}`, 4000, edits ? 'err' : 'ok');
  } catch (e: any) { agentStatus('failed: ' + (e?.message ?? e), 8000, 'err'); }
});
$('k-agentcopy')?.addEventListener('click', async () => {
  const text = connectionText();
  if (!text) return;
  const btn = $('k-agentcopy');
  try {
    await navigator.clipboard.writeText(text);
    // next to the button, not only in the status line: a confirmation somewhere else on the
    // screen is a confirmation people miss, which is how this button came to be needed
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy connection details'; btn.classList.remove('copied'); }, 2500);
  } catch {
    agentStatus('could not reach the clipboard, so select the text and copy it', 6000, 'err');
  }
});
$('k-agentstop').addEventListener('click', async () => {
  if (!agentSid) return;
  const sid = agentSid;
  stopSession?.(); stopSession = null; agentSid = null; agentToken = null; agentExpires = 0;
  try { sessionStorage.removeItem('agent-token:' + sid); } catch {}
  updateAgentUI();
  try { await sessionMod?.stopAgentSession(sid); agentStatus('session stopped, its token no longer works', 8000); }
  catch (e: any) { agentStatus('stopped locally, but the record remains: ' + (e?.message ?? e), 8000, 'err'); }
});
/** Allow edits appears twice: once before a session is started, where the choice is made
 *  deliberately, and once beside the live badge, where it is changed. One setting, so the
 *  second is mirrored onto the first and everything else reads `k-agentedits`. */
const editsAllowed = () => $<HTMLInputElement>('k-agentedits').checked;
function setEditsAllowed(on: boolean) {
  $<HTMLInputElement>('k-agentedits').checked = on;
  const two = $<HTMLInputElement>('k-agentedits2');
  if (two) two.checked = on;
  // A confirmation from before the change contradicts the badge that just flipped, so drop
  // whatever is being held and repaint from the state.
  agentSticky = 0;
  refreshAgentState();
}
$('k-agentedits').addEventListener('change', async e => {
  const on = (e.target as HTMLInputElement).checked;
  setEditsAllowed(on);
  if (agentSid) { try { await sessionMod?.setAgentEdits(agentSid, on); } catch {} }
});
$('k-agentedits2')?.addEventListener('change', async e => {
  const on = (e.target as HTMLInputElement).checked;
  setEditsAllowed(on);
  if (agentSid) { try { await sessionMod?.setAgentEdits(agentSid, on); } catch {} }
});
updateAgentUI();
refreshAgentState();
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
  // the plaintext token does not outlive the page that owned it
  agentToken = null; agentSid = null; agentExpires = 0;
});
const sessionParam = DESKTOP ? null : new URLSearchParams(location.search).get('session');
if (sessionParam) import('./session').then(m => { sessionMod = m; startRemoteSession(sessionParam); }).catch(e => agentStatus('session: ' + ((e as any)?.message ?? e)));

// ------------------------------------------------------------------ entry
async function pickFile() {
  if (DESKTOP && shell) {
    const [p] = await shell.openDialog({ title: 'Open a scan or a mesh' });
    if (p) await openPath(p, false);
    return;
  }
  const anyWin = window as any;
  if (anyWin.showOpenFilePicker) {
    try { const [h] = await anyWin.showOpenFilePicker({ types: [{ description: 'Point cloud', accept: { 'application/octet-stream': ['.e57', '.ply', '.las', '.laz', '.ptx', '.obj', '.stl', ...ASCII_EXT.map(e => '.' + e)] } }] }); openFile(await h.getFile(), h); } catch {}
    return;
  }
  const inp = document.createElement('input'); inp.type = 'file'; if (!isIOS) inp.accept = ['.e57', '.ply', '.las', '.laz', '.ptx', '.obj', '.stl', ...ASCII_EXT.map(e => '.' + e)].join(',');
  inp.onchange = () => inp.files?.[0] && openFile(inp.files[0]); inp.click();
}
/** Open a file the shell gave us by path.
 *
 *  The viewer has never needed a real `File` — it needs a name, a size and a way to read a
 *  byte range — so a path becomes a `NativeFile` with the same three and everything
 *  downstream, including the workers, is unchanged. `add` false replaces what is open, which
 *  is the destructive one, so it goes through the same unsaved-work guard as every other door.
 */
async function openPath(path: string, add: boolean) {
  if (!shell) return;
  if (!add && !(await confirmReplace())) return;
  try {
    const f = await shell.nativeFile(path);
    shell.notifyRecents();
    await openFile(f as unknown as File, null, add && viewer.loadedAll > 0);
  } catch (e: any) {
    fail(`Could not open ${path}: ${e?.message ?? e}`);
  }
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
  const defaultClosed = ['Tone', 'Clipping', 'measure', 'export', 'cache', 'sections', 'agent', 'surface', 'analysis', 'field', 'transform', 'register', 'fit', 'raster'].includes(name);
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
// ------------------------------------------------------------------ the desktop shell
//
// Loaded last and only in the desktop build: the page works exactly as it does in a browser
// until this runs, and everything it adds is a door — a menu item, a Finder drop, a native
// dialog — not a change to how anything works.
async function startDesktop() {
  document.body.classList.add('desktop');
  const m = await import('./desktop');
  shell = m;
  await m.init({
    openPath: (p, add) => openPath(p, add),
    addLayer: () => addFile(),
    importMesh: () => pickMeshFile(),
    save: () => saveCurrent(),
    exportPoints: () => saveCurrent(),
    undo: () => undoEdit(),
    redo: () => redoEdit(),
    fit: () => viewer.fit(),
    top: () => viewer.topDown(),
    panel: () => { $('panel').classList.toggle('hidden'); viewer.resize(); viewer.touch(); },
    agentPanel: () => {
      $('panel').classList.remove('hidden');
      const g = document.querySelector('[data-grp="agent"]') as HTMLElement | null;
      g?.classList.remove('closed');
      g?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      viewer.resize();
    },
    about: () => modal('e57view',
      `<p>An offline viewer for E57, LAS, LAZ, PTX, PLY and text point clouds, and for PLY, OBJ and STL meshes.</p>`
      + `<p>Everything happens on this machine. The app opens no network connection at all; the only socket it listens on is 127.0.0.1 for the agent bridge.</p>`
      + `<p class="hint mono">GPL-3.0-only</p>`,
      [{ label: 'Close', value: 'ok', cls: 'primary' }]),
  });
  // the bridge is always there in the desktop build, so the agent link is on by default
  agent.start();
  refreshBridge();
  setInterval(refreshBridge, 4000);
}
async function refreshBridge() {
  if (!shell) return;
  try {
    const b = await shell.bridgeStatus();
    bridgeExe = b.exe ?? bridgeExe;
    desktopBridge.port = b.port; desktopBridge.agents = b.agents;
    refreshAgentState();
    // the real path of the running binary, which is what every snippet has to name
    if (b.exe) renderMcpSetup();
  } catch { desktopBridge.port = 0; agentNote('the bridge did not answer'); refreshAgentState(); }
}
if (DESKTOP) startDesktop().catch(e => { agentNote('desktop shell: ' + (e?.message ?? e)); });

(window as any).__app = { openFile, openCached, writeCache, applyKeep, applyCrop, setCropRole, get cropState() { return cropState; }, addSection, undoEdit, redoEdit, saveCurrent, hist,
  commitTransform, transformState, levelCloud, rowMajor, fromRowMajor, runExport, updateTransformUI,
  dirtyList, isDirty, openAnother, confirmReplace,
  stateRecord, recommendedSource, surfaceRecord, heightmapCmd, contourCmd, fitPlaneCmd, dispatchAgent,
  createPrismRegion, placeRegion, scaleRegion, fitToContents, activeRegion, startSize, buildClassificationField,
  fitShape, detectShapes, fitPoints, applyShapeMask, get shapes() { return shapes; },
  rasterize, buildRaster, drawContours, measureVolume, contoursDxf, contoursGeoJson, rasterPng,
  get raster() { return raster; }, get contours() { return contours; },
  get sections() { return sections; }, renderSectionList, regionCount, syncRegions,
  activateEntity, cloneActive, mergeIntoActive, renderLayers, entityList, setReference,
  matchCentres, matchScales, runIcp, distanceToReference, removeLayer, addFile,
  get entities() { return viewer.entities; }, get activeId() { return viewer.activeId; },
  get cacheNote() { return cacheNote; }, get meta() { return meta; }, get cacheKey() { return cacheKey; }, get regions() { return allRegions(); }, buildMesh, analysis, runAnalysis, maskTool, get sfStats() { return viewer.cells.scalarStats(); }, get meshData() { return meshData; },
  agentRun: (cmd: string, args: any) => agent.run(cmd, args), runScript,
  set anaMaxPoints(v: number) { anaMaxPoints = v; }, get anaMaxPoints() { return anaCap(); },
  get anaHeap() { return anaHeap; }, noiseArgs, get anaUi() { return anaUi; },
  mcpBlocks, mcpTarget, mcpDesktopTarget, renderMcpSetup, get mcpClients() { return MCP_CLIENTS.map(c => ({ id: c.id, name: c.name })); },
  importMesh, measureActiveMesh, smoothActiveMesh, decimateActiveMesh, sampleMeshPoints, distanceToMesh,
  replaceMesh, flipMesh, meshEntities, meshBlob, saveMesh, refreshMeshUI, setDisplay,
  get meshFile() { return meshFile; }, get meshInfo() { return meshInfo; } };
