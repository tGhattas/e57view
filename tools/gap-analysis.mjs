// SPDX-License-Identifier: GPL-3.0-only
// Regenerate docs/cloudcompare-gap-analysis.md.
//
// The data below is a capability audit of CloudCompare read from its source in September 2026
// the menu tree, every dialog title, the plugin directories, the registered format filters
// and the command line constants. e57view's status against each row is kept current as
// things get built. It lives in a script rather than in the Markdown so that updating a status
// is one word in one place and the counts at the top cannot disagree with the tables.
import { writeFileSync } from 'node:fs';

// status: 'yes' | 'part' | 'no'.  The note says what differs, precisely, rather than implying
// a near match.
const D = [
["Session and data model", [
 ["Multiple entities open at once", "yes", "Layers, every visible one drawn, exactly one active."],
 ["Per-entity visibility and property toggles", "part", "Visibility and a colour tint per layer. Colour mode, point size and the scalar-field display are global."],
 ["Clone an entity", "yes", ""],
 ["Merge clouds", "yes", "Through each layer's own transform, so the geometry on screen is the geometry that lands."],
 ["Save a project file", "no", "The on-device cache stores one scan's decoded cells; there is no file holding several layers, their transforms and the camera."],
 ["Create a cloud from picked points, paste from clipboard", "part", "Sampling a mesh makes a new point layer; there is no picking or pasting into one."],
 ["Select children by type or name", "no", ""],
 ["Global shift and scale, user editable", "part", "The shift is subtracted automatically on load and reported by the agent as `translation`; it is not editable in the panel."],
 ["Octree as a user-visible object", "part", "Internal to the renderer and the analyser. CloudCompare exposes compute and resample, and other tools consume it."],
 ["Kd-tree", "no", ""],
]],
["File formats", [
 ["E57 read and write", "yes", "A columnar decoder written for this project, plus the Rust e57 writer. Round-trips bit-exact."],
 ["PLY read and write", "yes", "Points and meshes, ASCII and both binary orders."],
 ["LAS read and write", "part", "Reads 1.2 to 1.4 uncompressed; writes 1.2 point format 2."],
 ["LAZ, compressed LAS", "yes", "laz-rs compiled to WebAssembly, streamed through the ranged-read shim, so a multi-gigabyte LAZ never enters wasm memory whole. Read and write."],
 ["COPC cloud optimised point cloud", "part", "Reads as ordinary LAZ. The spatial index is not used, so there is no level-of-detail streaming from it."],
 ["LAS full waveform (FWF)", "no", "Including a 2D waveform viewer and FWF compression."],
 ["PTX and PTS structured scans", "yes", "PTX becomes one cloud with each scan's own transform applied and each scan a station. PTS reads through the text importer."],
 ["ASCII import with column mapping", "yes", "txt, asc, neu, xyz, pts, csv, sniffed for delimiter and columns and confirmed over the first rows."],
 ["Mesh formats in (OBJ, STL, OFF, VTK, FBX, Maya)", "part", "PLY, OBJ and STL open as mesh layers. The rest do not."],
 ["Mesh formats out", "part", "PLY, OBJ and STL, for any mesh layer including a reconstructed surface. No FBX, VTK or OFF."],
 ["DXF and SHP vector", "part", "Contours export as DXF LWPOLYLINE and as GeoJSON. Nothing vector is read, and there is no SHP."],
 ["Draco compressed (.drc)", "no", ""],
 ["RIEGL RDBX, plus match and plane patch files", "no", ""],
 ["PCD via the Point Cloud Library", "no", ""],
 ["STEP CAD import", "no", ""],
 ["Photogrammetry projects (Photoscan PSZ, Bundler)", "no", ""],
 ["Native binary formats (BIN, SBF)", "no", ""],
 ["Raster grids in and out", "part", "A height model exports as a PNG with its world file. No GeoTIFF, no ASC, and no raster import."],
 ["Depth map, ICM, POV, PN, PV, SOI, Sinusx, Mascaret", "no", "A long tail of survey and research formats."],
]],
["Viewing and rendering", [
 ["Eye-dome lighting", "yes", "Both have it. Ours has a same-surface tolerance, so close-ups do not ring."],
 ["Bubble view from a scanner station", "yes", "Both have it. Ours blends the E57 panorama with the points."],
 ["Cursor coordinate readout", "yes", ""],
 ["Frame rate test", "yes", "Internal, used by the drivers."],
 ["Sun light and a positionable custom light", "no", ""],
 ["Ambient occlusion", "no", "CloudCompare has qPCV and an SSAO option."],
 ["Materials and textures on meshes", "no", "Mesh layers carry vertex colours only."],
 ["Multiple 3D views, tiled or cascaded", "no", ""],
 ["Camera link between views", "no", ""],
 ["Stereo display", "no", "Anaglyph, side by side and NVIDIA Vision."],
 ["Render to a file at a chosen resolution", "part", "The agent renders at any width with an exact pixel-to-metre mapping. The panel has no render-to-file button."],
 ["Save a viewport as an object", "part", "A view link restores the camera and colour mode; it is a URL, not an entity."],
 ["Colour scale manager and custom ramps", "part", "One ramp, with the display range and a value filter. No manager, no custom scales, no scale bar in the view."],
 ["Orthographic projection", "part", "Every agent view and section is truly orthographic with a calibrated mapping. The panel camera is perspective."],
 ["Lock rotation about an axis", "no", ""],
 ["Preset views and precise zoom", "part", "Fit and top down in the panel; the agent can set an exact pose or an orbit. No front, side or isometric buttons."],
 ["Full screen", "part", "In the desktop app's View menu. Not in the browser build."],
 ["Clipping planes", "part", "Height clipping and crop volumes. No arbitrary plane you can toggle."],
]],
["Selection and segmentation", [
 ["Crop to a box or sphere", "yes", "With rotation, as CloudCompare's clipping box also has."],
 ["Section and slab cuts", "yes", "Any number, unioned."],
 ["Delete points inside a region", "yes", "Keep inside and Remove inside, with the preview dimming whichever half is going."],
 ["Freehand polygon segmentation", "yes", "An outline becomes a *prism*, a real 3D region you can orbit around and adjust, rather than a one-shot screen-space cut."],
 ["Clipping box with repeated slices", "part", "No repeat, no slice series generation."],
 ["Extract sections along a polyline, and unfold", "no", ""],
 ["Label connected components", "yes", "Written as a scalar field, so one cluster can be isolated with the value filter."],
 ["K-means clustering", "no", ""],
 ["Front propagation segmentation", "no", ""],
 ["Filter points by scalar value", "yes", "With a live count, and Delete points outside as one undoable step."],
 ["Colour based segmentation", "no", "qColorimetricSegmenter picks two colours and a tolerance."],
 ["Manual classification into layers", "part", "A LAS or LAZ classification is read as a scalar field. There is no painting classes by hand."],
 ["Virtual broom cleaning", "no", "qBroom sweeps a surface to remove what sits above it."],
]],
["Editing and transformation", [
 ["Undo and redo of destructive edits", "yes", "With disk spill for large steps. CloudCompare defines no undo action."],
 ["Apply a 4x4 transformation matrix", "yes", "Never baked: the cloud carries the matrix and every consumer reads through it, so it is instant, lossless and undoable."],
 ["Interactive translate and rotate of the cloud", "yes", "A drag gizmo on the cloud itself."],
 ["Scale and multiply", "part", "Uniform scale about the box centre or the origin. No per-axis multiply."],
 ["Level, make horizontal", "yes", "Fits a plane to a sample and turns it horizontal."],
 ["Move bounding box centre, min or max to the origin", "part", "Translate by an exact vector, which does it in one step, but there is no button for the three cases."],
 ["Subsample a cloud", "yes", "Spatial subsampling to a spacing, as an undoable edit; plus striding at load and at export."],
 ["Remove duplicate points", "yes", "To a tolerance."],
 ["Shift points along their normals", "no", ""],
 ["Primitive factory", "part", "A fitted plane, sphere, cylinder or circle is drawn in the view; it does not become an entity you can save or measure against."],
]],
["Scalar fields", [
 ["Arbitrary named scalar fields per point", "part", "One named field per layer at a time. CloudCompare holds many at once and switches between them."],
 ["Scalar field manager, rename, delete", "part", "Clear, and replace by computing another. No manager."],
 ["Histogram of a field", "yes", "With the display range and the filter range drawn on it."],
 ["Statistical parameters of a field", "part", "Minimum, maximum and how many points carry a value. No mean, variance or percentile report."],
 ["Gradient of a field", "no", ""],
 ["Gaussian and bilateral filtering of a field", "no", ""],
 ["Filter by value into a new cloud", "yes", "Delete points outside the range, undoably."],
 ["Field arithmetic", "no", "Add, subtract, multiply between fields."],
 ["Convert field to RGB, and RGB to field", "no", "Including random RGB per integer value."],
 ["Add constant, classification or point index fields", "part", "Classification, from LAS and LAZ. No constant or index field."],
 ["Coordinates to fields, and fields to coordinates", "no", ""],
 ["Normals to fields, and fields to normals", "no", ""],
 ["Interpolate a field from another entity", "part", "Distance to another layer, and distance to a mesh, are written as fields. There is no general interpolation of an existing field across entities."],
 ["Split a cloud by integer field value", "part", "Filter to one value and keep. It does not produce several clouds at once."],
 ["Colour scales bound to a field", "part", "One ramp over the field's range."],
]],
["Colours", [
 ["Brightness and gamma", "yes", ""],
 ["Intensity range mapping", "yes", "With a percentile auto-range."],
 ["Height ramp", "part", "An elevation colour mode with a fixed ramp."],
 ["Set a unique colour", "part", "A per-layer tint multiplier, for telling two overlapping scans apart."],
 ["Colorize, apply a hue while keeping luminance", "no", ""],
 ["Colour levels", "no", "Input and output level adjustment per channel."],
 ["Convert to greyscale", "no", ""],
 ["Colour to scalar field", "no", ""],
 ["Enhance colours with intensities", "yes", "The RGB x intensity colour mode."],
 ["Colour filters", "no", "Bilateral, Gaussian, mean and median."],
 ["Interpolate colours from another entity", "no", ""],
 ["Clear colours", "no", ""],
]],
["Normals", [
 ["Read normals from the file", "yes", "The libE57 nor extension, plus PLY and LAS."],
 ["Compute normals from a neighbourhood", "yes", "Plane fit over k nearest neighbours, in a worker over the whole cloud."],
 ["Orient normals with a minimum spanning tree", "part", "Breadth-first propagation through the neighbour graph, then a per-point decision to face the nearest scanner station, which is the orientation that is right for anything scanned from the inside. It is not an MST."],
 ["Orient normals with fast marching", "no", ""],
 ["Hough transform normals", "no", "qHoughNormals."],
 ["Invert normals", "yes", ""],
 ["Normals to dip and dip direction", "part", "A fitted plane reports dip and dip direction in degrees. Not written per point as a field."],
 ["Normals to HSV colours", "part", "A normal-shading colour mode. Not a stored colour."],
 ["Display normals as lines", "no", ""],
]],
["Measurement and inspection", [
 ["Distance between two picked points", "yes", "With the height difference and the horizontal component."],
 ["Coordinate readout at a picked point", "yes", "Local and global."],
 ["Persistent point labels", "part", "Measurements persist in a list for the session; they are not saved entities."],
 ["Point list picking", "no", "Build and export a table of picked points."],
 ["Measure a mesh surface area", "yes", "Through the layer's transform. A unit cube reads 6.000 m2."],
 ["Measure a mesh volume", "yes", "With the boundary edge count beside it, because an open mesh's divergence sum is not an enclosed volume. A unit cube reads 1.000 m3."],
 ["2.5D volume between two surfaces", "yes", "Cut and fill reported separately. Measured against arithmetic: 64.202 m3 against 64.274, -0.11%."],
 ["Geometric features", "yes", "Fifteen: roughness, curvature, planarity, linearity, sphericity, anisotropy, omnivariance, eigenentropy, verticality, volume and surface density, neighbour count and the three eigenvalues."],
 ["Local statistical test", "no", ""],
 ["Batch export of cloud and plane info", "part", "The agent's `state` and `fit` return exactly this as JSON. There is no batch file writer."],
]],
["Registration and alignment", [
 ["Fine registration by ICP", "yes", "Point-to-plane, rotating about the centroid, reporting per-iteration RMS, overlap, pairs and the matrix. Recovers a known offset to 0.000 mm / 0.0000 degrees."],
 ["Align by picking point pairs", "no", ""],
 ["Match bounding box centres", "yes", ""],
 ["Match scales", "yes", "From boxes measured the same way on both layers, which is the detail that decides whether the number means anything."],
 ["Automatic cloud alignment", "no", "No feature-based global registration."],
 ["Best registration RMS matrix", "yes", "ICP reports it."],
]],
["Comparison and distances", [
 ["Cloud to cloud distance", "yes", "Written as a scalar field, optionally signed along the reference's own normals."],
 ["Cloud to mesh distance", "yes", "Point-to-triangle through a triangle grid, not point-to-nearest-vertex. 249.96 to 250.64 mm on a known 250 mm offset."],
 ["Cloud to primitive distance", "no", ""],
 ["Closest point set", "no", ""],
 ["M3C2 multiscale change detection", "part", "The signed variant projects onto the reference point's own normal, which is the part of M3C2 that stops settlement and heave cancelling. It is not multiscale and has no confidence interval."],
 ["Volumetric change between meshes", "no", "qVoxFall, for rockfall volumes."],
 ["Comparison against a surface of revolution", "no", "qSRA, with 2D distance maps and DXF profiles."],
 ["Distance maps and distance to a best fit quadric", "no", ""],
]],
["Meshing and surfaces", [
 ["Surface reconstruction from points", "part", "A truncated signed distance field with surface nets. CloudCompare uses screened Poisson, which fills gaps more aggressively and takes a depth rather than a voxel size."],
 ["Laplacian style mesh smoothing", "yes", "Taubin by default on any mesh layer, imported or reconstructed: +0.12% volume over ten passes, against -1.98% for plain Laplacian."],
 ["Export a mesh", "yes", "PLY, OBJ or STL, with the layer transform and the global shift baked in."],
 ["Delaunay 2.5D triangulation", "no", "On the XY plane or a best fitting plane."],
 ["Mesh from scan grids", "no", "Uses the acquisition grid of a structured scan."],
 ["Surface between two polylines", "no", ""],
 ["Subdivide a mesh", "no", ""],
 ["Flip triangles", "yes", ""],
 ["Sample points on a mesh", "yes", "Area-weighted, by count or by density, with interpolated normals and colours, into a new point layer."],
 ["Convert texture or material to per-vertex RGB", "no", ""],
 ["Flag vertices by type", "part", "Boundary and non-manifold edges are counted and reported; they are not flagged per vertex."],
 ["Boolean CSG operations on meshes", "no", "qCork and a libIGL based alternative."],
 ["Moving least squares smoothing and reconstruction", "no", "Through the PCL wrapper."],
 ["Measure and report mesh quality", "part", "Boundary edges, non-manifold edges, zero-area triangles and whether the mesh is closed."],
 ["Decimate a mesh", "yes", "Quadric vertex clustering: linear and fast, but it takes a cell size rather than a triangle target."],
]],
["Fitting and shape detection", [
 ["Fit a plane", "yes", "With RMS, worst distance, dip and dip direction. Normal to 0.008 degrees on a fixture."],
 ["Fit a sphere", "yes", "Algebraic then Gauss-Newton. Centre and radius to 0.01 mm."],
 ["Fit a circle", "yes", ""],
 ["Fit a cylinder", "yes", "Axis from the normal set's least-variance direction, which is what makes it hold on a partial arc. 0.0000 degrees off the axis on a fixture."],
 ["Fit a 2D polygon facet", "no", ""],
 ["Fit a 2.5D quadric", "no", ""],
 ["RANSAC shape detection", "part", "Planes, spheres and cylinders, with inlier removal as the non-maximum suppression. No cones or tori."],
 ["Promote a circle to a cylinder", "no", ""],
 ["Bounding box PCA fit", "no", ""],
 ["Plane properties, compare and flip", "part", "A fit reports its plane fully; there is no comparison between two of them."],
]],
["Rasterisation, grids and volume", [
 ["Rasterize to a grid", "yes", "Highest, lowest, mean, point density or the mean of a scalar field, along any axis, draped over the cloud so it can be judged."],
 ["Contour plot to polylines and to mesh", "part", "Polylines, traced by marching squares with the crossing interpolated along each edge, out as DXF or GeoJSON. Not to a mesh."],
 ["Interpolate empty cells", "yes", "Nearest value or inverse distance, capped in reach so a hole is not filled from the far side of the site."],
 ["Raster and DEM export", "part", "PNG with a world file. No GeoTIFF or ASC."],
 ["2.5D volume calculation", "yes", "Against another layer or a flat plane, cut and fill separately."],
 ["Unroll a cylinder or cone", "no", "Also straightened unrolling, used on tunnels and tanks."],
]],
["Cleaning and filtering", [
 ["Manual removal inside a volume", "yes", "Box, sphere, slab or prism, with undo."],
 ["Statistical outlier removal", "yes", "On neighbour distance statistics, reporting the mean and the cut-off it used."],
 ["Noise filter relative to a fitted surface", "yes", ""],
 ["Remove duplicate points", "yes", ""],
 ["Cloth simulation ground filter", "no", "qCSF, the standard ground and off-ground split."],
 ["Hidden point removal", "no", "qHPR, approximate visibility from a viewpoint."],
]],
["Classification and domain tools", [
 ["CANUPO classifier, train and apply", "no", "Multiscale dimensionality, trained in the GUI."],
 ["3DMASC classifier", "no", "Multiple attributes, scales and clouds, usable without programming."],
 ["Masonry segmentation", "no", "Splits a dense scan of a wall into individual stones."],
 ["TreeIso individual tree isolation", "no", "Unsupervised segmentation of single trees from TLS."],
 ["3DFin forest inventory", "no", "Tree height, diameter at breast height and stem location."],
 ["G3Point granulometry", "no", "Segments and measures grains and gravel."],
 ["Facet and fracture detection", "no", "qFacets, with a stereogram and facet export."],
 ["Structural geology compass", "no", "qCompass, for outcrop orientation measurement."],
 ["Normal distance to a defined plane", "part", "A fitted plane gives the plane; the per-point distance to it is not written as a field."],
 ["Animation from a series of viewpoints", "no", "qAnimation renders a movie."],
]],
["Sensors", [
 ["Panorama imagery from the file", "yes", "E57 spherical images, shown as bubbles."],
 ["Stand at a scanner position", "part", "Enter the panorama. CloudCompare models the sensor and can render the view from it."],
 ["TLS and GBL sensor model", "part", "Station positions are read and used, to orient normals outward per point, but there is no editable sensor object."],
 ["Depth buffer create, show, export", "no", ""],
 ["Point visibility from a sensor", "no", "Using the depth buffer or the octree."],
 ["Camera sensor and uncertainty projection", "no", ""],
 ["Compute ranges from a sensor", "no", ""],
 ["Compute scattering angles", "no", ""],
]],
["Automation", [
 ["Drive the application from outside", "yes", "Thirty MCP tools over a localhost bridge, plus a tokened HTTP session that drives a live tab from anywhere. CloudCompare has a JSON-RPC plugin."],
 ["Headless command line batch processing", "no", "218 command constants: load, subsample, distances, ICP, normals, rasterize, filters, export format control, auto-save. Ours always drives a live window."],
 ["Command files and scripting", "yes", "A `script` runs a list of steps in order with each step's result available to the next, from an agent or from the panel."],
 ["Per-format export options in batch", "part", "Format and stride. No per-format option set."],
 ["A calibrated interface for measuring from renders", "yes", "Not in CloudCompare: an orthographic view comes back with the mapping that turns any of its pixels into a world point, and `probe` re-establishes that render's camera to answer exactly later."],
]],
];

const LBL = { yes: "Have", part: "Partial", no: "Missing" };
let nYes = 0, nPart = 0, nNo = 0, nAll = 0;
for (const [, rows] of D) for (const [, s] of rows) { nAll++; if (s === "yes") nYes++; else if (s === "part") nPart++; else nNo++; }

let md = `<!-- SPDX-License-Identifier: GPL-3.0-only -->
# What CloudCompare does that e57view does not

A capability audit, read from the source rather than from memory. The CloudCompare side comes
from a shallow clone of its master branch in September 2026: \`qCC/ui_templates/mainWindow.ui\`
parsed as a menu tree (235 actions), the \`windowTitle\` of every \`.ui\` dialog in the
application and its plugins, the \`plugins/core/Standard\` and \`plugins/core/IO\` directories,
the registered file format filters, and 218 command line constants. **Nothing here is inferred
from the name of a thing.**

The e57view side is kept current as things get built. Regenerate with
\`node tools/gap-analysis.mjs\`; the statuses live in that script so the counts cannot disagree
with the tables.

| | |
|---:|---|
| **${nAll}** | capabilities compared |
| **${nYes}** | covered |
| **${nPart}** | partial, or different in a way the note explains |
| **${nNo}** | missing outright |

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

**2. There is no headless mode.** Everything is driven through a live window. The \`script\`
command batches work and an agent can automate the whole surface, but there is no
\`e57view --load x.e57 --sor --save y.las\` that runs without a display. CloudCompare's 218
command line constants are a genuine product in their own right.

**3. The domain plugins are absent entirely.** Forest inventory, masonry segmentation,
granulometry, structural geology, classifier training. Each is a research group's work
packaged as a plugin, and none of it is a weekend.

**4. A long tail of formats and conveniences.** Colour levels, field arithmetic, stereo
display, multiple viewports, the more exotic file formats. Individually small; collectively
what twenty years looks like.

## Everything, by category

Legend: **Have**, **Partial** (the note says exactly what differs), **Missing**.

`;

for (const [cat, rows] of D) {
  const t = ["yes", "part", "no"].map(k => {
    const c = rows.filter(r => r[1] === k).length;
    return c ? `${c} ${LBL[k].toLowerCase()}` : "";
  }).filter(Boolean).join(" · ");
  md += `### ${cat}\n\n<sub>${t}</sub>\n\n| Capability in CloudCompare | e57view | Note |\n|---|---|---|\n`;
  for (const [f, s, n] of rows) md += `| ${f} | **${LBL[s]}** | ${n || "none"} |\n`;
  md += "\n";
}

md += `## What e57view has that CloudCompare does not

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
  renders that come with the mapping from pixel to metre, a \`probe\` that re-establishes a past
  render's camera to answer exactly, a \`recommendedSource\` that says whether to measure the
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
`;

writeFileSync("docs/cloudcompare-gap-analysis.md", md);
console.log(`docs/cloudcompare-gap-analysis.md · ${nAll} rows · ${nYes} have, ${nPart} partial, ${nNo} missing`);
