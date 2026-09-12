export type Ranged = (offset: number, length: number) => Uint8Array;
export type Batch = { xyz: Float64Array; rgb: Uint8Array; inten: Uint8Array; nrm: Int8Array; cls?: Uint8Array; n: number; read: number };
export type ColumnMap = { x: number; y: number; z: number; r: number; g: number; b: number; i: number; nx: number; ny: number; nz: number; s?: number };

export const ASCII_EXT: string[];
export function sniff(name: string, readRange: Ranged): 'e57' | 'ply' | 'las' | 'laz' | 'ptx' | 'ascii' | null;
export function plyHeader(readRange: Ranged): any;
export function lasHeader(readRange: Ranged): any;
export function parsePly(readRange: Ranged, size: number, name: string, onMeta: (m: any) => void, onBatch: (b: Batch) => void, onProgress?: (read: number, total: number) => void): { read: number };
export function parseLas(readRange: Ranged, size: number, name: string, onMeta: (m: any) => void, onBatch: (b: Batch) => void, onProgress?: (read: number, total: number) => void, opts?: { makeLaz?: (vlr: Uint8Array, offset: number, recLen: number) => { read(n: number): Uint8Array } }): { read: number };
export function asciiGuess(text: string): { delim: string; header: string[] | null; cols: number; sample: string[][]; map: ColumnMap; lines: number };
export function parseAscii(readRange: Ranged, size: number, name: string, map: ColumnMap, delim: string, skip: number, onMeta: (m: any) => void, onBatch: (b: Batch) => void, onProgress?: (read: number, total: number) => void): { read: number };
export function parsePtx(readRange: Ranged, size: number, name: string, onMeta: (m: any) => void, onBatch: (b: Batch) => void, onProgress?: (read: number, total: number) => void): { read: number };
