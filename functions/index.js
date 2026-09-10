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
import { randomUUID } from 'node:crypto';
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
  how: 'Open the scan in a browser (optionally ?cloud=ID&session=SID), keep the tab open, then POST commands here. No MCP config required.',
  open: 'https://opensketch.web.app/?cloud=CLOUD_ID&session=SESSION_ID&view=top',
  post: { session: 'from Copy agent URL', cmd: 'state | screenshot | set_view | set | regions | pick | measure | ai_suggest | suggestions | history | stations | open', args: {} },
  examples: [
    { cmd: 'state' },
    { cmd: 'screenshot', args: { width: 1024 } },
    { cmd: 'set_view', args: { preset: 'top' } },
    { cmd: 'ai_suggest', args: { provider: 'heuristic', kinds: ['noise'] } },
    { cmd: 'suggestions', args: { op: 'apply' } },
    { cmd: 'regions', args: { op: 'apply' } },
    { cmd: 'history', args: { op: 'undo' } },
  ],
};

export const agent = onRequest({ cors: true, timeoutSeconds: 120, memory: '256MiB' }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const sid = String(req.query.s || req.query.session || req.body?.session || '');
  if (req.method === 'GET' && !sid) { res.json(AGENT_HELP); return; }
  if (!/^[a-zA-Z0-9]{16,40}$/.test(sid)) { res.status(400).json({ error: 'pass session as ?s= or JSON { session }' }); return; }
  const db = getFirestore();
  const ref = db.doc(`agentSessions/${sid}`);
  const snap = await ref.get();
  if (!snap.exists) { res.status(404).json({ error: 'unknown session. In the viewer, Agent → Copy agent URL, and keep that tab open.' }); return; }
  if (req.method === 'GET') {
    const d = snap.data() || {};
    const age = Date.now() - (d.viewerAt || 0);
    res.json({ session: sid, cloudId: d.cloudId || null, viewer: age < 20_000 ? 'online' : 'offline — open the agent URL in a tab', help: AGENT_HELP });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST' }); return; }
  const cmd = req.body?.cmd || req.body?.op;
  if (!cmd || typeof cmd !== 'string') { res.status(400).json({ error: 'JSON body { cmd, args? }' }); return; }
  const args = req.body.args ?? {};
  const n = (snap.data()?.n || 0) + 1;
  await ref.set({ n, cmd: { n, name: cmd, args }, res: null }, { merge: true });
  const t0 = Date.now();
  while (Date.now() - t0 < 100_000) {
    await new Promise(r => setTimeout(r, 300));
    const s = await ref.get();
    const out = s.data()?.res;
    if (out?.n === n) { res.json(out); return; }
  }
  res.status(504).json({ error: 'viewer did not answer. Keep the tab with ?session=' + sid + ' open.' });
});
