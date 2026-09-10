// Cloud mode: upload a scan once, have it converted server-side into the same
// cell format the local cache uses, then stream cell *prefixes* by HTTP range
// request. Because every cell was shuffled at build time, the first N records
// of a cell are a uniform subsample — so a viewer can start on a few percent of
// the data and refine only the cells the camera is looking at.
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getStorage, ref, uploadBytesResumable } from 'firebase/storage';
import { getFirestore, doc, setDoc, onSnapshot, collection, query, where, orderBy, getDocs, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig, FUNCTIONS_REGION } from './firebase-config';
import type { LeafMeta } from './cells';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const storage = getStorage(app);
const db = getFirestore(app);
export const functions = getFunctions(app, FUNCTIONS_REGION);
export const callAi = httpsCallable(functions, 'aiSuggest', { timeout: 240000 });

export function ensureAuth(): Promise<string> {
  return new Promise((res, rej) => {
    const off = onAuthStateChanged(auth, async (u) => {
      if (u) { off(); res(u.uid); return; }
      try { const c = await signInAnonymously(auth); off(); res(c.user.uid); } catch (e) { off(); rej(e); }
    });
  });
}

export interface CloudDoc { id: string; name: string; status: 'uploading' | 'uploaded' | 'converting' | 'ready' | 'error'; progress?: number; points?: number; leaves?: number; bytes?: number; cellsUrl?: string; metaUrl?: string; error?: string; stride?: number; owner?: string; createdAt?: any }

export async function uploadScan(file: File, stride: number, onProgress: (frac: number, bps: number) => void): Promise<string> {
  const uid = await ensureAuth();
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  await setDoc(doc(db, 'clouds', id), { owner: uid, name: file.name, size: file.size, stride, status: 'uploading', createdAt: serverTimestamp() });
  const r = ref(storage, `uploads/${uid}/${id}/${file.name}`);
  const task = uploadBytesResumable(r, file, { contentType: 'application/octet-stream' });
  const t0 = Date.now();
  await new Promise<void>((res, rej) => {
    task.on('state_changed', s => onProgress(s.bytesTransferred / s.totalBytes, s.bytesTransferred / ((Date.now() - t0) / 1000)), rej, () => res());
  });
  await setDoc(doc(db, 'clouds', id), { status: 'uploaded' }, { merge: true });
  return id;
}

export function watchCloud(id: string, cb: (d: CloudDoc | null) => void) {
  return onSnapshot(doc(db, 'clouds', id), s => cb(s.exists() ? ({ id: s.id, ...(s.data() as any) }) : null));
}

/** Agent sessions: the id names the mailbox, the token opens it. The token is shown
 *  once, never stored here and never put in the page URL; only its hash is saved. */
const SESSION_TTL = 8 * 3600e3;
export interface AgentSession { sid: string; token: string; expiresAt: number }

async function sha256Hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
}
const hex = () => crypto.randomUUID().replace(/-/g, '');

export async function createAgentSession(cloudId: string | null, allowEdits = false): Promise<AgentSession> {
  const owner = await ensureAuth();
  const sid = hex().slice(0, 20);
  const token = hex() + hex();                      // 256 bits
  const expiresAt = Date.now() + SESSION_TTL;
  await setDoc(doc(db, 'agentSessions', sid), {
    owner, cloudId, allowEdits, createdAt: Date.now(), expiresAt,
    tokenHash: await sha256Hex(token), n: 0, viewerAt: Date.now(),
  });
  return { sid, token, expiresAt };
}
export async function setAgentEdits(sid: string, allowEdits: boolean) {
  await setDoc(doc(db, 'agentSessions', sid), { allowEdits }, { merge: true });
}
export async function stopAgentSession(sid: string) {
  await deleteDoc(doc(db, 'agentSessions', sid));
}

export function watchAgentSession(sid: string, dispatch: (cmd: string, args: any) => Promise<any>, onStatus?: (s: string) => void): () => void {
  const ref = doc(db, 'agentSessions', sid);
  let handling = 0;
  const beat = window.setInterval(() => { setDoc(ref, { viewerAt: Date.now() }, { merge: true }).catch(() => {}); }, 8000);
  const off = onSnapshot(ref, async snap => {
    const d = snap.data(); if (!d) { onStatus?.('session ended'); return; }
    const left = Math.max(0, ((d.expiresAt ?? 0) - Date.now()) / 3600e3);
    const tail = `${d.allowEdits ? 'edits allowed' : 'read-only'} · expires in ${left.toFixed(1)} h`;
    onStatus?.(d.cmd && d.res?.n !== d.cmd.n ? `running ${d.cmd.name}…` : `listening · ${tail}`);
    const cmd = d.cmd; if (!cmd || cmd.n === handling || d.res?.n === cmd.n) return;
    handling = cmd.n;
    try {
      const out = await dispatch(cmd.name, cmd.args ?? {});
      await setDoc(ref, { res: { n: cmd.n, ok: true, ...out, at: Date.now() }, viewerAt: Date.now() }, { merge: true });
    } catch (e: any) {
      await setDoc(ref, { res: { n: cmd.n, ok: false, error: String(e?.message ?? e), at: Date.now() }, viewerAt: Date.now() }, { merge: true });
    }
  }, err => onStatus?.('session error: ' + err.message));
  return () => { off(); clearInterval(beat); };
}

export async function listMyClouds(): Promise<CloudDoc[]> {
  const uid = await ensureAuth();
  const q = query(collection(db, 'clouds'), where('owner', '==', uid), orderBy('createdAt', 'desc'));
  try { return (await getDocs(q)).docs.map(d => ({ id: d.id, ...(d.data() as any) })); }
  catch { const q2 = query(collection(db, 'clouds'), where('owner', '==', uid)); return (await getDocs(q2)).docs.map(d => ({ id: d.id, ...(d.data() as any) })); }
}
export async function deleteCloud(id: string) { await deleteDoc(doc(db, 'clouds', id)); }

export interface StreamHandlers {
  meta(scanMeta: any, extra: { histogram: number[]; robust: any; kept: number; stride: number; name: string }): void;
  leaf(block: ArrayBuffer, count: number, meta: LeafMeta, capacity: number, tag: number): void;
  append(tag: number, recs: Uint8Array, n: number): void;
  progress(done: number, total: number): void;
  done(stats: { kept: number; leaves: number; bytesLoaded: number }): void;
}
export interface Streamer { refine(tag: number, want: number): void; loadedBytes: number; stop(): void }

const REC = 14;

/** Stream a converted cloud: a uniform prefix of every cell first, then refinement on demand. */
export async function streamCloud(d: CloudDoc, h: StreamHandlers, opts: { prefixFrac?: number; minPrefix?: number; maxConcurrent?: number } = {}): Promise<Streamer> {
  if (d.status !== 'ready' || !d.metaUrl || !d.cellsUrl) throw new Error('cloud is not ready');
  const meta = await (await fetch(d.metaUrl)).json();
  h.meta(meta.scanMeta, { histogram: meta.histogram, robust: meta.robust, kept: meta.kept, stride: meta.stride, name: meta.name });
  const leaves: any[] = meta.leaves;
  const loaded = new Map<number, number>();      // tag -> records loaded
  const inflight = new Set<number>();
  let bytes = 0, stopped = false;
  const frac = opts.prefixFrac ?? 0.08, minPrefix = opts.minPrefix ?? 6000, maxC = opts.maxConcurrent ?? 6;

  const fetchRange = async (l: any, from: number, to: number): Promise<Uint8Array> => {
    const r = await fetch(d.cellsUrl!, { headers: { Range: `bytes=${l.offset + from * REC}-${l.offset + to * REC - 1}` } });
    if (!r.ok && r.status !== 206) throw new Error(`range fetch failed: ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    bytes += buf.byteLength;
    return buf;
  };

  // phase 1: prefixes, biggest cells first so the overview fills in evenly
  const order = leaves.map((l, i) => i).sort((a, b) => leaves[b].count - leaves[a].count);
  let done = 0;
  const totalPrefix = leaves.reduce((a, l) => a + Math.min(l.count, Math.max(minPrefix, Math.ceil(l.count * frac))) * REC, 0);
  const worker = async () => {
    while (order.length && !stopped) {
      const i = order.shift()!; const l = leaves[i];
      const n = Math.min(l.count, Math.max(minPrefix, Math.ceil(l.count * frac)));
      const buf = await fetchRange(l, 0, n);
      loaded.set(i, n);
      h.leaf(buf.buffer as ArrayBuffer, n, { origin: l.origin, size: l.size, bmin: l.bmin, bmax: l.bmax }, l.count, i);
      done += buf.byteLength;
      h.progress(done, totalPrefix);
    }
  };
  await Promise.all(Array.from({ length: maxC }, worker));
  h.done({ kept: meta.kept, leaves: leaves.length, bytesLoaded: bytes });

  return {
    get loadedBytes() { return bytes; },
    stop() { stopped = true; },
    refine(tag: number, want: number) {
      if (stopped || inflight.size >= maxC) return;
      const l = leaves[tag]; const have = loaded.get(tag) ?? 0;
      if (!l || have >= l.count || inflight.has(tag)) return;
      const to = Math.min(l.count, Math.max(want, have + 20000));
      inflight.add(tag);
      fetchRange(l, have, to).then(buf => { loaded.set(tag, to); h.append(tag, buf, to - have); })
        .catch(() => {}).finally(() => inflight.delete(tag));
    },
  };
}
