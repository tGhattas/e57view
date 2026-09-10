/// <reference lib="webworker" />
// Imports PLY and LAS files into the same cell format the E57 path produces,
// so the rest of the app cannot tell the difference. Also the landing spot for
// scans exported by phone LiDAR apps.
import init, { PointSink } from './wasm/e57_wasm.js';
import wasmUrl from './wasm/e57_wasm_bg.wasm?url';
import { sniff, parsePly, parseLas } from '../shared/importers.mjs';

const post = (m: any, t?: Transferable[]) => (self as any).postMessage(m, t ?? []);
let ready: Promise<unknown> | null = null;

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type !== 'open') return;
  try {
    if (!ready) ready = init({ module_or_path: wasmUrl });
    await ready;
    const file: File = m.file;
    const fr = new FileReaderSync();
    const readRange = (offset: number, length: number) =>
      new Uint8Array(fr.readAsArrayBuffer(file.slice(offset, Math.min(offset + length, file.size))));
    const kind = sniff(file.name, readRange);
    if (kind !== 'ply' && kind !== 'las') throw new Error(kind === 'laz' ? 'LAZ is not supported yet — decompress to LAS first.' : `Unrecognised file type: ${file.name}`);

    const stride = Math.max(1, m.stride | 0);
    const t0 = performance.now();
    let sink: PointSink | null = null;
    let total = 0, lastProgress = 0;
    const preview = (rec: Uint8Array, count: number, pm: Float64Array) =>
      post({ type: 'preview', block: rec.buffer, count, meta: { origin: [pm[0], pm[1], pm[2]], size: pm[3], bmin: [pm[0], pm[1], pm[2]], bmax: [pm[0] + pm[3], pm[1] + pm[3], pm[2] + pm[3]] } }, [rec.buffer]);

    const onMeta = (im: any) => {
      total = im.points;
      const meta = {
        guid: null, library: `import:${im.format}`, images: 0, stations: [],
        scans: [{ name: im.name, points: im.points, bounds: im.bounds, translation: im.translation,
                  sensorVendor: im.format.toUpperCase() + (im.version ? ' ' + im.version : ''), sensorModel: im.pointFormat !== undefined ? `point format ${im.pointFormat}` : null,
                  hasColor: im.hasColor, hasIntensity: im.hasIntensity, hasNormals: im.hasNormals, cartesian: true, spherical: false, fields: 0 }],
      };
      post({ type: 'meta', meta, openMs: performance.now() - t0, bytesPulled: 0 });
      post({ type: 'plan', stride, willKeep: Math.floor(im.points / stride) });
      const b = im.bounds;
      sink = new PointSink(new Float64Array([b[0], b[2], b[4], b[1], b[3], b[5]]), im.points / stride, m.memLimit ?? 3e9, 1_200_000);
    };
    const onBatch = (bt: any) => {
      if (!sink) return;
      if (stride > 1) {
        // keep 1 in `stride` — cheap decimation before binning
        const n = Math.ceil(bt.n / stride);
        const xyz = new Float64Array(n * 3), rgb = new Uint8Array(n * 3), inten = new Uint8Array(n), nrm = new Int8Array(n * 3);
        let j = 0;
        for (let i = 0; i < bt.n; i += stride, j++) {
          xyz[j * 3] = bt.xyz[i * 3]; xyz[j * 3 + 1] = bt.xyz[i * 3 + 1]; xyz[j * 3 + 2] = bt.xyz[i * 3 + 2];
          rgb[j * 3] = bt.rgb[i * 3]; rgb[j * 3 + 1] = bt.rgb[i * 3 + 1]; rgb[j * 3 + 2] = bt.rgb[i * 3 + 2];
          inten[j] = bt.inten[i]; nrm[j * 3] = bt.nrm[i * 3]; nrm[j * 3 + 1] = bt.nrm[i * 3 + 1]; nrm[j * 3 + 2] = bt.nrm[i * 3 + 2];
        }
        sink.push(xyz, rgb, inten, nrm, j, preview);
      } else sink.push(bt.xyz, bt.rgb, bt.inten, bt.nrm, bt.n, preview);
    };
    const onProgress = (read: number, count: number) => {
      const now = performance.now();
      if (now - lastProgress > 80) { lastProgress = now; post({ type: 'progress', phase: 0, done: read, total: count, elapsed: now - t0, bytesPulled: 0 }); }
    };
    if (kind === 'ply') parsePly(readRange, file.size, file.name, onMeta, onBatch, onProgress);
    else parseLas(readRange, file.size, file.name, onMeta, onBatch, onProgress);
    if (!sink) throw new Error('nothing to import');

    const s = sink as PointSink;
    const stats: any = s.finish(preview,
      (phase: number, done: number, tot: number) => { post({ type: 'progress', phase, done, total: tot, elapsed: performance.now() - t0, bytesPulled: 0 }); return false; },
      (blocks: Uint8Array[], count: number, pm: Float64Array) => {
        const bufs = blocks.map(b => b.buffer as ArrayBuffer);
        post({ type: 'leaf', blocks: bufs, count, meta: { origin: [pm[0], pm[1], pm[2]], size: pm[3], bmin: [pm[4], pm[5], pm[6]], bmax: [pm[7], pm[8], pm[9]] } }, bufs);
      });
    post({ type: 'done', ms: performance.now() - t0, bytesPulled: file.size, stats: { read: total, kept: stats.kept, droppedInvalid: 0, leaves: stats.leaves, nodes: stats.leaves } });
  } catch (e: any) {
    post({ type: 'error', message: String(e?.message ?? e) });
  }
};
