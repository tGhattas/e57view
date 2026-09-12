# e57view — validated technical findings

All numbers below were measured on this machine (Apple Silicon, Node 20 / V8, Rust 1.98)
against a real file: `~/Downloads/1973-registered.e57`.

## Test file profile

| property | value |
|---|---|
| size | 3.23 GB |
| scans (Data3D) | 1 (registered, pre-merged) |
| points | 73,757,292 |
| images2D | 102, all **spherical** (equirectangular) |
| panorama resolution | 8192 x 4096 JPEG, ~9.1 MB each, 927 MB total |
| station spacing | ~5.9 m apart, 60.3 m span |
| sensor | NavVis (mobile mapping) |
| bbox | 86.3 x 114.8 x 42.2 m |
| density | ~176 pts/m^3 |
| per-point fields | X,Y,Z (f32) + **normalX/Y/Z** (f32, `nor:` extension) + intensity (f32 0..1) + R,G,B (u8) |
| pose | quaternion + translation, georeferenced (E=198574, N=746784, Z=202) |
| on-disk cost | 43.7 bytes/point |

Notable: this file carries **per-point normals**. Real shading is possible, not just EDL.

## Parser choice: Rust `e57` crate -> WASM

Crate `e57` v0.11.13. Dependency tree is `roxmltree` + optional `crc32c`. `#![forbid(unsafe_code)]`.

- Compiles clean to `wasm32-unknown-unknown` (verified).
- `E57Reader::new` is generic over `T: Read + Seek` — accepts any custom source.
- wasm-bindgen shim built and run end to end (verified).
- Module size: 347 KB after wasm-bindgen, pre-`wasm-opt`, pre-gzip.
- Do NOT call `E57Reader::from_file` — compiles on wasm, always fails at runtime.
- Do NOT enable `crc32c` — no hardware CRC on wasm; skip CRC validation in browser.

## The key architectural result: no whole-file load

The blocker everyone hits is that `E57Reader::new(Cursor::new(bytes))` needs the whole file in
wasm linear memory, and wasm32 caps at 4 GB. A 3.23 GB file is not loadable that way.

Fix: implement `Read + Seek` in Rust backed by a **synchronous** JS ranged-read callback.
In a Web Worker, `FileReaderSync` + `File.slice()` provides exactly this over a local file,
and OPFS `createSyncAccessHandle()` provides it over cached data. Neither needs
SharedArrayBuffer, so **no COOP/COEP headers and no cross-origin isolation are required**.

Measured through that shim, against the 3.23 GB file, with the file never loaded into wasm memory:

| operation | result |
|---|---|
| open (48-byte header + 177 KB XML) | **10 ms**, 2 ranged reads, 0.2 MB pulled |
| enumerate 73.76M points + 102 images | included in the above |
| decode throughput (warmed) | **3.06 - 3.18 M points/sec** |
| full 73.76M scan decode | **~23 s** single-threaded |
| extract one 8192x4096 panorama | 0.05 s (231 MB/s) |

Ranged-read buffering: a windowed cache inside the Rust source is required. Without it the
paged reader issues ~1 KB reads — 30,410 JS calls for 31 MB. With a 4-16 MB window that drops
to 7-30 calls at no throughput cost. Window size should be re-tuned against real
`FileReaderSync` overhead in browser.

Warning on benchmarking: unwarmed V8 reports ~1.2 M pts/s. Warm up before measuring.

## Decode path cost

`pointcloud_simple()` and `pointcloud_raw()` both land at ~4.5 M pts/s native — the raw path
allocates a `Vec<RecordValue>` per point, which cancels its advantage. Native full-file decode
is 16.5 s; wasm is 23 s, a 1.42x penalty.

To go faster, the win is not switching readers, it is **parallel decode**. E57 data packets are
self-describing (byte 0 = 1, length at bytes 2-4). A byte range can be split across N workers by
scanning forward to the next valid packet header. Needs a fork or an upstream PR — the crate
exposes no seek-to-point API. Estimated 4-8x, taking 74M points to roughly 4-6 s.

## Storage budget

| layout | bytes/pt | full cloud |
|---|---|---|
| f32 xyz + u8 rgb | 15 | 1.11 GB |
| u16 node-local xyz + rgb + intensity | 10 | 0.74 GB |
| **u16 xyz + rgb u8 + intensity u8 + oct-normal u8x2** | **12** | **0.89 GB** |

885 MB is fine for OPFS on disk, too big to hold in RAM. Hence: octree on disk, page nodes in
against a render budget. At 12 B/pt a 5M-point budget costs 60 MB of VRAM.

## Spatial ordering caveat

Points arrive in acquisition order, not spatial order. The first 10M points already span ~90% of
the X extent but only part of Y; Y does not fill in until the final ~25M points. A prefix of the
file is therefore not a valid preview of the whole cloud. The full indexing pass has to run
before a spatially uniform overview exists — progressive display during that pass shows a
growing trajectory, not a coarse whole.

## Visual verification — the cloud actually renders in colour

All 73,757,292 points were decoded and rasterized offline to confirm the data is real and
coherent, not just numerically plausible. Output in `renders/`.

This is a Rust top-down orthographic splatter with a z-buffer (`prototype/bench/render.rs`),
**not** the browser renderer. It validates the decoded data and the EDL algorithm. It does not
validate WebGL performance.

At 1000x1330 the cloud covers 45% of the frame. Four modes were rendered:

| render | result |
|---|---|
| `01-rgb.png` | Correct full colour. A street scene: parked cars, tree canopies, a blue roof, a terracotta tile roof, kerbs and road markings all legible. RGB decode is verified end to end. |
| `02-rgb-edl.png` | EDL working. Tree canopies gain 3D structure, kerbs and bush clumps resolve individually. |
| `03-elevation.png` | Elevation ramp over the declared Z range. Terrain reads clearly, sloping from high on the west side down to a lower parking area on the east. |
| `04-intensity.png` | Works, but far too dark — see below. |

### Two tuning facts this produced

**EDL strength must be low on RGB scans.** A first pass at strength 0.9 crushed the road surface
to black and destroyed the albedo. Re-rendered at **0.32** the road keeps its material while
trees and kerbs keep their structure. This confirms the 0.4 default in the plan, and confirms
that the knob has to be exposed rather than baked.

**Intensity is not display-ready as stored.** Mean intensity across the file is **0.227**, so
most values sit in the bottom quarter of the 0..1 range and a direct mapping renders near-black.
The declared `intensityLimits` describe sensor range, not a useful display range. This is
concrete evidence for the histogram with draggable min/max handles rather than auto-ranging —
without it, intensity mode ships looking broken.

## Built and deployed

The viewer is live at **https://opensketch.web.app** and was driven against the real 3.23 GB
file on the deployed build, not just locally.

| viewport | budget default | points | index time |
|---|---|---|---|
| desktop 1500x940 | 6 M | 5,673,637 | 21.8 s |
| iPad Pro 11 | 3 M | 2,950,291 | 21.7 s |
| iPhone 15 Pro | 1 M | 996,720 | 21.1 s |

Production bundle: 126 KB gzipped JavaScript plus a 311 KB WebAssembly module, 884 KB total.
The wasm is served as `application/wasm`, which matters for streaming instantiation.

### Framing bugs worth remembering

Three separate mistakes, all in camera fitting, all caught only by looking at screenshots:

1. **Inverted right vector.** Moving the camera right shifts the scene left. Got the sign
   backwards twice, which parked the cloud underneath the control panel.
2. **Iterative fit failed to converge.** Replaced with an exact analytic fit: for each of the
   eight bounding-box corners, solve the distance at which it lands on the frustum edge and
   take the worst. No iteration, no tuning.
3. **Portrait framing was fit by width.** A wide site on a portrait phone ended up tiny. Fixed
   by choosing the camera azimuth so the cloud's long footprint axis maps to the screen's long
   axis. This is the single biggest difference between usable and unusable on a phone.

### Still unverified

Physical iOS hardware. Chrome device emulation exercises the layout and the code paths, but
not WebKit. The float render target fallback, `FileReaderSync` against a multi-gigabyte file
from the Files app, and Safari's per-tab memory ceiling all remain untested on a real device.


## Round two: fast decoder, octree, continuous LOD

Three complaints from real use of the first build — can't zoom into the building, bright
discs everywhere, and "make it as fast as possible with all points" — turned out to share a
root cause: the first build had one global point spacing and no spatial structure.

### Where the crate's 23 seconds went

Reading `e57`'s internals: it validates a CRC on every 1020-byte page (a software table
loop over all 3.2 GB), pulls each value out with a 16-byte copy into a `u128`, boxes it in
a `RecordValue`, and builds a `Vec` per point. None of that is needed by a viewer.

A columnar reader (`fast.rs`) that reads 4 MB chunks, strips the CRC bytes without checking
them, and decodes each field with a type-specific loop straight into a typed column:

| | crate | fast reader |
|---|---|---|
| raw decode, native | 5.1 M pts/s | 20.1 M pts/s |
| decode + octree bin, all 73.7M, native | — | 5.6 s |
| decode + octree + shuffle + upload, browser | — | 13.5 s |

Validated bit-exact: column sums over 3M records match the crate on all ten fields.

### The octree

Leaf-only, cells split above 400K points, positions quantised to 16 bits in the cell cube
(0.08 mm at a 5 m cell). Requantising to a child on split is exact — halving the cube
doubles the resolution, so it is a shift. The root grows outward when a point lands outside
it, which is what makes scans without declared bounds work.

Each finished cell is Fisher-Yates shuffled. Drawing its first N records is then a uniform
random subsample, which is Schütz's continuous-LOD trick: level of detail with no extra
memory and no hierarchy of copies. This file becomes 702 cells, mean 105K points.

### The renderer

three.js is bypassed for the point pass. One VAO per cell, 14-byte interleaved records,
a bare `drawArrays` loop. Per frame: frustum-cull, desired points per cell = density ×
projected area, scale to the budget (both down when over and up when there's headroom),
front-to-back. Each cell gets an effective spacing of `spacing × sqrt(count / drawn)` so
adaptive sizing stays gap-free as LOD thins a cell.

GPU time measured with a `readPixels` sync (Chrome's `gl.finish()` does not wait):

| view | 4M | 8M | 16M | 32M |
|---|---|---|---|---|
| whole site | 7.2 ms | 9.8 ms | 14.0 ms | 29.9 ms |
| close up | 3.9 ms | 5.0 ms | 7.5 ms | 7.8 ms |

### The bright discs, explained

Two effects multiplied. Points at object edges against the sky get colourised white or
pale blue by the scanner's camera (a mixed-pixel artefact in the data itself). And the first
build sized every point from one global spacing with a 40 px clamp, so anything near the
camera ballooned into a disc, and EDL then drew a dark ring around each one. Per-cell
spacing with a 7 px clamp removes the ballooning; the sky-coloured points are still there
but at 1-2 px they read as noise, not features.

### EDL at close range

Potree's formula compares `log2(depth)` between a pixel and a ring of neighbours. A metre
from a wall, neighbouring points on the *same* surface differ by a few centimetres, which in
log space at that depth is a large ratio, and every point got a black outline. A tolerance
of 0.02 in log2 units (about 1.4% of depth) below which differences are ignored fixes it
without touching the look at distance, where same-surface differences are already tiny.

### Outliers

A handful of stray points sat 100 m above the roof. They inflated the bounding box, which
made the fit view tiny and the height range meaningless. Framing, height range and clipping
now use 0.2–99.8 percentile bounds computed from the preview sample.

## Round three: crop, export, cache, measure, panoramas

### Crop
Box or sphere. A persistent unit-cube group in the overlay scene carries the region: its
position is the centre and its scale the extents, so three.js's TransformControls moves and
resizes it directly with the mouse (arrows to move, handles to resize) and the sliders read
the same transform back. Preview dims outside points in the shader. Apply reads straddling
cells back from the GPU (`getBufferSubData`), filters, re-uploads, and recomputes tight
bounds; cells fully inside or outside are kept or dropped without a readback.

Verified: 73.7M → 14.9M kept / 58.8M dropped; the estimate shown in the confirmation dialog
was within 8% of the actual count.

### Export
All three formats are written by a worker into private browser storage, then streamed to
the chosen location (File System Access API) or handed to the browser as a download.

| format | 14.9M-point crop | notes |
|---|---|---|
| PLY binary | 641 MB | doubles, absolute coordinates |
| LAS 1.2 pf2 | — | 0.001 m scale, offset = scan pose |
| E57 | 644 MB, 5.7 s | Rust writer; pose, RGB, intensity, normals (`nor`) |

The exported E57 re-parses with the native reader and validates bit-exact across all ten
fields against the crate, at 14,909,477 points.

**The writer was 30x too slow at first.** The crate's paged writer reads the *next* page back
and seeks to the page start after every 1 KB page it writes. Each of those became a
JavaScript round trip: 7.4M points took 100 s. Serving reads and seeks from the pending write
buffer, and only crossing into JavaScript for genuinely new ranges, brought it to 3.3 s.

### Cache
Decoded cells (14 bytes per point) plus a leaf index and the histogram go to OPFS. The
prompt appears once per file; "never for this file" is remembered.

| | decode | from cache |
|---|---|---|
| 73.7M points | 14.1 s | **0.6 s** |
| 7.4M points | 5.3 s | 0.1 s |

Writing the 1.02 GB cache took about 2 s. Cached scans are listed on the start screen; in
Chromium the file handle is kept in IndexedDB so they reopen in one click after a permission
prompt.

### Panoramas
102 stations, 8192×4096 JPEGs pulled straight from the E57 blobs (50 ms each). The camera
stands at the station; the photo is a back-face sphere drawn behind the points, and the EDL
pass emits alpha so the points blend over it with a slider.

The first attempt showed the sky at the bottom. `ImageBitmap` textures upload unflipped, so
row 0 is the top of the photo; the elevation-to-v mapping had to be inverted. After that fix,
photo and points align exactly — door frames, wall edges and floor lines coincide.

### Two interaction bugs found only by driving the UI
A single click on a station marker was firing before a double-click could, so
double-clicking near a marker entered a panorama instead of re-centring. Station clicks
now wait 280 ms for a possible double-click. And the measure tool was silently losing clicks
to nearby station markers; markers are ignored while a tool is active.

## Round four: rotation, sections, AI clean, import, cloud, agents

All numbers below were driven through the UI in Chrome against the real file loaded 1 in 4
(18.4M points) unless stated.

### Regions
The crop box, sphere and slab are now one `Region` type with a quaternion. The shader tests
each point in region-local space against up to 16 regions: keep regions form a union, delete
regions subtract. The gizmo has Move / Rotate / Resize; a slab's Resize changes only its
thickness. Two horizontal sections 1.5 m and 8 m above the floor cut 18,439,323 points to
3,396,160 in one Apply.

### AI clean
- Local heuristic (colour + normal chaos on a 1 m grid; every cell is sampled in
  proportion to its footprint, about 30 records per square metre, so the sparse outer cells
  where the trees are get as much say as the dense interior): 16 vegetation clusters in
  **0.8 s** including the renders, no network. Approving all and applying removed 655,910
  points in the first round.
- First real-provider round (renders only, no candidates) was poor: the top-down render
  sent to the model was covered by the 102 station markers, and GPT/Grok answered with
  boxes like 43 × 34 × 34 m. Two fixes. Renders now go through `cleanRender` (overlay,
  labels, panoramas off; RGB, dense budget, wide clipping), and the pipeline became a
  hybrid: heuristic clumps are drawn as numbered candidates on the top-down render with a
  labelled 10 m grid, each candidate gets a 640 px oblique close-up with its box drawn, and
  the model only judges. Added boxes are snapped to vegetation cells, then to
  rough-and-tall cells, else trimmed to occupied cells and capped at 30 m.
- Model benchmark on the same 14 images (top-down high detail, 13 low): every model kept
  the candidate on the blue pool canopy and confirmed the trees. `gpt-4o` 14 s, `gpt-4.1`
  25 s (+4 cars), `gpt-5.4-mini` 23 s, `gpt-5.5` 32 s (+7 cars, +6 canopies the detector
  missed), `grok-4.20 non-reasoning` 25 s (+6 cars), `grok-4.3` 32 s, `grok-4.5` 112 s,
  `grok-4.6` 289 s. Defaults: `gpt-5.5` and `grok-4.3`. Reasoning models reject
  `temperature` and `max_tokens`, so the request body is model-gated
  (`shared/aiprompt.mjs`, shared by the browser fallback and the Cloud Function).
- End-to-end through the Cloud Function on the 18.4M-point load (1 in 4): candidates,
  renders and 12 close-ups in **0.8 s**; `gpt-5.5` answered in 17.3 s and confirmed 13 of
  16 candidates, keeping the pool canopy roof and the two playground-structure boxes with
  reasons quoting the close-ups; `grok-4.3` answered in 12.9 s and confirmed 13 of 16,
  keeping the roof edge and the playground structure. Every returned box is 1.8–6.8 m on a
  side with the height taken from the points, against 43 × 34 × 34 m before the rework.
- Production (https://opensketch.web.app, same load): `gpt-5.5` 36.6 s, 13 of 16 candidates
  confirmed plus 15 added (six parked cars, canopies the colour detector missed because
  they render white); `grok-4.3` 14.6 s, 13 of 16 plus 6 added. Added boxes take their
  height from the ground under them with a cap implied by the label (a car is 3 m, not
  the 20 m tree hanging over it), so the cars come back as 4.9 × 4.3 × 3.3 m boxes.

### Import
PLY (binary/ASCII) and LAS 1.2–1.4 uncompressed parse over the same synchronous ranged reader
and feed a `PointSink` in WebAssembly that builds the same octree. The 641 MB PLY export of
the crop (14.9M points) imported at 1 in 4 in **3.7 s** with colour, intensity and normals.
LAZ is refused with a clear message.

### Cloud
Firebase project `opensketch`: Storage bucket `opensketch-clouds` (europe-west1), anonymous
auth, Firestore `clouds/{id}` documents, two gen-2 functions in europe-west1.
`convertCloud` (16 GiB, 4 vCPU, 540 s cap for storage triggers) downloads the upload, runs
the same WebAssembly decoder through `fs.readSync`, writes `cells.bin` + `meta.json` with
download tokens, marks the document ready and deletes the upload. The Node converter does
the 7.4M-point export in **1.3 s**.

The client streams a uniform prefix of every cell (8% desktop, 4% touch, at least 6,000
records) then refines cells the camera wants via HTTP range requests, up to four at a time.

Three things bit during setup: the CLI needs a *default* bucket to exist (created via the
`defaultBucket` REST call), a `functions/.env` entry with the same name as a secret blocks
the deploy, and the bucket needs a CORS configuration or the browser cannot fetch the
cells at all.

### Agent link
The MCP server relays tool calls over a localhost WebSocket to the tab; screenshots come back
as PNG image content. Driven from a stand-in bridge in the test: state, 154 KB screenshot,
a measurement of 10.453 m from two picked pixels, and a keep box rotated 45°.

### Undo / redo / save
On the same 18.4M-point load (1 in 4): a crop dropping 10.6M points took **1.2 s** including
a 148 MB spill to disk; undo **0.5 s**, redo **0.4 s**. AI clean of 15 boxes **2.7 s**, undo
**0.3 s**. Save (E57 export + cache rewrite) **2.8 s** for 6.9M points; reload of the saved
cache **0.1 s**.

### Securing the HTTP agent endpoint
The first version was open. The Firestore rule was `allow read, write: if request.auth != null`
and anonymous auth is open to anyone, so a stranger who had never seen a session id could sign
in, **list every live session**, and then drive any open viewer tab: read state, pull
screenshots of the scan, crop it, or save over the cache. Verified against the deployed
project before the fix, and denied after it. The session id also travelled in the page URL, so
it reached browser history, referrer headers and the Google Analytics tag.

Four changes. Rules are owner-scoped (`resource.data.owner == request.auth.uid`) with
`allow list: if false`, so the collection cannot be enumerated. The id was split from the
credential: the page URL carries only the session id, while a 256-bit bearer token is copied
to the agent, stored as SHA-256 and compared in constant time by the function, which answers
401 identically for an unknown session and a bad token so ids cannot be probed. Sessions
expire after 8 hours and *Stop session* deletes the document. Commands that drop points,
write a file, load another scan or call a paid model return 403 until the tab ticks
*Allow edits*. Analytics now reports `origin + pathname` only.

Two bugs surfaced while testing the endpoint. The function wrote commands with `merge: true`,
which deep-merges maps, so arguments from earlier commands persisted: a stale `preset: 'top'`
silently turned every later `set_view` pose into a top-down jump. It now writes with
`mergeFields`, replacing the field outright. And a screenshot shipped the same frame twice,
as a PNG in the result and a JPEG alongside it, 660 KB per call; the PNG is dropped when a
JPEG is attached, which took a 900 px screenshot to 94 KB.

### Driving a clean from outside the browser
A first real run through `POST /agent` removed 1,052,087 points of scanner noise from a
32.4M-point scan (17 regions, detector 0.7 s, apply 15.7 s including readback) but answered
with `Invalid JSON payload received`. The apply handler returned the result of
`applyRegions` verbatim, which now carries the undo record: typed arrays, `THREE.Vector3`
instances and live WebGL leaf handles. Firestore rejected the write, so the caller saw a
failure for work that had in fact succeeded — the worst possible answer for an agent, which
would retry and delete more. Agent replies are now slimmed (heavy keys and typed arrays
dropped, result capped at 150 K characters, screenshot at 600 K) and both apply paths return
`{kept, dropped, points}`. `drive-agent.mjs` covers the whole loop against production:
token rejection, the read-only gate, pose after preset, apply, and undo.

### What could not be done
Browsers on iOS have no LiDAR or WebXR-depth access. The honest path is capture in a
scanning app and open the export here (which now works for PLY/LAS/E57), or an ARKit capture
in the native OpenSketch app that already exists in this Firebase project.

### Local network access
Chrome 152 gates a public https page's WebSocket to 127.0.0.1 behind a local-network-access
permission. With the check disabled the live site connects instantly; in a normal browser the
user sees a one-time prompt. Verified both ways with Playwright.

## Productionising

Cloud upload and AI cleaning came out. Both worked — the numbers above are real — but they
pulled the product away from what it is good at: opening a scan that never leaves the
machine. Removing them deleted `src/ai.ts`, `src/cloud.ts`, two Cloud Functions
(`aiSuggest`, `convertCloud`), the Storage bucket rules and CORS, the shared prompt module
and four test drivers. `src/session.ts` keeps the Firestore agent mailbox, which is all the
backend the viewer still needs.

What stayed is the agent interface, because it moves no data: it drives the tab the user
already has open. Delete-role regions survive without the AI that used to create them, so
an agent can still remove points with `regions add {role:'delete'}` then `regions apply`,
undoably. The MCP server is bundled by `npm run build` into one 876 KB file served from the
site, so registering it is a `curl` and a `claude mcp add` with no clone and no install; the
Agent panel has a Download server button and the two commands ready to copy. A web page
cannot start a local process, which is the whole reason the HTTP endpoint exists alongside.

## Surface reconstruction

Poisson is the usual answer and the wrong one here: it solves a global system, and these
scans already carry per-point normals from the `nor` extension, which is most of what the
solve is for. Each point is a small oriented plane, so the truncated signed distance field
can be splatted directly — walk each normal across the truncation band, accumulate the
signed distance with trilinear weights. Averaging every point that reaches a voxel is what
removes scanner noise, so the field is smoother than the cloud that made it.

Extraction is naive surface nets rather than marching cubes, chosen for a reason that has
nothing to do with quality: marching cubes needs a 256x16 triangle table, and a table
transcribed from memory is a silent, hard-to-spot corruption. Surface nets needs no table
at all — one vertex per sign-changing cell at the centroid of its crossings, one quad
around each sign-changing edge — and is manifold by construction. Cells with no data emit
no quad, so an open scan stays open instead of being capped with invented geometry.
Taubin smoothing (lambda then a slightly larger negative mu) drops ripple without the
shrinkage repeated Laplacian passes cause.

`cargo run --bin meshtest` checks the geometry instead of a render, against shapes whose
true surface is known. On a 2 m sphere from 400k points at a 5 cm voxel: mean vertex error
**0.9 mm**, worst 3.1 mm, surface area within **0.0%** of 4πr², zero boundary edges, zero
non-manifold edges, 100% of normals facing outward. A flat plane comes back flat to
**0.0 mm** and keeps its border rather than closing into a slab.

Two bugs the test caught that a screenshot would not have. The quad winding was inverted, so
every normal pointed into the surface — the render still looked plausible. And the density
fallback for clouds without normals produced 1,825 vertices and zero triangles, because
voxels below the weight threshold were rejected as invalid: in density mode empty space is
not missing data, it is the outside, and without it the field never crosses zero.

### On the real scan

18.4M points (1 in 4 of the NavVis file), reconstructed in the browser:

| Voxel | Triangles | Build | Draw | Heap |
|---|---|---|---|---|
| 12 cm | 1,785,012 | 7.0 s | 1467 fps | 149 MB |
| 6 cm | 4,303,346 | 12.7 s | 1001 fps | 197 MB |
| 5 cm | 7,713,006 | 16.3 s | — | — |

The weight threshold — how much accumulated evidence a voxel needs before it counts as
surface — mattered more than anything else, and the first guess was badly wrong. At 0.6 the
render was peppered with pinholes, because a cell needs all eight of its corners valid and
one weak corner kills it. Measuring boundary edges per triangle across a sweep put the knee
at 0.3 and the floor at 0.15:

| Threshold | Triangles | Hole perimeter per triangle |
|---|---|---|
| 0.6 | 4,706,528 | 0.221 |
| 0.3 | 6,462,436 | 0.157 |
| 0.15 | 7,713,006 | 0.148 |
| 0.05 | 9,331,992 | 0.149 |

0.15 is the default. What holes remain sit in foliage, which is correct: a tree has no
coherent surface to find.

A 2 cm voxel over the whole site wants more than 1.2 GB of field and took the tab down. The
mesher now checks its own footprint every eight cells and gives up with a message naming the
size, and the confirmation dialog estimates the field from the point spacing before any work
starts. Refusing at 2 cm leaves the page healthy: the points are untouched and a 10 cm build
straight afterwards succeeds.

Two rendering bugs worth recording. The surface drew washed out to pale yellow because
blending was still enabled from the previous pass, and this target holds (colour, log depth)
rather than premultiplied colour — the depth in the alpha channel was scaling the colour and
saturating it. And the build hung forever the first time because the worker was asked for a
result that was never requested: the message that starts extraction was missing, so both
sides waited politely for each other.

## Neighbourhood analysis

Normals, geometric features, outlier removal, duplicate detection and connected components
are one question asked five ways, so they share a single spatial index: a uniform voxel hash
rather than a kd-tree, because scan data is close to uniform along surfaces and a grid builds
in one counting pass with no recursion or rebalancing. `cargo run --bin anatest` checks the
maths against shapes with known answers: a plane reads planarity 0.92 and linearity 0.08, a
line reads linearity 1.00, a wall reads verticality 1.00 and a floor 0.00, sphere normals come
back radial and 100% outward after orientation, and statistical outlier removal drops all 150
planted specks while losing none of the 14,400 surface points.

On the real scan at 7.4M points: normals with orientation **53 s**, a geometric feature
**34 s**, heap 252 MB.

Three bugs worth recording, none of which a screenshot would have caught.

**A normal pointing straight up was indistinguishable from no normal at all.** The record
format marks "no normal" with (0,0,127), which is exactly what a real +Z normal quantises to,
so every horizontal upward surface lost its normals — and the surface reconstruction silently
fell back to density mode on ground and roofs. Real normals now step down to 126, an error of
0.45 degrees, well inside the quantisation noise.

**The field rendered flat grey because a leftover preview leaf was drawn over it.** The
low-resolution preview uploaded during loading has no correspondence to the analysed points,
so it never receives a field, and its points fall back to the "no value" colour — painting the
whole cloud grey on top of a perfectly correct result. Previews are now dropped when a field
is attached. Finding it needed the attribute state read from inside the draw call itself:
every check outside the frame said the buffer was bound and full of the right numbers.

**NaN is not a dependable sentinel on the GPU.** Marking "no value" with NaN and testing it
with `isnan` fails under a driver's fast maths. The CPU copy keeps NaN, which JavaScript
handles correctly for statistics, and the GPU copy swaps it for a finite sentinel compared
with an ordinary less-than.

## Freehand selection

Screen-space rather than world-space, because that is what the user is actually pointing at.
Each leaf's quantisation folds into the view-projection matrix, so a point costs three
multiply-adds instead of a full matrix product, and a leaf whose projected bounding box misses
the polygon is never read back from the GPU at all. **498 ms over 18,439,323 points.**

The overlay is an SVG, which cost one bug worth remembering: `position: fixed; inset: 0` does
not stretch a replaced element, so the lasso was drawing correctly into a 300x150 box in the
corner while every count came out right. The maths was never wrong, only invisible.

## Normals have to face the scanner, not away from the centroid

Orientation voted per connected component for "away from the cloud centroid". On the test
sphere that is exactly right and the check passed at 100%. Inside a building it is exactly
wrong, and it fails silently: a room is a closed shell seen from within, so every wall,
floor and ceiling normal comes out inverted as a block, the vote is unanimous, and the only
symptom is that the reconstructed surface is lit from the wrong side and the truncated
signed distance field cancels itself where two walls meet.

The fix is not a better vote, it is a different question. A laser only ever measured a
surface from the station it was standing at, so the outward direction is "toward the nearest
station" — a per-point fact, not a per-component one, which matters as soon as one cloud
covers several rooms. The E57 carries 102 of them in the test file, and
`viewer.stationPositions()` already had them in the right frame.

Cost: nothing measurable. A brute-force scan of 102 stations is ~102 distance computations
per point, against the ~150 the k-nearest search already does with its 27-cell sweep and its
`select_nth_unstable`. A grid over the stations was written and then thrown away as an
optimisation of the cheap half of the loop.

The synthetic room in `anatest` makes the difference unmissable: 61,206 points on the inside
faces of a 6 m box with a station at the centre. The centroid vote faces **0.0%** of them at
the station; the station flip faces **100.0%**. A four-station variant is checked against an
independently recomputed nearest station, also 100%.

While in there: the propagation pass described itself as breadth-first and popped a stack.
It is now an index into a growing vector, so a point's sign is decided within a few
neighbour hops of its seed rather than at the end of one long arm of a depth-first walk.

## Compacting two arrays with one mask, only one of which existed

`applyRegions` kept a bit mask of dropped points so undo could re-interleave the records
exactly. It allocated that mask **only when recording an undo step**. The scalar-field
compaction, written later, consulted the same mask — so with `record=false` every kept value
landed at the index of a different point, and nothing crashed, nothing looked wrong, and the
field was simply describing the wrong points from then on.

Worth recording because of how it hid: the bug needed a scalar field *and* a non-recording
call, and the only non-recording caller was a code path no driver exercised. The fix is one
line of intent — decide keep or drop once per point, then use that decision for the records,
the scalars and the undo mask alike — and the check in `drive-analysis.mjs` gives each point
a unique field value so a shift of one is visible: **315 kept of 1,171, 0 misplaced**.

## Cloud transforms: do not bake

The obvious implementation rewrites every point. At 14 bytes and 16-bit positions per leaf
cube that means a full readback, a matrix multiply, a requantisation and a re-upload — about
a second per transform on 18 million points, a lossy round trip through the quantisation
every time, and an undo step the size of the cloud.

So the cloud carries a `model` matrix instead and every consumer reads through it. The work
is finding all of them: the vertex shader (before the region tests, the height clipping and
the elevation ramp, with `mat3(uModel)` on the normal), `applyRegions` / `applyMask` /
`keepPoint`, the leaf classifier, `polygonMask`, the picker, the mesher, the analyser, and
the three exporters. `leafFold` folds the model into the same three columns the leaf
quantisation already provided, so a per-point test still costs three multiply-adds; the
lasso multiplies the model into the view-projection matrix it was building anyway, so the
**498 ms over 18.4M points** measured for freehand selection is unchanged.

Measured on the synthetic fixtures: a transform is a matrix copy and a bounds recompute.
Nothing is read back except the sample described below.

Two things bit.

**A rotated box re-boxed is bigger than what it holds.** The framing box (`viewer.bounds()`)
drives fitting, the elevation ramp and the clipping sliders, and it was being carried through
each change by transforming its eight corners. A 6 × 6 m plane tilted 15° went from a
1.546 m height range to **2.982 m** after being levelled — the box grew while the points got
flatter, which is the opposite of what the feature is for. It is now measured from a uniform
sample of the points whenever the linear part of the matrix changes (a pure translation
carries over exactly, so `bounds()` moves by exactly the metres you asked for), and only
inflated during a gizmo drag, where a readback every frame would stall. Levelled: **1.546 m
→ 0.000 m**. The leaves are shuffled, so a prefix of each is a uniform subsample — the same
property the level-of-detail draw relies on.

**A surface built through the model is transformed twice.** The mesher is handed the matrix
so the voxel grid aligns with the levelled world rather than slicing a floor at an angle,
which means the vertices come back in world space; drawing them through `uModel` again
doubled the rotation. The viewer now remembers the matrix a surface was built with and draws
it through `current × build⁻¹`: the identity right after a build, and exactly the points'
own movement afterwards. `drive-transform.mjs` rotates a further 90° after a build and
checks the exported surface's bounding box against the rotation of the previous one.

Row-major on the Rust side, column-major in three.js, and the panel's matrix box is
row-major because that is how a matrix is written down. Every crossing is commented, because
that is the kind of thing that is silently transposed once and then compensated for twice.

The gizmo is shared rather than duplicated: `TransformControls` is attached to exactly one
object at a time, so turning on the cloud drag releases the crop region and showing the crop
region releases the cloud. That is three lines and one invariant instead of a second gizmo
instance and a z-fighting problem.

## One definition of "unsaved"

Before this there were two half-answers to "is there work to lose". `confirmDiscardHistory`
counted undo and redo steps, which misses a scalar field and a reconstructed surface
entirely — neither goes through the history — and the start screen, the only place that
offered another file, was hidden as soon as a scan loaded, so drag-and-drop was the only way
out.

The useful realisation is that the undo stack **is** the list of unsaved point changes: a
save clears it, a reload and an open replace it, and undoing a transform back to the identity
genuinely does make the cloud clean again. Deriving the answer from `hist.undo`'s entry kinds
rather than a flag means an undo un-dirties the scan for free, which a boolean would have got
wrong. Only the two things that never enter the history — a field and a surface — need a mark
of their own.

Naming the losses rather than counting them is the part that matters. "There is unsaved
history (5 undo, 0 redo)" tells a user nothing about whether they mind; "1 edit · computed
normals · a scalar field (Planarity) · a 5,832-triangle surface · a transform" tells them
exactly what they are about to throw away, and the same list is what `state.unsaved` hands an
agent. *Save as… first* runs the save and then continues to the picker **only if the scan
came out clean**, so a cancelled save cannot quietly discard the work it was meant to protect.

## What an agent actually needs to model from a scan

The instinct is to give an agent more pictures. It does not need more pictures. Everything it
can do with a screenshot it can already do, and none of it is measurable: a perspective frame
has no scale, so "that wall looks about three metres" is the best answer available, and the
model comes out approximately wrong in a way nothing downstream can detect.

What it needs is calibration and vectors.

**Calibration** means the image arrives with the arithmetic that inverts it. A perspective
render cannot carry that — one metre is a different number of pixels at every depth — so the
preset views use a genuinely orthographic projection. That took a real change rather than the
existing trick: `renderTopDown` already approximated ortho with a 10° field of view at a long
distance, and the scale still varies by the depth of the scene over the camera distance, which
is a few per cent, which is 20 cm across a room. So the projection matrix on the perspective
camera is swapped for an orthographic one for the duration of the render. Three things had to
learn about it: the point-size shader (`projFactor` is a constant, `1/metresPerPixel`, instead
of falling off with depth), the level-of-detail estimate (a leaf's projected radius no longer
depends on its distance), and the picker (an orthographic ray through a pixel is parallel to
the view axis, so the depth buffer says only how far along it the point sits). The camera
object itself stays a `PerspectiveCamera`, so the controls, the overlay and the EDL pass never
find out.

The mapping is reported twice: `topLeft` plus `perPixelRight`/`perPixelDown`, which is exact
for any orientation including the isometric view, and `originX/originY/extentX/extentY`, which
is the form a person writes on a drawing and is null when the view is not axis aligned.
`drive-agent-model.mjs` checks the two against each other and against a `probe`: **100 pixels
across the image measured 0.7651 m against 0.7651 m predicted.**

**Vectors** are the other half, and the more important one. `contour` is the primitive that
matters: marching squares over the occupancy of a horizontal slab, returning closed polylines
in metres. An agent drawing a floor plan from a picture is tracing pixels; an agent given four
closed rings and a bounding box that matches the room to **3 cm** is doing geometry. Likewise
`fitplane` returns a normal *and* an RMS, because the RMS is what says whether the thing is a
plane at all — and it caught the test's own mistake: a fitting box tall enough to include the
floor and the ceiling strips either side of a wall reported a 24 mm RMS for a wall that is
exactly flat. Tightened to the wall alone: **0 mm over 2,720 points**.

Three things bit.

**A uniform sample of the cloud is a sparse sample of a slab.** The first `contour`
implementation reused `cells.sample` — right for the heightmap, which covers everything —
and a 0.3 m slab holds about 5% of a room's points, so a 20% sample of the cloud left the wall
lines full of gaps and marching squares returned 221 tiny closed loops, one per isolated cell.
Contour now reads every point of the cells the slab touches and skips the rest by their
transformed bounding box, which is both complete and cheaper on a real scan, where a thin slab
misses most cells entirely. The raster cell also has a floor of two and a half point spacings,
because a cell finer than the point spacing cannot be traced through whatever resolution was
asked for.

**Ramer-Douglas-Peucker collapses a closed ring.** It keeps the two endpoints and measures
everything else against the line between them; on a ring those endpoints are the same point,
that line has no length, and the entire outline simplifies to a single vertex. The room's
footprint came back as one two-point polyline with a degenerate bounding box. The ring is now
cut at the vertex furthest from the start and the halves simplified separately.

**Firestore refuses an array directly inside an array** — which is the shape of every
genuinely two-dimensional thing here: pixel pairs to probe, polylines from a contour. The
relay wrote command arguments straight into a document field, so `probe` with
`pixels: [[400,267],[500,267]]` failed the write, the function's promise rejected, and the
agent got **HTTP 500 with an empty body**: no error, no hint, nothing to act on. Arguments and
answers now cross the mailbox as JSON strings, which have no such rules, and the HTTP shape
the caller sees is unchanged. Large answers are split into ≤ 560,000-character parts rather
than dropped, so a 1.9 MB surface export arrives in five and reassembles to a byte-exact PLY.

And one that was already there: **`OrbitControls.update()` ends in `lookAt(target)`.** Setting
the camera's position and calling `lookAt` is not enough, because the next render re-aims it at
the stale orbit target — so the first orthographic top view was quietly swung off axis and the
mapping described a frame that had never been rendered. The probe caught it immediately: 100
pixels apart measured 1.0108 m against 0.8744 m predicted. `renderTopDown` had the same latent
bug and is fixed with it.

## A crop region that only ever kept

The crop region was hard-wired as a keep region: Apply dropped everything outside it, and
removing a parked van or a tripod from the middle of a scan meant drawing a lasso or asking an
agent to add a delete-role region by hand. The region machinery had supported both roles since
the beginning — the shader dims outside a keep region and inside a delete region, and
`applyRegions` unions keeps and subtracts deletes — so the gap was one flag and one filter.

`applyKeep` filtered `allRegions()` down to keep-role regions, which is what made the crop
mode invisible: switching its role to `delete` would have made the region disappear from the
apply set entirely and Apply would have done nothing. It now commits every keep and delete
region together (`cutRegions()`), which is the same call either way, and `estimateKept`
answers the same question in both directions — how many survive this set — so the dialog can
say *"roughly 6,050 points removed, 6,050 kept"* whichever mode it is in.

`drive-cropmode.mjs` checks the two modes are exact complements over the same box:
**1,849 kept + 10,251 removed = 12,100**, with not one point inside the box surviving the
remove, and both undoing.

## A one-shot screen-space cut was the wrong shape for the job

The freehand lasso worked exactly as designed and was not useful. You traced an outline, and
the points were dropped immediately — which means you could never check what the selection
was about to take. The selection was an invisible frustum extending away from one camera
position, so there was nothing to look at, nothing to adjust, and no way to orbit round and
see whether the thing behind the thing you wanted was also inside it. Undo was the only
inspection tool, which is a poor one.

The fix is not a better lasso, it is a different object. A traced outline now becomes a
**prism**: the polygon extruded along the view direction of the camera that drew it, converted
from pixels to metres at the orbit target's depth so what you drew around lands on the points
you were looking at. From then on it is an ordinary region — visible in the 3D overlay as two
outline caps and the edges between them, moved and rotated with the same gizmo as the box,
adjustable in depth, switchable between Keep and Remove, unioned with the other regions, and
cut only when Apply is pressed. `drive-segment.mjs` asserts the property the whole change
exists for: **1,600 points inside, and still 1,600 after orbiting 90°, from the side, and from
below.**

**What it costs per point in the shader.** The region loop already transformed each point into
each region's local frame; a prism adds `abs(l.z) <= half.z` and then an even-odd crossing
test over its outline. The crossings are the cost: one compare, one divide and one multiply
per edge, for points that pass the depth test. Twenty-four sides is the cap, so the worst case
is 24 iterations — but only for points inside the depth band, and only for the prisms among
the active regions. The outlines of every active prism live in one `vec2[96]` uniform with a
per-region start and count, which is what fixes the limits at four prisms of 24 sides: a
`vec2[96]` plus two `float[16]` is 896 bytes of uniform storage, against the 16 KB a WebGL2
implementation must provide. Simplification keeps a traced outline inside 24 vertices with the
same ring-safe Douglas-Peucker the contour tracer needed, doubling the tolerance until it
fits. Measured: no change in frame time on the 16,900-point fixture, and the 4-vertex outline
a mouse trace produces is the common case, not the 24-vertex worst case.

The leaf-level rejection is where the real saving is, and a prism gets a tighter one than the
bounding-sphere test the box and sphere use: the cell's eight corners are projected into the
prism's frame, and the cell is rejected outright if its 2D bounding box misses the outline's
bounding box or its Z range clears the depth band. A cell is accepted whole only when all
eight projected corners are inside the outline *and* within the depth, so a cell the outline
merely clips falls through to the per-point test, which is correct rather than conservative.

Two smaller things this shook out. **Apply's direction is a property of the set, not of the
crop box**: `removingInside()` first asked whether the crop box was in Remove mode, which was
wrong as soon as a drawn region could be the only thing in the list — the dialog said "Apply
crop?" while about to remove. It now asks whether the set has anything to keep at all. And a
region's point count is worth showing in the list, but `countInside` reads cells back from the
GPU, and the list is re-rendered on every gizmo frame; the count is now skipped while a handle
is moving (falling back to the cheap cell-classification estimate) and recomputed once on
release, which needed one extra `onRegionChange` when the drag ends.

## Two clouds, and the smallest change that got there

Registration, cloud-to-cloud distance and merging are the payoff, and all three need two
clouds in memory at once. The renderer had exactly one `CellRenderer` and `main.ts` had about
a dozen module variables that *were* the loaded scan — its file, its metadata, its histograms,
its surface. Threading an entity argument through every one of those call sites would have
been a hundred edits and a hundred chances to pass the wrong one.

So the module variables stay, and they are the **active** entity's state, swapped in and out
around a switch. `captureActive` and `restoreActive` are eleven lines each and the only place
that has to know what an entity remembers; `viewer.cells` became an accessor for the active
entity's renderer, and every single-cloud call site kept working unchanged. The one rule this
buys is worth stating: a switch is refused while a scan is loading, because a decode in flight
writes into whatever is active.

What genuinely had to change: the draw loop (one pass per visible entity into the same target,
the frame budget shared out by point count, a per-entity colour tint uniform), `bounds()` (the
active entity for tools, the union of the visible ones for fitting and the height range), the
history (each step records its entity, and undo switches back to it first), and "dirty", which
now aggregates across layers and names the layer — *"a scalar field (Planarity) on Second
pass"*.

Two clouds also raised a question a single cloud never had to answer: **where is the second
one?** Each file is shifted into its own local frame on load, so two scans both start near the
origin and land on top of each other regardless of where they actually are. A layer added
after the first is now placed by the difference between its own global shift and the first
layer's, which is the only thing two separate files say about their relative position. Without
it the first `drive-entities` run had two clouds 20 m apart in the world sitting in the same
4.45 m box.

**Merging cannot keep the leaf cubes.** A leaf is an axis-aligned cube with 16-bit offsets
inside it, and a rotated cube is not a cube. Each source leaf is therefore read through its own
model matrix and back through the active layer's, its transformed points get a fresh cube, and
they are requantised into it — under a tenth of a millimetre for a leaf a few metres across,
and the alternative is refusing to merge anything that has been rotated. Scalar fields are
dropped, because a field covering part of a cloud is worse than no field.

### Point-to-plane ICP, and the 47 mm that would not go away

Point-to-plane rather than point-to-point because scan data is surfaces: a point is free to
slide along the surface it belongs to, and forbidding that is what makes plain ICP crawl along
a flat wall. Each pair contributes one equation, `(R p + t - q) · n = 0`, linearised in a small
rotation, so an iteration is a 6×6 solve however many pairs there are. Two details earned
their comments: the rotation is taken about the moving cloud's own centroid (solving for a
rotation about the origin when the cloud is tens of metres away mixes a tiny angle and a large
translation into one normal matrix, and the conditioning shows), and it is applied as the exact
exponential of the rotation vector rather than `I + [ω]×`, so a large first step stays a
rotation instead of a slight shear. A little Tikhonov on the diagonal keeps a plane-only
overlap from producing a singular solve.

`anatest` moves a 61,206-point room by a known 2° and 0.15 m with 2 mm of noise on top:
**0.0493 mm and 0.0000°** recovered, from an initial RMS of 110 mm, in 3 iterations. At **60%
overlap**, 0.1258 mm.

Then the browser gave 47 mm and would not budge, over four iterations that each improved by
less than a tenth of a per cent. The cause was two lines earlier: **Match scales had scaled the
cloud by 0.977**. Two copies of the same room reported different bounding boxes, because one
had been measured by the loader (a 0.2% percentile over a 1024-bin histogram) and the other
resampled after a rotation — two different measurements of the same thing, and coarse
alignment turned the difference into a scale. A rigid ICP cannot undo a scale error, so it
stalled at exactly the residual the scale left behind, and every downstream number was wrong
without anything reporting a failure. Both coarse tools now measure both layers the same way,
from a uniform sample of their own points, and `Match scales` says so out loud when the
per-axis ratios disagree, because that means a rotation rather than a scale. After the fix:
**0.000 mm, 0.0000°, distance field 0.00 mm.**

### A preview that was drawn forever

Chasing why two 8,100-point layers drew 21,200 points a frame: leaf uploads are deferred to the
next frame, and `dropPreview` only dropped the leaves that had already been uploaded. On a
small file every worker message arrives before a frame runs, so the low-resolution preview was
still in the queue when the first real leaf landed, was uploaded afterwards, and was drawn on
top of the real points for the rest of the session. It has presumably been doing that since the
preview was written; nobody noticed because the preview is the same points, so it only cost
fill rate. `dropPreview` now drops the queued ones too.

### Scope

Per-entity surfaces are stored per entity and re-uploaded on a switch, but only the **active**
layer's surface is drawn — one `MeshView`, not one per layer. Stations are likewise the active
layer's only. Both are honest limits rather than oversights: drawing every layer's surface
needs a program and a VAO set per layer, and the panorama bubble assumes one scan's pose.

## Pointing at a thing beats drawing round it

The outline tool works, and it was the wrong default. Tracing a polygon is a careful,
two-handed operation that has to be done from a viewpoint where the thing is unobstructed;
what people actually do is look at something and say *that one*. So the primary gesture is now
one click: **S**, click a point on the cloud, and a small box or sphere appears centred exactly
on the surface point under the cursor — `pickWorld` already gave the millimetre-accurate answer
for the measure tool, so the placement is free.

Making it big enough is then the whole job, and there are four ways because different sizes
want different ones: the gizmo handles for a shape you are watching, the sliders for a number
you know, **Alt + scroll** for the gesture everyone's fingers already have (captured before
OrbitControls sees the wheel, or the camera dollies at the same time), and **Fit to contents**
for "as big as that object". Fit grows each axis by half until a `countInside` stops rising —
that is the edge of whatever the region is sitting on — and then replaces the region with the
exact bounding box of the points it holds. Growing alone would leave it 50% too big; the
tightening is what makes it a fit. On the test blob: **1,600 of 1,600 points, radius 1.42 m
against a true half-diagonal of 1.379 m**, having started at 0.2 m.

The margin it leaves after tightening had to stop being "two point spacings". A sparse cloud's
spacing estimate can be a quarter of a metre, which on a 2 m object is a 25% overshoot; it is
now the smaller of one spacing and 2% of the fitted extent.

The outline tool stays, on ⇧S and a secondary button, because for an awkwardly shaped thing it
is still the right answer.

## LAZ, and a spare byte that had been waiting

`laz` 0.13 (laz-rs) compiles to wasm32 unchanged, which settles the hard part: LAZ is an
arithmetic coder with per-field predictors, and writing one would have been a month. It reads
through the same `JsRangeSource` the E57 path uses, so a LAZ is decompressed a chunk at a time
out of the file on disk and a multi-gigabyte one never enters wasm memory whole. The
decompressed records are ordinary LAS point records, so the existing LAS decoder reads them
and the two formats share one loop.

Measured natively on 5,000,000 generated terrain points (`laztest`): **130.0 MB of raw records
compress to 3.3 MB — 2.5% — in 0.40 s, and decompress in 0.88 s: 5.7 M points/s, 148 MB/s of
output**, byte-exact, with a seek to an arbitrary point index landing correctly. In the browser
the round trip through the viewer's own export is 30.5% of the LAS it came from (a small file,
where the chunk table and header are a real fraction).

COPC is LAZ with an extra VLR describing an octree; ignoring that VLR reads every point in
file order, which is what this viewer wants anyway since it builds its own octree.

**Classification needed somewhere to live.** A per-point label cannot be carried beside the
points, because the octree shuffles them — that is what makes drawing a prefix of a leaf a
uniform subsample. But the 14-byte record has always had a spare byte at index 13, and a LAS
classification is exactly one byte. It travels with the point through the shuffle, through a
crop, through undo, and the field is built from it after the leaves land. That last part cost
one debugging round: uploads are deferred a frame at a time, so anything that reads leaves
back has to wait for the queue to drain — the same lesson as the cached-transform framing box,
now a shared `afterUploads` helper.

**Plain text has no header to trust.** The delimiter is guessed by which separator splits the
first line into the most fields, a header row is one whose fields are not all numbers, and the
columns are guessed by name when there is a header and by shape when there is not (seven
columns is the PTS convention, x y z intensity r g b). Then the first rows are shown in a table
with a select per field, because the guess is going to be wrong sometimes and the alternative
is loading nonsense. Colours are recognised as 0-255 or 0-1 from the first row that has them.

**PTX is structured, and the structure is the point.** Each scan carries rows, columns, a
scanner position and a 4×4 pose; points are in the scanner's own frame and a shot that returned
nothing is written as `0 0 0`. Applying each pose puts every scan in one frame, skipping the
zeros drops the misses, and each scan's translation becomes a station — so the station markers
and "view from here" work on a Leica export with no panoramas in it at all.

## Fits that report a residual, and a detector that removes what it finds

Every fit here returns an RMS beside its parameters, and that is the whole design. A cylinder
fitted to a flat wall comes back with a radius and an axis and a centre — perfectly formed,
entirely meaningless — and the only thing that says so is the residual. `drive-fit.mjs` tests
exactly that case: a sphere fitted to the pipe reports **118.7 mm RMS against 0.4 mm for the
right shape**.

Each fit is algebraic first and geometric second. A sphere's algebraic form (`x²+y²+z² + ax +
by + cz + d = 0`) is linear, so it cannot fail to converge and gives a starting point; then a
dozen Gauss-Newton steps on the true distance `|p - c| - r` make the RMS mean what it says.
The cylinder's axis comes from the **normals**, not the points: every normal of a cylinder is
perpendicular to its axis, so the normal set spans a plane and the axis is the direction they
vary least in — which works on a 90° arc, where fitting the axis from the points would not.
Measured against known primitives with a millimetre of jitter: plane normal **0.008°** off,
sphere centre **0.011 mm** and radius **0.000 mm**, cylinder axis **0.0000°** and radius
**0.000 mm**, circle radius **0.01 mm**.

The detector is RANSAC, one shape at a time, and the part worth stating is that **removing
each shape's inliers before looking for the next is the non-maximum suppression**. Two fits of
the same wall cannot both survive, because after the first there is nothing left for the second
to be supported by — no scoring heuristic, no overlap test, just an invariant. Each shape is
then refitted on everything that agreed with it, which is what turns a lucky three-point sample
into a measurement: in the native scene the refitted planes come back at **0.6 mm RMS** from
1 mm of noise.

RANSAC runs on a sample, because it does not need ten million points to find a wall. But the
labels a sample produces only cover the sample, so the field is built by classifying **every**
point against the few shapes that were found — cheaper than feeding everything to the
detector, and honest about what it knows. On the test scene: **38,299 points labelled of
38,291 real ones, with 2,000 noise points left unclaimed.**

Two things the driver shook out. **Undo refused to run on an empty layer.** `undoEdit` began
with `if (!viewer.loaded) return null`, which is precisely backwards: an edit that removed
everything is the one that most needs undoing, and there was no way back from it. And a fit
over a region that also contains noise reports a worse residual — which is correct, and meant
the test fixture had to keep its noise out of the boxes it fits in, rather than the code
pretending the noise was not there.

## A volume is a subtraction, and the asymmetry in it is the whole answer

A 2.5D volume is the difference between two height rasters, one cell area at a time. The
arithmetic is trivial; getting the right answer was about which side gets its holes filled.

Against a flat plane the first attempt was already right: **64.202 m³ against an arithmetic
64.274 m³, −0.11%**, for a pyramid (a²h/3) plus a half-cylinder mound (πr²L/2). Against a
*reference layer* it came out at **16.019 m³ — a quarter of the answer** — and the reason is
worth keeping. The reference was sampled at 0.1 m and the raster cell was 0.05 m, so only about
one cell in four of the reference had a point in it, and every cell where the reference was
empty was skipped. Not reported as missing: silently skipped, in a number that looked
plausible.

Filling both sides fixed that and broke something else: **+8.4%**, because filling the *active*
layer extends its surface up to twelve cells past its own edge and invents volume that was
never scanned. So the reference is hole-filled and the active layer is not, and the asymmetry
is the point: a cell the reference has no point in still has ground under it, but a cell the
active layer has no point in has nothing measured above it. Both ways now agree: **64.202 m³,
−0.11%**.

The same reach cap that makes filling safe means it does not fill everything — the two shapes
in the fixture are 4.5 m apart and the ground between them stays empty at a twelve-cell reach.
That is the intended behaviour and the driver asserts it rather than asserting full coverage.

Contours interpolate the crossing along each cell edge rather than taking the midpoint, which
is the difference between a contour and a staircase: the pyramid's contour at half height comes
out **3.050 m across against an exact 3.000**, at a 0.1 m cell.

A world file is six numbers and the only one that needs thought is the last: the *centre* of
the top-left pixel, in the global frame, with a negative y scale because image rows run down
and northings run up.

## A mesh is a layer, and the renderer had quietly assumed otherwise

The surface renderer had existed since the reconstruction work, but there was exactly one of
it. `Viewer.mesh` was a field, `state.meshBase` remembered the transform each layer's surface
had been built in, and switching layers re-uploaded the new active layer's triangles into that
one renderer. It worked because a surface was always a by-product of the active cloud, and you
only ever wanted to see the active cloud's.

An imported mesh breaks that in the first minute of use: the whole point of opening a design
model next to a scan is seeing both. So `MeshView` moved into `Entity`, `viewer.mesh` became an
accessor for the active one, and the draw loop walks every visible layer's. Switching layers
now re-points the UI instead of re-uploading anything, which also made it instant. The
`current × built-with⁻¹` trick that keeps a surface glued to its points survived unchanged —
it just runs per entity now.

A mesh layer is a layer with zero points, which needed two small honesties elsewhere:
`visibleEntities` (the point draw loop, merging, registration) still filters on `total > 0`,
and a new `shownEntities` is what framing and the height range use. And `setModel` re-boxes a
mesh layer from its vertices rather than sampling points it does not have — a rotated box
inflates, and a mesh has exact vertices to measure instead.

### Point-to-triangle, because point-to-nearest-vertex is a different measurement

Cloud-to-mesh distance is the one part that had to be in Rust. The naive version — index the
mesh vertices in the existing spatial grid and reuse the nearest-point search — is wrong by up
to most of a triangle on a coarse mesh, and coarse meshes are exactly what people compare
against. A point 2 m above the centre of a unit cube's top face is 2 m from the surface and
2.121 m from the nearest vertex; on a 20 cm-decimated model that gap is centimetres.

So triangles go into a uniform grid by their bounding boxes and each query expands a shell at a
time until no unsearched cell can be closer than the best already found. The per-triangle test
is the standard region classification: project into the plane, and clamp to the nearest edge or
vertex when the projection falls outside. A triangle spanning an absurd number of cells is
registered by its three corners only — the expanding search still reaches it, and the
alternative is one triangle in ten thousand cells.

Validated natively against a unit cube (face, edge, corner, on-surface, inside), then in the
browser against a shell of 30,000 points 250 mm outside a 16,384-triangle sphere mesh:
**249.96 to 250.64 mm**. The spread is the sphere's own faceting, not the measurement.

### Decimation: vertex clustering, and saying so

The brief allowed either quadric edge collapse or vertex clustering "if quadric is too much —
say which". It is vertex clustering, and the trade is worth stating rather than burying:
clustering is one linear pass with no priority queue, so it finishes on millions of triangles
in well under a second, but you give it a **cell size** and get whatever triangle count that
grid produces. Edge collapse hits an exact target and follows thin features better, at the cost
of a heap of every edge re-ranked on each collapse.

What it does keep is corners, because each cluster's representative is the point minimising the
squared distance to the planes of its triangles — the quadric — not the mean of its vertices.
Where that system is near-singular (a flat patch, where any point on the plane is as good) or
throws the point outside the cell, it falls back to the area-weighted mean. A 16,384-triangle
sphere decimates to 770 triangles at a 20 cm cell with the area holding at **12.529 m² against
12.566**.

**The bug that made this look broken first**: the cluster key packed three cell indices into
one double as `(x+2²⁰)·2⁴⁰ + (y+2²⁰)·2²⁰ + z`, which exceeds 2⁵³ and collides. Collisions weld
unrelated parts of a model into one vertex, and the sphere came out at 180 triangles and
**4.12 m²** — a third of its area — which looks like a bad algorithm rather than a bad hash. It
is now two levels of `Map`, outer keyed on the x index and inner on `y·dz + z`, neither of which
can overflow for any grid a machine could hold. The same mistake was in the duplicate-triangle
test and is fixed the same way.

### Taubin, and why the default matters

Laplacian smoothing shrinks: every pass pulls a sphere toward its centre and a wall toward the
room. Taubin follows each λ pass with a μ pass at a slightly larger negative weight, which
makes it a low-pass filter on the surface rather than a blur. Over ten passes on a sphere mesh
the volume moves **+0.12%** with Taubin and **−1.98%** with plain Laplacian, so Taubin is the
default and the checkbox is called *Keep volume* rather than anything about λ and μ. Boundary
vertices are pinned: a vertex with neighbours on one side only gets dragged inward by any
averaging, Taubin included.

### Volume is only a volume when the mesh is closed

The divergence sum over triangles gives the enclosed volume for a closed, consistently wound
surface and an arbitrary number for anything else. Rather than hide that, `measure` reports
`closed` and `boundaryEdges` next to the number and the agent reply says in words that an open
mesh's volume is not an enclosed volume. A unit cube reads 6.000 m² and 1.000 m³ with zero
boundary edges; a single quad reads 4.000 m² and four boundary edges.

### Sampling is the bridge back to the point tools

Points scattered over a mesh, area-weighted (so one big triangle gets as many as the hundred
small ones covering the same area), land as a **new point layer** — which means every cloud
tool works on a mesh through one step: fit primitives to it, section it, contour it, raster it,
register a scan onto it. The generator is a small deterministic xorshift, so the same mesh
gives the same points twice and a driver can assert on them. 120,000 points over a 12.560 m²
sphere come back at **9554.1 per m² against an expected 9549.3**, with every sampled radius
within 0.6 mm of the sphere.

The one piece of plumbing that mattered: sampled points arrive in world coordinates in random
order, and handing the renderer one leaf holding all of them would draw correctly but give
every leaf a box covering the whole model, so the level-of-detail pass could never reject one.
They are binned onto a coarse grid first, about 40,000 points a leaf.

### PLY is two formats

A PLY is a point cloud or a mesh depending on whether it has a `face` element with a non-zero
count, and nothing in the name says which. The open path reads 64 KB of header and decides
there; a PLY with faces becomes a mesh layer, one without stays on the cloud importer it always
used. OBJ and STL have no such ambiguity. STL has no vertices at all — only loose triangles —
so its corners are welded back together on import at a ten-millionth of the model's extent,
because without shared vertices smoothing, decimation and the boundary-edge count are all
meaningless.

## A script is a way of not waiting nineteen times

Driving a viewer from an agent is mostly waiting. A modelling session is twenty or so calls,
each one crossing a relay, and nineteen of them are decided entirely by the previous answer:
fit a plane in a box built from the bounds the last call reported, count points at the height
the last fit found, contour at that height. The commands were never the slow part.

So `script` takes the whole plan — an array of `{cmd, args, save?, label?}` — and runs it in
the tab, with each step's result available to the next. The reply is one record per step in
order, with its result, its error and its milliseconds, whatever happened.

The variables are deliberately small, and the restraint is the design:

- `$last` — the previous step's result.
- `$layers`, `$active` — recomputed **before every step**, because a step can add, remove or
  activate a layer and a stale list would be worse than none.
- `$name` — bound by a step's own `save`, or passed in by the caller as `vars`.

Dotted paths index in, array indices included: `$last.area`, `$layers.0.id`,
`$s.bounds.local.centre`. A string that is *exactly* `"$path"` is replaced by the value with
its own type, so an array stays an array and a number stays a number; `${path}` inside a longer
string interpolates as text. Those are two different operations and conflating them is how a
box centre ends up as the string `"3.025,2.025,0"`.

What it deliberately does not have: conditionals, loops, arithmetic. Every one of those is a
step toward a badly-specified programming language embedded in JSON, and the agent calling it
already has a real one. A script is a batch, not a program. It also cannot run a script —
checked explicitly, because the alternative is a stack overflow in someone's browser tab.

Three smaller decisions that each came from a concrete failure mode:

- **A step's picture is not shipped.** `screenshot` and `view` answer with base64, and a
  five-step script with two views is megabytes in a reply that is capped at 700,000 characters.
  Step results have `png` and `image.data` replaced with a note saying how big they were and to
  ask for the picture with its own call.
- **A failing step names what was available.** `no variable $nope. Available: $layers, $active,
  $last` is the difference between a typo you fix in five seconds and one you fix by reading the
  documentation again.
- **A script is exactly as privileged as its steps.** The edit gate runs over the step list
  before anything executes, in the tab and in the relay both, so a read-only session cannot get
  an editing command through by wrapping it.

`drive-script.mjs` runs one end to end — fit a floor inside a box built from the cloud's own
bounds, count what is on it at the height the fit found, measure the diagonal from two
whole-array variables — and then checks the failure paths: an unknown command stops the run, a
bad variable is named, `stopOnError:false` finishes anyway, and a nested script is refused.

## A desktop app, and the three things a web page cannot do

The viewer did not need porting. The desktop build runs the same TypeScript, the same Rust
compiled to WebAssembly, the same WebGL2 renderer, the same workers and the same OPFS cache,
inside a WKWebView instead of Chrome. What a native shell adds is exactly three things, and
everything in `desktop/` exists to provide one of them: **files by path**, **real Save
dialogs**, and **an MCP server that needs no Node and no network**.

Tauri v2 rather than Electron, because the Rust toolchain was already here and the numbers are
not close: the whole macOS app is **4.7 MB** and the disk image **3.1 MB**, against something
over 100 MB for an Electron shell of the same page.

### Reading a 3 GB file with no `File` object

Every decoder in this project is written against `readRange(offset, length) -> Uint8Array`,
because the point of the E57 reader is that the file never enters memory. In a browser that is
`FileReaderSync` over `File.slice()` inside a worker. In the desktop app there is no `File` —
the user chose a path, or dropped one from Finder, which Tauri delivers as a path rather than
a drop event.

So the shell serves byte ranges over a custom URL scheme and the worker reads them with a
**synchronous XHR**, which a worker is allowed to do. The alternatives were worse. A
`SharedArrayBuffer` with an `Atomics.wait` handshake needs cross-origin isolation and a main
thread that is never busy — and the main thread here is the one rendering. Making the reader
async means rewriting the Rust `Read` implementation and everything above it. A blocking range
request inside a worker is the small answer, and because it has the same shape as the browser
path, nothing downstream changed: one ternary in each of three workers.

**It hung on the first run, silently.** Sixty seconds at 6% CPU and flat memory. The cause was
the Content Security Policy: `connect-src` did not list the custom scheme, so WKWebView refused
the request without an error a worker could see. Adding `e57vfile:` to `connect-src` fixed it
outright. Worth writing down because the symptom — a hang, not a failure — points nowhere near
the cause.

### The bug that made every fix invisible

For an hour the app kept behaving as though half the fixes had not been made, because they had
not. `tauri::generate_context!()` bakes the built front-end into the binary **at macro
expansion time**, and cargo does not know that happened: rebuild `dist-desktop`, leave `src/`
alone, and cargo cheerfully skips the compile and ships the *previous* front-end inside a
freshly bundled app. Everything compiles, the app runs, and it is the wrong app. The same trap
caught `include_str!("../../mcp/tools.json")` — the binary served 29 tools for a while after
the file had 30.

Two lines in `build.rs` fix it, and they are the kind of line that is obvious only afterwards:

    println!("cargo:rerun-if-changed=../dist-desktop");
    println!("cargo:rerun-if-changed=../mcp/tools.json");

### Offline means the bytes, not the behaviour

"No network" is a claim about what ships, not about what runs. Three things in the web build
reach out: the analytics tag, the Google Fonts stylesheet, and Firebase for the hosted agent
relay. Guarding them at runtime would still ship them.

So the desktop build is a separate Vite mode. An `enforce: 'pre'` plugin strips the analytics
script and the font links out of the HTML (the font stacks already name `system-ui` and
`ui-monospace` as fallbacks, so this costs the typeface and nothing else), and resolves
`./session` to a four-line stub that throws with an explanation — which takes **458 KB of
Firestore client** out of the bundle rather than merely not calling it. It also blanks the
web-only install snippet, because a URL in a `<pre>` is still a URL in the shipped bytes.
Afterwards the only absolute URLs left in `dist-desktop` are the two XML namespaces that SVG
requires. The one socket the process opens is a listener on 127.0.0.1 for the agent bridge.

### One source of truth for 30 tools

The desktop app serves MCP from Rust, and the web build serves it from Node. Two
implementations describing the same thirty tools in two languages would drift the week after
they were written — so neither describes them. `mcp/tools.json` holds every name, description,
JSON Schema, timeout and reply shape; `mcp/server.mjs` reads it and converts each schema back
into the zod shape the SDK wants, and `desktop/src/mcp.rs` embeds it and serves `tools/list`
verbatim.

Pushing the *reply* shape into the same file is what made the two actually identical rather
than merely similar. Each tool carries a small `ui` record — `shot: always | never | own-image
| own-png`, an optional `noShotWhen: {op: [...]}`, an optional `writesFile: {arg, via}` — and
both servers implement that one algorithm instead of twenty-nine hand-written handlers. The
Node server went from 282 lines to 171 in the process. `test-mcp.mjs` drives each server over
stdio the way an agent does and compares every name, description, property list and required
list against the file: 23 checks, and it runs in CI on all three platforms.

The split that made this possible: in the web build the Node MCP server *is* the WebSocket
endpoint, but the desktop app is already running when an agent starts, so the app owns a small
router — one viewer, any number of agents — and `e57view --mcp` is just another agent that
happens to speak MCP on its own stdin and stdout. The wire protocol is byte-for-byte the one
the web build already used, so `agent.ts` cannot tell which server it is talking to.

### Measured, on this machine, on the real scan

`drive-desktop.mjs` drives the **built app** through its own MCP server — there is no
Playwright, because a WKWebView is not a browser you can attach to, and the interface an agent
will actually use is the right one to test through. Against `1973-registered.e57`, 3.23 GB:

| | |
|---|---|
| open by path, 73,757,292 points | **17.1 s** (Chrome, same file: 13.5 s) |
| resident memory, whole scan loaded | **97 MB** (the 1,033 MB of records live in GPU buffers) |
| cache the decoded cells to OPFS | **1.1 s** |
| reopen from that cache | **0.6 s — 27.9x faster than decoding** |
| export 1-in-40 as LAS to a chosen path | 48.0 MB in 1.0 s, byte-exact |
| exact point-in-box count over all 73.8M | passes |

WKWebView was the risk and it carried everything: `FileReaderSync` was not needed in the end,
OPFS sync access handles work, and the float render targets the eye-dome pass needs are there.

### `viewer_cache`, which the desktop made obvious

Driving the app headlessly exposed a real gap in the agent surface: an agent could *open* a
cached scan but never *create* one, because caching was a modal the user answered. Since a
scan that takes seventeen seconds to decode reopens in half a second, caching one you will come
back to is among the most useful things an agent can do for the next session. It is a tool now.
