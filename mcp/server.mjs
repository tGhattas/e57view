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

const server = new McpServer({ name: 'e57view', version: '0.1.0' });

server.tool('viewer_state', 'Everything about the loaded scan: point count, local and global bounds, the global shift, median point spacing, what fraction of points carry a real normal, the scalar field, the reconstructed surface (triangles, vertices, holeRatio = boundary edges / triangles, the voxel it was built at), station count, the cloud transform, unsaved work, the camera record — and recommendedSource, which says whether to measure the points or the surface, and why. Units are metres throughout. Start here.', {},
  async () => text(await call('state')));

server.tool('viewer_view', 'A calibrated image. With a preset it is rendered with a true orthographic projection, so one metre is the same number of pixels everywhere and the mapping that comes back turns any pixel into a world point exactly: topLeft plus perPixelRight/perPixelDown, or originX/originY/extentX/extentY for the axis-aligned presets. Use this, not viewer_screenshot, for anything you intend to measure. Set ortho:false for an ordinary perspective look from that direction. The current colour mode is respected, so a scalar field photographs as itself.', {
  preset: z.enum(['top', 'bottom', 'front', 'back', 'left', 'right', 'iso', 'current']).default('top'),
  width: z.number().int().optional().describe('longest side in pixels, 64-2048, default 1024'),
  ortho: z.boolean().optional().describe('default true for a preset: orthographic and measurable'),
}, async (a) => withOwnImage('view', a));

server.tool('viewer_section', 'A floor plan or a wall elevation: an orthographic image of one slab only, with the same exact pixel-to-metre mapping. axis is the slab normal, at is where it sits (metres, local frame — take it from viewer_state bounds), thickness is how deep. The rest of the cloud is hidden for the render and put back afterwards.', {
  axis: z.enum(['x', 'y', 'z']).default('z'), at: z.number().optional().describe('default the middle of the bounds'),
  thickness: z.number().optional().describe('metres, default about eight point spacings'),
  width: z.number().int().optional(),
}, async (a) => withOwnImage('section', a));

server.tool('viewer_probe', 'Turn pixels of the most recent viewer_view or viewer_section back into world points, local and global. That render\'s camera is re-established first, so the answer is exact even if the view has moved since. null where the pixel hit nothing.', {
  pixels: z.array(z.array(z.number()).length(2)).describe('[[x,y], …] in the pixels of that image'),
}, async (a) => text(await call('probe', a)));

server.tool('viewer_heightmap', 'A raster of the highest surface per cell, as a grey PNG, with its metre mapping. Grey 0 means no data; 1..255 maps linearly onto [zMin, zMax]. Computed from a uniform sample, so it is fast on tens of millions of points.', {
  axis: z.enum(['x', 'y', 'z']).default('z').describe('which axis is measured; z is a height model'),
  resolution: z.number().int().optional().describe('cells along the longer side, default 512'),
}, async (a) => withOwnImage('heightmap', a));

server.tool('viewer_contour', 'The footprint of a horizontal slab as 2D polylines in metres (local frame; add translation for global), traced by marching squares over an occupancy raster and simplified. This is the primitive to draw a plan from — vectors, not a picture.', {
  z: z.number().optional().describe('slab centre in metres, local frame'),
  thickness: z.number().optional(), resolution: z.number().int().optional(),
  dilate: z.boolean().optional().describe('grow the raster by a cell first; use on a sparse or patchy scan'),
  maxVertices: z.number().int().optional().describe('simplification is loosened until the result fits, default 12000'),
}, async (a) => text(await call('contour', a, 180000)));

server.tool('viewer_fitplane', 'Best-fit plane through the points inside a box (or through points you supply) by PCA: normal, centroid, RMS and worst distance, dip and dip direction in degrees, and how many points it used. RMS is how flat the thing actually is — the number that says whether to trust the plane.', {
  box: z.object({ center: z.array(z.number()).length(3), half: z.array(z.number()).length(3), quat: z.array(z.number()).length(4).optional() }).optional(),
  points: z.array(z.array(z.number()).length(3)).optional(),
}, async (a) => text(await call('fitplane', a, 180000)));

server.tool('viewer_distance', 'Straight-line distance between two world points, with the height difference and the horizontal component. Metres.', {
  a: z.array(z.number()).length(3), b: z.array(z.number()).length(3),
}, async (a) => text(await call('distance', a)));

server.tool('viewer_inside', 'Exact count and bounding box of the points inside a box. Exact, not sampled: cells wholly inside are counted without being read, only the cells the box cuts are.', {
  box: z.object({ center: z.array(z.number()).length(3), half: z.array(z.number()).length(3), quat: z.array(z.number()).length(4).optional() }),
}, async (a) => text(await call('inside', a, 180000)));

server.tool('viewer_screenshot', 'The current view as a PNG, plus the camera record (position, target, up, fov, aspect, pixel size, view-projection matrix) so nothing you are shown is uncalibrated. For anything measurable prefer viewer_view, which is orthographic.', { width: z.number().optional().describe('max width in px, default 1280') },
  async ({ width }) => { const s = await call('screenshot', { width: width ?? 1280 }); return { content: [{ type: 'image', data: s.png, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ view: s.view, camera: s.camera }, null, 2) }] }; });

server.tool('viewer_set_view', 'Move the camera. preset: fit | top; or give pose {p:[x,y,z], t:[x,y,z]} (local metres, Z up); or fly {position, yaw, pitch}. Returns a screenshot.', {
  preset: z.enum(['fit', 'top']).optional(), pose: z.object({ p: z.array(z.number()).length(3), t: z.array(z.number()).length(3) }).optional(),
  orbit: z.object({ azimuthDeg: z.number(), elevationDeg: z.number(), distance: z.number().optional() }).optional().describe('orbit around the current target'),
}, async (a) => withShot(await call('set_view', a), true));

server.tool('viewer_set', 'Change display settings. Any subset: colorMode (0 rgb,1 intensity,2 rgb×intensity,3 elevation,4 normals,5 scalar field,6 flat), pointSize, maxPx, edl, edlStrength, normalShade, budget, density, clipZMin, clipZMax, bright, gamma.', {
  settings: z.record(z.union([z.number(), z.boolean()])) }, async ({ settings }) => withShot(await call('set', settings), true));

const regionShape = z.object({
  id: z.string().optional(), kind: z.enum(['box', 'sphere', 'slab']), role: z.enum(['keep', 'pending', 'delete']).default('keep'),
  center: z.array(z.number()).length(3), half: z.array(z.number()).length(3).optional(), radius: z.number().optional(),
  quat: z.array(z.number()).length(4).optional().describe('x y z w'), label: z.string().optional(),
});
server.tool('viewer_regions', 'List, add, update, remove or clear crop/delete regions (box, sphere, slab). role keep = crop to it; delete = remove inside. apply drops points accordingly (undoable until Save).', {
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

server.tool('viewer_surface', 'Reconstruct a triangle surface from the points and their normals, show or hide it, discard it, or write it to a file on this machine. build takes voxelCm (detail, smaller is finer), smooth (0-6) and fillGaps (1-4), and reports holeRatio so you can tell whether the result is worth measuring. export writes PLY or OBJ to `path` with the cloud transform and the global shift already baked in. The points are never modified.', {
  op: z.enum(['build', 'show', 'clear', 'export']), voxelCm: z.number().optional(), smooth: z.number().int().optional(),
  fillGaps: z.number().optional(), mode: z.enum(['points', 'mesh', 'both']).optional(),
  format: z.enum(['ply', 'obj']).optional().describe('op=export'), path: z.string().optional().describe('op=export: where to write it'),
}, async (a) => {
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

server.tool('viewer_transform', 'Move, rotate, scale or level the whole cloud. The points are never rewritten: the cloud carries a 4x4 matrix applied at render, test, analysis and export time, so this is instant, lossless and undoable, and only a written file bakes it. get reports the matrix; set replaces it (16 numbers, row-major); translate/rotate/scale compose on top of it; level fits a plane to a sample and turns it horizontal; reset clears it.', {
  op: z.enum(['get', 'set', 'translate', 'rotate', 'scale', 'level', 'reset']),
  matrix: z.array(z.number()).length(16).optional().describe('op=set: row-major 4x4'),
  translation: z.array(z.number()).length(3).optional().describe('op=translate: metres'),
  axis: z.enum(['x', 'y', 'z']).optional().describe('op=rotate'),
  degrees: z.number().optional().describe('op=rotate'),
  about: z.enum(['centre', 'origin']).optional().describe('op=rotate/scale pivot, default the bounding-box centre'),
  factor: z.number().optional().describe('op=scale: uniform factor'),
}, async (a) => withShot(await call('transform', a, 120000), a.op !== 'get'));

server.tool('viewer_history', 'Undo or redo the last edit, save a copy of the in-memory cloud (clears undo/redo), or report stack status.', {
  op: z.enum(['undo', 'redo', 'save', 'status']),
}, async (a) => withShot(await call('history', a, 180000), a.op !== 'status'));

server.tool('viewer_stations', 'List panorama stations, or enter one by index to look around its 360° photo (exit with index -1).', { enter: z.number().int().optional() },
  async (a) => withShot(await call('stations', a, 60000), a.enter !== undefined));

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[e57view-mcp] ready; bridge on ws://127.0.0.1:${PORT}\n`);
