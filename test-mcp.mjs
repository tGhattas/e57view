// SPDX-License-Identifier: GPL-3.0-only
// The two MCP servers — the Node one for the web build, the Rust one inside the desktop app —
// must offer exactly the tools in mcp/tools.json, and nothing else. This drives each over
// stdio the way an agent does (initialize, notifications/initialized, tools/list, ping) and
// compares what comes back against the file.
//
//   node test-mcp.mjs                      # the Node server
//   node test-mcp.mjs --rust               # the desktop binary's --mcp mode
//   node test-mcp.mjs --call               # also round-trip a tools/call to a running app
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const TOOLS = JSON.parse(readFileSync(new URL('./mcp/tools.json', import.meta.url), 'utf8'));
const wantRust = process.argv.includes('--rust');
const wantCall = process.argv.includes('--call');
const RUST_BIN = process.env.E57VIEW_BIN || 'desktop/target/release/e57view';

let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };

/** One stdio MCP conversation: newline-delimited JSON-RPC both ways. */
function session(cmd, args) {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map();
  const notes = [];
  p.stdout.on('data', d => {
    buf += d.toString();
    for (let nl; (nl = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      else notes.push(m);
    }
  });
  let err = '';
  p.stderr.on('data', d => { err += d.toString(); });
  let id = 0;
  return {
    proc: p, notes, get stderr() { return err; },
    send(method, params) { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); },
    req(method, params, timeoutMs = 25000) {
      const myId = ++id;
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`${method} timed out after ${timeoutMs / 1000}s${err ? ' · stderr: ' + err.slice(-300) : ''}`)), timeoutMs);
        waiting.set(myId, m => { clearTimeout(t); m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result); });
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
      });
    },
    close() { p.stdin.end(); p.kill(); },
  };
}

/** Compare a served tool list against mcp/tools.json, field by field. */
function compare(label, served) {
  const byName = new Map(served.map(t => [t.name, t]));
  ok(`${label}: serves every tool in tools.json`, served.length === TOOLS.length,
     `${served.length} served, ${TOOLS.length} defined`);
  const missing = TOOLS.filter(t => !byName.has(t.name)).map(t => t.name);
  const extra = served.filter(t => !TOOLS.some(d => d.name === t.name)).map(t => t.name);
  ok(`${label}: no tool missing`, !missing.length, missing.join(', ') || 'none');
  ok(`${label}: no tool invented`, !extra.length, extra.join(', ') || 'none');
  let descOff = [], schemaOff = [];
  for (const d of TOOLS) {
    const s = byName.get(d.name);
    if (!s) continue;
    if (s.description !== d.description) descOff.push(d.name);
    // required and property names are what an agent actually depends on
    const sp = Object.keys(s.inputSchema?.properties ?? {}).sort().join(',');
    const dp = Object.keys(d.inputSchema?.properties ?? {}).sort().join(',');
    const sr = [...(s.inputSchema?.required ?? [])].sort().join(',');
    const dr = [...(d.inputSchema?.required ?? [])].sort().join(',');
    if (sp !== dp || sr !== dr) schemaOff.push(`${d.name} (${sp} / ${dp} · req ${sr} / ${dr})`);
  }
  ok(`${label}: every description is the one in tools.json`, !descOff.length, descOff.join(', ') || 'all match');
  ok(`${label}: every argument list is the one in tools.json`, !schemaOff.length, schemaOff.join(' | ') || 'all match');
}

async function drive(label, cmd, args) {
  const s = session(cmd, args);
  try {
    const init = await s.req('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e57view-test', version: '1' },
    });
    ok(`${label}: initialize names the server`, init?.serverInfo?.name === 'e57view', JSON.stringify(init?.serverInfo ?? null));
    ok(`${label}: and declares a tools capability`, !!init?.capabilities?.tools, JSON.stringify(init?.capabilities ?? {}));
    s.send('notifications/initialized', {});
    await s.req('ping', {});
    ok(`${label}: answers ping`, true, '');
    const list = await s.req('tools/list', {});
    compare(label, list?.tools ?? []);
    if (wantCall) {
      const r = await s.req('tools/call', { name: 'viewer_state', arguments: {} }, 60000);
      const body = (r?.content ?? []).find(c => c.type === 'text')?.text ?? '';
      let st = null; try { st = JSON.parse(body); } catch {}
      ok(`${label}: tools/call reaches the running app`, !!st && typeof st.points === 'number', st ? `${st.points} points, ${st.units}` : body.slice(0, 120));
    }
    return true;
  } catch (e) {
    ok(`${label}: the conversation completed`, false, String(e.message).slice(0, 300));
    return false;
  } finally { s.close(); }
}

// ---------------------------------------------------------------- definitions themselves
ok('tools.json parses and holds tools', Array.isArray(TOOLS) && TOOLS.length > 20, `${TOOLS.length} tools`);
const badly = TOOLS.filter(t => !t.name || !t.description || t.inputSchema?.type !== 'object');
ok('every definition has a name, a description and an object schema', !badly.length, badly.map(t => t.name).join(', ') || 'all well-formed');
const dupes = TOOLS.map(t => t.name).filter((n, i, a) => a.indexOf(n) !== i);
ok('no tool is defined twice', !dupes.length, dupes.join(', ') || 'none');

await drive('node', process.execPath, ['mcp/server.mjs']);

if (wantRust) {
  if (!existsSync(RUST_BIN)) {
    ok(`rust: ${RUST_BIN} exists`, false, 'build it with npm run desktop:build, or set E57VIEW_BIN');
  } else {
    await drive('rust', RUST_BIN, ['--mcp']);
  }
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
