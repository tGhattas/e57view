/// <reference lib="webworker" />
import init, { E57Handle, set_window_size } from './wasm/e57_wasm.js';
import wasmUrl from './wasm/e57_wasm_bg.wasm?url';
import { isNative, nativeReadRange } from '../shared/nativefile.mjs';

let ready: Promise<unknown> | null = null;
const post = (m: any, t?: Transferable[]) => (self as any).postMessage(m, t ?? []);

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (!ready) ready = init({ module_or_path: wasmUrl });
    await ready;
    if (msg.type !== 'open') return;

    const file: File = msg.file;
    let bytesPulled = 0;
    // FileReaderSync is worker-only and synchronous: exactly what the Rust `Read` impl
    // needs. The multi-GB file never enters wasm memory, and this needs no
    // SharedArrayBuffer / COOP / COEP. The desktop build has no `File` to slice — the user
    // gave a path — so the same callback is served by the shell over a custom URL scheme.
    const readRange = isNative(file)
      ? nativeReadRange(file as any, (n: number) => { bytesPulled += n; })
      : (() => {
          const fr = new FileReaderSync();
          return (offset: number, length: number): Uint8Array => {
            const end = Math.min(offset + length, file.size);
            const buf = fr.readAsArrayBuffer(file.slice(offset, end));
            bytesPulled += buf.byteLength;
            return new Uint8Array(buf);
          };
        })();

    set_window_size(8 * 1024 * 1024);
    const t0 = performance.now();
    const h = new E57Handle(readRange, file.size);
    const meta = JSON.parse(h.meta());
    post({ type: 'meta', meta, openMs: performance.now() - t0, bytesPulled });

    const scanIndex: number = msg.scanIndex ?? 0;
    const stride: number = Math.max(1, msg.stride | 0);
    const memLimit: number = msg.memLimit ?? 3.0e9;
    const scan = meta.scans[scanIndex];
    post({ type: 'plan', stride, willKeep: Math.floor(scan.points / stride) });

    const tD = performance.now();
    let lastProgress = 0;
    const stats = h.stream(scanIndex, stride, 1_200_000, memLimit,
      // preview: sparse points quantised to the root cube, streamed during decode
      (rec: Uint8Array, count: number, m: Float64Array) => {
        post({ type: 'preview', block: rec.buffer, count,
               meta: { origin: [m[0], m[1], m[2]], size: m[3],
                       bmin: [m[0], m[1], m[2]], bmax: [m[0] + m[3], m[1] + m[3], m[2] + m[3]] } },
             [rec.buffer]);
      },
      // progress: phase 0 = decoding records, phase 1 = finalising leaves
      (phase: number, done: number, total: number) => {
        const now = performance.now();
        if (now - lastProgress > 80 || done >= total) {
          lastProgress = now;
          post({ type: 'progress', phase, done, total, elapsed: now - tD, bytesPulled });
        }
        return false;
      },
      // leaf: shuffled 14-byte records in blocks, origin/size cube, tight bounds
      (blocks: Uint8Array[], count: number, m: Float64Array) => {
        const bufs = blocks.map(b => b.buffer as ArrayBuffer);
        post({ type: 'leaf', blocks: bufs, count,
               meta: { origin: [m[0], m[1], m[2]], size: m[3],
                       bmin: [m[4], m[5], m[6]], bmax: [m[7], m[8], m[9]] } }, bufs);
      },
    );
    post({ type: 'done', ms: performance.now() - tD, bytesPulled, stats });
  } catch (e: any) {
    post({ type: 'error', message: String(e?.message ?? e) });
  }
};
