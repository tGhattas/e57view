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
    /**
     * `model` is the cloud's 4x4 transform in **row-major** order, or empty for identity.
     */
    add_leaf(ox: number, oy: number, oz: number, size: number, recs: Uint8Array, model: Float32Array): void;
    /**
     * One leaf of the reference. `stride` keeps 1 in N, for a cloud bigger than the
     * analyser will hold; `model` is its own row-major 4x4, so both clouds arrive in the
     * same frame however each of them is transformed on screen.
     */
    add_reference_leaf(ox: number, oy: number, oz: number, size: number, recs: Uint8Array, model: Float32Array, stride: number): void;
    build(): void;
    build_reference(): void;
    components(radius: number, min_pts: number, progress?: Function | null): Float32Array;
    compute_normals(k: number, progress?: Function | null): void;
    /**
     * Point-to-plane registration needs planes, so a reference without usable normals
     * gets them computed here rather than failing or silently falling back.
     */
    compute_reference_normals(k: number, progress?: Function | null): void;
    /**
     * Distance from every point of this cloud to the nearest triangle of a mesh.
     *
     * The mesh arrives in the same frame as the points — the caller has already put it
     * through both the mesh's and the cloud's transforms — so this is pure geometry.
     * `signed` reports which side of the surface each point is on, using the triangle's
     * own facing, which is only meaningful on a consistently wound mesh.
     */
    distance_to_mesh(pos: Float32Array, idx: Uint32Array, signed: boolean, max_r: number, progress?: Function | null): Float32Array;
    distance_to_reference(signed: boolean, max_r: number, progress?: Function | null): Float32Array;
    duplicates(tol: number): Uint8Array;
    feature(name: string, k: number, radius: number, progress?: Function | null): Float32Array;
    /**
     * Run ICP and report what it did, as JSON. `max_dist` is the starting rejection gate
     * in metres; it tightens to 15% of that as the fit settles.
     */
    icp(max_iter: number, max_dist: number, sample: number, progress?: Function | null): string;
    invert_normals(): void;
    len(): number;
    constructor(cell: number);
    /**
     * CloudCompare's noise filter, with all of its options: a kNN or a sphere
     * neighbourhood, a relative (n sigma) or absolute distance threshold, and whether
     * points with too few neighbours to fit a plane are dropped or kept.
     */
    noise(use_knn: boolean, knn: number, radius: number, use_absolute_error: boolean, absolute_error: number, n_sigma: number, remove_isolated: boolean, progress?: Function | null): Uint8Array;
    /**
     * Normals interleaved as x,y,z signed bytes, for the viewer to patch into its records.
     */
    normals_bytes(): Int8Array;
    orient_normals(k: number, vx: number, vy: number, vz: number, use_viewpoint: boolean, progress?: Function | null): void;
    /**
     * Turn each normal toward the nearest scanner station. `vps` is a flat x,y,z list in
     * the same frame as the points (so already through the cloud's model matrix).
     */
    orient_to_viewpoints(vps: Float32Array): void;
    rewind(): void;
    /**
     * Returns the keep mask; the mean and cut-off used are reported separately.
     */
    sor(k: number, n_sigma: number, progress?: Function | null): Uint8Array;
    start_reference(cell: number): void;
    subsample(spacing: number): Uint8Array;
    /**
     * Rewrite the normal bytes of the next leaf, in the order the leaves were added.
     */
    write_normals(recs: Uint8Array): void;
    readonly component_count: number;
    readonly cut_distance: number;
    readonly mean_distance: number;
    readonly reference_len: number;
    readonly reference_normals: number;
}

/**
 * RANSAC detection. `labels` is one shape index per point, -1 for the points no shape
 * claimed, in the order they were handed in.
 */
export class Detection {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    labels(): Int32Array;
    readonly json: string;
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

export class LazReader {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `vlr` is the body of the "laszip encoded" VLR (user id "laszip encoded", record 22204);
     * `offset` is the file's offset to point data; `rec_len` the uncompressed record length.
     */
    constructor(read_range: Function, len: number, vlr: Uint8Array, offset: number, rec_len: number);
    /**
     * The next `n` points, as uncompressed LAS point records.
     */
    read(n: number): Uint8Array;
    seek_point(index: number): void;
}

/**
 * Compresses LAS point records into a LAZ file through the same sink the E57 writer uses.
 */
export class LazWriter {
    free(): void;
    [Symbol.dispose](): void;
    add_points(recs: Uint8Array): void;
    /**
     * Flush the last chunk and write the chunk table. Returns where the data ends.
     */
    finish(): number;
    /**
     * `fmt` is the LAS point format and `extra` the number of extra bytes per record.
     */
    constructor(sink: object, at: number, fmt: number, extra: number);
    /**
     * The VLR body that has to go in the file's header, describing how it was compressed.
     */
    vlr(): Uint8Array;
    readonly count: number;
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
     * `model` is the cloud's 4x4 transform in **row-major** order, or empty for identity.
     */
    add_leaf(ox: number, oy: number, oz: number, size: number, recs: Uint8Array, stride: number, model: Float32Array): void;
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
 * A mesh prepared for distance queries. Built once, queried a cloud at a time.
 */
export class MeshDistance {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Distance from every point to the nearest triangle. `signed` gives the side.
     */
    distances(pts: Float32Array, signed: boolean, max_r: number, progress?: Function | null): Float32Array;
    constructor(pos: Float32Array, idx: Uint32Array);
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
     * `cls` is optional: pass an empty slice when the source has no classification.
     */
    push(xyz: Float64Array, rgb: Uint8Array, inten: Uint8Array, nrm: Int8Array, cls: Uint8Array, n: number, preview: Function): void;
}

export function detect_shapes(xyz: Float32Array, nrm: Float32Array, tol: number, min_pts: number, max_shapes: number, kinds: string, trials: number, progress?: Function | null): Detection;

/**
 * Fit one primitive to a set of points. `xyz` is x,y,z triples; `nrm` the same length for
 * a cylinder (its axis comes from the normals) and may be empty otherwise.
 */
export function fit_shape(kind: string, xyz: Float32Array, nrm: Float32Array): string;

/**
 * The laszip VLR body for a point format, so a caller can lay out the file's header
 * before it starts compressing: the offset to point data depends on this record's length.
 */
export function laz_vlr(fmt: number, extra: number): Uint8Array;

export function set_window_size(n: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_cloudanalysis_free: (a: number, b: number) => void;
    readonly __wbg_detection_free: (a: number, b: number) => void;
    readonly __wbg_e57export_free: (a: number, b: number) => void;
    readonly __wbg_e57handle_free: (a: number, b: number) => void;
    readonly __wbg_lazreader_free: (a: number, b: number) => void;
    readonly __wbg_lazwriter_free: (a: number, b: number) => void;
    readonly __wbg_meshbuilder_free: (a: number, b: number) => void;
    readonly __wbg_meshdistance_free: (a: number, b: number) => void;
    readonly __wbg_pointsink_free: (a: number, b: number) => void;
    readonly cloudanalysis_add_leaf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly cloudanalysis_add_reference_leaf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly cloudanalysis_build: (a: number) => void;
    readonly cloudanalysis_build_reference: (a: number) => void;
    readonly cloudanalysis_component_count: (a: number) => number;
    readonly cloudanalysis_components: (a: number, b: number, c: number, d: number) => [number, number];
    readonly cloudanalysis_compute_normals: (a: number, b: number, c: number) => void;
    readonly cloudanalysis_compute_reference_normals: (a: number, b: number, c: number) => void;
    readonly cloudanalysis_cut_distance: (a: number) => number;
    readonly cloudanalysis_distance_to_mesh: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly cloudanalysis_distance_to_reference: (a: number, b: number, c: number, d: number) => [number, number];
    readonly cloudanalysis_duplicates: (a: number, b: number) => [number, number];
    readonly cloudanalysis_feature: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly cloudanalysis_icp: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly cloudanalysis_invert_normals: (a: number) => void;
    readonly cloudanalysis_len: (a: number) => number;
    readonly cloudanalysis_mean_distance: (a: number) => number;
    readonly cloudanalysis_new: (a: number) => number;
    readonly cloudanalysis_noise: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly cloudanalysis_normals_bytes: (a: number) => [number, number];
    readonly cloudanalysis_orient_normals: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly cloudanalysis_orient_to_viewpoints: (a: number, b: number, c: number) => void;
    readonly cloudanalysis_reference_len: (a: number) => number;
    readonly cloudanalysis_reference_normals: (a: number) => number;
    readonly cloudanalysis_rewind: (a: number) => void;
    readonly cloudanalysis_sor: (a: number, b: number, c: number, d: number) => [number, number];
    readonly cloudanalysis_start_reference: (a: number, b: number) => void;
    readonly cloudanalysis_subsample: (a: number, b: number) => [number, number];
    readonly cloudanalysis_write_normals: (a: number, b: number, c: number, d: any) => void;
    readonly detect_shapes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => number;
    readonly detection_json: (a: number) => [number, number];
    readonly detection_labels: (a: number) => [number, number];
    readonly e57export_add_points: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly e57export_finish: (a: number) => [number, number, number];
    readonly e57export_new: (a: any, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly e57handle_image_blob: (a: number, b: number) => [number, number, number];
    readonly e57handle_meta: (a: number) => [number, number];
    readonly e57handle_new: (a: any, b: number) => [number, number, number];
    readonly e57handle_stream: (a: number, b: number, c: number, d: number, e: number, f: any, g: any, h: any) => [number, number, number];
    readonly fit_shape: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly laz_vlr: (a: number, b: number) => [number, number, number, number];
    readonly lazreader_new: (a: any, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly lazreader_read: (a: number, b: number) => [number, number, number, number];
    readonly lazreader_seek_point: (a: number, b: number) => [number, number];
    readonly lazwriter_add_points: (a: number, b: number, c: number) => [number, number];
    readonly lazwriter_count: (a: number) => number;
    readonly lazwriter_finish: (a: number) => [number, number, number];
    readonly lazwriter_new: (a: any, b: number, c: number, d: number) => [number, number, number];
    readonly lazwriter_vlr: (a: number) => [number, number, number, number];
    readonly meshbuilder_add_leaf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly meshbuilder_bricks: (a: number) => number;
    readonly meshbuilder_build: (a: number, b: number, c: number) => [number, number];
    readonly meshbuilder_colors: (a: number) => [number, number];
    readonly meshbuilder_indices: (a: number) => [number, number];
    readonly meshbuilder_new: (a: number, b: number, c: number) => number;
    readonly meshbuilder_normals: (a: number) => [number, number];
    readonly meshbuilder_positions: (a: number) => [number, number];
    readonly meshdistance_distances: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly meshdistance_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly pointsink_finish: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly pointsink_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly pointsink_push: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: any) => [number, number];
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
