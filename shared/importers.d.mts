export function sniff(name: string, readRange: (offset: number, length: number) => Uint8Array): 'e57' | 'ply' | 'las' | 'laz' | null;
export interface ImportMeta { name: string; points: number; translation: number[]; bounds: number[]; hasColor: boolean; hasIntensity: boolean; hasNormals: boolean; format: string; version?: string; pointFormat?: number }
export interface ImportBatch { xyz: Float64Array; rgb: Uint8Array; inten: Uint8Array; nrm: Int8Array; n: number; read: number }
export function parsePly(readRange: (o: number, l: number) => Uint8Array, size: number, name: string, onMeta: (m: ImportMeta) => void, onBatch: (b: ImportBatch) => void, onProgress?: (read: number, count: number) => void): { read: number };
export function parseLas(readRange: (o: number, l: number) => Uint8Array, size: number, name: string, onMeta: (m: ImportMeta) => void, onBatch: (b: ImportBatch) => void, onProgress?: (read: number, count: number) => void): { read: number };
