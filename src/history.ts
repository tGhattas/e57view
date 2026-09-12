// Undo / redo of in-memory edits: crop, clean, computed normals, cloud transform.
//
// A point-dropping step keeps the dropped 14-byte records plus a bit-mask of original
// order so undo can re-interleave exactly (the shuffled LOD prefix stays
// uniform). Small steps stay in RAM; large ones spill to OPFS so a 15-million
// point crop does not pin ~200 MB on the heap. Save / reload / a new file
// discards the stack.
//
// A normals step is the same shape with a smaller payload — three bytes per point of the
// previous orientation — so it rides the same spill machinery. A transform step carries two
// 4x4 matrices and nothing else, which is the whole point of not baking them.

import * as THREE from 'three';
import type { NormalsUndo, Region, UndoRecord } from './cells';

const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export type HistKind = 'crop' | 'clean' | 'normals' | 'transform';

/** The cloud's model matrix either side of the change, column-major (three.js order). */
export interface TransformRecord { prev: number[]; next: number[] }

export interface UiSnap {
  cropped: boolean;
  cropOn: boolean;
  crop: Region;
  frac: number[];
  sections: Region[];
  deletes: Region[];
}

export interface HistEntry {
  id: string;
  kind: HistKind;
  label: string;
  dropped: number;
  kept: number;
  /** Dropped records, for the kinds that drop points. */
  undo: UndoRecord | null;
  /** Previous normal bytes, 3 per point, leaf by leaf in `records()` order. */
  normals?: NormalsUndo;
  transform?: TransformRecord;
  robust: THREE.Box3;
  before: UiSnap;
  after: UiSnap;
  spilled: boolean;
}

/** Whatever bytes this entry needs to hold on to. A transform entry has none. */
function payload(e: HistEntry): { leaves: { recs: Uint8Array }[]; bytes: number } | null {
  return e.undo ?? e.normals ?? null;
}

export type HistoryIo = {
  write(id: string, i: number, recs: Uint8Array): Promise<void>;
  read(id: string, i: number): Promise<Uint8Array>;
  drop(id: string): Promise<void>;
  clear(): Promise<void>;
};

const DIR = 'e57view-undo';
export const RAM_BUDGET = coarse ? 96e6 : 384e6;
const SPILL_AT = 24e6;

export function cloneRegion(r: Region): Region {
  return { id: r.id, kind: r.kind, role: r.role, center: [...r.center], half: [...r.half], radius: r.radius, quat: [...r.quat], label: r.label };
}
export function cloneRegions(rs: Region[]): Region[] { return rs.map(cloneRegion); }

export class History {
  undo: HistEntry[] = [];
  redo: HistEntry[] = [];
  onChange: (() => void) | null = null;
  /** True after a spill failed on both the worker and main-thread paths. */
  diskFail = false;
  private n = 0;
  private io: HistoryIo | null;

  constructor(opts: { io?: HistoryIo } = {}) { this.io = opts.io ?? null; }

  get ram(): number {
    let n = 0;
    for (const e of [...this.undo, ...this.redo]) { const p = payload(e); if (p && !e.spilled) n += p.bytes; }
    return n;
  }
  get canUndo() { return this.undo.length > 0; }
  get canRedo() { return this.redo.length > 0; }
  get steps() { return { undo: this.undo.length, redo: this.redo.length, ram: this.ram }; }

  snapshot(p: { cropped: boolean; cropOn: boolean; crop: Region; frac: number[]; sections: Region[]; deletes: Region[] }): UiSnap {
    return { cropped: p.cropped, cropOn: p.cropOn, crop: cloneRegion(p.crop), frac: p.frac.slice(), sections: cloneRegions(p.sections), deletes: cloneRegions(p.deletes) };
  }

  async push(partial: Omit<HistEntry, 'id' | 'spilled'>): Promise<HistEntry> {
    await this.discard(this.redo); this.redo.length = 0;
    const e: HistEntry = { ...partial, id: 'h' + (++this.n), spilled: false };
    const p = payload(e);
    if (p && (p.bytes >= SPILL_AT || this.ram + p.bytes > RAM_BUDGET)) await this.spill(e);
    this.undo.push(e);
    await this.evict();
    this.onChange?.();
    return e;
  }

  peekUndo() { return this.undo[this.undo.length - 1] ?? null; }
  peekRedo() { return this.redo[this.redo.length - 1] ?? null; }

  movedToRedo(e: HistEntry) { if (this.undo[this.undo.length - 1] === e) this.undo.pop(); this.redo.push(e); this.onChange?.(); }
  movedToUndo(e: HistEntry) { if (this.redo[this.redo.length - 1] === e) this.redo.pop(); this.undo.push(e); this.onChange?.(); }

  /** An undo or redo refilled `recs` from the GPU; count them toward the RAM budget and
   *  spill again if needed. */
  async afterRedo(e: HistEntry) {
    const p = payload(e); if (!p) return;
    p.bytes = p.leaves.reduce((n, l) => n + l.recs.byteLength + ((l as { mask?: Uint8Array }).mask?.byteLength ?? 0), 0);
    e.spilled = !p.leaves.some(l => l.recs.byteLength);
    await this.evict();
  }

  async clear() {
    await this.discard(this.undo); await this.discard(this.redo);
    this.undo = []; this.redo = []; this.diskFail = false; this.onChange?.();
  }

  async fetch(e: HistEntry, i: number): Promise<Uint8Array> {
    const recs = payload(e)?.leaves[i]?.recs;
    if (recs && recs.byteLength) return recs;
    return this.readSpill(e.id, i);
  }

  private async evict() {
    let ram = this.ram;
    for (const e of this.undo) {
      if (ram <= RAM_BUDGET) break;
      const p = payload(e);
      if (p && !e.spilled) { ram -= p.bytes; await this.spill(e); }
    }
  }

  private async spill(e: HistEntry) {
    const p = payload(e); if (!p) return;
    try {
      for (let i = 0; i < p.leaves.length; i++) {
        const recs = p.leaves[i].recs;
        if (!recs.byteLength) continue;
        const copy = new Uint8Array(recs.byteLength); copy.set(recs);
        try {
          if (this.io) await this.io.write(e.id, i, copy);
          else await this.writeMain(e.id, i, copy);
        } catch (err) {
          if (!this.io) throw err;
          const copy2 = new Uint8Array(recs.byteLength); copy2.set(recs);
          await this.writeMain(e.id, i, copy2);
        }
        p.leaves[i].recs = new Uint8Array(0);
        if ((i & 7) === 7) await new Promise(r => setTimeout(r, 0));
      }
      e.spilled = true;
      this.diskFail = false;
    } catch (err) {
      console.warn('undo spill failed; keeping the step in RAM', err);
      this.diskFail = true;
      this.onChange?.();
    }
  }

  private async writeMain(id: string, i: number, recs: Uint8Array) {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(DIR, { create: true });
    const ed = await d.getDirectoryHandle(id, { create: true });
    const fh = await ed.getFileHandle(i + '.bin', { create: true });
    const w = await fh.createWritable();
    await w.write(recs.buffer as ArrayBuffer);
    await w.close();
  }

  private async readSpill(id: string, i: number): Promise<Uint8Array> {
    if (this.io) {
      try { return await this.io.read(id, i); } catch { /* fall through */ }
    }
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(DIR);
    const ed = await d.getDirectoryHandle(id);
    const fh = await ed.getFileHandle(i + '.bin');
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  }

  private async discard(list: HistEntry[]) {
    if (!list.length) return;
    for (const e of list) {
      try {
        if (this.io) await this.io.drop(e.id);
        else await this.dropMain(e.id);
      } catch {
        try { await this.dropMain(e.id); } catch {}
      }
      for (const l of payload(e)?.leaves ?? []) l.recs = new Uint8Array(0);
      e.spilled = true;
    }
  }

  private async dropMain(id: string) {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(DIR);
    await d.removeEntry(id, { recursive: true });
  }
}
