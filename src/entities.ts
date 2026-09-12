// SPDX-License-Identifier: GPL-3.0-only
// Entities: more than one cloud open at once.
//
// Registration, cloud-to-cloud distance and merging all need two clouds in memory, so the
// renderer stopped being "the" cloud and became one per entity. Each entity owns its leaves,
// its model matrix and its scalar field (all inside its own `CellRenderer`), plus the
// bookkeeping that used to be module-level state in main.ts: the file it came from, its E57
// metadata, the loader's histograms, its reconstructed surface.
//
// Exactly one entity is active. Every tool — crop, sections, lasso, analysis, surface,
// transform, export, save — acts on the active one, and that is deliberate: a tool that
// silently spanned several clouds would be impossible to reason about. The draw loop is the
// exception, because seeing two clouds at once is the whole point.
//
// The active entity's share of what used to be module state is swapped in and out around a
// switch rather than being read through an accessor at a hundred call sites. `capture` and
// `restore` are the two halves of that, and they are the only places that have to know the
// list of things an entity remembers.

import * as THREE from 'three';
import { CellRenderer } from './cells';
import { MeshView, type MeshData } from './meshview';

/** The part of an entity that main.ts holds in module variables while it is active. */
export interface EntityState {
  meta: any;
  file: File | null;
  handle: any;
  cacheKey: string;
  fromCache: boolean;
  cropped: boolean;
  histogram: Uint32Array<ArrayBuffer>;
  axisHist: Uint32Array<ArrayBuffer>[];
  axisCube: { origin: number[]; size: number } | null;
  sfName: string;
  /** Set for a layer that came from a mesh file rather than a scan. */
  meshFile: string;
  meshData: MeshData | null;
  meshBase: THREE.Matrix4;
  meshInfo: { triangles: number; vertices: number; boundaryEdges: number; voxelCm: number; fromNormals: boolean } | null;
  dirtyField: string;
  dirtySurface: number;
}

export function blankState(): EntityState {
  return {
    meta: null, file: null, handle: null, cacheKey: '', fromCache: false, cropped: false,
    histogram: new Uint32Array(256),
    axisHist: [new Uint32Array(1024), new Uint32Array(1024), new Uint32Array(1024)],
    axisCube: null,
    sfName: '', meshFile: '', meshData: null, meshBase: new THREE.Matrix4(), meshInfo: null,
    dirtyField: '', dirtySurface: 0,
  };
}

export class Entity {
  readonly id: string;
  name: string;
  visible = true;
  cells: CellRenderer;
  /** Each entity draws its own surface. It used to be one renderer for "the" mesh, which
   *  meant only the active layer's surface was ever on screen — wrong the moment a mesh
   *  became a layer in its own right rather than a by-product of the active cloud. */
  mesh: MeshView;
  /** Percentile framing box, in world space. Null until the loader reports one. */
  robust: THREE.Box3 | null = null;
  /** An optional colour multiplier, so two overlapping scans can be told apart. */
  tint = { on: false, color: '#66ccff' };
  state: EntityState = blankState();

  constructor(gl: WebGL2RenderingContext, id: string, name: string) {
    this.id = id; this.name = name;
    this.cells = new CellRenderer(gl);
    this.mesh = new MeshView(gl);
  }
  /** True for a layer that is a mesh rather than a cloud: no points, triangles instead. */
  get isMesh() { return this.cells.total === 0 && this.mesh.hasMesh; }
  /** Anything to draw at all. */
  get hasContent() { return this.cells.total > 0 || this.mesh.hasMesh; }
  get points() { return this.cells.total; }
  /** The box a tool should work in: the percentile box when there is one, else the cells'. */
  bounds(): THREE.Box3 {
    return this.robust && !this.robust.isEmpty() ? this.robust : this.cells.bounds;
  }
  /** The colour multiplier the shader wants: 1,1,1 when the tint is off. */
  tintRgb(): [number, number, number] {
    if (!this.tint.on) return [1, 1, 1];
    const c = new THREE.Color(this.tint.color);
    return [c.r, c.g, c.b];
  }
  dispose(gl: WebGL2RenderingContext) { this.cells.clear(); this.mesh.clear(); void gl; }
}
