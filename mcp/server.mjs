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

server.tool('viewer_state', 'Everything about the active layer (and the list of layers): point count, local and global bounds, the global shift, median point spacing, what fraction of points carry a real normal, the scalar field, the reconstructed surface (triangles, vertices, holeRatio = boundary edges / triangles, the voxel it was built at), station count, the cloud transform, unsaved work, the camera record — and recommendedSource, which says whether to measure the points or the surface, and why. Units are metres throughout. Start here.', {},
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
  id: z.string().optional(), kind: z.enum(['box', 'sphere', 'slab', 'prism']), role: z.enum(['keep', 'pending', 'delete']).default('keep'),
  center: z.array(z.number()).length(3), half: z.array(z.number()).length(3).optional(), radius: z.number().optional(),
  quat: z.array(z.number()).length(4).optional().describe('x y z w'), label: z.string().optional(),
  poly: z.array(z.array(z.number()).length(2)).optional().describe('prism: the outline in the region\'s own local XY plane, metres, extruded to +/- half[2] along local Z'),
});
server.tool('viewer_regions', 'Bounding shapes that decide what survives: box, sphere, slab, or prism (an outline extruded along a view direction). The usual way to make one is place: point at a thing (a world point, or a pixel of the last view) and get a small box or sphere centred exactly there, then grow it by a factor or fit it to what it holds. role keep = crop to the union of the keeps; delete = remove what is inside. lasso is the shortcut for a prism: give screen pixels from the current camera and it builds the region the way the panel does, reporting how many points it holds. mode sets which way the panel\'s own crop region cuts. apply commits every keep and delete region in one undoable step. A region is not a cut until apply, so it can be inspected from any angle first.', {
  op: z.enum(['list', 'place', 'grow', 'fit', 'add', 'update', 'remove', 'clear', 'mode', 'lasso', 'apply']), region: regionShape.optional(), id: z.string().optional(),
  at: z.array(z.number()).length(3).optional().describe('op=place: where to put it, local metres'),
  pixel: z.array(z.number()).length(2).optional().describe('op=place: a pixel of the last view instead'),
  kind: z.enum(['box', 'sphere']).optional().describe('op=place'),
  size: z.number().optional().describe('op=place: starting size across, metres'),
  factor: z.number().optional().describe('op=grow: multiply the active region by this'),
  role: z.enum(['keep', 'delete']).optional().describe('op=mode or op=lasso: keep inside, or remove inside'),
  pixels: z.array(z.array(z.number()).length(2)).optional().describe('op=lasso: [[x,y], …] of the image you measured'),
  width: z.number().optional(), height: z.number().optional().describe('op=lasso: the pixel size of that image, if it was not the live canvas'),
  depth: z.number().optional().describe('op=lasso: half depth along the view axis in metres; the default spans the cloud'),
  label: z.string().optional(),
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
  format: z.enum(['ply', 'obj', 'stl']).optional().describe('op=export'), path: z.string().optional().describe('op=export: where to write it'),
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

server.tool('viewer_mesh', 'Triangle meshes as layers. A mesh opened in the viewer (Mesh -> Import mesh…, PLY/OBJ/STL) becomes a layer of its own, drawn alongside the clouds and moved by viewer_transform like one; every visible layer\'s triangles are drawn, not only the active one\'s. list reports the mesh layers. measure gives surface area and volume through the layer\'s transform, with the boundary edge count next to them — volume only means anything when closed is true, and an open mesh says so rather than quietly returning a number. sample scatters points over the triangles, area-weighted, into a NEW point layer with normals and colours (give count or density in points per m2). distance measures every point of the ACTIVE CLOUD to the nearest TRIANGLE of a mesh layer — point-to-triangle, not point-to-nearest-vertex — and writes it as a scalar field. flip reverses the winding. smooth is Taubin by default, which keeps the volume, or plain Laplacian with taubin:false, which shrinks it. decimate is vertex clustering at cellCm, which is fast but cannot hit an exact triangle count. save writes PLY, OBJ or STL to a path on this machine, with the layer transform and the global shift baked in.', {
  op: z.enum(['list', 'measure', 'sample', 'distance', 'flip', 'smooth', 'decimate', 'show', 'save']),
  count: z.number().int().optional().describe('op=sample: how many points in all'),
  density: z.number().optional().describe('op=sample: points per square metre, instead of count'),
  mesh: z.string().optional().describe('op=distance: the mesh layer id or name'),
  signed: z.boolean().optional().describe('op=distance: report which side of the surface each point is on'),
  iterations: z.number().int().optional().describe('op=smooth: passes, default 5'),
  taubin: z.boolean().optional().describe('op=smooth: keep the volume, default true'),
  cellCm: z.number().optional().describe('op=decimate: clustering cell in centimetres, default 10'),
  mode: z.enum(['points', 'mesh', 'both']).optional().describe('op=show'),
  format: z.enum(['ply', 'obj', 'stl']).optional().describe('op=save'),
  path: z.string().optional().describe('op=save: where to write it'),
}, async (a) => {
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

server.tool('viewer_entities', 'The clouds in memory. Every visible one is drawn; exactly one is active, and every other tool — crop, analysis, surface, transform, export — works on the active one. list reports them with their point counts and transforms; activate switches; show/hide toggles drawing without unloading; rename; clone copies the active one; merge appends every other visible layer into the active one through each of their transforms (scalar fields are dropped, and it cannot be undone); remove unloads one. A file is added in the viewer itself (Layers -> Add file…) or with viewer_open for a cached scan.', {
  op: z.enum(['list', 'activate', 'show', 'hide', 'rename', 'clone', 'merge', 'remove']),
  id: z.string().optional().describe('the layer id or its name'), name: z.string().optional().describe('op=rename'),
}, async (a) => withShot(await call('entities', a, 300000), a.op !== 'list'));

server.tool('viewer_register', 'Move the ACTIVE layer onto a reference layer; the reference is never touched. centres matches bounding-box centres, scales matches their sizes (for two clouds in different units — not for a rotated copy, whose boxes legitimately differ), and icp is point-to-plane fine registration, reporting per-iteration RMS, final RMS, overlap fraction and the matrix. Each is one undoable transform step.', {
  op: z.enum(['centres', 'scales', 'icp']),
  reference: z.string().describe('the id or name of another layer'),
  maxDistance: z.number().optional().describe('op=icp: rejection gate as a multiple of three point spacings, default 6'),
  maxIterations: z.number().int().optional().describe('op=icp: default 30'),
}, async (a) => withShot(await call('register', a, 900000), true));

server.tool('viewer_distance_to', 'Distance from every point of the ACTIVE layer to the nearest point of a reference layer, written as a scalar field named "Distance to <reference>" — so the colour ramp, the histogram and the value filter all work on it. signed projects onto the reference point\'s own normal instead, which says which side of the reference surface each point is on: settlement and heave stop cancelling into the same positive number. A reference bigger than the analyser holds is subsampled, and the reply says so.', {
  reference: z.string(), signed: z.boolean().optional(),
}, async (a) => withShot(await call('distance_to', a, 900000), true));

server.tool('viewer_volume', 'A 2.5D volume between the ACTIVE layer and a reference — another layer, or a flat plane at a height. Reports added (fill), removed (cut) and net separately, because their sum hides both, plus the area it covered. The reference is hole-filled first and the active layer is not: a cell the reference has no point in still has ground under it, but filling the active layer would invent surface past its own edge. Draws the difference as a coloured grid.', {
  reference: z.string().optional().describe('a layer id or name; omit or "plane" for a flat plane'),
  plane: z.number().optional().describe('the plane height in local metres, when there is no reference layer'),
  cell: z.number().optional().describe('cell size in metres, default 0.25'),
}, async (a) => withShot(await call('volume', a, 600000), true));

server.tool('viewer_fit', 'Fit a primitive to the ACTIVE REGION\'s contents, or to the whole layer when no region is active — or give a box and it fits inside that. Returns the parameters and the RMS, which is the number that decides whether to believe them: a cylinder fitted to a flat wall has a radius and an axis and means nothing, and only the residual says so. The fitted shape is drawn in the view.', {
  shape: z.enum(['plane', 'sphere', 'cylinder', 'circle']),
  box: z.object({ center: z.array(z.number()).length(3), half: z.array(z.number()).length(3), quat: z.array(z.number()).length(4).optional() }).optional(),
}, async (a) => withShot(await call('fit', a, 300000), true));

server.tool('viewer_detect', 'Find shapes without being told where: RANSAC over the points, one shape at a time, removing each shape\'s inliers before looking for the next. Returns the shapes with their parameters, point counts and RMS, and writes a scalar field named "Shape" holding each point\'s shape index — so the ramp shows them and the value filter isolates one.', {
  tolerance: z.number().optional().describe('metres a point may be from a shape and still belong to it, default 0.02'),
  minPoints: z.number().int().optional().describe('support a shape needs, default 2000'),
  shapes: z.array(z.enum(['plane', 'sphere', 'cylinder'])).optional(),
}, async (a) => withShot(await call('detect', a, 900000), true));

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
