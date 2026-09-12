#!/usr/bin/env node
// MCP server for e57view. Speaks MCP over stdio to the agent (Claude Code,
// Claude Desktop, Cursor…) and forwards each tool call over a localhost
// WebSocket to the running viewer tab. Screenshots come back as images so the
// agent can look at what it changed.
//
//   claude mcp add e57view -- node /path/to/mcp/server.mjs
//   then open https://opensketch.web.app/?agent=1 in Chrome (or toggle "Agent link").
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import TOOLS from './tools.json' with { type: 'json' };
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
    if (!app || app.readyState !== 1) return reject(new Error('No viewer connected. Open https://opensketch.web.app/?agent=1 (or switch on "Agent link" in the Cache group) in Chrome on this machine.'));
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`viewer did not answer ${cmd} within ${timeoutMs / 1000}s`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    app.send(JSON.stringify({ id, cmd, args }));
  });
}
const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
/** Collect a payload the viewer handed back in parts (its HTTP relay caps a reply at 1 MiB;
 *  this websocket does not, but the command is the same either way). */
async function collect(cmd, args, first, field = 'image') {
  const p = first?.[field];
  if (!p || typeof p.data !== 'string') return null;
  let all = p.data;
  for (let i = 1; i < (p.parts || 1); i++) {
    const r = await call(cmd, { ...args, part: i }, 180000);
    all += r?.[field]?.data ?? '';
  }
  return all;
}
/** A command that answers with its own calibrated image: show the image, then the record. */
async function withOwnImage(cmd, args) {
  const r = await call(cmd, args, 180000);
  const b64 = await collect(cmd, args, r);
  const { image, ...rest } = r ?? {};
  const c = [];
  if (b64) c.push({ type: 'image', data: b64, mimeType: image?.mime ?? 'image/jpeg' });
  c.push({ type: 'text', text: JSON.stringify(rest, null, 2) });
  return { content: c };
}
const withShot = async (v, shot) => {
  const c = [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }];
  if (shot) { const s = await call('screenshot', { width: 1280 }); c.push({ type: 'image', data: s.png, mimeType: 'image/png' }); }
  return { content: c };
};

// ---------------------------------------------------------------- tool definitions
//
// The names, descriptions and argument schemas live in tools.json, which the Rust desktop
// build embeds as well. Two servers describing the same tools in two languages drift the
// week after they are written; one file cannot. Only the handlers live here, and registering
// one whose definition is missing — or leaving a definition with no handler — is an error at
// start-up rather than a tool that quietly does nothing.
const server = new McpServer({ name: 'e57view', version: '0.1.0' });
const defs = new Map(TOOLS.map(t => [t.name, t]));

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
function reg(name, handler) {
  const d = defs.get(name);
  if (!d) throw new Error(`${name} has a handler but no definition in mcp/tools.json`);
  defs.delete(name);
  server.tool(name, d.description, shape(d.inputSchema), handler);
}

reg('viewer_state', async () => text(await call('state')));

reg('viewer_view', async (a) => withOwnImage('view', a));

reg('viewer_section', async (a) => withOwnImage('section', a));

reg('viewer_probe', async (a) => text(await call('probe', a)));

reg('viewer_heightmap', async (a) => withOwnImage('heightmap', a));

reg('viewer_contour', async (a) => text(await call('contour', a, 180000)));

reg('viewer_fitplane', async (a) => text(await call('fitplane', a, 180000)));

reg('viewer_distance', async (a) => text(await call('distance', a)));

reg('viewer_inside', async (a) => text(await call('inside', a, 180000)));

reg('viewer_screenshot', async ({ width }) => { const s = await call('screenshot', { width: width ?? 1280 }); return { content: [{ type: 'image', data: s.png, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ view: s.view, camera: s.camera }, null, 2) }] }; });

reg('viewer_set_view', async (a) => withShot(await call('set_view', a), true));

reg('viewer_set', async ({ settings }) => withShot(await call('set', settings), true));

reg('viewer_regions', async (a) => withShot(await call('regions', a, 120000), a.op !== 'list'));

reg('viewer_pick', async (a) => text(await call('pick', a)));

reg('viewer_measure', async (a) => withShot(await call('measure', a), true));

reg('viewer_export', async ({ path, format, stride }) => {
  const r = await call('export', { format, stride }, 30 * 60 * 1000);
  const parts = chunks.get(r.transferId) ?? []; chunks.delete(r.transferId);
  const buf = Buffer.concat(parts);
  writeFileSync(path, buf);
  return text({ saved: path, bytes: buf.length, points: r.count });
});

reg('viewer_open', async (a) => withShot(await call('open', a, 15 * 60 * 1000), true));

reg('viewer_surface', async (a) => {
  if (a.op === 'export') {
    if (!a.path) throw new Error('op=export needs path');
    const args = { op: 'export', format: a.format ?? 'ply', part: 0 };
    const first = await call('surface', args, 600000);
    let all = first.data ?? '';
    for (let i = 1; i < (first.parts || 1); i++) all += (await call('surface', { ...args, part: i }, 600000)).data ?? '';
    const buf = Buffer.from(all, 'base64');
    writeFileSync(a.path, buf);
    return text({ saved: a.path, bytes: buf.length, parts: first.parts, triangles: first.triangles, vertices: first.vertices, holeRatio: first.holeRatio });
  }
  return withShot(await call('surface', a, 600000), true);
});

reg('viewer_script', async (a) => withShot(await call('script', a, 30 * 60 * 1000), true));

reg('viewer_mesh', async (a) => {
  if (a.op === 'save') {
    if (!a.path) throw new Error('op=save needs path');
    const r = await call('mesh', { op: 'save', format: a.format ?? 'ply' }, 600000);
    const parts = chunks.get(r.transferId) ?? []; chunks.delete(r.transferId);
    const buf = Buffer.concat(parts);
    writeFileSync(a.path, buf);
    return text({ saved: a.path, bytes: buf.length, triangles: r.triangles });
  }
  return withShot(await call('mesh', a, 900000), a.op !== 'list' && a.op !== 'measure');
});

reg('viewer_entities', async (a) => withShot(await call('entities', a, 300000), a.op !== 'list'));

reg('viewer_register', async (a) => withShot(await call('register', a, 900000), true));

reg('viewer_distance_to', async (a) => withShot(await call('distance_to', a, 900000), true));

reg('viewer_volume', async (a) => withShot(await call('volume', a, 600000), true));

reg('viewer_fit', async (a) => withShot(await call('fit', a, 300000), true));

reg('viewer_detect', async (a) => withShot(await call('detect', a, 900000), true));

reg('viewer_transform', async (a) => withShot(await call('transform', a, 120000), a.op !== 'get'));

reg('viewer_history', async (a) => withShot(await call('history', a, 180000), a.op !== 'status'));

reg('viewer_stations', async (a) => withShot(await call('stations', a, 60000), a.enter !== undefined));

if (defs.size) throw new Error(`mcp/tools.json defines tools with no handler here: ${[...defs.keys()].join(', ')}`);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[e57view-mcp] ready; bridge on ws://127.0.0.1:${PORT}\n`);
