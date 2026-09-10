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

## Tools

- **Crop** — a box or sphere you drag around with a gizmo (arrows move it, handles resize it),
  or place on the orbit centre and size with sliders. Outside points are dimmed in preview or
  hidden. *Apply crop* asks for confirmation, then drops outside points from memory. The file
  on disk is never touched; *Reload* brings everything back.
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
- **View link** — copies a URL that restores the camera and colour mode when the same file
  is opened again.

## Round four

- **Crop rotation and slabs.** The crop region is now a box, sphere or slab with its own
  orientation: Move / Rotate / Resize with the gizmo. A slab is a section plane with
  thickness, infinite in its own plane, so tilted cuts are one drag away.
- **Sections.** Add as many slabs as you like (floors, a corridor, a wall). Points inside
  *any* section are kept; Apply crop drops the rest. Sections and the crop box share the
  same keep rule.
- **AI clean.** Three providers behind one button. *Local heuristic* finds vegetation from
  colour and surface chaos on a metre grid of the cloud in under a second, no network.
  *OpenAI* and *Grok* run a hybrid: the heuristic's clumps become numbered candidates drawn
  on a clean top-down render with a labelled 10 m grid, each candidate also gets an oblique
  close-up with its box drawn, and the model confirms or rejects each one (a box on a roof
  or a playground canopy is rejected), names it, may add boxes the detector missed (cars,
  overexposed canopies) and may propose height sections. Added boxes are snapped to the
  data — vegetation cells first, then rough-and-tall cells, else the model's footprint
  trimmed to occupied cells — so boxes stay tight; the model supplies judgement, never
  geometry. Every suggestion appears as a tinted box with ✓ / ✗ in the view and in a list;
  approve or decline individually or all at once, adjust any box with the gizmo, then
  *Apply approved* removes those points after a confirmation. Defaults are `gpt-5.5` and
  `grok-4.3`; type any model name in the field. Keys live in Firebase secrets
  (`OPENAI_API_KEY`, `XAI_API_KEY`); a key pasted in the panel is used directly from the
  browser instead.
- **PLY and LAS import.** Scans from phone LiDAR apps open directly; they get the same
  cells, cache and tools as E57.
- **Cloud mode.** Switch it on, upload a scan once, and it is converted on the server into
  the same cell format the local cache uses. Anyone with the link streams it: a uniform
  prefix of every cell first, then the cells the camera is looking at are refined by HTTP
  range requests. No file on the viewer's device, no rendering server.
- **Agent link + MCP server.** `mcp/server.mjs` exposes the viewer to AI agents (Claude
  Code, Claude Desktop, Cursor…): state, screenshots, camera, settings, regions, measure,
  export to a local path, AI suggestions, stations. Switch on *Agent link* in the panel
  (or open with `?agent=1`); the server relays over a localhost WebSocket.
- **iPhone and iPad.** A touch toolbar (Orbit / Fly / Measure / Crop / Leave photo), an
  on-screen joystick for fly mode, a larger gizmo, and a *Scan with this device* card.

### About LiDAR capture on iPhone and iPad

Safari has no access to the LiDAR sensor and no WebXR depth on iOS, so a web page cannot
capture a scan. What works: capture in Scaniverse, Polycam or 3D Scanner App, export PLY,
LAS or E57, and open it here — the importers above exist for exactly that. The project's
native OpenSketch iOS app could add an ARKit capture that writes E57 or PLY to Files; the
web app would open it unchanged.

### Cloud architecture

```
browser ── Firebase Storage upload ──► uploads/{uid}/{id}/file
                                             │ finalize trigger
                                        convertCloud (Cloud Functions gen2, 16 GiB, 4 vCPU)
                                             │ same WebAssembly decoder as the browser
                                        clouds/{id}/cells.bin + meta.json
                                             │ HTTP range requests (tokened URLs)
viewer ◄── prefix of every cell, then refinement of visible cells
```

Conversion runs once per upload and is billed for its runtime only; serving is static
storage egress; the viewer's GPU does the rendering. Pixel streaming was rejected: it
needs always-on GPU servers and gets worse with every extra viewer.

### Setting the AI keys

```sh
firebase functions:secrets:set OPENAI_API_KEY --project opensketch
firebase functions:secrets:set XAI_API_KEY --project opensketch
firebase deploy --only functions --project opensketch
```

Both currently hold the placeholder `unset`, which the function reports as "not set".
`functions/.env.example` documents them for local emulation; do not put the real names in
`functions/.env` — an env var with a secret's name blocks the deploy.

### MCP setup

```sh
cd mcp && npm install
claude mcp add e57view -- node /absolute/path/to/e57view/mcp/server.mjs
```

Then open https://opensketch.web.app/?agent=1 in Chrome on the same machine. Chrome will
ask once whether the site may access devices on your local network: that is the bridge
on `127.0.0.1:7337` — allow it. (Automated browsers cannot answer that prompt, which is why
the production run of the test shows the link as off; on the http dev server no prompt
is needed.)

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

No parallel decode. No undo for a crop other than reloading. No multi-scan visibility
toggles (the test file is one registered scan). No angle or area measurement.

## Deploy

```sh
npm run build
firebase deploy --only hosting --project opensketch
```

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
