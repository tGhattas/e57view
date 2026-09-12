// A file on disk, made to look like a `File` to code that never wanted one.
//
// Every decoder in this project is written against `readRange(offset, length) -> Uint8Array`
// plus a size and a name, because the whole point of the E57 reader is that a multi-gigabyte
// file never enters memory. In a browser that callback is `FileReaderSync` over
// `File.slice()`. In the desktop build there is no `File` — the user picked a path, or
// dropped one from Finder — so the shell serves byte ranges over a custom URL scheme and the
// worker reads them with a **synchronous XHR**, which workers are allowed to do.
//
// That choice is deliberate. The alternatives are a SharedArrayBuffer with an `Atomics.wait`
// handshake back to the main thread (needs cross-origin isolation, and a main thread that is
// never busy) or making the whole decoder async (a rewrite of the Rust `Read` impl). A
// blocking range request inside a worker is the small answer, and it is the same shape as the
// browser path so nothing downstream changes.

export const NATIVE = '__e57native';

/** The plain object that survives `postMessage` into a worker. */
export function nativeDescriptor({ id, name, path, size, lastModified, url }) {
  return { [NATIVE]: true, id, name, path, size, lastModified, url };
}
export const isNative = (f) => !!f && f[NATIVE] === true;

/** A synchronous `readRange` over a native file. Worker only: a document may not block. */
export function nativeReadRange(d, onBytes) {
  const xhr = new XMLHttpRequest();
  let binary = false;          // true once responseType turns out to be unavailable
  return (offset, length) => {
    const len = Math.min(length, Math.max(0, d.size - offset));
    if (len <= 0) return new Uint8Array(0);
    xhr.open('GET', `${d.url}?off=${offset}&len=${len}`, false);
    if (!binary) {
      try { xhr.responseType = 'arraybuffer'; }
      catch { binary = true; }
    }
    if (binary) xhr.overrideMimeType('text/plain; charset=x-user-defined');
    xhr.send(null);
    if (xhr.status && xhr.status !== 200) throw new Error(`could not read ${d.name} at ${offset}: HTTP ${xhr.status}`);
    let out;
    if (!binary && xhr.response) out = new Uint8Array(xhr.response);
    else {
      // the fallback every engine supports: bytes smuggled through a string
      const s = xhr.responseText ?? '';
      out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    }
    onBytes?.(out.byteLength);
    return out;
  };
}

/** Enough of `File` for the main thread: name, size, and async slices. */
export class NativeFile {
  constructor(d) {
    this.descriptor = d;
    this.name = d.name;
    this.size = d.size;
    this.lastModified = d.lastModified;
    this.path = d.path;
    this[NATIVE] = true;
    this.id = d.id;
    this.url = d.url;
  }
  /** Async, unlike the worker's: nothing on the main thread may block on a socket. */
  async bytes(offset, length) {
    const len = Math.min(length, Math.max(0, this.size - offset));
    if (len <= 0) return new Uint8Array(0);
    const r = await fetch(`${this.url}?off=${offset}&len=${len}`);
    if (!r.ok) throw new Error(`could not read ${this.name}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  slice(start = 0, end = this.size) {
    const self = this;
    return {
      size: Math.max(0, end - start),
      async arrayBuffer() { return (await self.bytes(start, end - start)).buffer; },
    };
  }
  async arrayBuffer() { return (await this.bytes(0, this.size)).buffer; }
}
