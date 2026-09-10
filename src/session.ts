// Agent sessions: a small Firestore mailbox between one viewer tab and the /agent
// function, so an AI agent can drive this tab from anywhere without local setup.
// The id names the mailbox; the bearer token is the credential and never enters a URL.
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, deleteDoc, onSnapshot } from 'firebase/firestore';
import { firebaseConfig } from './firebase-config';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export function ensureAuth(): Promise<string> {
  return new Promise((res, rej) => {
    const off = onAuthStateChanged(auth, u => {
      if (u) { off(); res(u.uid); return; }
      signInAnonymously(auth).catch(rej);
    }, rej);
  });
}

const SESSION_TTL = 8 * 3600e3;
export interface AgentSession { sid: string; token: string; expiresAt: number }

async function sha256Hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
}
const hex = () => crypto.randomUUID().replace(/-/g, '');

export async function createAgentSession(allowEdits = false): Promise<AgentSession> {
  const owner = await ensureAuth();
  const sid = hex().slice(0, 20);
  const token = hex() + hex();                      // 256 bits
  const expiresAt = Date.now() + SESSION_TTL;
  await setDoc(doc(db, 'agentSessions', sid), {
    owner, allowEdits, createdAt: Date.now(), expiresAt,
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
