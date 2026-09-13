// SPDX-License-Identifier: GPL-3.0-only
// Neighbourhood analysis off the main thread.
//
// The viewer streams its octree leaves in, the WebAssembly analyser builds one spatial
// index over all of them, and each operation returns a single flat array the size of the
// cloud: new normals, one scalar per point, or a keep mask. Record bytes are decoded on
// arrival and dropped, so the worker never holds a second copy of the cloud.
import init, { CloudAnalysis, fit_shape, detect_shapes } from './wasm/e57_wasm.js';
import wasmUrl from './wasm/e57_wasm_bg.wasm?url';

let wasmReady: Promise<any> | null = null;
let wasmExports: any = null;
const ensureWasm = () => (wasmReady ??= init({ module_or_path: wasmUrl }).then(w => { wasmExports = w; return w; }));
/** The size of the WebAssembly heap, which is where the index and the points live. Reported
 *  with every result so a big run can say what it actually cost. */
const heapBytes = () => wasmExports?.memory?.buffer?.byteLength ?? 0;

let a: CloudAnalysis | null = null;
let fed = 0;
let maxPoints = 30e6;
/** The cloud's 4x4 transform, row-major, or empty for identity. The viewer keeps its points
 *  quantised in their original leaf cubes and carries the transform separately, so every
 *  leaf has to be read through it here. */
let model = new Float32Array(0);
let cell = 0.05;
let refStarted = false, refFed = 0;
/** How many of the points fed so far this tile is responsible for.
 *
 *  A cloud too big to index at once arrives one spatial tile at a time: the tile's own
 *  leaves first, then the leaves around it, fed as context so a neighbourhood search at the
 *  tile's edge still sees a whole surface. Results are cut back to this length, because the
 *  context points belong to another tile and will be answered for there. */
let coreLen = 0;
/** True between a `start` and the first failure.
 *
 *  The main thread posts leaves without waiting for each one, so when a run is refused
 *  part-way through the feed there are already more leaves in flight. Answering those with a
 *  null analyser threw, and the second error overwrote the first: the user was told
 *  "Cannot read properties of null" instead of why the run was refused. Once something has
 *  gone wrong this worker says nothing further until the next `start`. */
let armed = false;
/** Milliseconds spent decoding records into the analyser, for the profile in the reply. */
let msFeed = 0;

const post = (m: any, t: Transferable[] = []) => (self as any).postMessage(m, t);
/** "73.8M" reads better than "73757292", and "5,000" reads better than "0.0M". */
const big = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n.toLocaleString('en-GB');
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
      model = m.model && m.model.length === 16 ? new Float32Array(m.model) : new Float32Array(0);
      cell = m.cell;
      refStarted = false; refFed = 0;
      fed = 0; coreLen = 0; msFeed = 0;
      armed = true;
      post({ type: 'ready' });
      return;
    }

    // Fitting and detection take the points directly rather than through the grid, so they
    // do not disturb whatever the analyser is holding.
    if (m.type === 'fit') {
      await ensureWasm();
      post({ type: 'fit', json: fit_shape(m.kind, new Float32Array(m.xyz), new Float32Array(m.nrm ?? new Float32Array(0))) });
      return;
    }
    if (m.type === 'detect') {
      await ensureWasm();
      const d = detect_shapes(new Float32Array(m.xyz), new Float32Array(m.nrm ?? new Float32Array(0)),
        m.tol, m.minPts, m.maxShapes ?? 12, m.kinds ?? 'plane,sphere,cylinder', m.trials ?? 400,
        (i: number) => post({ type: 'progress', phase: `Looking for shape ${i + 1}`, done: i, total: m.maxShapes ?? 12 }));
      const json = d.json;
      const labels = d.labels();
      d.free();
      post({ type: 'detect', json, labels }, [labels.buffer]);
      return;
    }

    if (m.type === 'ref') {
      if (!armed || !a) return;      // a failure already reported; stay quiet until the next start
      // a leaf of the reference cloud, read through its own model matrix
      if (!refStarted) { a.start_reference(cell); refStarted = true; }
      const recs = new Uint8Array(m.recs);
      a.add_reference_leaf(m.origin[0], m.origin[1], m.origin[2], m.size, recs,
        m.model && m.model.length === 16 ? new Float32Array(m.model) : new Float32Array(0), Math.max(1, m.stride | 0));
      refFed++;
      if ((refFed & 15) === 0) post({ type: 'progress', phase: 'Reading the reference', done: a.reference_len, total: 0 });
      return;
    }

    if (m.type === 'leaf') {
      if (!armed || !a) return;      // a failure already reported; stay quiet until the next start
      const recs = new Uint8Array(m.recs);
      // `base` is where this leaf's first point sits in the whole cloud. Rules of the form
      // "the first one wins" are settled on it, so a tile decides the way the cloud would.
      const tf = performance.now();
      a.add_leaf(m.origin[0], m.origin[1], m.origin[2], m.size, recs, model, (m.base ?? 0) >>> 0);
      msFeed += performance.now() - tf;
      fed++;
      const n = a.len();
      if (!m.context) coreLen = n;
      if (n > maxPoints) {
        armed = false;
        a.free(); a = null;
        post({ type: 'error', message: `${big(n)} points is past the ${big(maxPoints)} this device can index at once, and this operation needs the whole cloud in one index. Crop to a smaller area, or reload at a coarser sampling.` });
        return;
      }
      if ((fed & 15) === 0) post({ type: 'progress', phase: 'Reading cells', done: n, total: 0 });
      return;
    }

    if (m.type === 'run') {
      if (!armed || !a) return;      // a failure already reported; stay quiet until the next start
      const n = a.len();
      // how many of them this run answers for: all of them unless leaves came in as context
      const own = Math.min(m.outLen ?? (coreLen || n), n);
      post({ type: 'progress', phase: 'Indexing', done: 0, total: n });
      const tb = performance.now();
      a.build();
      const msBuild = performance.now() - tb;
      const t0 = performance.now();
      const op = m.op;
      let out: any = { type: 'result', op, points: own, fed: n };

      if (op === 'normals') {
        a.compute_normals(m.k, prog('Computing normals', n));
        if (m.orient) {
          const vps: Float32Array | null = m.viewpoints && m.viewpoints.length >= 3 ? new Float32Array(m.viewpoints) : null;
          const v = m.viewpoint;
          // Propagation first: it makes neighbouring normals agree, which is a local
          // decision and the only one the neighbour graph can make. Then the global sign.
          a.orient_normals(m.k, v ? v[0] : 0, v ? v[1] : 0, v ? v[2] : 0, !!v && !vps, prog('Orienting normals', n));
          // With the scanner's own stations known, the outward direction is "toward the
          // nearest station", decided per point. That overrides the per-component vote,
          // which is wrong for anything scanned from the inside.
          if (vps) { post({ type: 'progress', phase: 'Facing the stations', done: 0, total: n }); a.orient_to_viewpoints(vps); }
        }
      } else if (op === 'invert') {
        a.invert_normals();
      } else if (op === 'feature') {
        const f = a.feature(m.name, m.k, m.radius, own, prog('Computing ' + m.name, n));
        out.kind = 'field';
        out.data = f;
      } else if (op === 'sor_means') {
        // Every point's mean neighbour distance, handed back rather than reduced here. The
        // main thread adds the tiles up, works out one threshold for the whole cloud and
        // applies it, so each neighbourhood is searched once instead of once per pass.
        out.kind = 'means';
        out.data = a.sor_means(m.knn ?? m.k ?? 6, own, prog('Measuring neighbourhoods', n));
      } else if (op === 'sor_stats' || op === 'sor_cut') {
        // The two-pass form, kept because the native tests drive it and because it is the
        // one that needs no memory on the main thread. The viewer uses sor_means: the same
        // first pass, handing back the numbers rather than a summary, so there is no second
        // pass at all.
        if (op === 'sor_stats') {
          const st = a.sor_stats(m.knn ?? m.k ?? 6, own, prog('Measuring neighbourhoods', n));
          out.kind = 'stats';
          out.sum = st[0]; out.sum2 = st[1]; out.count = st[2];
        } else {
          out.kind = 'mask';
          out.data = a.sor_cut(m.knn ?? m.k ?? 6, Number(m.cut), own, prog('Removing outliers', n));
        }
      } else if (op === 'sor') {
        out.kind = 'mask';
        out.data = a.sor(m.knn ?? m.k ?? 6, Number(m.sigma ?? 1), prog('Measuring neighbourhoods', n));
        out.mean = a.mean_distance;
        out.cut = a.cut_distance;
        out.params = { knn: m.knn ?? m.k ?? 6, nSigma: Number(m.sigma ?? 1) };
      } else if (op === 'noise') {
        // CloudCompare's own defaults, so the same settings mean the same thing there:
        // a sphere neighbourhood, a relative threshold, one sigma, isolated points kept.
        // The radius defaults to three point spacings, which is the same idea as their
        // "1% of the bounding box scaled by point count" and lands in the same place.
        out.kind = 'mask';
        const useKnn = !!m.useKnn;
        const radius = m.radius !== undefined ? Number(m.radius) : cell * 1.2;
        out.data = a.noise(useKnn, m.knn ?? m.k ?? 6, radius,
          !!m.useAbsoluteError, Number(m.absoluteError ?? 0), Number(m.sigma ?? 1),
          !!m.removeIsolated, own, prog('Fitting local surfaces', n));
        out.params = {
          neighbourhood: useKnn ? 'knn' : 'radius', knn: m.knn ?? m.k ?? 6, radius,
          threshold: m.useAbsoluteError ? 'absolute' : 'relative',
          absoluteError: Number(m.absoluteError ?? 0), nSigma: Number(m.sigma ?? 1),
          removeIsolated: !!m.removeIsolated,
        };
      } else if (op === 'duplicates') {
        out.kind = 'mask';
        out.data = a.duplicates(m.tol);
      } else if (op === 'subsample') {
        out.kind = 'mask';
        out.data = a.subsample(m.spacing);
      } else if (op === 'components') {
        out.kind = 'field';
        out.data = a.components(m.radius, m.minPts, prog('Growing clusters', n));
        out.components = a.component_count;
      } else if (op === 'distance_to_mesh') {
        // The mesh arrives already in world coordinates, and the analyser's points are read
        // through the cloud's model as they are fed, so both are in the same frame here.
        const reach = Math.max(cell * 200, 2);
        out.kind = 'field';
        out.data = a.distance_to_mesh(new Float32Array(m.meshPos), new Uint32Array(m.meshIdx),
          !!m.signed, reach, prog('Measuring to the mesh', n));
      } else if (op === 'distance_to' || op === 'icp') {
        if (!refStarted || !a.reference_len) throw new Error('no reference cloud was fed');
        post({ type: 'progress', phase: 'Indexing the reference', done: 0, total: a.reference_len });
        a.build_reference();
        if (op === 'distance_to') {
          // A nearest-point query is only worth answering out to a sane range; beyond that the
          // honest answer is "nothing near", which comes back as NaN and draws as "no value".
          const reach = Math.max(cell * 200, 2);
          out.kind = 'field';
          out.data = a.distance_to_reference(!!m.signed, reach, prog('Measuring the distance', n));
        } else {
          // point-to-plane needs planes: a reference with no usable normals gets them here
          if (a.reference_normals < 0.5) {
            post({ type: 'progress', phase: 'The reference has no normals, computing them', done: 0, total: a.reference_len });
            a.compute_reference_normals(16, prog('Reference normals', a.reference_len));
          }
          // the gate starts at three point spacings times the caller's multiplier
          const gate = Math.max(cell * 0.4 * 3 * (m.maxDist ?? 6), cell * 0.5);
          let last = -1;
          const r = JSON.parse(a.icp(Math.max(1, m.maxIter ?? 30), gate, Math.max(1000, m.sample ?? 200000), (it: number, rms: number) => {
            if (it === last) return; last = it;
            post({ type: 'progress', phase: `ICP iteration ${it + 1} · RMS ${(rms * 1000).toFixed(2)} mm`, done: it, total: m.maxIter ?? 30 });
          }));
          Object.assign(out, r);
          out.kind = 'icp';
          out.referenceNormals = a.reference_normals;
        }
      } else {
        throw new Error('unknown analysis: ' + op);
      }

      if (op === 'normals' || op === 'invert') {
        // hand back only the normals; the viewer patches its own records with them
        const nrm = new Int8Array(own * 3);
        nrm.set(a.normals_bytes().subarray(0, own * 3));
        out.kind = 'normals';
        out.data = nrm;
      }
      // A tile answers for its own points only. Everything above was computed over the
      // context points too, because that is what makes the edges right, and this is where
      // they are dropped.
      if (out.data && own < n && out.data.length > own && out.kind !== 'normals') {
        out.data = out.data.subarray(0, own);
      }
      out.ms = performance.now() - t0;
      out.msFeed = msFeed;
      out.msBuild = msBuild;
      out.heap = heapBytes();
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
    const first = armed;
    armed = false;
    try { a?.free(); } catch {}
    a = null;
    // only the first failure is worth reporting; anything after it is a consequence
    if (first) post({ type: 'error', message: String(e?.message ?? e) });
  }
};
