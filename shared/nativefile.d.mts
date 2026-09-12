// SPDX-License-Identifier: GPL-3.0-only
export declare const NATIVE: string;
export interface NativeDescriptor {
  id: number; name: string; path: string; size: number; lastModified: number; url: string;
}
export declare function nativeDescriptor(d: NativeDescriptor): NativeDescriptor & Record<string, unknown>;
export declare function isNative(f: unknown): boolean;
export declare function nativeReadRange(d: NativeDescriptor, onBytes?: (n: number) => void): (offset: number, length: number) => Uint8Array;
export declare class NativeFile {
  constructor(d: NativeDescriptor);
  descriptor: NativeDescriptor;
  name: string; size: number; lastModified: number; path: string; id: number; url: string;
  bytes(offset: number, length: number): Promise<Uint8Array>;
  slice(start?: number, end?: number): { size: number; arrayBuffer(): Promise<ArrayBuffer> };
  arrayBuffer(): Promise<ArrayBuffer>;
}
