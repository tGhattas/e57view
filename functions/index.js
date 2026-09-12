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
  post: { session: 'session id', cmd: 'state | screenshot | view | section | probe | heightmap | contour | fitplane | distance | inside | measure | pick | set_view | set | regions | transform | surface | history | stations | open', args: {} },
  units: 'metres, everywhere. Coordinates are local unless a field says global; global = local + state.translation.',
  modelling: {
    why: 'Everything below is calibrated: an image comes with the mapping that turns any of its pixels into a world point, and every measurement is taken from the points or the surface rather than off a picture.',
    workflow: [
      '1. state — point count, bounds, median spacing, hasNormals, and recommendedSource: measure the points, or the surface, and why.',
      '2. view { preset:"top" } — orthographic, so mapping.metresPerPixel is exact everywhere.',
      '3. probe { pixels:[[x,y]] } — those pixels back to world points, exactly, even if the view has moved since.',
      '4. section { axis:"z", at, thickness } — a plan; axis "x" or "y" gives an elevation.',
      '5. contour { z, thickness } — the same slab as polylines in metres. Vectors, not a picture: this is what you draw from.',
      '6. fitplane { box } — a wall or a floor as a plane, with the RMS that says whether to believe it.',
      '7. heightmap — highest surface per cell as a grey PNG with its metre mapping.',
      '8. distance / inside — lengths and counts from the data.',
      '9. surface build then surface export — a triangle mesh, with holeRatio telling you how complete it is.',
    ],
    paging: 'A reply travels in one Firestore document capped at 1 MiB, so a big payload (a surface export, a wide image) comes back as { part, parts, data }. Ask for the rest with the same command and part: 1, 2, … and concatenate before decoding.',
  },
  examples: [
    { cmd: 'state' },
    { cmd: 'view', args: { preset: 'top', width: 1024 } },
    { cmd: 'probe', args: { pixels: [[512, 384], [612, 384]] } },
    { cmd: 'section', args: { axis: 'z', at: 1.5, thickness: 0.3 } },
    { cmd: 'contour', args: { z: 1.5, thickness: 0.3 } },
    { cmd: 'fitplane', args: { box: { center: [0, 2, 1.5], half: [0.06, 1.5, 1] } } },
    { cmd: 'heightmap', args: { resolution: 512 } },
    { cmd: 'distance', args: { a: [0, 0, 0], b: [6, 4, 3] } },
    { cmd: 'inside', args: { box: { center: [3, 2, 0.02], half: [4, 3, 0.05] } } },
    { cmd: 'surface', args: { op: 'build', voxelCm: 6 } },
    { cmd: 'surface', args: { op: 'export', format: 'ply', part: 0 } },
    { cmd: 'transform', args: { op: 'level' } },
    { cmd: 'history', args: { op: 'undo' } },
    { cmd: 'revoke' },
  ],
  slow: 'A command that takes more than 50 s returns 202 { pending: N }. Collect it later with GET /agent?s=SESSION&n=N.',
  lifetime: 'The session dies with the browser window: the tab revokes its own token as it closes. It also expires 8 hours after it is created, and Stop session revokes it by hand.',
  note: 'Commands that drop points, write a file, load another scan, move the cloud or spend real time (regions apply, history undo|redo|save, open, surface build, transform) need Allow edits ticked in the viewer tab. Everything under "modelling" is read-only apart from surface build.',
};

/** Constant-time compare of sha256(token) against the stored hash. */
function tokenOk(token, hash) {
  if (!token || typeof hash !== 'string' || !hash) return false;
  const a = Buffer.from(createHash('sha256').update(String(token)).digest('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** The viewer's answer, flattened back out of its JSON string. */
function reply(r) {
  if (!r || typeof r.json !== 'string') return r;
  const { json, ...rest } = r;
  try { return { ...rest, ...JSON.parse(json) }; } catch { return { ...rest, error: 'unreadable answer from the viewer' }; }
}
function bearer(req) {
  const m = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : String(req.body?.token || '');
}
// The viewer tab is the real gate (it refuses the same set); this only saves a round trip.
function needsEdit(cmd, args = {}) {
  if (cmd === 'open') return true;
  if (cmd === 'regions') return args.op === 'apply';
  if (cmd === 'history') return args.op !== 'status';
  if (cmd === 'surface') return args.op === 'build';
  if (cmd === 'transform') return (args.op ?? 'get') !== 'get';
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
      if (d.res?.n === want) res.json(reply(d.res));
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
  //
  // Arguments and answers travel as JSON strings, not as structures. Firestore refuses an
  // array directly inside an array, which is exactly the shape of the useful things here —
  // pixel pairs to probe, polylines from a contour — and refusing them turned into a 500
  // with an empty body rather than anything a caller could act on. A string has no such
  // rules, and the HTTP shape the agent sees is unchanged.
  await ref.set({ n, cmd: { n, name: cmd, argsJson: JSON.stringify(args ?? {}) }, res: null }, { mergeFields: ['n', 'cmd', 'res'] });
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
    res.json(reply(out));
  } catch {
    res.status(202).json({
      pending: n,
      hint: `the viewer is still working (a backgrounded tab is throttled by the browser). The command was queued and will run. Collect the answer with GET /agent?s=${sid}&n=${n}`,
    });
  } finally { unsub(); }
});
