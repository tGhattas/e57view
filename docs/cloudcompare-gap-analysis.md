<!-- SPDX-License-Identifier: GPL-3.0-only -->
# What CloudCompare does that e57view does not

A capability audit, read from the source rather than from memory. The CloudCompare side comes
from a shallow clone of its master branch in September 2026: `qCC/ui_templates/mainWindow.ui`
parsed as a menu tree (235 actions), the `windowTitle` of every `.ui` dialog in the
application and its plugins, the `plugins/core/Standard` and `plugins/core/IO` directories,
the registered file format filters, and 218 command line constants. **Nothing here is inferred
from the name of a thing.**

The e57view side is kept current as things get built. Regenerate with
`node tools/gap-analysis.mjs`; the statuses live in that script so the counts cannot disagree
with the tables.

| | |
|---:|---|
| **190** | capabilities compared |
| **64** | covered |
| **48** | partial, or different in a way the note explains |
| **78** | missing outright |

## Where the remaining distance is

Five structural gaps were named when this audit was first written. Four have since closed:
several clouds at once, scalar fields, computing and orienting normals, and moving the cloud.
The fifth turned into something deliberately different. An outline drawn on screen becomes a
**prism region** you can orbit around and adjust rather than a one-shot screen-space cut,
because a cut you cannot inspect from another angle is the thing users kept getting wrong.

What is left divides into four honest groups.

**1. The data model stops at clouds and meshes.** CloudCompare holds a tree of entities,
including polylines, sensors, labels, primitives and viewports, that can be saved together as a
project.
e57view has layers of points and layers of triangles, and nothing that holds them together on
disk. A project file is the single biggest missing thing, and most of the "no" rows about
polylines and labels follow from it.

**2. There is no headless mode.** Everything is driven through a live window. The `script`
command batches work and an agent can automate the whole surface, but there is no
`e57view --load x.e57 --sor --save y.las` that runs without a display. CloudCompare's 218
command line constants are a genuine product in their own right.

**3. The domain plugins are absent entirely.** Forest inventory, masonry segmentation,
granulometry, structural geology, classifier training. Each is a research group's work
packaged as a plugin, and none of it is a weekend.

**4. A long tail of formats and conveniences.** Colour levels, field arithmetic, stereo
display, multiple viewports, the more exotic file formats. Individually small; collectively
what twenty years looks like.

## Everything, by category

Legend: **Have**, **Partial** (the note says exactly what differs), **Missing**.

### Session and data model

<sub>3 have · 4 partial · 3 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Multiple entities open at once | **Have** | Layers, every visible one drawn, exactly one active. |
| Per-entity visibility and property toggles | **Partial** | Visibility and a colour tint per layer. Colour mode, point size and the scalar-field display are global. |
| Clone an entity | **Have** | none |
| Merge clouds | **Have** | Through each layer's own transform, so the geometry on screen is the geometry that lands. |
| Save a project file | **Missing** | The on-device cache stores one scan's decoded cells; there is no file holding several layers, their transforms and the camera. |
| Create a cloud from picked points, paste from clipboard | **Partial** | Sampling a mesh makes a new point layer; there is no picking or pasting into one. |
| Select children by type or name | **Missing** | none |
| Global shift and scale, user editable | **Partial** | The shift is subtracted automatically on load and reported by the agent as `translation`; it is not editable in the panel. |
| Octree as a user-visible object | **Partial** | Internal to the renderer and the analyser. CloudCompare exposes compute and resample, and other tools consume it. |
| Kd-tree | **Missing** | none |

### File formats

<sub>5 have · 6 partial · 8 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| E57 read and write | **Have** | A columnar decoder written for this project, plus the Rust e57 writer. Round-trips bit-exact. |
| PLY read and write | **Have** | Points and meshes, ASCII and both binary orders. |
| LAS read and write | **Partial** | Reads 1.2 to 1.4 uncompressed; writes 1.2 point format 2. |
| LAZ, compressed LAS | **Have** | laz-rs compiled to WebAssembly, streamed through the ranged-read shim, so a multi-gigabyte LAZ never enters wasm memory whole. Read and write. |
| COPC cloud optimised point cloud | **Partial** | Reads as ordinary LAZ. The spatial index is not used, so there is no level-of-detail streaming from it. |
| LAS full waveform (FWF) | **Missing** | Including a 2D waveform viewer and FWF compression. |
| PTX and PTS structured scans | **Have** | PTX becomes one cloud with each scan's own transform applied and each scan a station. PTS reads through the text importer. |
| ASCII import with column mapping | **Have** | txt, asc, neu, xyz, pts, csv, sniffed for delimiter and columns and confirmed over the first rows. |
| Mesh formats in (OBJ, STL, OFF, VTK, FBX, Maya) | **Partial** | PLY, OBJ and STL open as mesh layers. The rest do not. |
| Mesh formats out | **Partial** | PLY, OBJ and STL, for any mesh layer including a reconstructed surface. No FBX, VTK or OFF. |
| DXF and SHP vector | **Partial** | Contours export as DXF LWPOLYLINE and as GeoJSON. Nothing vector is read, and there is no SHP. |
| Draco compressed (.drc) | **Missing** | none |
| RIEGL RDBX, plus match and plane patch files | **Missing** | none |
| PCD via the Point Cloud Library | **Missing** | none |
| STEP CAD import | **Missing** | none |
| Photogrammetry projects (Photoscan PSZ, Bundler) | **Missing** | none |
| Native binary formats (BIN, SBF) | **Missing** | none |
| Raster grids in and out | **Partial** | A height model exports as a PNG with its world file. No GeoTIFF, no ASC, and no raster import. |
| Depth map, ICM, POV, PN, PV, SOI, Sinusx, Mascaret | **Missing** | A long tail of survey and research formats. |

### Viewing and rendering

<sub>4 have · 7 partial · 7 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Eye-dome lighting | **Have** | Both have it. Ours has a same-surface tolerance, so close-ups do not ring. |
| Bubble view from a scanner station | **Have** | Both have it. Ours blends the E57 panorama with the points. |
| Cursor coordinate readout | **Have** | none |
| Frame rate test | **Have** | Internal, used by the drivers. |
| Sun light and a positionable custom light | **Missing** | none |
| Ambient occlusion | **Missing** | CloudCompare has qPCV and an SSAO option. |
| Materials and textures on meshes | **Missing** | Mesh layers carry vertex colours only. |
| Multiple 3D views, tiled or cascaded | **Missing** | none |
| Camera link between views | **Missing** | none |
| Stereo display | **Missing** | Anaglyph, side by side and NVIDIA Vision. |
| Render to a file at a chosen resolution | **Partial** | The agent renders at any width with an exact pixel-to-metre mapping. The panel has no render-to-file button. |
| Save a viewport as an object | **Partial** | A view link restores the camera and colour mode; it is a URL, not an entity. |
| Colour scale manager and custom ramps | **Partial** | One ramp, with the display range and a value filter. No manager, no custom scales, no scale bar in the view. |
| Orthographic projection | **Partial** | Every agent view and section is truly orthographic with a calibrated mapping. The panel camera is perspective. |
| Lock rotation about an axis | **Missing** | none |
| Preset views and precise zoom | **Partial** | Fit and top down in the panel; the agent can set an exact pose or an orbit. No front, side or isometric buttons. |
| Full screen | **Partial** | In the desktop app's View menu. Not in the browser build. |
| Clipping planes | **Partial** | Height clipping and crop volumes. No arbitrary plane you can toggle. |

### Selection and segmentation

<sub>6 have · 2 partial · 5 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Crop to a box or sphere | **Have** | With rotation, as CloudCompare's clipping box also has. |
| Section and slab cuts | **Have** | Any number, unioned. |
| Delete points inside a region | **Have** | Keep inside and Remove inside, with the preview dimming whichever half is going. |
| Freehand polygon segmentation | **Have** | An outline becomes a *prism*, a real 3D region you can orbit around and adjust, rather than a one-shot screen-space cut. |
| Clipping box with repeated slices | **Partial** | No repeat, no slice series generation. |
| Extract sections along a polyline, and unfold | **Missing** | none |
| Label connected components | **Have** | Written as a scalar field, so one cluster can be isolated with the value filter. |
| K-means clustering | **Missing** | none |
| Front propagation segmentation | **Missing** | none |
| Filter points by scalar value | **Have** | With a live count, and Delete points outside as one undoable step. |
| Colour based segmentation | **Missing** | qColorimetricSegmenter picks two colours and a tolerance. |
| Manual classification into layers | **Partial** | A LAS or LAZ classification is read as a scalar field. There is no painting classes by hand. |
| Virtual broom cleaning | **Missing** | qBroom sweeps a surface to remove what sits above it. |

### Editing and transformation

<sub>6 have · 3 partial · 1 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Undo and redo of destructive edits | **Have** | With disk spill for large steps. CloudCompare defines no undo action. |
| Apply a 4x4 transformation matrix | **Have** | Never baked: the cloud carries the matrix and every consumer reads through it, so it is instant, lossless and undoable. |
| Interactive translate and rotate of the cloud | **Have** | A drag gizmo on the cloud itself. |
| Scale and multiply | **Partial** | Uniform scale about the box centre or the origin. No per-axis multiply. |
| Level, make horizontal | **Have** | Fits a plane to a sample and turns it horizontal. |
| Move bounding box centre, min or max to the origin | **Partial** | Translate by an exact vector, which does it in one step, but there is no button for the three cases. |
| Subsample a cloud | **Have** | Spatial subsampling to a spacing, as an undoable edit; plus striding at load and at export. |
| Remove duplicate points | **Have** | To a tolerance. |
| Shift points along their normals | **Missing** | none |
| Primitive factory | **Partial** | A fitted plane, sphere, cylinder or circle is drawn in the view; it does not become an entity you can save or measure against. |

### Scalar fields

<sub>2 have · 7 partial · 6 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Arbitrary named scalar fields per point | **Partial** | One named field per layer at a time. CloudCompare holds many at once and switches between them. |
| Scalar field manager, rename, delete | **Partial** | Clear, and replace by computing another. No manager. |
| Histogram of a field | **Have** | With the display range and the filter range drawn on it. |
| Statistical parameters of a field | **Partial** | Minimum, maximum and how many points carry a value. No mean, variance or percentile report. |
| Gradient of a field | **Missing** | none |
| Gaussian and bilateral filtering of a field | **Missing** | none |
| Filter by value into a new cloud | **Have** | Delete points outside the range, undoably. |
| Field arithmetic | **Missing** | Add, subtract, multiply between fields. |
| Convert field to RGB, and RGB to field | **Missing** | Including random RGB per integer value. |
| Add constant, classification or point index fields | **Partial** | Classification, from LAS and LAZ. No constant or index field. |
| Coordinates to fields, and fields to coordinates | **Missing** | none |
| Normals to fields, and fields to normals | **Missing** | none |
| Interpolate a field from another entity | **Partial** | Distance to another layer, and distance to a mesh, are written as fields. There is no general interpolation of an existing field across entities. |
| Split a cloud by integer field value | **Partial** | Filter to one value and keep. It does not produce several clouds at once. |
| Colour scales bound to a field | **Partial** | One ramp over the field's range. |

### Colours

<sub>3 have · 2 partial · 7 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Brightness and gamma | **Have** | none |
| Intensity range mapping | **Have** | With a percentile auto-range. |
| Height ramp | **Partial** | An elevation colour mode with a fixed ramp. |
| Set a unique colour | **Partial** | A per-layer tint multiplier, for telling two overlapping scans apart. |
| Colorize, apply a hue while keeping luminance | **Missing** | none |
| Colour levels | **Missing** | Input and output level adjustment per channel. |
| Convert to greyscale | **Missing** | none |
| Colour to scalar field | **Missing** | none |
| Enhance colours with intensities | **Have** | The RGB x intensity colour mode. |
| Colour filters | **Missing** | Bilateral, Gaussian, mean and median. |
| Interpolate colours from another entity | **Missing** | none |
| Clear colours | **Missing** | none |

### Normals

<sub>3 have · 3 partial · 3 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Read normals from the file | **Have** | The libE57 nor extension, plus PLY and LAS. |
| Compute normals from a neighbourhood | **Have** | Plane fit over k nearest neighbours, in a worker over the whole cloud. |
| Orient normals with a minimum spanning tree | **Partial** | Breadth-first propagation through the neighbour graph, then a per-point decision to face the nearest scanner station, which is the orientation that is right for anything scanned from the inside. It is not an MST. |
| Orient normals with fast marching | **Missing** | none |
| Hough transform normals | **Missing** | qHoughNormals. |
| Invert normals | **Have** | none |
| Normals to dip and dip direction | **Partial** | A fitted plane reports dip and dip direction in degrees. Not written per point as a field. |
| Normals to HSV colours | **Partial** | A normal-shading colour mode. Not a stored colour. |
| Display normals as lines | **Missing** | none |

### Measurement and inspection

<sub>6 have · 2 partial · 2 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Distance between two picked points | **Have** | With the height difference and the horizontal component. |
| Coordinate readout at a picked point | **Have** | Local and global. |
| Persistent point labels | **Partial** | Measurements persist in a list for the session; they are not saved entities. |
| Point list picking | **Missing** | Build and export a table of picked points. |
| Measure a mesh surface area | **Have** | Through the layer's transform. A unit cube reads 6.000 m2. |
| Measure a mesh volume | **Have** | With the boundary edge count beside it, because an open mesh's divergence sum is not an enclosed volume. A unit cube reads 1.000 m3. |
| 2.5D volume between two surfaces | **Have** | Cut and fill reported separately. Measured against arithmetic: 64.202 m3 against 64.274, -0.11%. |
| Geometric features | **Have** | Fifteen: roughness, curvature, planarity, linearity, sphericity, anisotropy, omnivariance, eigenentropy, verticality, volume and surface density, neighbour count and the three eigenvalues. |
| Local statistical test | **Missing** | none |
| Batch export of cloud and plane info | **Partial** | The agent's `state` and `fit` return exactly this as JSON. There is no batch file writer. |

### Registration and alignment

<sub>4 have · 2 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Fine registration by ICP | **Have** | Point-to-plane, rotating about the centroid, reporting per-iteration RMS, overlap, pairs and the matrix. Recovers a known offset to 0.000 mm / 0.0000 degrees. |
| Align by picking point pairs | **Missing** | none |
| Match bounding box centres | **Have** | none |
| Match scales | **Have** | From boxes measured the same way on both layers, which is the detail that decides whether the number means anything. |
| Automatic cloud alignment | **Missing** | No feature-based global registration. |
| Best registration RMS matrix | **Have** | ICP reports it. |

### Comparison and distances

<sub>2 have · 1 partial · 5 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Cloud to cloud distance | **Have** | Written as a scalar field, optionally signed along the reference's own normals. |
| Cloud to mesh distance | **Have** | Point-to-triangle through a triangle grid, not point-to-nearest-vertex. 249.96 to 250.64 mm on a known 250 mm offset. |
| Cloud to primitive distance | **Missing** | none |
| Closest point set | **Missing** | none |
| M3C2 multiscale change detection | **Partial** | The signed variant projects onto the reference point's own normal, which is the part of M3C2 that stops settlement and heave cancelling. It is not multiscale and has no confidence interval. |
| Volumetric change between meshes | **Missing** | qVoxFall, for rockfall volumes. |
| Comparison against a surface of revolution | **Missing** | qSRA, with 2D distance maps and DXF profiles. |
| Distance maps and distance to a best fit quadric | **Missing** | none |

### Meshing and surfaces

<sub>5 have · 3 partial · 7 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Surface reconstruction from points | **Partial** | A truncated signed distance field with surface nets. CloudCompare uses screened Poisson, which fills gaps more aggressively and takes a depth rather than a voxel size. |
| Laplacian style mesh smoothing | **Have** | Taubin by default on any mesh layer, imported or reconstructed: +0.12% volume over ten passes, against -1.98% for plain Laplacian. |
| Export a mesh | **Have** | PLY, OBJ or STL, with the layer transform and the global shift baked in. |
| Delaunay 2.5D triangulation | **Missing** | On the XY plane or a best fitting plane. |
| Mesh from scan grids | **Missing** | Uses the acquisition grid of a structured scan. |
| Surface between two polylines | **Missing** | none |
| Subdivide a mesh | **Missing** | none |
| Flip triangles | **Have** | none |
| Sample points on a mesh | **Have** | Area-weighted, by count or by density, with interpolated normals and colours, into a new point layer. |
| Convert texture or material to per-vertex RGB | **Missing** | none |
| Flag vertices by type | **Partial** | Boundary and non-manifold edges are counted and reported; they are not flagged per vertex. |
| Boolean CSG operations on meshes | **Missing** | qCork and a libIGL based alternative. |
| Moving least squares smoothing and reconstruction | **Missing** | Through the PCL wrapper. |
| Measure and report mesh quality | **Partial** | Boundary edges, non-manifold edges, zero-area triangles and whether the mesh is closed. |
| Decimate a mesh | **Have** | Quadric vertex clustering: linear and fast, but it takes a cell size rather than a triangle target. |

### Fitting and shape detection

<sub>4 have · 2 partial · 4 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Fit a plane | **Have** | With RMS, worst distance, dip and dip direction. Normal to 0.008 degrees on a fixture. |
| Fit a sphere | **Have** | Algebraic then Gauss-Newton. Centre and radius to 0.01 mm. |
| Fit a circle | **Have** | none |
| Fit a cylinder | **Have** | Axis from the normal set's least-variance direction, which is what makes it hold on a partial arc. 0.0000 degrees off the axis on a fixture. |
| Fit a 2D polygon facet | **Missing** | none |
| Fit a 2.5D quadric | **Missing** | none |
| RANSAC shape detection | **Partial** | Planes, spheres and cylinders, with inlier removal as the non-maximum suppression. No cones or tori. |
| Promote a circle to a cylinder | **Missing** | none |
| Bounding box PCA fit | **Missing** | none |
| Plane properties, compare and flip | **Partial** | A fit reports its plane fully; there is no comparison between two of them. |

### Rasterisation, grids and volume

<sub>3 have · 2 partial · 1 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Rasterize to a grid | **Have** | Highest, lowest, mean, point density or the mean of a scalar field, along any axis, draped over the cloud so it can be judged. |
| Contour plot to polylines and to mesh | **Partial** | Polylines, traced by marching squares with the crossing interpolated along each edge, out as DXF or GeoJSON. Not to a mesh. |
| Interpolate empty cells | **Have** | Nearest value or inverse distance, capped in reach so a hole is not filled from the far side of the site. |
| Raster and DEM export | **Partial** | PNG with a world file. No GeoTIFF or ASC. |
| 2.5D volume calculation | **Have** | Against another layer or a flat plane, cut and fill separately. |
| Unroll a cylinder or cone | **Missing** | Also straightened unrolling, used on tunnels and tanks. |

### Cleaning and filtering

<sub>4 have · 2 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Manual removal inside a volume | **Have** | Box, sphere, slab or prism, with undo. |
| Statistical outlier removal | **Have** | On neighbour distance statistics, reporting the mean and the cut-off it used. |
| Noise filter relative to a fitted surface | **Have** | none |
| Remove duplicate points | **Have** | none |
| Cloth simulation ground filter | **Missing** | qCSF, the standard ground and off-ground split. |
| Hidden point removal | **Missing** | qHPR, approximate visibility from a viewpoint. |

### Classification and domain tools

<sub>1 partial · 9 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| CANUPO classifier, train and apply | **Missing** | Multiscale dimensionality, trained in the GUI. |
| 3DMASC classifier | **Missing** | Multiple attributes, scales and clouds, usable without programming. |
| Masonry segmentation | **Missing** | Splits a dense scan of a wall into individual stones. |
| TreeIso individual tree isolation | **Missing** | Unsupervised segmentation of single trees from TLS. |
| 3DFin forest inventory | **Missing** | Tree height, diameter at breast height and stem location. |
| G3Point granulometry | **Missing** | Segments and measures grains and gravel. |
| Facet and fracture detection | **Missing** | qFacets, with a stereogram and facet export. |
| Structural geology compass | **Missing** | qCompass, for outcrop orientation measurement. |
| Normal distance to a defined plane | **Partial** | A fitted plane gives the plane; the per-point distance to it is not written as a field. |
| Animation from a series of viewpoints | **Missing** | qAnimation renders a movie. |

### Sensors

<sub>1 have · 2 partial · 5 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Panorama imagery from the file | **Have** | E57 spherical images, shown as bubbles. |
| Stand at a scanner position | **Partial** | Enter the panorama. CloudCompare models the sensor and can render the view from it. |
| TLS and GBL sensor model | **Partial** | Station positions are read and used, to orient normals outward per point, but there is no editable sensor object. |
| Depth buffer create, show, export | **Missing** | none |
| Point visibility from a sensor | **Missing** | Using the depth buffer or the octree. |
| Camera sensor and uncertainty projection | **Missing** | none |
| Compute ranges from a sensor | **Missing** | none |
| Compute scattering angles | **Missing** | none |

### Automation

<sub>3 have · 1 partial · 1 missing</sub>

| Capability in CloudCompare | e57view | Note |
|---|---|---|
| Drive the application from outside | **Have** | Thirty MCP tools over a localhost bridge, plus a tokened HTTP session that drives a live tab from anywhere. CloudCompare has a JSON-RPC plugin. |
| Headless command line batch processing | **Missing** | 218 command constants: load, subsample, distances, ICP, normals, rasterize, filters, export format control, auto-save. Ours always drives a live window. |
| Command files and scripting | **Have** | A `script` runs a list of steps in order with each step's result available to the next, from an agent or from the panel. |
| Per-format export options in batch | **Partial** | Format and stride. No per-format option set. |
| A calibrated interface for measuring from renders | **Have** | Not in CloudCompare: an orthographic view comes back with the mapping that turns any of its pixels into a world point, and `probe` re-establishes that render's camera to answer exactly later. |

## What e57view has that CloudCompare does not

Short, and worth being honest about. CloudCompare also has eye-dome lighting, bubble views from
a scanner position, and a JSON-RPC remote control plugin, so none of those are ours alone.

- **It runs in a browser with nothing installed and nothing uploaded.** The file is read off the
  local disk by a WebAssembly decoder. This is the whole product, and CloudCompare has no
  equivalent.
- **It opens a 3.23 GB E57 in about 13 seconds** with no import or conversion step, and caches
  the decoded cells so the next open takes about a second.
- **A desktop build that is 4.7 MB and opens no network connection at all.** Same code, same
  renderer, with files by path and MCP served from the binary.
- **Touch interface for iPhone and iPad**, including a bottom sheet and a larger gizmo.
- **Undo and redo for destructive edits**, spilling large steps to disk. CloudCompare's menu
  defines no undo action at all; its model avoids needing one by creating new entities instead
  of modifying existing ones.
- **An interface built for AI agents rather than adapted for one**: calibrated orthographic
  renders that come with the mapping from pixel to metre, a `probe` that re-establishes a past
  render's camera to answer exactly, a `recommendedSource` that says whether to measure the
  points or the surface and why, and scripts that batch a plan into one round trip.
- **Shareable view links** that restore the camera and colour mode.

## How this was compiled, and what it does not cover

Nine CloudCompare plugins are git submodules that a shallow clone does not fetch: cc3DFin,
q3DMASC, qColorimetricSegmenter, qG3Point, qJSonRPCPlugin, qMPlane, qMasonry, qTreeIso and
qVoxFall. Their directories were empty, so what they do was taken from CloudCompare's own
changelog and documentation rather than from reading their code.

Not covered: the ccViewer companion application, Qt and OpenGL internals, anything behind a
build flag that was not compiled, and the exact behaviour of plugins whose source was not
fetched. Where a capability is marked partial, the note says precisely what differs rather than
implying a near match.

- <https://github.com/CloudCompare/CloudCompare>
- <https://www.cloudcompare.org/doc/wiki/index.php/Plugins>
