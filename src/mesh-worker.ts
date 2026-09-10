// Surface reconstruction off the main thread. The viewer reads its octree leaves back from
// the GPU and streams them here; the WebAssembly mesher splats each leaf into a sparse
// signed-distance field and extracts the surface once every leaf has arrived.
import init, { MeshBuilder } from './wasm/e57_wasm.js';
import wasmUrl from './wasm/e57_wasm_bg.wasm?url';

let wasmReady: Promise<any> | null = null;
const ensureWasm = () => (wasmReady ??= init({ module_or_path: wasmUrl }));

let builder: MeshBuilder | null = null;
let stride = 1;
let fed = 0;
let maxBytes = 900e6;
const BRICK_BYTES = 8 * 8 * 8 * 7;   // sd + weight + rgb per voxel

const post = (m: any, t: Transferable[] = []) => (self as any).postMessage(m, t);

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === 'start') {
      await ensureWasm();
      builder?.free();
      builder = new MeshBuilder(m.voxel, m.trunc, m.minWeight);
      stride = Math.max(1, m.stride | 0);
      maxBytes = m.maxBytes || 900e6;
      fed = 0;
      post({ type: 'ready' });
      return;
    }
    if (m.type === 'leaf') {
      const recs = new Uint8Array(m.recs);
      builder!.add_leaf(m.origin[0], m.origin[1], m.origin[2], m.size, recs, stride);
      fed++;
      if ((fed & 7) === 0) {
        const bricks = builder!.bricks();
        const bytes = bricks * BRICK_BYTES;
        if (bytes > maxBytes) {
          builder!.free(); builder = null;
          post({ type: 'error', message: `this Detail needs more than ${(bytes / 1e9).toFixed(1)} GB of field. Raise Detail (a larger voxel) or crop to a smaller area first.` });
          return;
        }
        post({ type: 'progress', leaves: fed, bricks, bytes });
      }
      return;
    }
    if (m.type === 'build') {
      const t0 = performance.now();
      const stats = JSON.parse(builder!.build(m.smooth | 0, m.iso));
      const pos = builder!.positions();
      const nrm = builder!.normals();
      const col = builder!.colors();
      const idx = builder!.indices();
      builder!.free();
      builder = null;
      post(
        { type: 'mesh', stats: { ...stats, ms: performance.now() - t0 }, pos, nrm, col, idx },
        [pos.buffer, nrm.buffer, col.buffer, idx.buffer],
      );
      return;
    }
    if (m.type === 'cancel') {
      builder?.free();
      builder = null;
      post({ type: 'cancelled' });
      return;
    }
  } catch (e: any) {
    try { builder?.free(); } catch {}
    builder = null;
    post({ type: 'error', message: String(e?.message ?? e) });
  }
};
