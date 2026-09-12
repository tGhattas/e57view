// The desktop shell, seen from the page.
//
// Loaded only when the build flag and the Tauri global both say so, so the web bundle never
// carries any of it. Everything here is one of the three things a web page cannot do: open a
// file by path, write one to a path the user chose, and talk to a menu bar. The viewer itself
// is unchanged — the shell hands it a `File`-shaped thing and listens for what the user asked
// for, and every actual behaviour stays in main.ts where the web build already had it.
import { NativeFile, type NativeDescriptor } from '../shared/nativefile.mjs';

type Tauri = {
  core: { invoke<T = any>(cmd: string, args?: any): Promise<T> };
  event: { listen(name: string, fn: (e: { payload: any }) => void): Promise<() => void> };
  dialog: {
    open(o: any): Promise<string | string[] | null>;
    save(o: any): Promise<string | null>;
    message(m: string, o?: any): Promise<void>;
  };
};
const T = () => (window as any).__TAURI__ as Tauri;
export const inTauri = typeof (window as any).__TAURI__ !== 'undefined';

export const SCAN_EXT = ['e57', 'ply', 'las', 'laz', 'ptx', 'txt', 'xyz', 'pts', 'asc', 'csv', 'neu', 'obj', 'stl'];
export const MESH_EXT_D = ['ply', 'obj', 'stl'];

/** Register a path with the shell and get something the viewer can treat as a File. */
export async function nativeFile(path: string): Promise<NativeFile> {
  const d = await T().core.invoke<NativeDescriptor>('native_open', { path });
  return new NativeFile(d);
}
export async function closeNative(id: number) {
  try { await T().core.invoke('native_close', { id }); } catch {}
}

export async function openDialog(opts: { multiple?: boolean; title?: string; extensions?: string[] } = {}): Promise<string[]> {
  const r = await T().dialog.open({
    multiple: !!opts.multiple,
    title: opts.title ?? 'Open',
    filters: [{ name: 'Point clouds and meshes', extensions: opts.extensions ?? SCAN_EXT }],
  });
  return r == null ? [] : Array.isArray(r) ? r : [r];
}
export async function saveDialog(defaultName: string, extensions: string[]): Promise<string | null> {
  return await T().dialog.save({
    defaultPath: defaultName,
    filters: [{ name: extensions.join('/').toUpperCase(), extensions }],
  });
}

/** Stream a Blob out to a path. Chunked and base64 because Tauri's IPC would otherwise
 *  serialise a byte array as a JSON array of numbers — a third more bytes beats ten times. */
export async function writeBlobTo(blob: Blob, path: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  const CH = 4 * 1024 * 1024;
  const id = await T().core.invoke<number>('write_open', { path });
  let done = 0;
  try {
    for (let off = 0; off < blob.size; off += CH) {
      const buf = new Uint8Array(await blob.slice(off, off + CH).arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192));
      await T().core.invoke('write_chunk', { id, data: btoa(s) });
      done += buf.length;
      onProgress?.(done, blob.size);
    }
  } finally {
    await T().core.invoke('write_close', { id });
  }
  return done;
}

/** A small file read whole — a mesh, a script. Refused past a cap on the Rust side. */
export async function readAll(path: string): Promise<ArrayBuffer> {
  const b64 = await T().core.invoke<string>('read_all', { path });
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function recents(): Promise<string[]> {
  try { return await T().core.invoke<string[]>('recents'); } catch { return []; }
}
export async function clearRecents() {
  try { await T().core.invoke('clear_recents'); } catch {}
}
export async function bridgeStatus(): Promise<{ port: number; viewer: boolean; agents: number; exe: string | null }> {
  return await T().core.invoke('bridge_status');
}

export interface DesktopHooks {
  openPath(path: string, add: boolean): Promise<void> | void;
  save(): void;
  exportPoints(): void;
  undo(): void;
  redo(): void;
  fit(): void;
  top(): void;
  panel(): void;
  agentPanel(): void;
  about(): void;
  addLayer(): void;
  importMesh(): void;
}

/** Wire the menu bar, Finder drops and the bridge notice to the page. */
export async function init(hooks: DesktopHooks) {
  const t = T();
  await t.event.listen('e57view://menu', async (e) => {
    const id = String(e.payload?.id ?? '');
    switch (id) {
      case 'open-path': await hooks.openPath(String(e.payload.path), false); break;
      case 'open': {
        const [p] = await openDialog({ title: 'Open a scan or a mesh' });
        if (p) await hooks.openPath(p, false);
        break;
      }
      case 'add': hooks.addLayer(); break;
      case 'mesh': hooks.importMesh(); break;
      case 'save': hooks.save(); break;
      case 'export': hooks.exportPoints(); break;
      case 'undo': hooks.undo(); break;
      case 'redo': hooks.redo(); break;
      case 'fit': hooks.fit(); break;
      case 'top': hooks.top(); break;
      case 'panel': hooks.panel(); break;
      case 'agentpanel': hooks.agentPanel(); break;
      case 'about-e57view': hooks.about(); break;
      case 'recent-clear': await clearRecents(); notifyRecents(); break;
    }
  });
  // Finder drops arrive as paths, because the shell intercepts them before the webview
  await t.event.listen('tauri://drag-drop', async (e) => {
    const paths: string[] = e.payload?.paths ?? [];
    for (let i = 0; i < paths.length; i++) await hooks.openPath(paths[i], i > 0);
  });
}

/** Tell the shell to rebuild the Open Recent menu. */
export function notifyRecents() {
  try { (window as any).__TAURI__.event.emit('e57view://recents-changed', {}); } catch {}
}
