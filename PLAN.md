# e57view, build plan

A browser E57 viewer with ReCap-grade visual quality, no install and no upload.

Read `FINDINGS.md` first. Every performance claim here rests on measurements already taken
against a real 3.23 GB / 73.8M-point file.

---

## 1. The bet

Autodesk ReCap is a desktop install with a long import step. The opening it leaves is a viewer
that starts instantly in a tab, keeps the file on the user's disk, and still renders as well.

Three measured facts make that possible:

1. E57 metadata parses in **10 ms** without reading the point data. The UI can be populated
   before the user's hand leaves the mouse.
2. A synchronous ranged-read shim lets WASM read a 3.23 GB file it cannot hold in memory,
   with **no server and no cross-origin isolation**.
3. Full indexing of 73.8M points takes **~23 s** once, then OPFS makes every later open instant.

So the product promise is: *drop a file, see it immediately, wait once, never wait again.*

## 2. Architecture

Four stages, three of them off the main thread.

```
  main thread            worker pool                     OPFS
  ───────────            ───────────                     ────
  drop / picker  ──────► [probe]  header+XML, 10ms
       │                    │
       │  scan card ◄───────┘
       │
       │               ┌► [decode]  wasm e57 ─┐
       ├── index ──────┼► [decode]            ├──► [octree build] ──► nodes/*.bin
       │               └► [decode]            ┘                       hierarchy.bin
       │                                                              meta.json
       │  progress ◄────────────────────────────────────────────────────┘
       │
  [renderer] ◄──── node pages, view-dependent priority ◄──────────────┘
   WebGL2 + EDL + normals
```

**Stage 1, Probe.** Worker opens the file through the ranged-read shim, reads the 48-byte
header and the XML section. Returns scan list, point counts, bounds, poses, sensor strings, and
the image2D table. Cost: 10 ms, 0.2 MB read. The UI shows a real scan card immediately.

**Stage 2, Index.** Workers stream points through the WASM decoder and feed an octree builder.
Nodes are quantized to 12 B/pt and written to OPFS as they complete. Coarse levels are emitted
first so the renderer has something within ~1 s.

**Stage 3, Cache.** Keyed on file identity (name + size + lastModified + E57 root GUID). A
`FileSystemFileHandle` is kept in IndexedDB so "recent files" reopen without a picker. Cache hit
means stage 2 is skipped entirely.

**Stage 4, Render.** Main thread. Frustum-culls the octree, sorts nodes by projected screen
size, pages them in and out against a point budget, draws with a custom point shader plus an EDL
post-pass.

## 3. Ingest detail

### The ranged-read shim (already prototyped, `scratchpad/shim`)

```rust
pub struct JsRangeSource {
    read_range: js_sys::Function,  // (offset, length) -> Uint8Array, SYNCHRONOUS
    len: u64, pos: u64,
    win: Vec<u8>, win_len: usize, win_start: u64,   // 4-16 MB window
}
impl Read for JsRangeSource { ... }
impl Seek for JsRangeSource { ... }
```

Backed in the worker by either:
- `new FileReaderSync().readAsArrayBuffer(file.slice(off, off+len))` for a local `File`, or
- `syncAccessHandle.read(buf, {at: off})` for OPFS-cached data.

The window is mandatory. Without it the E57 paged reader issues ~1 KB reads and you get 30,410
JS round trips per 31 MB.

### Octree build

Potree-style, built streaming rather than in two passes:

- Root cube from the XML `cartesianBounds`, no pre-pass needed, the bounds are declared.
- Node capacity ~50K points. Grid-subsample on insert: each node keeps a coarse occupancy grid
  and accepts a point only if its cell is empty, otherwise pushes it to the child. This yields
  the uniform-density look Potree has, not random decimation.
- For this file the tree settles around 5-6 levels and a few thousand nodes.

Node payload, 12 bytes per point:

| field | bytes | note |
|---|---|---|
| x, y, z | 6 | u16 each, quantized to the node's own AABB |
| r, g, b | 3 | u8 |
| intensity | 1 | u8, remapped through `intensityLimits` |
| normal | 2 | octahedral-encoded u8 pair |

Normals are the reason to spend the extra 2 bytes. This file has them, and real shading beats
EDL alone by a wide margin. Files without normals get the same layout with a zero normal and a
flag in `meta.json`.

### Parallel decode (phase 2)

The single biggest speedup available. E57 data packets are self-describing: byte 0 is `1`,
length lives at bytes 2-4. Split the CompressedVector byte range into N chunks, scan each
forward to the first valid packet header, decode independently. The crate has no seek-to-point
API, so this needs a fork and ideally an upstream PR. Expect 4-8x, cutting 23 s to 4-6 s.

Ship phase 1 single-threaded. 23 s once, with progressive display, is acceptable.

## 4. Renderer detail

WebGL2 via three.js for camera, math, controls and picking, but with fully custom materials.
three.js earns its place on scaffolding, not on its built-in `PointsMaterial`, which is not
adequate here.

### Point pass

- `gl.POINTS`, one draw call per loaded node, instanced where it helps.
- Point size is screen-space adaptive, derived from the node's spacing at its octree level and
  the distance to camera, so density looks even instead of clumping near the camera.
- Circular points by discarding on `gl_PointCoord` radius. Square is a toggle, it is faster.
- Dequantize u16 positions in the vertex shader against a per-node AABB uniform.

### Shading

Port three shaders from Potree rather than inventing them. Each encodes a non-obvious trick.

1. **Eye-dome lighting.** Does NOT run off the depth buffer. The point pass writes
   `log2(-viewPos.z)` into the alpha of a float target; the post-pass samples a ring of 8
   neighbours, accumulates `max(0, depth - neighbourDepth)`, and shades by
   `exp(-response * 300 * strength)`. Log space makes the response a *ratio* of distances, which
   is why one strength value works from a 2 m statue to a 5 km corridor. Ship radius 1.4 px,
   strength 0.4. Push strength toward 1.0+ on intensity-only scans, lower on RGB.
2. **Adaptive point size.** Walks the octree *inside the vertex shader* against a small texture
   the CPU rebuilds each frame from the visible-node set, so each point knows the spacing of the
   deepest *visible* node at its position and grows to cover the gap. This is what removes the
   holes that appear while a region refines, not optional on a progressive viewer.
3. **Normal shading.** Hemispheric against the decoded normals, layered on top of EDL.

### Color modes

RGB, intensity, RGB x intensity, elevation ramp, normal-as-color, classification, flat, and
**scan colour** (each source scan a distinct hue, the fastest way to eyeball a bad
registration). Intensity and elevation get a histogram with draggable min/max handles and
savable ramp presets, because auto-ranging is wrong often enough to matter.

### Quality tiers

- **Fast**, square points, no EDL. For navigation on weak GPUs.
- **Balanced** (default), circular points, EDL, normals.
- **High**, Potree's three-pass weighted splat: a depth prepass that pushes each point two
  radii back to build a shell, an additive accumulation weighted by distance from the splat
  centre, then a normalize pass. Removes shimmer when orbiting, at ~2x geometry cost.

### Budget

A point-budget slider from 500K to 20M, auto-tuned from measured frame time. Sustainable
on-screen points at 1440p with EDL on:

| machine | 60 fps | 30 fps |
|---|---|---|
| integrated Intel / older APU | 1-2 M | 3-4 M |
| Apple Silicon M1 / M2 | 3-5 M | 8-10 M |
| M3 / M4 Pro or Max | 6-10 M | 15-20 M |
| discrete laptop GPU | 5-10 M | 15-20 M |

So 5M is the right default. EDL costs ~10% of the budget; HQ splatting ~50%.

The ceiling is usually **not** raster throughput. It is **draw calls**, one per resident node,
several hundred to a thousand per frame, and VRAM once extra attributes are resident. Measure
both in M3, because they may force larger nodes than the obvious choice.

### WebGPU is not the upgrade it looks like

WebGPU hardcodes its point primitive to **1 pixel**. There is no `gl_PointSize` equivalent, and
three.js documents the limitation. Porting is not a backend swap: it means instanced quads at
6x the vertex work, or compute-shader software rasterization with atomics, research-grade, and
needing 64-bit atomics the web does not have. Build on WebGL2, keep render passes behind an
interface, revisit only for a real reason.

## 5. Bubble views

102 spherical panoramas at 8192x4096, each with its own pose. This is ReCap's station
navigation and it is largely free here.

- Station markers drawn in 3D at each panorama's translation.
- Clicking one moves the camera there and fades in a textured sphere built from the JPEG.
- Blend between the panorama and the point cloud with a slider, so users can check registration.
- Decode with `createImageBitmap(blob, {resizeWidth: 4096})` and keep at most 2-3 resident.
  A full 8192x4096 RGBA texture is 134 MB, so residency has to be capped.

## 6. Interface

Dark, near-black viewport. The cloud is the only saturated thing on screen. All chrome is thin,
translucent, and gets out of the way.

**Entry.** The whole window is the drop target. Centered: a single line of copy, an *Open file*
button using `showOpenFilePicker`, and beneath it a recent-files list that reopens from cache
instantly. A note that files never leave the machine, because for survey data that is a purchase
objection, not a footnote.

**Loading.** The scan card appears at 10 ms with real metadata. Below it a progress bar for
indexing, with points/sec and an ETA, and the viewport already drawing whatever has been built.
Never a blank screen with a spinner.

**Viewport.** Full bleed. A thin top bar with the file name, point count and FPS. A left rail of
mode toggles: orbit, fly, first-person, measure, section, stations. A right panel, collapsible,
holding the knobs.

**Knobs**, grouped and collapsed by default except Appearance:

| group | controls |
|---|---|
| Appearance | color mode, point size, size mode (fixed / adaptive), shape, opacity |
| Lighting | EDL on/off, strength, radius; normal shading on/off, intensity |
| Tone | brightness, contrast, gamma, intensity range (histogram with handles) |
| Clipping | section box with a drag gizmo, slice mode with thickness, invert |
| Navigation | mode, movement speed, up-axis, focal length |
| Performance | point budget, quality tier, live FPS and resident-node readout |
| Stations | list of the 102 panoramas, click to enter bubble view |

Every knob writes to a URL fragment so a view can be shared or bookmarked. Keyboard shortcuts
for the mode toggles. `Cmd+Z` for measurement edits.

**Measurement.** Point-to-point distance, polyline length, area, height delta, and a volume
estimate later. Snap to nearest point using GPU picking, which renders node and point indices to
an offscreen target and reads back one pixel. Exact, and simpler than a CPU raycast.

## 7. Stack and layout

No backend. A static site.

- Vite + TypeScript
- three.js on WebGL2, render passes behind an interface
- Rust -> `wasm32-unknown-unknown` via wasm-bindgen for ingest
- OPFS for the octree cache, IndexedDB for file handles and settings
- Deployable to any static host

```
e57view/
  crates/e57-wasm/        Rust: ranged-read shim, decode, quantize
  src/
    ingest/               worker pool, octree builder, OPFS store
    render/               renderer, shaders, LOD scheduler, picking
    ui/                   entry, panels, knobs, measurement
    state/                view state, URL sync
  public/
```

## 8. Milestones

**M1, Prove it in the browser.** Port the prototype shim into a real worker with
`FileReaderSync`, open the 3.23 GB file, print the scan card. Confirms the 10 ms open and that
`FileReaderSync` overhead does not change the window-size tuning. Small, and it de-risks the
rest.

**M2, Points on screen.** Decode a bounded prefix, render with a basic point shader, orbit
controls. No LOD yet. First visual.

**M3, Octree and OPFS.** Streaming builder, node format, disk cache, LOD scheduler, point
budget. This is the biggest single piece of work.

**M4, Look.** EDL, normal shading, adaptive point size, colour modes, tone controls. Where it
starts to match ReCap.

**M5, Tools.** Section box, clipping, measurement, GPU picking.

**M6, Stations.** Panorama extraction, bubble views, blend slider.

**M7, Polish and speed.** Parallel decode, quality tiers, URL state, shortcuts, empty and error
states.

## 9. Risks

**Indexing time on slower machines.** 23 s is the Apple Silicon number. A weak laptop could see
60 s+. Mitigation: parallel decode in M7, and always render progressively so the wait is not
dead time.

**OPFS quota.** 885 MB per file, and browsers may prompt or evict. Mitigation: request
persistent storage, show cache size, offer eviction, and degrade to in-memory with a lower
budget if refused.

**Memory during build.** The octree builder holds partial nodes. Must flush aggressively to OPFS
rather than accumulating, or a 74M-point build will pressure the tab.

**Files without normals.** Most terrestrial E57s will not have them. EDL has to carry the look
on its own, so it needs to be genuinely good, not an afterthought.

**Spherical-only scans.** Terrestrial scanners often store spherical coordinates with no
cartesian. The crate converts, but it must be exercised, the test file is cartesian, so this
path is currently untested.

**Multi-scan files.** The test file is a single registered cloud. Files with 50+ unregistered
scans need per-scan visibility toggles and per-scan pose handling, which is a different UI
problem. Get a multi-scan test file before M3.

**Draw calls, not fill rate.** One call per resident node hits a ceiling before raster
throughput does. May force larger nodes, trading against LOD granularity. Measure in M3.

## 10. What not to adopt

Existing Potree wrappers (`@pnext/three-loader`, `potree-core`) all assume the octree was
converted server-side and is fetched over HTTP range requests. Ours is built in-browser from the
user's own file, so the loader is genuinely different work with nothing to reuse. The shaders
are the opposite case: proven, short, worth porting verbatim. **Take the shaders, write the
loader.**

Four ReCap features that are easy to skip and shouldn't be: scan-colour mode; a bubble view
paired with an overhead minimap (the minimap is what makes a panorama navigable rather than
disorienting); savable gradient ramps; and view states as real shareable objects. A ViewCube and
zoom-to-rectangle are cheap and expected.
