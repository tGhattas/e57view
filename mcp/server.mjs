#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// MCP server for e57view. Speaks MCP over stdio to the agent (Claude Code,
// Claude Desktop, Cursor…) and forwards each tool call over a localhost
// WebSocket to the running viewer tab. Screenshots come back as images so the
// agent can look at what it changed.
//
//   claude mcp add e57view -- node /path/to/mcp/server.mjs
//   then open https://e57view.web.app/?agent=1 in Chrome (or toggle "Agent link").
//
// The desktop build serves the same tools from Rust with no Node at all. Neither server
// describes a tool itself: mcp/tools.json holds every name, description, argument schema,
// timeout and reply shape, and both read it. Two descriptions of the same 29 tools in two
// languages drift the week after they are written; one file cannot.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import TOOLS from './tools.json' with { type: 'json' };
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.E57VIEW_PORT || 7337);
let app = null;                       // the connected viewer socket
let nextId = 1;
const pending = new Map();
const chunks = new Map();             // export transfers: id -> Buffer[]

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
wss.on('connection', (ws) => {
  app = ws;
  ws.on('message', (data, isBinary) => {
    if (isBinary) {                   // export chunk: 4-byte id, 4-byte seq, payload
      const buf = Buffer.from(data);
      const id = buf.readUInt32LE(0);
      (chunks.get(id) ?? chunks.set(id, []).get(id)).push(buf.subarray(8));
      return;
    }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.hello) { process.stderr.write(`[e57view-mcp] viewer connected: ${m.hello}\n`); return; }
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'viewer error'));
  });
  ws.on('close', () => { if (app === ws) app = null; });
});

function call(cmd, args = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!app || app.readyState !== 1) return reject(new Error('No viewer connected. Open https://e57view.web.app/?agent=1 (or switch on "Agent link" in the Cache group) in Chrome on this machine.'));
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`viewer did not answer ${cmd} within ${timeoutMs / 1000}s`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    app.send(JSON.stringify({ id, cmd, args }));
  });
}

// ---------------------------------------------------------------- shared definitions
/** JSON Schema back to the zod shape the MCP SDK wants. Only the constructs tools.json uses. */
function zod(s) {
  let t;
  if (Array.isArray(s.enum)) t = z.enum(s.enum);
  else switch (s.type) {
    case 'string': t = z.string(); break;
    case 'boolean': t = z.boolean(); break;
    case 'integer': case 'number': {
      t = z.number();
      if (s.type === 'integer') t = t.int();
      if (s.minimum !== undefined) t = t.min(s.minimum);
      if (s.maximum !== undefined) t = t.max(s.maximum);
      break;
    }
    case 'array': {
      t = z.array(zod(s.items ?? {}));
      if (s.minItems !== undefined && s.minItems === s.maxItems) t = t.length(s.minItems);
      else { if (s.minItems !== undefined) t = t.min(s.minItems); if (s.maxItems !== undefined) t = t.max(s.maxItems); }
      break;
    }
    case 'object': t = s.properties ? z.object(shape(s)) : z.record(z.any()); break;
    default: t = z.any();
  }
  if (s.description) t = t.describe(s.description);
  if (s.default !== undefined) t = t.default(s.default);
  return t;
}
function shape(s) {
  const req = new Set(s.required ?? []);
  const out = {};
  for (const [k, v] of Object.entries(s.properties ?? {})) {
    const t = zod(v);
    out[k] = req.has(k) || v.default !== undefined ? t : t.optional();
  }
  return out;
}

// ---------------------------------------------------------------- turning a reply into content
const json = (v) => ({ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) });
/** True when this call's arguments match a `{op:[...]}`-style condition from tools.json. */
const matches = (cond, args) => !cond || Object.entries(cond).every(([k, vs]) => vs.includes(args?.[k]));
/** Collect a payload the viewer handed back in parts (its HTTP relay caps a reply at 1 MiB;
 *  this websocket does not, but the command is the same either way). */
async function collectParts(cmd, args, first, timeoutMs, field = 'image') {
  const p = first?.[field];
  if (!p || typeof p.data !== 'string') return null;
  let all = p.data;
  for (let i = 1; i < (p.parts || 1); i++) {
    const r = await call(cmd, { ...args, part: i }, timeoutMs);
    all += r?.[field]?.data ?? '';
  }
  return all;
}

/** One handler for every tool, driven entirely by the `ui` record in tools.json. */
async function run(def, args) {
  const { cmd, timeoutMs, ui } = def;
  const wf = ui.writesFile;

  // a tool that writes a file on this machine: two ways the bytes come back
  if (wf && matches(wf.when, args) && args?.[wf.arg]) {
    const path = args[wf.arg];
    const { [wf.arg]: _drop, ...rest } = args;
    if (wf.via === 'chunks') {
      const r = await call(cmd, rest, timeoutMs);
      const parts = chunks.get(r.transferId) ?? []; chunks.delete(r.transferId);
      const buf = Buffer.concat(parts);
      writeFileSync(path, buf);
      return { content: [json({ saved: path, bytes: buf.length, ...(wf.count ? { [wf.count]: r[wf.count] } : {}) })] };
    }
    // the other way: base64 in the reply itself, paged because the HTTP relay caps a reply
    const first = await call(cmd, { ...rest, part: 0 }, timeoutMs);
    let b64 = first.data ?? '';
    for (let i = 1; i < (first.parts || 1); i++) b64 += (await call(cmd, { ...rest, part: i }, timeoutMs)).data ?? '';
    const buf = Buffer.from(b64, 'base64');
    writeFileSync(path, buf);
    const { data: _d, ...meta } = first;
    return { content: [json({ saved: path, bytes: buf.length, ...meta })] };
  }

  const r = await call(cmd, args ?? {}, timeoutMs);

  if (ui.shot === 'own-image') {
    const b64 = await collectParts(cmd, args ?? {}, r, timeoutMs);
    const { image, ...rest } = r ?? {};
    const c = [];
    if (b64) c.push({ type: 'image', data: b64, mimeType: image?.mime ?? 'image/jpeg' });
    c.push(json(rest));
    return { content: c };
  }
  if (ui.shot === 'own-png') {
    const { png, ...rest } = r ?? {};
    const c = [];
    if (png) c.push({ type: 'image', data: png, mimeType: 'image/png' });
    c.push(json(rest));
    return { content: c };
  }
  // a courtesy picture of what changed, unless this call is one of the read-only ops
  let shot = ui.shot === 'always';
  if (shot && matches(ui.noShotWhen, args) && ui.noShotWhen) shot = false;
  if (ui.onlyShotWhenPresent && args?.[ui.onlyShotWhenPresent] === undefined) shot = false;
  const c = [json(r)];
  if (shot) {
    try { const s = await call('screenshot', { width: 1280 }); c.push({ type: 'image', data: s.png, mimeType: 'image/png' }); }
    catch { /* the picture is a courtesy; the answer is the point */ }
  }
  return { content: c };
}

const server = new McpServer({ name: 'e57view', version: '0.1.0' });
for (const def of TOOLS) server.tool(def.name, def.description, shape(def.inputSchema), (a) => run(def, a));

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[e57view-mcp] ready; ${TOOLS.length} tools; bridge on ws://127.0.0.1:${PORT}\n`);
