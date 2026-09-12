// Neighbourhood analysis off the main thread.
//
// The viewer streams its octree leaves in, the WebAssembly analyser builds one spatial
// index over all of them, and each operation returns a single flat array the size of the
// cloud: new normals, one scalar per point, or a keep mask. Record bytes are decoded on
// arrival and dropped, so the worker never holds a second copy of the cloud.
import init, { CloudAnalysis } from './wasm/e57_wasm.js';
import wasmUrl from './wasm/e57_wasm_bg.wasm?url';

let wasmReady: Promise<any> | null = null;
const ensureWasm = () => (wasmReady ??= init({ module_or_path: wasmUrl }));

let a: CloudAnalysis | null = null;
let fed = 0;
let maxPoints = 30e6;

const post = (m: any, t: Transferable[] = []) => (self as any).postMessage(m, t);
const prog = (phase: string, total: number) => {
  let last = 0;
  return (i: number) => {
    if (i - last < 200_000) return;
    last = i;
    post({ type: 'progress', phase, done: i, total });
  };
};

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === 'start') {
      await ensureWasm();
      a?.free();
      a = new CloudAnalysis(m.cell);
      maxPoints = m.maxPoints || 30e6;
      fed = 0;
      post({ type: 'ready' });
      return;
    }

    if (m.type === 'leaf') {
      const recs = new Uint8Array(m.recs);
      a!.add_leaf(m.origin[0], m.origin[1], m.origin[2], m.size, recs);
      fed++;
      const n = a!.len();
      if (n > maxPoints) {
        a!.free(); a = null;
        post({ type: 'error', message: `${(n / 1e6).toFixed(1)}M points is past the ${(maxPoints / 1e6).toFixed(0)}M this device can analyse at once. Crop to a smaller area, or reload at a coarser sampling.` });
        return;
      }
      if ((fed & 15) === 0) post({ type: 'progress', phase: 'Reading cells', done: n, total: 0 });
      return;
    }

    if (m.type === 'run') {
      const n = a!.len();
      post({ type: 'progress', phase: 'Indexing', done: 0, total: n });
      a!.build();
      const t0 = performance.now();
      const op = m.op;
      let out: any = { type: 'result', op, points: n };

      if (op === 'normals') {
        a!.compute_normals(m.k, prog('Computing normals', n));
        if (m.orient) {
          const v = m.viewpoint;
          a!.orient_normals(m.k, v ? v[0] : 0, v ? v[1] : 0, v ? v[2] : 0, !!v, prog('Orienting normals', n));
        }
      } else if (op === 'invert') {
        a!.invert_normals();
      } else if (op === 'feature') {
        const f = a!.feature(m.name, m.k, m.radius, prog('Computing ' + m.name, n));
        out.kind = 'field';
        out.data = f;
      } else if (op === 'sor') {
        out.kind = 'mask';
        out.data = a!.sor(m.k, m.sigma, prog('Measuring neighbourhoods', n));
        out.mean = a!.mean_distance;
        out.cut = a!.cut_distance;
      } else if (op === 'noise') {
        out.kind = 'mask';
        out.data = a!.noise(m.k, m.sigma, prog('Fitting local surfaces', n));
      } else if (op === 'duplicates') {
        out.kind = 'mask';
        out.data = a!.duplicates(m.tol);
      } else if (op === 'subsample') {
        out.kind = 'mask';
        out.data = a!.subsample(m.spacing);
      } else if (op === 'components') {
        out.kind = 'field';
        out.data = a!.components(m.radius, m.minPts, prog('Growing clusters', n));
        out.components = a!.component_count;
      } else {
        throw new Error('unknown analysis: ' + op);
      }

      if (op === 'normals' || op === 'invert') {
        // hand back only the normals; the viewer patches its own records with them
        const nrm = new Int8Array(n * 3);
        const src = a!.normals_bytes();
        nrm.set(src);
        out.kind = 'normals';
        out.data = nrm;
      }
      out.ms = performance.now() - t0;
      post(out, out.data ? [out.data.buffer] : []);
      return;
    }

    if (m.type === 'done') {
      a?.free();
      a = null;
      post({ type: 'freed' });
      return;
    }
  } catch (e: any) {
    try { a?.free(); } catch {}
    a = null;
    post({ type: 'error', message: String(e?.message ?? e) });
  }
};
