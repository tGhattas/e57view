<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Acknowledgements

We did not start from nothing. Other people solved the hard parts first and published the
answers, and most of the software below we used for years before writing a line of this one.

**The E57 format.** ASTM committee E57 spent years producing a standard that is actually
specified, with a reference implementation to check yourself against. The maintained fork,
[libE57Format](https://github.com/asmaloney/libE57Format) (Boost licence), is the reason an
E57 file means the same thing in two programs. Our decoder reads the same XML and the same
compressed vectors; where we were unsure what a field meant, that library answered.

**The `e57` crate.** [cry-inc's Rust implementation](https://github.com/cry-inc/e57) (MIT) is
what we started from. We ended up writing our own columnar decoder for speed, and validated it
bit-exact against that crate on all ten fields of our test file. It is still the reference we
check against, and it still opens files we get wrong.

**LAS, LAZ, and Martin Isenburg.** LASzip made point cloud files small enough to move around,
and Isenburg gave it away under Apache 2.0 before he died in 2021. LAStools taught a generation
what a fast point cloud tool feels like. We read LAZ through
[laz-rs](https://github.com/tmontaigu/laz-rs) by Thomas Montaigu, compiled to WebAssembly, and
it worked first time on a 3 GB file.

**PDAL**, from Howard Butler and Hobu, is the plumbing under most of the industry, and
Entwine and COPC came out of the same place. We do not use PDAL here, but the formats and the
conventions we follow are largely theirs.

**PCL** gave the field its vocabulary. Statistical outlier removal, normal estimation from
local neighbourhoods, the whole way of thinking about a point and its k nearest neighbours:
that is Willow Garage and Open Perception, under a BSD licence, for over fifteen years.

**CloudCompare**, and Daniel Girardeau-Montaut in particular. It is the tool people actually
use, and it is free. We reimplemented its SOR and noise filters in Rust so that the same
settings remove the same points, reading `CCCoreLib::CloudSamplingTools` to get the details
right, including the ones its own comments explain. No CloudCompare code is in this
repository; the filters are written from the published algorithm, and there is a test that
compares ours against a transcription of it point for point. We also used its feature list as
the yardstick for what a point cloud tool is expected to do, which is
[written down](docs/cloudcompare-gap-analysis.md) rather than left as a vague ambition.

**Potree**, by Markus Schütz. Potree proved that tens of millions of points could be drawn in
a browser, which is the assumption this whole project rests on. The shuffled-octree idea, where
a prefix of a node is a uniform subsample and level of detail costs no extra storage, is
Potree's. We arrived at the same 14-byte record independently and then found he had been there
first.

**Eye-dome lighting** is Christian Boucheny's, from his doctoral work at EDF R&D. Turn it off
and a dense scan reads as a flat smear of colour with no depth in it at all. Both CloudCompare
and Potree ship an implementation, and ours follows theirs.

**Open3D** and **MeshLab** are where we went to check what a mesh operation is supposed to do.

**The papers.** Surface nets from Sarah Frisken Gibson (1998). Taubin smoothing from Gabriel
Taubin's SIGGRAPH 1995 paper, which is why our smoother keeps the volume. Point-to-plane ICP
from Chen and Medioni, with Kok-Lim Low's 2004 linear least-squares formulation for the 6x6
solve. RANSAC shape detection from Schnabel, Wahl and Klein (2007). Quadric error metrics from
Garland and Heckbert (1997), and vertex clustering from Rossignac and Borrel (1993).

**The tools underneath.** three.js for the camera and the matrix maths. wasm-bindgen, which
makes Rust in a browser ordinary. Tauri, which wrapped the same code as a 4.7 MB desktop
application with about two hundred lines of Rust.

If we have used your work and not named it, that is an oversight and we would like to fix it.
Open an issue or a pull request against this file.
