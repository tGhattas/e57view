# e57view

**Live: https://opensketch.web.app**

A browser E57 point cloud viewer. No install, no upload, no server — the file is read
straight off your disk and never leaves the machine. Works on desktop, iPhone and iPad,
and can be added to the home screen as a web app.

Built against a real 3.23 GB / 73.8M point NavVis scan. See `PLAN.md` for the design and
`FINDINGS.md` for the measurements behind it.

## What works today

- Opens multi-gigabyte E57 files. **The file is never loaded into WebAssembly memory** — a
  synchronous ranged-read shim (`FileReaderSync` over `File.slice()`) feeds the Rust reader,
  so wasm32's 4 GB address space is not a ceiling. No SharedArrayBuffer, no COOP/COEP.
- Header + XML parse in ~10 ms. Scan card is populated before anything is decoded.
- A **fast columnar decoder** (`crates/e57-wasm/src/fast.rs`) replaces the crate's readers:
  no per-page CRC, no per-value 16-byte copy, no per-point allocation. 4x faster raw, validated
  bit-exact against the crate on all ten fields of the test file.
- Points are binned into a **leaf-only octree** with 16-bit positions per cell (14 bytes per
  point) and each cell is **shuffled**, so drawing a prefix of a cell is a uniform subsample.
  That is continuous level of detail with zero extra storage.
- A **raw WebGL2 renderer** (`src/cells.ts`) frustum-culls cells, sizes each one's draw count
  by projected screen area, fills the per-frame budget, and hands the shader a per-cell
  spacing so adaptive point size never balloons.
- Colour modes: RGB, intensity, RGB × intensity, elevation ramp, normals, flat.
- Eye-dome lighting with a same-surface tolerance (no black rings on close-ups), adaptive
  point sizing with a max-pixel clamp, circular points, normal shading.
- Tone controls, intensity histogram with auto-ranged handles, height clipping. Bounds for
  framing and clipping come from percentiles of a sample, so stray outlier points can't
  blow up the view.
- **Zoom toward the cursor, double-click to move the orbit centre onto a point, and a fly
  mode** (W A S D, Q E, drag to look, scroll for speed) for walking inside a building.
- Renders only when something changed. The whole budget is drawn when idle; a fraction
  while interacting.

Measured against the live deployment, Chrome on Apple Silicon, all 73.8M points in memory:

| | |
|---|---|
| preview on screen | 2.3 s |
| all 73,757,292 points loaded | 13.5 s |
| GPU frame, 8M points drawn, whole site in view | 9.8 ms |
| GPU frame, 8M points drawn, close up | 5.0 ms |
| GPU frame, 16M drawn | 14 ms |
| GPU frame, 32M drawn | 30 ms |

iPhone keeps 1 in 10 (7.4M) and draws 1M; iPad keeps 1 in 4 (18.4M) and draws 2M.

## Layers

More than one cloud can be open at once, which is what registration, cloud-to-cloud distance
and merging all need. Every visible layer is drawn into the same frame — they share the
deferred format, so they depth-composite correctly and the eye-dome pass shades whatever ends
up in front — and exactly one layer is **active**: every tool, every readout and every agent
command works on that one, deliberately, because a tool that silently spanned several clouds
would be impossible to reason about.

- **Add file…** opens a scan alongside the ones already open, and so does dropping a file with
  **Shift** held. *Open file…* still replaces everything, with the unsaved-work warning.
- A layer added after the first is placed by the difference between its own global shift and
  the first layer's — the only thing two separate files say about where they sit relative to
  each other.
- An eye toggles drawing without unloading; a click activates; a double-click renames; a tint
  multiplies one layer's colour so two overlapping scans can be told apart.
- **Clone** copies the active layer, **Merge into active** appends every other visible layer's
  points through each of their transforms so the geometry is preserved. Scalar fields are
  dropped on a merge, and it cannot be undone.
- Undo knows which layer each step belongs to and switches back to it before undoing.

## Register

Moves the **active** layer onto a reference and never touches the reference.

- **Match centres** and **Match scales** are the coarse step. Both measure the two layers the
  same way, from a uniform sample of their own points — comparing a loader percentile box
  against a resampled one invents a scale error out of nothing, and a rigid fit cannot undo a
  scale error. *Match scales* is for two clouds in different units; two copies of the same
  cloud differ in bounding box as soon as one is rotated.
- **Fine registration (ICP)** is point-to-plane, in Rust, in the analyser worker. Scan data is
  surfaces, and a point is free to slide along the surface it belongs to; forbidding that —
  which point-to-point ICP does — is what makes plain ICP crawl across a flat wall. Up to
  200,000 points of the moving cloud per iteration, nearest reference point through the same
  voxel grid the analyses use, pairs beyond a gate that tightens as the fit settles rejected,
  and a 6×6 solve per iteration however many pairs there are. It reports per-iteration RMS,
  final RMS and overlap, and applies as one undoable step labelled *"ICP: RMS 0.4 mm, 98%
  overlap"*.
- **Distance to reference** writes the distance from every point of the active layer to the
  nearest reference point as a scalar field, so the colour ramp, the histogram and the value
  filter all work on it. Signed against the reference's own normals is the M3C2-style version:
  it says which side of the surface each point is on, so settlement and heave stop cancelling
  into the same positive number.

Validated natively: a room moved by a known 2° and 0.15 m, with 2 mm of noise, comes back to
**0.05 mm and 0.0000°**, and to **0.13 mm** with only 60% overlap. In the browser, two copies
of the same room register to **0.000 mm** and their distance field reads **0.00 mm**.

## Tools

- **Crop** — a box, sphere or slab you drag around with a gizmo (arrows move it, handles
  resize it), or place on the orbit centre and size with sliders — and the same for a sphere, a
  slab or a drawn prism, any number of them unioned in the Sections list. It cuts either way:
  **Keep inside** drops everything outside it, **Remove inside** drops what is inside it, and
  the preview dims whichever half is going so what you see is what Apply will leave. The
  confirmation counts both sides — *"roughly 6,050 points removed, 6,050 kept"*. The file on
  disk is never touched; *Undo* puts the points back and *Reload* brings everything back.
- **Export** — save what is in memory (the crop, if you applied one, optionally every Nth
  point) as **E57**, **LAS 1.2** or binary **PLY**. E57 keeps colour, intensity and normals
  (`nor` extension) with the original pose, so coordinates stay georeferenced. Written by
  the Rust E57 writer in a worker into private browser storage, then streamed to wherever
  you choose. Verified round-trip: the exported E57 re-parses bit-exact.
- **Measure** — distance between two clicked points, with the height difference. Single
  click shows the surface coordinates (Easting / Northing / Z, plus local).
- **Stations** — every panorama in the file is a marker; click one to stand in the 360°
  photo with the points blended over it (slider). Walk away and it fades out. Photo and
  points align.
- **Cache** — after a decode you are asked whether to cache the decoded cells in the
  browser's private storage. A cached scan reopens in about a second. Cached scans are
  listed on the start screen, with a remove button, and reopen in one click in Chromium.
- **Open another scan** — *Open…* in the top bar, in the Performance group, or **⌘O**. If the
  loaded scan has unsaved work the viewer says what would be lost in plain words — *"1 edit ·
  computed normals · a scalar field (Planarity) · a 5,832-triangle surface · a transform"* —
  and offers *Cancel*, *Save as… first* or *Open anyway*. Drag-and-drop and the cached list
  ask the same question. With nothing unsaved it opens straight away. One definition of
  "unsaved" covers point edits, normals, fields, surfaces and transforms, and it is cleared
  by a save, a reload or an open.
- **Undo / redo / Save.** Every destructive edit is undoable (⌘Z / ⇧⌘Z). ⌘S opens *Save as…*,
  which writes a copy of the points in memory; the on-device cache is updated only if the
  scan was already cached, and history is cleared after a warning. Large undo steps spill
  to the origin-private file system so a multi-million-point crop does not pin hundreds of
  megabytes in RAM.
- **Create a region** — press <b>S</b> (or *Create region*), then click a point on the cloud: a
  small box or sphere appears centred exactly there, active with the gizmo already in Resize.
  Make it the right size however suits: the handles, the size sliders, *Grow ×1.5* / *Shrink
  ÷1.5*, **Alt** (Option) and the scroll wheel, or **Fit to contents**, which grows it until it
  stops finding new points and then tightens onto the ones it holds — the "enlarge to the
  object" gesture in one click. Each Create adds another; they union, and any row can be
  flipped to *Remove*.
- **Draw an outline** — <b>⇧S</b>, trace a shape over the view, then **Create region**.
  The outline becomes a **prism**: extruded along the direction you drew it from, scaled to
  metres at the orbit centre so it lands on the points you were looking at. From then on it is
  a bounding shape like the box — drawn in 3D so you can orbit around it and see exactly what
  it holds, moved and rotated with the gizmo, adjustable in depth, switchable between *Keep*
  and *Remove*, unioned with the other regions, and cut only when you press Apply. The count
  it holds does not change when the camera does, which is the entire point. Up to four drawn
  regions of 24 sides can be active at once. *Keep inside now* and *Remove inside now* remain
  for a one-shot screen-space cut: half a second over 18.4 million points, because each leaf's
  quantisation is folded into the view-projection matrix and a leaf whose projected box misses
  the shape is never read back.
- **Analysis** — one neighbourhood search, reused five ways. *Compute normals* fits a plane
  to each point's neighbours and *Orient* makes neighbours agree then turns them outward,
  which matters because surface reconstruction is only as good as the normals feeding it.
  When the file carries panorama stations, *Orient* turns each normal toward the nearest one:
  a laser only ever saw a surface from the station that measured it, which is the opposite of
  "away from the centroid" for anything scanned from the inside. Computed normals are
  undoable like any other edit.
  *Measure* writes a geometric feature into a scalar field: roughness, curvature, planarity,
  linearity, sphericity, anisotropy, omnivariance, eigenentropy, verticality, volume and
  surface density, neighbour count, or any of the three eigenvalues. *Clean* removes
  statistical outliers, off-surface noise or duplicates. *Components* labels groups of points
  that touch, and *Thin* keeps one point per cube. Every removal is confirmed, counted and
  undoable like a crop.
- **Scalar fields** — one number per point, displayed through a colour ramp with a histogram,
  an adjustable display range, and a value filter that can dim, hide or delete the points
  outside it. A field survives cropping and undo, staying aligned with the points it belongs
  to.
- **Surface reconstruction** — builds a triangle mesh from the points and their normals.
  Each point is a small piece of oriented plane, so a truncated signed distance field can be
  splatted directly instead of solved for: the field averages every point that reaches a
  voxel, which is what removes scanner noise, and surface nets turn it into triangles.
  Taubin smoothing drops the remaining ripple without shrinking the shape. *Detail* is the
  voxel size and defaults to the scan's own point spacing, because anything finer only
  reconstructs noise; *Fill gaps* widens the band each point writes, closing small holes at
  the cost of rounding sharp edges. The surface draws into the same pass as the points, so
  it is occluded by them correctly and picks up the same eye-dome shading, and
  *Points / Surface / Both* switches between them. Clouds with no normals fall back to a
  density isosurface. Save as binary PLY (colour and normals) or OBJ. The points are never
  modified.
- **Transform** — move, rotate, scale, level or hand the cloud a 4x4 matrix. **Nothing is
  baked**: the points stay quantised in their original leaf cubes and the matrix is applied
  when they are drawn, tested, cropped, lassoed, analysed, meshed and exported. So a
  transform is instant on 18 million points, loses no precision to requantisation, and
  undoes with two matrices instead of a copy of the cloud. *Level* fits a plane to a uniform
  sample by PCA and turns it horizontal about the bounding-box centre; the drag toggle hands
  the whole cloud to the same gizmo the crop region uses (only one is ever attached). The
  scan's own global shift sits beside it, separately editable, because that one affects
  exported coordinates and the readout rather than anything on screen. *Save a copy* bakes
  the matrix into the file, and the on-device cache stores it, so a cached transformed scan
  reopens transformed.
- **Agent modelling tools** — what an AI needs to build a model from a scan, which is not
  more screenshots. `view` renders a preset with a **true orthographic projection**, so one
  metre is the same number of pixels everywhere and the mapping it returns turns any pixel
  into a world point exactly; `probe` turns pixels of that image back into world points by
  re-establishing its camera, so the answer holds after the view has moved. `section` is a
  floor plan or a wall elevation of one slab. `contour` gives the same slab as **polylines in
  metres** rather than pixels — the thing you actually draw from. `fitplane` fits a plane by
  PCA and reports the RMS that says whether to believe it. `heightmap` is a grey raster of the
  highest surface per cell with its metre mapping. `distance` and `inside` answer lengths and
  counts from the data. `state` reports bounds, spacing, normal coverage, the surface's hole
  ratio, and **recommendedSource** — points or surface, and why. `surface export` writes the
  mesh with the transform and the global shift baked in. Replies bigger than the relay's 1 MiB
  document come back in numbered parts. See `public/llms.txt`.
- **View link** — copies a URL that restores the camera and colour mode when the same file
  is opened again.

## Mobile

The point budget starts at 1M on phones and 3M on tablets, because iOS Safari is memory
limited and kills tabs that overreach. It is a knob, not a cap — raise it and press
*Reload at this budget*.

- The control panel becomes a bottom sheet with a drag handle; swipe or tap to open.
- One finger orbits, two fingers pan and pinch-zoom.
- The camera azimuth is chosen so the cloud's long axis runs along the screen's long axis,
  which is what makes a wide site usable in portrait.
- Device pixel ratio is capped at 2. iPhone's native 3 triples fill cost for no visible gain
  on a point cloud.
- EDL needs a renderable float texture. The renderer probes `EXT_color_buffer_float`, falls
  back to half float, and disables EDL rather than failing if neither is available.
- iOS registers no MIME type for `.e57`, and an `accept` filter greys the file out in the
  Files picker, so the filter is dropped on iOS.

### Tested how

Desktop and Chrome device emulation for iPhone 15 Pro and iPad Pro 11, against the real
3.23 GB file. **Not yet tested on physical iOS hardware**, so the WebKit-specific paths —
the float-texture fallback, `FileReaderSync` on a multi-gigabyte file coming from iCloud
Drive, and Safari's tab memory ceiling — are written defensively but unproven.

## Not built yet

No parallel decode. No multi-scan visibility toggles (the test file is one registered
scan). No angle or area measurement.

## Removed

Cloud upload and AI-assisted cleaning were built and then taken out of the product. The
viewer is local-only again: a scan never leaves the machine that opened it, there are no
provider keys and no server-side conversion. The agent interface stays, because it drives
the tab the user already has open rather than moving any data. History is in
`FINDINGS.md`.

## Deploy

```sh
npm run build     # bundles the app and the MCP server into dist/
firebase deploy --only hosting,functions,firestore:rules --project opensketch
```

The only Cloud Function is `agent`, the mailbox that lets an AI agent drive an open tab
over HTTP. It stores nothing but the current command and its answer.

## Run it

```sh
npm install
npm run dev          # http://127.0.0.1:5180
```

Rebuilding the WebAssembly needs the Rust toolchain and `wasm-bindgen` 0.2.128:

```sh
rustup target add wasm32-unknown-unknown
npm run wasm
```

`drive.mjs` opens the app in Chrome, loads a file and captures the screenshots in `shots/`.
