<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Changelog

Grouped by what it does for you rather than strictly by date, because the work arrived in
capability-sized pieces and that is how it is useful to read. Numbers are from the drivers that
assert them on every run; the reasoning behind most of them is in [FINDINGS.md](FINDINGS.md).

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Nothing has
been released yet, so everything is unreleased.

## Unreleased

### Reading and writing files

- **E57**, with a columnar decoder written for this project (`crates/e57-wasm/src/fast.rs`):
  no per-page CRC, no per-value copy, no per-point allocation. Four times faster than the
  reference reader and validated bit-exact against it on all ten fields.
- The file is **never loaded into WebAssembly memory**. A synchronous ranged-read shim feeds
  the Rust reader, so wasm32's 4 GB address space is not a ceiling and a 3.23 GB scan opens in
  13.5 s in Chrome.
- **PLY**, **LAS**, **PTX** and delimited **text** import. Text is sniffed for its delimiter
  and columns and confirmed in a dialog over the first rows.
- **LAZ** import and export, with laz-rs compiled to WebAssembly and streamed through the same
  ranged-read shim, so a multi-gigabyte LAZ never enters wasm memory whole. COPC files read as
  ordinary LAZ. A LAS or LAZ **classification** becomes a scalar field, carried in the point
  record's spare byte so it survives the octree shuffle.
- **Mesh import**: PLY, OBJ and STL with faces open as a layer of triangles rather than points.
- **Export** as E57, LAS 1.2, LAZ or binary PLY; meshes as PLY, OBJ or STL. The E57 writer
  keeps colour, intensity and normals with the original pose; an exported E57 re-parses
  bit-exact.

### Viewing

- A **leaf-only octree** with 16-bit positions (14 bytes a point) and each leaf shuffled, so
  drawing a prefix of a leaf is a uniform subsample — continuous level of detail at no storage
  cost.
- A **raw WebGL2 renderer** that frustum-culls leaves, sizes each one's draw count by projected
  screen area and fills a per-frame budget. 8M points in 9.8 ms, 32M in 30 ms.
- **Eye-dome lighting** with a same-surface tolerance, adaptive point sizing, circular points,
  normal shading, seven colour modes, tone controls and height clipping.
- **Panorama stations**: stand inside a scan's own 360° photo with the points blended over it.
- Framing bounds from percentiles of a sample, so one stray point cannot blow up the view.
- Zoom toward the cursor, double-click to move the orbit centre, and a **fly mode** for walking
  inside a building.
- A **mobile** layout: bottom-sheet panel, two-finger pan and pinch, an azimuth chosen so the
  cloud's long axis runs along the screen's long axis.

### Editing

- **Regions**: box, sphere, slab and prism, added to a list and applied only when you say so.
  Placed by pointing at a thing and grown or fitted to what they hold, rather than drawn.
- **Crop both ways** — keep what is inside, or remove it — with the preview dimming whichever
  half is going, and the confirmation counting both sides.
- **Undo and redo** for every destructive step, spilling to private browser storage so undoing
  a crop of 70M points does not need a second copy in memory.
- **Save as** writes what is in memory, crop and transform included, and never touches the
  original.

### Analysis

- **Normals**: estimated from neighbourhoods, propagated breadth-first, and oriented toward the
  scan's own station positions per point — which is the only orientation that is right for
  something scanned from the inside.
- **Scalar fields** from curvature, planarity, verticality, roughness, density and more, with a
  ramp, a histogram and a value filter.
- **Cleaning**: statistical outlier removal, a local-surface noise filter, duplicate removal and
  spatial subsampling.
- **Connected components**, so a cluster can be isolated and kept or dropped.
- **Fit primitives** — plane, sphere, cylinder, circle — each reporting an RMS, because a
  cylinder fitted to a flat wall has a radius and an axis and means nothing without one.
  Validated to 0.008° on a plane normal, 0.01 mm on a sphere, 0.0000° on a cylinder axis.
- **RANSAC shape detection** that removes each shape's inliers before looking for the next,
  which is also the non-maximum suppression.

### Surfaces and meshes

- **Surface reconstruction** from oriented points into a triangle mesh, with a hole ratio so
  you can tell whether the result is worth measuring.
- **Meshes as layers**, every visible one drawn: area and volume through the layer's transform
  with the boundary-edge count beside them (a unit cube reads 6.000 m² and 1.000 m³),
  area-weighted **point sampling** into a new layer, **cloud-to-mesh distance** as a scalar
  field (point-to-triangle, 249.96–250.64 mm on a known 250 mm offset), **flip**, **Taubin
  smoothing** (+0.12% volume over ten passes, against −1.98% for plain Laplacian) and
  **decimation** by quadric vertex clustering.

### Rasters, contours and volumes

- **Height models** over a regular grid along any axis, draped over the cloud so they can be
  judged, and exported as PNG with a **world file**.
- **Contours** at an interval by marching squares with the crossing interpolated along each
  edge, exported as **DXF** or **GeoJSON** in the global frame.
- **2.5D volumes** against another layer or a flat plane, cut and fill reported separately:
  **64.202 m³ against an arithmetic 64.274 m³, −0.11%**.

### Layers and registration

- **More than one cloud open at once**, every visible one drawn, exactly one active.
- **Registration**: match centres, match scales, and point-to-plane **ICP** reporting
  per-iteration RMS, overlap and the matrix. Recovers a known offset to 0.000 mm / 0.0000°.
- **Cloud-to-cloud distance** as a scalar field, signed against the reference's own normals.
- **Merge**, **clone** and **tint**.

### Transforms

- A cloud carries a 4×4 matrix applied at render, test, analysis and export time. **Nothing is
  ever baked** except into a written file, so a transform is instant, lossless and undoable.
- Move, rotate, scale, **level** (fit a plane to a sample and make it horizontal) and reset,
  from the panel, a drag gizmo, or an agent.

### The agent interface

- **30 MCP tools** over a localhost bridge, and a **calibrated modelling kit**: orthographic
  views whose pixel-to-metre mapping is exact, `probe` to turn any pixel of a past render back
  into a world point, sections, contours, plane fits with residuals, height maps, exact
  point-in-box counts, and a `recommendedSource` that says whether to measure the points or the
  surface and why.
- A **hosted HTTP session** for driving a browser tab from anywhere: opt-in, bearer token,
  read-only by default, revoked when the tab closes.
- **Scripts**: a list of `{cmd, args}` steps run in order with each step's result available to
  the next, because the round trip is the expensive part and most steps are decided entirely by
  the previous answer.
- **`llms.txt`** describing the whole surface, with worked examples.

### The desktop app

- **Tauri v2**, 4.7 MB, working with no network at all: no analytics, no web fonts, and 458 KB
  of Firestore client resolved away rather than merely not called.
- Files open **by path** — Finder drops, a File menu with Open Recent, `e57view scan.e57` — and
  exports go through **native Save dialogs**.
- **MCP built in**: `e57view --mcp` speaks MCP on stdio with no Node and no install, from the
  same `mcp/tools.json` the web server reads, so the two cannot drift.
- On a 3.23 GB, 73.8M-point E57: **13.0 s to open by path, 82 MB resident, 1.1 s to cache,
  0.7 s to reopen from that cache**.

### Removed

- **AI-assisted cleaning** and **cloud upload**, both of which existed early on. A viewer that
  uploads your scan to a third party is a different product with a different threat model, and
  the cleaning was better served by the deterministic filters above. The agent interface, which
  those were built alongside, stayed.
