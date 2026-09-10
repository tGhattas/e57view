// e57view Cloud Functions.
//   agent — a mailbox so an AI agent can drive a viewer tab over HTTP. The tab holds the
//           data and does the work; this only relays commands and answers.
import { onRequest } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createHash, timingSafeEqual } from 'node:crypto';

initializeApp();
setGlobalOptions({ region: 'europe-west1' });

const AGENT_HELP = {
  name: 'e57view agent',
  how: 'In the viewer: Agent → Copy agent URL. That copies a page link plus a bearer token. Keep the tab open and POST commands here with the token in an Authorization header. No MCP config required.',
  auth: "Authorization: Bearer <token from Copy agent URL>  (or JSON { token }). The session id names the mailbox; the token is the credential. Sessions expire after 8 hours and are read-only unless the viewer ticks Allow edits.",
  post: { session: 'session id', cmd: 'state | screenshot | set_view | set | regions | pick | measure | history | stations | open', args: {} },
  examples: [
    { cmd: 'state' },
    { cmd: 'screenshot', args: { width: 1024 } },
    { cmd: 'set_view', args: { preset: 'top' } },
    { cmd: 'set_view', args: { pose: { p: [10, 10, 5], t: [0, 0, 0] } } },
    { cmd: 'history', args: { op: 'undo' } },
    { cmd: 'revoke' },
  ],
  slow: 'A command that takes more than 50 s returns 202 { pending: N }. Collect it later with GET /agent?s=SESSION&n=N.',
  lifetime: 'The session dies with the browser window: the tab revokes its own token as it closes. It also expires 8 hours after it is created, and Stop session revokes it by hand.',
  note: 'Commands that drop points, write a file or load another scan need Allow edits ticked in the viewer tab.',
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
  if (cmd === 'regions') return args.op === 'apply';
  if (cmd === 'history') return args.op !== 'status';
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
    // ?n=N collects the answer to a command whose HTTP wait already timed out.
    const want = Number(req.query.n);
    if (Number.isFinite(want) && want > 0) {
      if (d.res?.n === want) res.json(d.res);
      else res.status(202).json({ pending: want, of: d.n ?? 0, hint: 'the viewer has not answered yet; poll this again' });
      return;
    }
    res.json({
      session: sid, cloudId: d.cloudId || null,
      viewer: Date.now() - (d.viewerAt || 0) < 60_000 ? 'online' : 'quiet — the tab may be backgrounded, commands still queue',
      mode: d.allowEdits ? 'edits allowed' : 'read-only',
      expiresAt: d.expiresAt ?? null, help: AGENT_HELP,
    });
    return;
  }

  const cmd = req.body?.cmd || req.body?.op;
  if (!cmd || typeof cmd !== 'string') { res.status(400).json({ error: 'JSON body { session, cmd, args? }' }); return; }
  // The tab beacons this as it closes, so the token dies with the window it belonged to.
  if (cmd === 'revoke') { await ref.delete(); res.json({ revoked: sid }); return; }
  const args = req.body.args ?? {};
  if (needsEdit(cmd, args) && !d.allowEdits) {
    res.status(403).json({ error: `"${cmd}" changes the scan. This session is read-only: tick "Allow edits" in the viewer's Agent panel.` });
    return;
  }
  const n = (d.n || 0) + 1;
  // mergeFields replaces these fields outright. A deep merge would leave arguments from
  // earlier commands behind, and a stale "preset" silently overrode later poses.
  await ref.set({ n, cmd: { n, name: cmd, args }, res: null }, { mergeFields: ['n', 'cmd', 'res'] });
  // Firebase Hosting gives up on a rewrite at 60 s, so answer before that and let the
  // caller collect a slow result instead of losing it to a proxy error page.
  let unsub = () => {};
  try {
    const out = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 50_000);
      unsub = ref.onSnapshot(s => {
        const r = s.data()?.res;
        if (r?.n === n) { clearTimeout(t); resolve(r); }
      }, err => { clearTimeout(t); reject(err); });
    });
    res.json(out);
  } catch {
    res.status(202).json({
      pending: n,
      hint: `the viewer is still working (a backgrounded tab is throttled by the browser). The command was queued and will run. Collect the answer with GET /agent?s=${sid}&n=${n}`,
    });
  } finally { unsub(); }
});
