export declare const MESH_EXT: string[];
export declare function sniffMesh(name: string, head: Uint8Array): 'ply' | 'obj' | 'stl' | null;
export declare function parseMesh(kind: string, buf: ArrayBuffer): {
  pos: Float32Array; nrm: Float32Array; col: Uint8Array; idx: Uint32Array;
  origin: number[]; badIndices: number;
};
export declare function meshToStl(pos: Float32Array, idx: Uint32Array,
  xform: (x: number, y: number, z: number, out: number[]) => void): ArrayBuffer;
