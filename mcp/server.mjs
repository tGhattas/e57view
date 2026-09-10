#!/usr/bin/env node
// MCP server for e57view. Speaks MCP over stdio to the agent (Claude Code,
// Claude Desktop, Cursor…) and forwards each tool call over a localhost
// WebSocket to the running viewer tab. Screenshots come back as images so the
// agent can look at what it changed.
//
//   claude mcp add e57view -- node /path/to/mcp/server.mjs
//   then open https://opensketch.web.app/?agent=1 in Chrome (or toggle "Agent link").
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
const withShot = async (v, shot) => {
  const c = [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }];
  if (shot) { const s = await call('screenshot', { width: 1280 }); c.push({ type: 'image', data: s.png, mimeType: 'image/png' }); }
  return { content: c };
};

const server = new McpServer({ name: 'e57view', version: '0.1.0' });

server.tool('viewer_state', 'Current viewer state: file, points in memory, camera, knobs, regions, measurements, suggestions.', {},
  async () => text(await call('state')));

server.tool('viewer_screenshot', 'Capture the current view as a PNG image.', { width: z.number().optional().describe('max width in px, default 1280') },
  async ({ width }) => { const s = await call('screenshot', { width: width ?? 1280 }); return { content: [{ type: 'image', data: s.png, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(s.view) }] }; });

server.tool('viewer_set_view', 'Move the camera. preset: fit | top; or give pose {p:[x,y,z], t:[x,y,z]} (local metres, Z up); or fly {position, yaw, pitch}. Returns a screenshot.', {
  preset: z.enum(['fit', 'top']).optional(), pose: z.object({ p: z.array(z.number()).length(3), t: z.array(z.number()).length(3) }).optional(),
  orbit: z.object({ azimuthDeg: z.number(), elevationDeg: z.number(), distance: z.number().optional() }).optional().describe('orbit around the current target'),
}, async (a) => withShot(await call('set_view', a), true));

server.tool('viewer_set', 'Change display settings. Any subset: colorMode (0 rgb,1 intensity,2 rgb×intensity,3 elevation,4 normals,5 flat), pointSize, maxPx, edl, edlStrength, normalShade, budget, density, clipZMin, clipZMax, bright, gamma.', {
  settings: z.record(z.union([z.number(), z.boolean()])) }, async ({ settings }) => withShot(await call('set', settings), true));

const regionShape = z.object({
  id: z.string().optional(), kind: z.enum(['box', 'sphere', 'slab']), role: z.enum(['keep', 'pending', 'delete']).default('keep'),
  center: z.array(z.number()).length(3), half: z.array(z.number()).length(3).optional(), radius: z.number().optional(),
  quat: z.array(z.number()).length(4).optional().describe('x y z w'), label: z.string().optional(),
});
server.tool('viewer_regions', 'List, add, update, remove or clear crop/delete regions (box, sphere, slab). role keep = crop to it; delete = remove inside. apply drops points accordingly (irreversible in memory; reload restores).', {
  op: z.enum(['list', 'add', 'update', 'remove', 'clear', 'apply']), region: regionShape.optional(), id: z.string().optional(),
}, async (a) => withShot(await call('regions', a, 120000), a.op !== 'list'));

server.tool('viewer_pick', 'World point under a screen pixel (x,y in CSS px of the last screenshot scale), or null.', { x: z.number(), y: z.number() },
  async (a) => text(await call('pick', a)));

server.tool('viewer_measure', 'Distance between two world points, or between two picked pixels.', {
  a: z.array(z.number()).length(3).optional(), b: z.array(z.number()).length(3).optional(),
  pxA: z.array(z.number()).length(2).optional(), pxB: z.array(z.number()).length(2).optional(), clear: z.boolean().optional(),
}, async (a) => withShot(await call('measure', a), true));

server.tool('viewer_export', 'Export the points in memory to a local file on this machine. format e57|las|ply, stride keeps 1 in N.', {
  path: z.string(), format: z.enum(['e57', 'las', 'ply']), stride: z.number().int().min(1).default(1),
}, async ({ path, format, stride }) => {
  const r = await call('export', { format, stride }, 30 * 60 * 1000);
  const parts = chunks.get(r.transferId) ?? []; chunks.delete(r.transferId);
  const buf = Buffer.concat(parts);
  writeFileSync(path, buf);
  return text({ saved: path, bytes: buf.length, points: r.count });
});

server.tool('viewer_open', 'Open a scan: a cached scan by key (as listed by viewer_state.cached, Chromium only) or a cloud scan by id.', {
  cached: z.string().optional(), cloud: z.string().optional(), stride: z.number().int().min(1).optional(),
}, async (a) => withShot(await call('open', a, 15 * 60 * 1000), true));

server.tool('viewer_ai_suggest', 'Ask an AI provider what to clean (vegetation, vehicles, noise). provider heuristic|openai|xai. Returns suggestions and shows them as pending boxes.', {
  provider: z.enum(['heuristic', 'openai', 'xai']).default('heuristic'), model: z.string().optional(), kinds: z.array(z.string()).optional(),
}, async (a) => withShot(await call('ai_suggest', a, 300000), true));

server.tool('viewer_suggestions', 'Accept/reject AI suggestions by id or all, or apply the accepted ones.', {
  op: z.enum(['list', 'accept', 'reject', 'accept_all', 'reject_all', 'apply', 'clear']), id: z.string().optional(),
}, async (a) => withShot(await call('suggestions', a, 120000), a.op !== 'list'));

server.tool('viewer_stations', 'List panorama stations, or enter one by index to look around its 360° photo (exit with index -1).', { enter: z.number().int().optional() },
  async (a) => withShot(await call('stations', a, 60000), a.enter !== undefined));

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[e57view-mcp] ready; bridge on ws://127.0.0.1:${PORT}\n`);
