/* tslint:disable */
/* eslint-disable */

/**
 * Neighbourhood analysis driven from a worker. The caller streams in the viewer's own
 * leaf records, runs one analysis, then pulls back either a per-point number (a scalar
 * field), a per-point keep mask, or rewritten normals.
 */
export class CloudAnalysis {
    free(): void;
    [Symbol.dispose](): void;
    add_leaf(ox: number, oy: number, oz: number, size: number, recs: Uint8Array): void;
    build(): void;
    components(radius: number, min_pts: number, progress?: Function | null): Float32Array;
    compute_normals(k: number, progress?: Function | null): void;
    duplicates(tol: number): Uint8Array;
    feature(name: string, k: number, radius: number, progress?: Function | null): Float32Array;
    invert_normals(): void;
    len(): number;
    constructor(cell: number);
    noise(k: number, n_sigma: number, progress?: Function | null): Uint8Array;
    /**
     * Normals interleaved as x,y,z signed bytes, for the viewer to patch into its records.
     */
    normals_bytes(): Int8Array;
    orient_normals(k: number, vx: number, vy: number, vz: number, use_viewpoint: boolean, progress?: Function | null): void;
    rewind(): void;
    /**
     * Returns the keep mask; the mean and cut-off used are reported separately.
     */
    sor(k: number, n_sigma: number, progress?: Function | null): Uint8Array;
    subsample(spacing: number): Uint8Array;
    /**
     * Rewrite the normal bytes of the next leaf, in the order the leaves were added.
     */
    write_normals(recs: Uint8Array): void;
    readonly component_count: number;
    readonly cut_distance: number;
    readonly mean_distance: number;
}

/**
 * Streams points into a new E57 file. Field order: xyz f64 (relative to
 * the pose translation), rgb u8, intensity u8, normal i8.
 */
export class E57Export {
    free(): void;
    [Symbol.dispose](): void;
    add_points(xyz: Float64Array, rgb: Uint8Array, inten: Uint8Array, nrm: Int8Array, n: number): void;
    finish(): number;
    constructor(sink: object, guid: string, name: string, tx: number, ty: number, tz: number, has_color: boolean, has_intensity: boolean, has_normals: boolean);
}

export class E57Handle {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Raw JPEG/PNG bytes of image `idx` (index into the images2D list).
     */
    image_blob(idx: number): Uint8Array;
    /**
     * Everything the UI needs for its scan card. Header + XML only.
     */
    meta(): string;
    constructor(read_range: Function, len: number);
    /**
     * Decode scan `idx` keeping 1 in `stride` points, into an octree.
     *
     * `preview(records: Uint8Array, count, meta: Float64Array[4])` streams a
     * quick sparse preview during decode (about `preview_target` points).
     * `progress(phase, done, total) -> bool` — return true to abort.
     * `leaf(blocks: Array<Uint8Array>, count, meta: Float64Array[10])` is
     * called once per finished leaf: origin xyz, cube size, tight min xyz,
     * tight max xyz. Positions are relative to the scan translation.
     */
    stream(idx: number, stride: number, preview_target: number, mem_limit: number, preview: Function, progress: Function, leaf: Function): object;
}

/**
 * Surface reconstruction, driven from a worker: feed it the viewer's own leaf records,
 * then pull the triangles back out. Buffers are moved, not copied, on the way out.
 */
export class MeshBuilder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * One octree leaf: its cube origin and size, plus the packed 14-byte records.
     */
    add_leaf(ox: number, oy: number, oz: number, size: number, recs: Uint8Array, stride: number): void;
    bricks(): number;
    /**
     * Extract the surface. Returns a JSON summary; the buffers follow.
     */
    build(smooth: number, density_iso: number): string;
    colors(): Uint8Array;
    indices(): Uint32Array;
    constructor(voxel: number, trunc_voxels: number, min_weight: number);
    normals(): Float32Array;
    positions(): Float32Array;
}

/**
 * Octree sink for points that don't come from an E57: PLY, LAS, a device scan.
 * Same cells, same preview, same leaf hand-over as `E57Handle::stream`.
 */
export class PointSink {
    free(): void;
    [Symbol.dispose](): void;
    finish(preview: Function, progress: Function, leaf: Function): object;
    /**
     * `bounds` = [minx,miny,minz,maxx,maxy,maxz] hint (the root grows if points fall outside).
     */
    constructor(bounds: Float64Array, expected: number, mem_limit: number, preview_target: number);
    /**
     * Positions relative to whatever origin the caller chose (keep them small: f32 on the GPU).
     */
    push(xyz: Float64Array, rgb: Uint8Array, inten: Uint8Array, nrm: Int8Array, n: number, preview: Function): void;
}

export function set_window_size(n: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_cloudanalysis_free: (a: number, b: number) => void;
    readonly __wbg_e57export_free: (a: number, b: number) => void;
    readonly __wbg_e57handle_free: (a: number, b: number) => void;
    readonly __wbg_meshbuilder_free: (a: number, b: number) => void;
    readonly __wbg_pointsink_free: (a: number, b: number) => void;
    readonly cloudanalysis_add_leaf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly cloudanalysis_build: (a: number) => void;
    readonly cloudanalysis_component_count: (a: number) => number;
    readonly cloudanalysis_components: (a: number, b: number, c: number, d: number) => [number, number];
    readonly cloudanalysis_compute_normals: (a: number, b: number, c: number) => void;
    readonly cloudanalysis_cut_distance: (a: number) => number;
    readonly cloudanalysis_duplicates: (a: number, b: number) => [number, number];
    readonly cloudanalysis_feature: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly cloudanalysis_invert_normals: (a: number) => void;
    readonly cloudanalysis_len: (a: number) => number;
    readonly cloudanalysis_mean_distance: (a: number) => number;
    readonly cloudanalysis_new: (a: number) => number;
    readonly cloudanalysis_noise: (a: number, b: number, c: number, d: number) => [number, number];
    readonly cloudanalysis_normals_bytes: (a: number) => [number, number];
    readonly cloudanalysis_orient_normals: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly cloudanalysis_rewind: (a: number) => void;
    readonly cloudanalysis_sor: (a: number, b: number, c: number, d: number) => [number, number];
    readonly cloudanalysis_subsample: (a: number, b: number) => [number, number];
    readonly cloudanalysis_write_normals: (a: number, b: number, c: number, d: any) => void;
    readonly e57export_add_points: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly e57export_finish: (a: number) => [number, number, number];
    readonly e57export_new: (a: any, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly e57handle_image_blob: (a: number, b: number) => [number, number, number];
    readonly e57handle_meta: (a: number) => [number, number];
    readonly e57handle_new: (a: any, b: number) => [number, number, number];
    readonly e57handle_stream: (a: number, b: number, c: number, d: number, e: number, f: any, g: any, h: any) => [number, number, number];
    readonly meshbuilder_add_leaf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly meshbuilder_bricks: (a: number) => number;
    readonly meshbuilder_build: (a: number, b: number, c: number) => [number, number];
    readonly meshbuilder_colors: (a: number) => [number, number];
    readonly meshbuilder_indices: (a: number) => [number, number];
    readonly meshbuilder_new: (a: number, b: number, c: number) => number;
    readonly meshbuilder_normals: (a: number) => [number, number];
    readonly meshbuilder_positions: (a: number) => [number, number];
    readonly pointsink_finish: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly pointsink_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly pointsink_push: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: any) => [number, number];
    readonly set_window_size: (a: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
