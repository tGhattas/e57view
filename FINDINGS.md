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
