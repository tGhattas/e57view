// The built desktop app, driven the way an agent drives it: through its own MCP server.
//
// There is no Playwright here — the app is a WKWebView, not a browser this can attach to, and
// that is the point. The only way in is the interface the app actually offers, which is
// `e57view --mcp` on stdin and stdout relaying to the running window over the localhost
// bridge. If that works, the app works, and so does the thing an agent will use.
//
//   E57VIEW_TEST_FILE=/path/to/scan.e57 node drive-desktop.mjs
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.E57VIEW_APP || 'desktop/target/release/bundle/macos/e57view.app';
const BIN = process.env.E57VIEW_BIN || join(APP, 'Contents/MacOS/e57view');
const SCAN = process.env.E57VIEW_TEST_FILE || '';
const scratch = mkdtempSync(join(tmpdir(), 'e57view-desktop-'));

let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!existsSync(BIN)) {
  console.log(`No desktop build at ${BIN}. Build it with: npm run desktop:build`);
  process.exit(1);
}
if (!SCAN || !existsSync(SCAN)) {
  console.log('E57VIEW_TEST_FILE is not set to a scan on this machine, so the real-file part is skipped.');
  console.log('Set it to any E57/LAS/LAZ/PLY file to run the whole thing:');
  console.log('  E57VIEW_TEST_FILE=/path/to/scan.e57 node drive-desktop.mjs');
}

// ---------------------------------------------------------------- launch
console.log(`APP ${APP}`);
spawnSync('pkill', ['-f', 'e57view.app/Contents/MacOS/e57view']);
await sleep(600);
const app = spawn('open', ['-n', APP], { stdio: 'ignore' });
app.unref();
await sleep(3500);

/** The app's process id and resident memory, in MB. */
function proc() {
  try {
    const out = execFileSync('bash', ['-lc', `ps -Ao pid,rss,comm | grep 'e57view.app/Contents/MacOS/e57view' | grep -v grep | head -1`]).toString().trim();
    if (!out) return null;
    const [pid, rss] = out.split(/\s+/);
    return { pid: Number(pid), mb: Number(rss) / 1024 };
  } catch { return null; }
}
const p0 = proc();
ok('the app is running', !!p0, p0 ? `pid ${p0.pid}, ${p0.mb.toFixed(0)} MB at rest` : 'not found');

// ---------------------------------------------------------------- its own MCP server
function mcp() {
  const p = spawn(BIN, ['--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map();
  p.stdout.on('data', d => {
    buf += d.toString();
    for (let nl; (nl = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  let id = 0;
  return {
    close: () => { p.stdin.end(); p.kill(); },
    req(method, params, timeoutMs = 600000) {
      const myId = ++id;
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`${method} timed out`)), timeoutMs);
        waiting.set(myId, m => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
      });
    },
  };
}
const s = mcp();
const init = await s.req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'drive-desktop', version: '1' } });
ok('the app serves MCP on stdio', init?.serverInfo?.name === 'e57view', JSON.stringify(init?.serverInfo));
const list = await s.req('tools/list', {});
ok('and offers its tools', (list?.tools?.length ?? 0) >= 29, `${list?.tools?.length} tools`);

/** One tools/call, with the JSON body pulled back out of the content array. */
async function call(name, args = {}, timeoutMs = 1800000) {
  const r = await s.req('tools/call', { name, arguments: args }, timeoutMs);
  const txt = (r?.content ?? []).find(c => c.type === 'text')?.text ?? '';
  const img = (r?.content ?? []).find(c => c.type === 'image');
  if (r?.isError) throw new Error(txt.slice(0, 400));
  let body = null; try { body = JSON.parse(txt); } catch { body = txt; }
  return { body, img, raw: r };
}

// the window has to be up and connected to the bridge before anything can be asked of it
let st = null;
for (let i = 0; i < 40 && !st; i++) {
  try { st = (await call('viewer_state', {}, 20000)).body; } catch { await sleep(500); }
}
ok('the window is connected to the bridge', !!st, st ? `${st.points} points loaded, units ${st.units}` : 'never answered');

if (SCAN && existsSync(SCAN) && st) {
  const bytes = statSync(SCAN).size;
  console.log(`SCAN ${SCAN} · ${(bytes / 1e9).toFixed(2)} GB`);

  // start cold: a cached copy from an earlier run would make the decode timing a lie
  const was = (await call('viewer_cache', { op: 'list' })).body;
  for (const c of was?.cached ?? []) await call('viewer_cache', { op: 'drop', key: c.key });

  // ---------------------------------------------------------------- open by path
  const t0 = Date.now();
  const opened = (await call('viewer_open', { path: SCAN })).body;
  const loadS = (Date.now() - t0) / 1000;
  console.log(`OPEN  ${JSON.stringify(opened).slice(0, 200)}`);
  ok('a file opens by path, with no File object anywhere', (opened?.points ?? 0) > 1e6, `${(opened?.points ?? 0).toLocaleString()} points in ${loadS.toFixed(1)}s`);
  const p1 = proc();
  console.log(`LOAD  ${loadS.toFixed(1)}s · ${(opened.points / 1e6).toFixed(1)}M points · ${p1 ? p1.mb.toFixed(0) + ' MB resident' : 'memory unknown'}`);

  st = (await call('viewer_state')).body;
  ok('the scan reads as a scan', st.points > 1e6 && st.bounds && st.medianSpacing > 0,
     `${st.points.toLocaleString()} pts · ${st.bounds.local.size.map(v => v.toFixed(1)).join(' x ')} m · spacing ${st.medianSpacing} m`);
  ok('memory is in proportion to the points kept', !p1 || p1.mb < (st.points * 14) / 1e6 * 4,
     p1 ? `${p1.mb.toFixed(0)} MB for ${(st.points * 14 / 1e6).toFixed(0)} MB of records` : 'unknown');

  // ---------------------------------------------------------------- a picture
  const shot = await call('viewer_screenshot', { width: 900 });
  ok('WebGL2 renders in the webview', !!shot.img && shot.img.data.length > 20000,
     shot.img ? `${(shot.img.data.length / 1024).toFixed(0)} KB of PNG` : 'no image came back');

  // ---------------------------------------------------------------- the cache
  const tc = Date.now();
  const wrote = (await call('viewer_cache', { op: 'write' })).body;
  console.log(`CACHE ${JSON.stringify(wrote).slice(0, 180)}`);
  ok('the decoded cells cache to disk', !!wrote?.key, `${wrote?.note ?? ''} in ${((Date.now() - tc) / 1000).toFixed(1)}s`);
  const cached = (await call('viewer_cache', { op: 'list' })).body;
  ok('and the cache lists them back', (cached?.cached ?? []).some(c => c.key === wrote.key),
     `${(cached?.cached ?? []).length} cached`);

  const tr = Date.now();
  const re = (await call('viewer_open', { cached: wrote.key })).body;
  const reS = (Date.now() - tr) / 1000;
  ok('a cached scan reopens, and much faster', (re?.points ?? 0) > 1e6 && reS < loadS,
     `${(re?.points ?? 0).toLocaleString()} points in ${reS.toFixed(1)}s, against ${loadS.toFixed(1)}s from the file`);
  console.log(`CACHE READ  ${reS.toFixed(1)}s (${(loadS / Math.max(reS, 0.01)).toFixed(1)}x faster than decoding)`);

  // ---------------------------------------------------------------- export to a real path
  const out = join(scratch, 'export.las');
  const te = Date.now();
  const ex = (await call('viewer_export', { path: out, format: 'las', stride: 40 })).body;
  ok('an export lands at the path the agent named', existsSync(out) && statSync(out).size > 1000,
     existsSync(out) ? `${(statSync(out).size / 1e6).toFixed(1)} MB in ${((Date.now() - te) / 1000).toFixed(1)}s` : 'no file');
  ok('and the shell wrote every byte the viewer produced', ex?.bytes === (existsSync(out) ? statSync(out).size : -1),
     `${ex?.bytes} reported, ${existsSync(out) ? statSync(out).size : 0} on disk`);

  // ---------------------------------------------------------------- a measurement through it all
  const inside = (await call('viewer_inside', { box: { center: st.bounds.local.centre, half: [1e4, 1e4, 1e4] } })).body;
  ok('analysis runs on the real scan in the webview', inside?.count > 1e6, `${(inside?.count ?? 0).toLocaleString()} points counted exactly`);
}

s.close();
spawnSync('pkill', ['-f', 'e57view.app/Contents/MacOS/e57view']);
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
