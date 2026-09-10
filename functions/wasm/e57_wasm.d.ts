/* tslint:disable */
/* eslint-disable */

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
