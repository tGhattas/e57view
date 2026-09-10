// Cloud side of e57view.
//  convertCloud — runs once per uploaded scan: decodes it into the cell format the
//                 viewer streams (the same format as the local cache), then deletes
//                 the upload. Billed only while it runs; serving is static storage.
//  aiSuggest    — holds the AI provider keys; the browser sends renders, gets boxes back.
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
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
