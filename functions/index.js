// Cloud side of e57view.
//  convertCloud — runs once per uploaded scan: decodes it into the cell format the
//                 viewer streams (the same format as the local cache), then deletes
//                 the upload. Billed only while it runs; serving is static storage.
//  aiSuggest    — holds the AI provider keys; the browser sends renders, gets boxes back.
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, statSync, createReadStream } from 'node:fs';
import { convertFile } from './convert.mjs';
import { suggest } from './ai.mjs';

initializeApp();
setGlobalOptions({ region: 'europe-west1' });
const BUCKET = 'opensketch-clouds';
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const XAI_API_KEY = defineSecret('XAI_API_KEY');

export const convertCloud = onObjectFinalized(
  { bucket: BUCKET, memory: '16GiB', cpu: 4, timeoutSeconds: 540, concurrency: 1, maxInstances: 3 },
  async (event) => {
    const name = event.data.name;                        // uploads/{uid}/{cloudId}/{file}
    const m = name.match(/^uploads\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!m) return;
    const [, uid, cloudId, fileName] = m;
    const db = getFirestore();
    const doc = db.collection('clouds').doc(cloudId);
    const bucket = getStorage().bucket(BUCKET);
    const snap = await doc.get();
    const stride = Math.max(1, Number(snap.data()?.stride ?? 1) | 0);
    await doc.set({ status: 'converting', progress: 0, startedAt: FieldValue.serverTimestamp(), owner: uid, fileName }, { merge: true });

    const work = `/tmp/${cloudId}`;
    mkdirSync(work, { recursive: true });
    const inPath = `${work}/in`;
    try {
      await bucket.file(name).download({ destination: inPath });
      const size = statSync(inPath).size;
      let lastUpdate = 0;
      const result = await convertFile(inPath, work, { name: fileName, size, stride, memLimit: 3.6e9,
        onProgress: async (phase, done, total) => {
          const now = Date.now();
          if (now - lastUpdate < 2000) return; lastUpdate = now;
          await doc.set({ progress: phase === 0 ? (done / total) * 0.9 : 0.9 + (done / Math.max(total, 1)) * 0.1 }, { merge: true });
        } });
      // upload cells + meta with download tokens so plain HTTP range requests work
      const token = randomUUID();
      const up = async (local, remote, contentType) => {
        await bucket.upload(local, { destination: remote, contentType, metadata: { metadata: { firebaseStorageDownloadTokens: token } }, resumable: true });
        return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(remote)}?alt=media&token=${token}`;
      };
      const cellsUrl = await up(`${work}/cells.bin`, `clouds/${cloudId}/cells.bin`, 'application/octet-stream');
      const metaUrl = await up(`${work}/meta.json`, `clouds/${cloudId}/meta.json`, 'application/json');
      await doc.set({ status: 'ready', progress: 1, cellsUrl, metaUrl, points: result.kept, leaves: result.leaves, bytes: result.bytes,
                      sourceSize: size, readyAt: FieldValue.serverTimestamp() }, { merge: true });
      await bucket.file(name).delete().catch(() => {});
    } catch (e) {
      await doc.set({ status: 'error', error: String(e?.message ?? e) }, { merge: true });
      throw e;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

export const aiSuggest = onCall(
  { secrets: [OPENAI_API_KEY, XAI_API_KEY], memory: '1GiB', timeoutSeconds: 240, cors: true },
  async (req) => {
    const { provider, model, images, context } = req.data ?? {};
    if (!['openai', 'xai'].includes(provider)) throw new HttpsError('invalid-argument', 'provider must be openai or xai');
    if (!Array.isArray(images) || !images.length) throw new HttpsError('invalid-argument', 'no images');
    const total = images.reduce((a, i) => a + (i.dataUrl?.length ?? 0), 0);
    if (total > 12e6) throw new HttpsError('invalid-argument', 'images too large');
    const key = provider === 'openai' ? OPENAI_API_KEY.value() : XAI_API_KEY.value();
    if (!key || key === 'unset') throw new HttpsError('failed-precondition', `${provider === 'openai' ? 'OPENAI_API_KEY' : 'XAI_API_KEY'} is not set. Run: firebase functions:secrets:set ${provider === 'openai' ? 'OPENAI_API_KEY' : 'XAI_API_KEY'}`);
    try {
      return await suggest({ provider, model, key, images, context });
    } catch (e) {
      throw new HttpsError('internal', String(e?.message ?? e));
    }
  });

const AGENT_HELP = {
  name: 'e57view agent',
  how: 'In the viewer: Agent → Copy agent URL. That copies a page link plus a bearer token. Keep the tab open and POST commands here with the token in an Authorization header. No MCP config required.',
  auth: "Authorization: Bearer <token from Copy agent URL>  (or JSON { token }). The session id names the mailbox; the token is the credential. Sessions expire after 8 hours and are read-only unless the viewer ticks Allow edits.",
  post: { session: 'session id', cmd: 'state | screenshot | set_view | set | regions | pick | measure | ai_suggest | suggestions | history | stations | open', args: {} },
  examples: [
    { cmd: 'state' },
    { cmd: 'screenshot', args: { width: 1024 } },
    { cmd: 'set_view', args: { preset: 'top' } },
    { cmd: 'set_view', args: { pose: { p: [10, 10, 5], t: [0, 0, 0] } } },
    { cmd: 'ai_suggest', args: { provider: 'heuristic', kinds: ['noise'] } },
    { cmd: 'suggestions', args: { op: 'apply' } },
    { cmd: 'history', args: { op: 'undo' } },
  ],
  note: 'Commands that drop points, write a file, load another scan or call a paid model need Allow edits ticked in the viewer tab.',
};

/** Constant-time compare of sha256(token) against the stored hash. */
function tokenOk(token, hash) {
  if (!token || typeof hash !== 'string' || !hash) return false;
  const a = Buffer.from(createHash('sha256').update(String(token)).digest('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}
function bearer(req) {
  const m = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : String(req.body?.token || '');
}
function needsEdit(cmd, args = {}) {
  if (cmd === 'open') return true;
  if (cmd === 'regions' || cmd === 'suggestions') return args.op === 'apply';
  if (cmd === 'history') return args.op !== 'status';
  if (cmd === 'ai_suggest') return !!args.provider && args.provider !== 'heuristic';
  return false;
}

export const agent = onRequest({ cors: true, timeoutSeconds: 120, memory: '256MiB' }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ error: 'GET or POST' }); return; }
  // The id names the mailbox and may travel in a query string; the token never does.
  const sid = String(req.query.s || req.query.session || req.body?.session || '');
  if (!sid) { res.json(AGENT_HELP); return; }
  if (!/^[a-zA-Z0-9]{16,40}$/.test(sid)) { res.status(400).json({ error: 'bad session id' }); return; }

  const ref = getFirestore().doc(`agentSessions/${sid}`);
  const snap = await ref.get();
  const d = snap.exists ? (snap.data() || {}) : null;
  // One answer for "no such session" and "wrong token", so this cannot be used to probe ids.
  if (!d || !tokenOk(bearer(req), d.tokenHash)) {
    res.status(401).json({ error: 'unknown session or bad token. In the viewer: Agent → Copy agent URL, then send the token as "Authorization: Bearer <token>".' });
    return;
  }
  if (d.expiresAt && Date.now() > d.expiresAt) {
    res.status(410).json({ error: 'session expired. Copy a fresh agent URL in the viewer.' });
    return;
  }
  if (req.method === 'GET') {
    res.json({
      session: sid, cloudId: d.cloudId || null,
      viewer: Date.now() - (d.viewerAt || 0) < 20_000 ? 'online' : 'offline — open the viewer page and keep it open',
      mode: d.allowEdits ? 'edits allowed' : 'read-only',
      expiresAt: d.expiresAt ?? null, help: AGENT_HELP,
    });
    return;
  }

  const cmd = req.body?.cmd || req.body?.op;
  if (!cmd || typeof cmd !== 'string') { res.status(400).json({ error: 'JSON body { session, cmd, args? }' }); return; }
  const args = req.body.args ?? {};
  if (needsEdit(cmd, args) && !d.allowEdits) {
    res.status(403).json({ error: `"${cmd}" changes the scan or spends credit. This session is read-only: tick "Allow edits" in the viewer's Agent panel.` });
    return;
  }
  const n = (d.n || 0) + 1;
  // mergeFields replaces these fields outright. A deep merge would leave arguments from
  // earlier commands behind, and a stale "preset" silently overrode later poses.
  await ref.set({ n, cmd: { n, name: cmd, args }, res: null }, { mergeFields: ['n', 'cmd', 'res'] });
  let unsub = () => {};
  try {
    const out = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 100_000);
      unsub = ref.onSnapshot(s => {
        const r = s.data()?.res;
        if (r?.n === n) { clearTimeout(t); resolve(r); }
      }, err => { clearTimeout(t); reject(err); });
    });
    res.json(out);
  } catch {
    res.status(504).json({ error: 'the viewer did not answer. Keep the page with ?session=' + sid + ' open.' });
  } finally { unsub(); }
});
