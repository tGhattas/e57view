// SPDX-License-Identifier: GPL-3.0-only
// Neighbourhood analysis: everything that needs to know what surrounds a point.
//
// Normals, geometric features, outlier removal, duplicate detection and connected
// components are all the same question asked five ways — "which points are near this
// one?" — so they share one spatial index and one pass over it. Building that index
// once is most of the cost; the analyses on top are comparatively cheap.
//
// The index is a uniform voxel hash rather than a kd-tree. Scan data is close to
// uniform along surfaces, which is the case a grid handles well, and it builds in one
// counting pass with no recursion, no rebalancing and no per-node allocation.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Default)]
pub struct FxHasher {
    h: u64,
}
impl Hasher for FxHasher {
    fn finish(&self) -> u64 {
        self.h
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.h = (self.h ^ b as u64).wrapping_mul(0x1000_0000_1b3);
        }
    }
    fn write_i64(&mut self, i: i64) {
        let mut h = (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        h ^= h >> 29;
        h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
        h ^= h >> 32;
        self.h = h;
    }
    fn write_u64(&mut self, i: u64) {
        self.write_i64(i as i64)
    }
}
type FastMap<K, V> = HashMap<K, V, BuildHasherDefault<FxHasher>>;

#[inline]
fn key(x: i32, y: i32, z: i32) -> i64 {
    ((x as i64 & 0x1F_FFFF) << 42) | ((y as i64 & 0x1F_FFFF) << 21) | (z as i64 & 0x1F_FFFF)
}
/// Which per-point number to produce. The names match what a surveyor sees in the panel.
#[derive(Clone, Copy, PartialEq)]
pub enum Feature {
    Roughness,
    Curvature,
    Planarity,
    Linearity,
    Sphericity,
    Anisotropy,
    Omnivariance,
    Eigenentropy,
    Verticality,
    VolumeDensity,
    SurfaceDensity,
    NeighbourCount,
    EigenValue1,
    EigenValue2,
    EigenValue3,
}
impl Feature {
    pub fn from_str(s: &str) -> Option<Feature> {
        use Feature::*;
        Some(match s {
            "roughness" => Roughness,
            "curvature" => Curvature,
            "planarity" => Planarity,
            "linearity" => Linearity,
            "sphericity" => Sphericity,
            "anisotropy" => Anisotropy,
            "omnivariance" => Omnivariance,
            "eigenentropy" => Eigenentropy,
            "verticality" => Verticality,
            "volume_density" => VolumeDensity,
            "surface_density" => SurfaceDensity,
            "neighbours" => NeighbourCount,
            "eig1" => EigenValue1,
            "eig2" => EigenValue2,
            "eig3" => EigenValue3,
            _ => return None,
        })
    }
}

/// How a noise filter chooses its neighbourhood and its threshold.
#[derive(Clone, Copy, Debug)]
pub struct NoiseParams {
    /// The `knn` nearest points rather than a sphere. CloudCompare's dialog defaults to
    /// the sphere; its function signature defaults to this being false as well.
    pub use_knn: bool,
    pub knn: usize,
    /// Sphere radius in metres, used when `use_knn` is false.
    pub radius: f32,
    /// A fixed distance from the local plane instead of a multiple of the local spread.
    pub use_absolute_error: bool,
    pub absolute_error: f32,
    pub n_sigma: f32,
    /// Drop points with too few neighbours to fit a plane. Off by default in
    /// CloudCompare, and off here, because "I could not measure this point" and "this
    /// point is noise" are different statements.
    pub remove_isolated: bool,
}

impl Default for NoiseParams {
    /// CloudCompare's own defaults: sphere neighbourhood, relative error, one sigma,
    /// isolated points kept.
    fn default() -> NoiseParams {
        NoiseParams {
            use_knn: false, knn: 6, radius: 0.0,
            use_absolute_error: false, absolute_error: 0.0,
            n_sigma: 1.0, remove_isolated: false,
        }
    }
}

pub struct Analyzer {
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub z: Vec<f32>,
    pub nx: Vec<i8>,
    pub ny: Vec<i8>,
    pub nz: Vec<i8>,
    /// Where each point sits in the whole cloud.
    ///
    /// A cloud too big to index at once is analysed one spatial tile at a time, and a tile
    /// holds its own points followed by its neighbours' points as context. Any rule of the
    /// form "the first one wins" then has to mean first in the file, not first in this tile,
    /// or two tiles looking at the same pair of points would each keep a different one.
    pub gid: Vec<u32>,
    cell: f32,
    inv_cell: f32,
    // CSR-style grid: cell key -> slice of `order`
    starts: FastMap<i64, (u32, u32)>,
    order: Vec<u32>,
    built: bool,
    /// Bounding-box diagonal, so a neighbour search knows when it has covered everything.
    extent: f32,
}

/// Public wrapper, so the shape fits can share this rather than carry a second copy.
pub fn eigen_sym3_pub(a: [[f64; 3]; 3]) -> ([f64; 3], [[f64; 3]; 3]) { eigen_sym3(a) }

/// Eigen decomposition of a symmetric 3x3 matrix by cyclic Jacobi rotations.
/// Returns eigenvalues ascending, with the matching eigenvectors as columns.
fn eigen_sym3(mut a: [[f64; 3]; 3]) -> ([f64; 3], [[f64; 3]; 3]) {
    let mut v = [[0.0f64; 3]; 3];
    for i in 0..3 {
        v[i][i] = 1.0;
    }
    for _ in 0..12 {
        // largest off-diagonal
        let (mut p, mut q, mut off) = (0usize, 1usize, 0.0f64);
        for i in 0..3 {
            for j in (i + 1)..3 {
                if a[i][j].abs() > off {
                    off = a[i][j].abs();
                    p = i;
                    q = j;
                }
            }
        }
        if off < 1e-14 {
            break;
        }
        let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
        let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
        let c = 1.0 / (t * t + 1.0).sqrt();
        let s = t * c;
        for k in 0..3 {
            let akp = a[k][p];
            let akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
        }
        for k in 0..3 {
            let apk = a[p][k];
            let aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
        }
        for k in 0..3 {
            let vkp = v[k][p];
            let vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
        }
    }
    let mut idx = [0usize, 1, 2];
    let ev = [a[0][0], a[1][1], a[2][2]];
    idx.sort_by(|&i, &j| ev[i].partial_cmp(&ev[j]).unwrap_or(std::cmp::Ordering::Equal));
    let vals = [ev[idx[0]], ev[idx[1]], ev[idx[2]]];
    let mut vecs = [[0.0f64; 3]; 3];
    for (c, &i) in idx.iter().enumerate() {
        for r in 0..3 {
            vecs[r][c] = v[r][i];
        }
    }
    (vals, vecs)
}

/// Negate a quantised normal without landing on (0,0,127), which the record format
/// reserves for "this point has no normal".
#[inline]
fn flip(nx: &mut i8, ny: &mut i8, nz: &mut i8) {
    *nx = -(*nx).max(-127);
    *ny = -(*ny).max(-127);
    *nz = -(*nz).max(-127);
    if *nx == 0 && *ny == 0 && *nz == 127 {
        *nz = 126;
    }
}

pub struct IcpResult {
    /// Row-major 4x4 to apply to the moving cloud.
    pub matrix: [f32; 16],
    pub rms: f32,
    pub rms_history: Vec<f32>,
    pub overlap: f32,
    pub iterations: usize,
    pub pairs: usize,
}

pub fn identity4() -> [f32; 16] {
    let mut m = [0.0f32; 16];
    m[0] = 1.0; m[5] = 1.0; m[10] = 1.0; m[15] = 1.0;
    m
}
#[inline]
fn apply4(m: &[f32; 16], x: f32, y: f32, z: f32) -> [f32; 3] {
    [m[0] * x + m[1] * y + m[2] * z + m[3],
     m[4] * x + m[5] * y + m[6] * z + m[7],
     m[8] * x + m[9] * y + m[10] * z + m[11]]
}
fn mul4(a: &[f32; 16], b: &[f32; 16]) -> [f32; 16] {
    let mut o = [0.0f32; 16];
    for r in 0..4 { for c in 0..4 {
        let mut s = 0.0;
        for k in 0..4 { s += a[r * 4 + k] * b[k * 4 + c]; }
        o[r * 4 + c] = s;
    }}
    o
}
/// A rigid transform from a rotation vector and a translation, taken about `c`:
/// `p' = R (p - c) + c + t`. The rotation is the exact exponential of the vector rather than
/// `I + [w]x`, so a large step stays a rotation instead of a slight shear.
fn rigid_about(w: [f32; 3], t: [f32; 3], c: [f32; 3]) -> [f32; 16] {
    let th = (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt();
    let r = if th < 1e-12 {
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    } else {
        let (s, k) = (th.sin(), th.cos());
        let a = [w[0] / th, w[1] / th, w[2] / th];
        let v = 1.0 - k;
        [[k + a[0] * a[0] * v, a[0] * a[1] * v - a[2] * s, a[0] * a[2] * v + a[1] * s],
         [a[1] * a[0] * v + a[2] * s, k + a[1] * a[1] * v, a[1] * a[2] * v - a[0] * s],
         [a[2] * a[0] * v - a[1] * s, a[2] * a[1] * v + a[0] * s, k + a[2] * a[2] * v]]
    };
    let mut m = [0.0f32; 16];
    for i in 0..3 {
        for j in 0..3 { m[i * 4 + j] = r[i][j]; }
        m[i * 4 + 3] = c[i] + t[i] - (r[i][0] * c[0] + r[i][1] * c[1] + r[i][2] * c[2]);
    }
    m[15] = 1.0;
    m
}
/// Gaussian elimination with partial pivoting on the 6x6 normal equations.
fn solve6(mut a: [[f64; 6]; 6], mut b: [f64; 6]) -> Option<[f64; 6]> {
    for col in 0..6 {
        let mut piv = col;
        for r in (col + 1)..6 { if a[r][col].abs() > a[piv][col].abs() { piv = r; } }
        if a[piv][col].abs() < 1e-18 { return None; }
        if piv != col { a.swap(piv, col); b.swap(piv, col); }
        let d = a[col][col];
        for r in (col + 1)..6 {
            let f = a[r][col] / d;
            if f == 0.0 { continue; }
            for c in col..6 { a[r][c] -= f * a[col][c]; }
            b[r] -= f * b[col];
        }
    }
    let mut x = [0.0f64; 6];
    for i in (0..6).rev() {
        let mut s = b[i];
        for j in (i + 1)..6 { s -= a[i][j] * x[j]; }
        x[i] = s / a[i][i];
        if !x[i].is_finite() { return None; }
    }
    Some(x)
}

impl Analyzer {
    pub fn new(cell: f32) -> Analyzer {
        let cell = cell.max(1e-4);
        Analyzer {
            x: Vec::new(), y: Vec::new(), z: Vec::new(),
            nx: Vec::new(), ny: Vec::new(), nz: Vec::new(),
            gid: Vec::new(),
            cell, inv_cell: 1.0 / cell,
            starts: FastMap::default(), order: Vec::new(), built: false,
            extent: 0.0,
        }
    }

    pub fn len(&self) -> usize { self.x.len() }
    pub fn cell_size(&self) -> f32 { self.cell }

    /// Decode one octree leaf's 14-byte records into the flat arrays.
    ///
    /// `model` is the cloud's 4x4 transform, **row-major**, or None for identity. The viewer
    /// keeps its points quantised in their original leaf cubes and carries the transform
    /// separately, so every analysis has to apply it here or read a cloud that is not the
    /// one on screen — verticality on a levelled scan being the obvious case. Normals are
    /// rotated by the upper-left 3x3 and requantised.
    pub fn add_records(&mut self, origin: [f32; 3], size: f32, recs: &[u8], model: Option<&[f32; 16]>) {
        let base = self.len() as u32;
        self.add_records_stride(origin, size, recs, model, 1, base)
    }
    /// Same, keeping 1 in `stride`. A reference cloud bigger than the analyser will hold is
    /// subsampled rather than refused: a nearest-neighbour query against a subsample is a
    /// slightly worse answer, where no answer is no registration at all.
    pub fn add_records_stride(&mut self, origin: [f32; 3], size: f32, recs: &[u8], model: Option<&[f32; 16]>, stride: usize, base: u32) {
        const REC: usize = 14;
        let n = recs.len() / REC;
        let k = size / 65536.0;
        let step = stride.max(1);
        self.x.reserve(n / step + 1); self.y.reserve(n / step + 1); self.z.reserve(n / step + 1);
        self.gid.reserve(n / step + 1);
        for i in (0..n).step_by(step) {
            let o = i * REC;
            let qx = u16::from_le_bytes([recs[o], recs[o + 1]]) as f32;
            let qy = u16::from_le_bytes([recs[o + 2], recs[o + 3]]) as f32;
            let qz = u16::from_le_bytes([recs[o + 4], recs[o + 5]]) as f32;
            let p = [origin[0] + qx * k, origin[1] + qy * k, origin[2] + qz * k];
            let (mut nx, mut ny, mut nz) = (recs[o + 10] as i8, recs[o + 11] as i8, recs[o + 12] as i8);
            let p = match model {
                None => p,
                Some(m) => {
                    // rotate the normal too, unless it is the "no normal" placeholder
                    if !(nx == 0 && ny == 0 && nz == 127) {
                        let (a, b, c) = (nx as f32, ny as f32, nz as f32);
                        let tx = m[0] * a + m[1] * b + m[2] * c;
                        let ty = m[4] * a + m[5] * b + m[6] * c;
                        let tz = m[8] * a + m[9] * b + m[10] * c;
                        let l = (tx * tx + ty * ty + tz * tz).sqrt();
                        if l > 1e-9 {
                            nx = (tx / l * 127.0).round().clamp(-127.0, 127.0) as i8;
                            ny = (ty / l * 127.0).round().clamp(-127.0, 127.0) as i8;
                            nz = (tz / l * 127.0).round().clamp(-127.0, 127.0) as i8;
                            if nx == 0 && ny == 0 && nz == 127 { nz = 126; }
                        }
                    }
                    [
                        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
                        m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
                        m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
                    ]
                }
            };
            self.x.push(p[0]);
            self.y.push(p[1]);
            self.z.push(p[2]);
            self.nx.push(nx);
            self.ny.push(ny);
            self.nz.push(nz);
            self.gid.push(base.wrapping_add(i as u32));
        }
        self.built = false;
    }

    /// One counting pass builds the grid; nothing is allocated per cell.
    pub fn build(&mut self) {
        if self.built { return; }
        let n = self.x.len();
        // the longest distance that can exist in this cloud, which is where a neighbour
        // search can stop looking
        let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
        for i in 0..n {
            for (a, v) in [self.x[i], self.y[i], self.z[i]].into_iter().enumerate() {
                if v < lo[a] { lo[a] = v; }
                if v > hi[a] { hi[a] = v; }
            }
        }
        self.extent = if n == 0 { 0.0 } else {
            ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt()
        };
        let mut counts: FastMap<i64, u32> = FastMap::default();
        let mut keys = Vec::with_capacity(n);
        for i in 0..n {
            let k = key(
                (self.x[i] * self.inv_cell).floor() as i32,
                (self.y[i] * self.inv_cell).floor() as i32,
                (self.z[i] * self.inv_cell).floor() as i32,
            );
            keys.push(k);
            *counts.entry(k).or_insert(0) += 1;
        }
        let mut at = 0u32;
        self.starts.clear();
        self.starts.reserve(counts.len());
        for (k, c) in counts.iter() {
            self.starts.insert(*k, (at, 0));
            at += *c;
        }
        self.order = vec![0u32; n];
        for i in 0..n {
            let e = self.starts.get_mut(&keys[i]).unwrap();
            self.order[(e.0 + e.1) as usize] = i as u32;
            e.1 += 1;
        }
        self.built = true;
    }

    /// Indices within `radius` of point i, searching the cells around it.
    /// `out` is reused by the caller to avoid an allocation per point.
    #[inline]
    fn radius_search(&self, i: usize, radius: f32, out: &mut Vec<(f32, u32)>) {
        self.radius_search_at(self.x[i], self.y[i], self.z[i], radius, out)
    }
    /// The same search from a position that need not be one of the points — what a second
    /// cloud's points are, when they are being matched against this one.
    #[inline]
    fn radius_search_at(&self, px: f32, py: f32, pz: f32, radius: f32, out: &mut Vec<(f32, u32)>) {
        out.clear();
        let r2 = radius * radius;
        let reach = (radius * self.inv_cell).ceil() as i32;
        let (cx, cy, cz) = (
            (px * self.inv_cell).floor() as i32,
            (py * self.inv_cell).floor() as i32,
            (pz * self.inv_cell).floor() as i32,
        );
        for dz in -reach..=reach {
            for dy in -reach..=reach {
                for dx in -reach..=reach {
                    if let Some(&(s, c)) = self.starts.get(&key(cx + dx, cy + dy, cz + dz)) {
                        for t in 0..c {
                            let j = self.order[(s + t) as usize];
                            let ju = j as usize;
                            let d = (self.x[ju] - px).powi(2) + (self.y[ju] - py).powi(2) + (self.z[ju] - pz).powi(2);
                            if d <= r2 {
                                out.push((d, j));
                            }
                        }
                    }
                }
            }
        }
    }

    /// The k nearest neighbours of i, growing the radius until enough are found.
    #[inline]
    fn knn(&self, i: usize, k: usize, scratch: &mut Vec<(f32, u32)>) -> usize {
        let mut r = self.cell;
        for _ in 0..5 {
            self.radius_search(i, r, scratch);
            if scratch.len() > k {
                break;
            }
            r *= 2.0;
        }
        if scratch.len() > k + 1 {
            // Same rule as nearest_set: an f64 distance recomputed from the coordinates, ties
            // broken by the point's place in the file. An f32 comparison with no tie-break
            // let the partition keep whichever of two equidistant neighbours the grid
            // happened to reach first, so a point at the edge of a tile could come out with a
            // slightly different neighbourhood from the same point in the whole cloud.
            let (px, py, pz) = (self.x[i] as f64, self.y[i] as f64, self.z[i] as f64);
            let d64 = |j: u32| {
                let ju = j as usize;
                let dx = self.x[ju] as f64 - px;
                let dy = self.y[ju] as f64 - py;
                let dz = self.z[ju] as f64 - pz;
                dx * dx + dy * dy + dz * dz
            };
            let gid = &self.gid;
            scratch.select_nth_unstable_by(k, |a, b| {
                d64(a.1).partial_cmp(&d64(b.1)).unwrap_or(std::cmp::Ordering::Equal)
                    .then(gid[a.1 as usize].cmp(&gid[b.1 as usize]))
            });
            scratch.truncate(k + 1);
        }
        scratch.len()
    }

    /// Covariance eigen decomposition of a neighbourhood, plus its centroid.
    #[inline]
    fn local_pca(&self, nb: &[(f32, u32)]) -> ([f64; 3], [[f64; 3]; 3], [f64; 3]) {
        let n = nb.len().max(1) as f64;
        let (mut mx, mut my, mut mz) = (0.0f64, 0.0, 0.0);
        for &(_, j) in nb {
            let j = j as usize;
            mx += self.x[j] as f64;
            my += self.y[j] as f64;
            mz += self.z[j] as f64;
        }
        mx /= n; my /= n; mz /= n;
        let mut c = [[0.0f64; 3]; 3];
        for &(_, j) in nb {
            let j = j as usize;
            let d = [self.x[j] as f64 - mx, self.y[j] as f64 - my, self.z[j] as f64 - mz];
            for a in 0..3 {
                for b in 0..3 {
                    c[a][b] += d[a] * d[b];
                }
            }
        }
        for a in 0..3 {
            for b in 0..3 {
                c[a][b] /= n;
            }
        }
        let (vals, vecs) = eigen_sym3(c);
        (vals, vecs, [mx, my, mz])
    }

    /// Least-eigenvector normals. Orientation is fixed afterwards, not here.
    pub fn compute_normals(&mut self, k: usize, mut progress: impl FnMut(usize)) {
        self.build();
        let n = self.len();
        let mut scratch: Vec<(f32, u32)> = Vec::with_capacity(256);
        let mut out = vec![0i8; n * 3];
        for i in 0..n {
            let m = self.knn(i, k, &mut scratch);
            if m < 3 {
                out[i * 3 + 2] = 127;
                continue;
            }
            let (_, vecs, _) = self.local_pca(&scratch);
            let (a, b, c) = (vecs[0][0], vecs[1][0], vecs[2][0]);
            let l = (a * a + b * b + c * c).sqrt().max(1e-12);
            out[i * 3] = (a / l * 127.0).round().clamp(-127.0, 127.0) as i8;
            out[i * 3 + 1] = (b / l * 127.0).round().clamp(-127.0, 127.0) as i8;
            out[i * 3 + 2] = (c / l * 127.0).round().clamp(-127.0, 127.0) as i8;
            // never emit the "no normal" marker for a normal we actually computed
            if out[i * 3] == 0 && out[i * 3 + 1] == 0 && out[i * 3 + 2] == 127 { out[i * 3 + 2] = 126; }
            if i % 65536 == 0 { progress(i); }
        }
        for i in 0..n {
            self.nx[i] = out[i * 3];
            self.ny[i] = out[i * 3 + 1];
            self.nz[i] = out[i * 3 + 2];
        }
    }

    /// Make neighbouring normals agree, then flip each connected component as a unit.
    ///
    /// A breadth-first walk over the neighbour graph propagates orientation outward from a
    /// seed, flipping any normal that disagrees with the one it was reached from. That is
    /// the spirit of a minimum spanning tree traversal without the cost of building one:
    /// the queue is an index into a growing vector, so a point is visited in order of how
    /// many neighbour hops it is from the seed, which keeps the propagation path short and
    /// the sign decisions local. Each component is then flipped as a unit so its normals
    /// point away from the cloud centre, or toward a viewpoint when one is supplied.
    ///
    /// The whole-component vote is only right for an object seen from outside. For an
    /// interior scan use `orient_to_viewpoints` afterwards, which decides per point.
    pub fn orient_normals(&mut self, k: usize, viewpoint: Option<[f32; 3]>, mut progress: impl FnMut(usize)) {
        self.build();
        let n = self.len();
        if n == 0 { return; }
        let (mut cx, mut cy, mut cz) = (0.0f64, 0.0, 0.0);
        for i in 0..n {
            cx += self.x[i] as f64; cy += self.y[i] as f64; cz += self.z[i] as f64;
        }
        cx /= n as f64; cy /= n as f64; cz /= n as f64;

        let mut seen = vec![false; n];
        let mut scratch: Vec<(f32, u32)> = Vec::with_capacity(256);
        let mut queue: Vec<u32> = Vec::new();
        let mut comp: Vec<u32> = Vec::new();
        let mut done = 0usize;
        for seed in 0..n {
            if seen[seed] { continue; }
            seen[seed] = true;
            queue.clear(); comp.clear();
            queue.push(seed as u32);
            let mut head = 0usize;
            while head < queue.len() {
                let cur = queue[head];
                head += 1;
                let ci = cur as usize;
                comp.push(cur);
                done += 1;
                if done % 65536 == 0 { progress(done); }
                let cn = [self.nx[ci] as f32, self.ny[ci] as f32, self.nz[ci] as f32];
                self.knn(ci, k, &mut scratch);
                for &(_, j) in scratch.iter() {
                    let ju = j as usize;
                    if seen[ju] { continue; }
                    seen[ju] = true;
                    let dot = cn[0] * self.nx[ju] as f32 + cn[1] * self.ny[ju] as f32 + cn[2] * self.nz[ju] as f32;
                    if dot < 0.0 {
                        let (mut a, mut b, mut c) = (self.nx[ju], self.ny[ju], self.nz[ju]);
                        flip(&mut a, &mut b, &mut c);
                        self.nx[ju] = a; self.ny[ju] = b; self.nz[ju] = c;
                    }
                    queue.push(j);
                }
            }
            // one vote per component: does it face away from the centre (or toward the eye)?
            let mut vote = 0i64;
            for &p in comp.iter() {
                let pu = p as usize;
                let (rx, ry, rz) = match viewpoint {
                    Some(v) => (v[0] - self.x[pu], v[1] - self.y[pu], v[2] - self.z[pu]),
                    None => (self.x[pu] - cx as f32, self.y[pu] - cy as f32, self.z[pu] - cz as f32),
                };
                let d = rx * self.nx[pu] as f32 + ry * self.ny[pu] as f32 + rz * self.nz[pu] as f32;
                vote += if d > 0.0 { 1 } else { -1 };
            }
            if vote < 0 {
                for &p in comp.iter() {
                    let pu = p as usize;
                    let (mut a, mut b, mut c) = (self.nx[pu], self.ny[pu], self.nz[pu]);
                    flip(&mut a, &mut b, &mut c);
                    self.nx[pu] = a; self.ny[pu] = b; self.nz[pu] = c;
                }
            }
        }
    }

    /// Turn every normal toward the nearest of the scanner's own viewpoints.
    ///
    /// `vps` is a flat list of x,y,z triples in the same frame as the points. A laser scan
    /// only ever saw a surface from the station that measured it, so "toward the station"
    /// is the physically correct outward direction — and for an interior it is the opposite
    /// of "away from the cloud centroid", which is why a whole-component vote turns every
    /// wall in a building the wrong way round. Decided per point, so one cloud covering
    /// many rooms comes out right everywhere.
    ///
    /// Stations number in the hundreds, so the nearest one is found by brute force: fewer
    /// distance computations per point than the neighbour search that produced the normals.
    pub fn orient_to_viewpoints(&mut self, vps: &[f32]) {
        let m = vps.len() / 3;
        if m == 0 { return; }
        for i in 0..self.len() {
            let (px, py, pz) = (self.x[i], self.y[i], self.z[i]);
            let mut best = f32::INFINITY;
            let mut bk = 0usize;
            for k in 0..m {
                let dx = vps[k * 3] - px;
                let dy = vps[k * 3 + 1] - py;
                let dz = vps[k * 3 + 2] - pz;
                let d = dx * dx + dy * dy + dz * dz;
                if d < best { best = d; bk = k; }
            }
            let rx = vps[bk * 3] - px;
            let ry = vps[bk * 3 + 1] - py;
            let rz = vps[bk * 3 + 2] - pz;
            let dot = rx * self.nx[i] as f32 + ry * self.ny[i] as f32 + rz * self.nz[i] as f32;
            if dot < 0.0 {
                let (mut a, mut b, mut c) = (self.nx[i], self.ny[i], self.nz[i]);
                flip(&mut a, &mut b, &mut c);
                self.nx[i] = a; self.ny[i] = b; self.nz[i] = c;
            }
        }
    }

    /// The nearest point to an arbitrary position, as (index, squared distance). The search
    /// grows the radius until something is found or `max_r` is passed, then does one more ring
    /// at the radius that found it, because the first hit in a cell sweep need not be nearest.
    pub fn nearest(&self, px: f32, py: f32, pz: f32, max_r: f32, scratch: &mut Vec<(f32, u32)>) -> Option<(u32, f32)> {
        let mut r = self.cell;
        loop {
            self.radius_search_at(px, py, pz, r, scratch);
            if !scratch.is_empty() {
                let mut best = (f32::INFINITY, 0u32);
                for &(d, j) in scratch.iter() {
                    if d < best.0 { best = (d, j); }
                }
                // a cell sweep of radius r covers every point within r, so this is exact
                if best.0.sqrt() <= r { return Some((best.1, best.0)); }
                return Some((best.1, best.0));
            }
            if r >= max_r { return None; }
            r = (r * 2.0).min(max_r);
        }
    }

    /// What fraction of the points carry a usable normal. Below about half, orientation is
    /// worth computing before anything leans on them.
    pub fn normal_fraction(&self) -> f32 {
        let n = self.len();
        if n == 0 { return 0.0; }
        let mut have = 0usize;
        for i in 0..n {
            if !(self.nx[i] == 0 && self.ny[i] == 0 && self.nz[i] == 127) { have += 1; }
        }
        have as f32 / n as f32
    }

    /// Distance from every point of `self` to the nearest point of `reference`.
    ///
    /// `signed` projects onto the reference point's own normal instead, which is what an
    /// M3C2-style comparison wants: it tells you which side of the reference surface the
    /// point is on, so settlement and heave do not cancel out into the same positive number.
    pub fn distance_to(&self, reference: &Analyzer, signed: bool, max_r: f32, mut progress: impl FnMut(usize)) -> Vec<f32> {
        let n = self.len();
        let mut out = vec![f32::NAN; n];
        let mut scratch: Vec<(f32, u32)> = Vec::with_capacity(256);
        for i in 0..n {
            if let Some((j, d2)) = reference.nearest(self.x[i], self.y[i], self.z[i], max_r, &mut scratch) {
                let ju = j as usize;
                let d = d2.sqrt();
                out[i] = if signed {
                    let nn = [reference.nx[ju] as f32, reference.ny[ju] as f32, reference.nz[ju] as f32];
                    let l = (nn[0] * nn[0] + nn[1] * nn[1] + nn[2] * nn[2]).sqrt();
                    let placeholder = reference.nx[ju] == 0 && reference.ny[ju] == 0 && reference.nz[ju] == 127;
                    if l > 1e-6 && !placeholder {
                        (self.x[i] - reference.x[ju]) * nn[0] / l
                            + (self.y[i] - reference.y[ju]) * nn[1] / l
                            + (self.z[i] - reference.z[ju]) * nn[2] / l
                    } else { d }
                } else { d };
            }
            if i % 65536 == 0 { progress(i); }
        }
        out
    }

    /// Point-to-plane ICP of `self` onto `reference`, returning the rigid transform to apply
    /// to `self` (row-major 4x4) and how well it did.
    ///
    /// Point-to-plane rather than point-to-point because scan data is surfaces: a point is
    /// free to slide along the surface it belongs to, and forbidding that — which
    /// point-to-point does — is what makes plain ICP crawl across a flat wall. Each pair
    /// contributes one equation, `(R p + t - q) . n = 0`, linearised in a small rotation, so
    /// an iteration is a 6x6 solve however many pairs there are.
    ///
    /// The rotation is taken about the moving cloud's own centroid. Solving for a rotation
    /// about the origin when the cloud sits tens of metres away mixes a tiny angle with a
    /// large translation in one normal matrix, and the conditioning shows.
    pub fn icp(&mut self, reference: &Analyzer, max_iter: usize, max_dist: f32, sample: usize,
               mut progress: impl FnMut(usize, f32)) -> IcpResult {
        let n = self.len();
        let mut res = IcpResult { matrix: identity4(), rms: f32::NAN, rms_history: Vec::new(), overlap: 0.0, iterations: 0, pairs: 0 };
        if n == 0 || reference.len() == 0 { return res; }
        let step = ((n + sample.max(1) - 1) / sample.max(1)).max(1);
        let idx: Vec<usize> = (0..n).step_by(step).collect();
        let mut m = identity4();
        let mut scratch: Vec<(f32, u32)> = Vec::with_capacity(256);
        let mut gate = max_dist;
        let floor = max_dist * 0.15;
        for it in 0..=max_iter {
            // one pass over the sample: correspondences, residuals, and the normal equations
            let mut ata = [[0.0f64; 6]; 6];
            let mut atb = [0.0f64; 6];
            let mut ss = 0.0f64;
            let mut cnt = 0usize;
            let mut cx = 0.0f64; let mut cy = 0.0f64; let mut cz = 0.0f64;
            let mut pts: Vec<([f32; 3], [f32; 3], f32)> = Vec::with_capacity(idx.len());
            for &i in idx.iter() {
                let p = apply4(&m, self.x[i], self.y[i], self.z[i]);
                let Some((j, d2)) = reference.nearest(p[0], p[1], p[2], gate, &mut scratch) else { continue };
                if d2.sqrt() > gate { continue; }
                let ju = j as usize;
                let nn = [reference.nx[ju] as f32, reference.ny[ju] as f32, reference.nz[ju] as f32];
                let l = (nn[0] * nn[0] + nn[1] * nn[1] + nn[2] * nn[2]).sqrt();
                if l < 1e-6 { continue; }
                let nn = [nn[0] / l, nn[1] / l, nn[2] / l];
                let r = (p[0] - reference.x[ju]) * nn[0] + (p[1] - reference.y[ju]) * nn[1] + (p[2] - reference.z[ju]) * nn[2];
                cx += p[0] as f64; cy += p[1] as f64; cz += p[2] as f64;
                pts.push((p, nn, r));
                ss += (r * r) as f64;
                cnt += 1;
            }
            if cnt < 20 { break; }
            let rms = (ss / cnt as f64).sqrt() as f32;
            res.rms = rms;
            res.rms_history.push(rms);
            res.overlap = cnt as f32 / idx.len() as f32;
            res.pairs = cnt;
            res.iterations = it;
            res.matrix = m;
            progress(it, rms);
            if it >= 2 {
                let prev = res.rms_history[res.rms_history.len() - 2];
                if prev > 0.0 && (prev - rms) / prev < 0.001 { break; }
            }
            if it == max_iter { break; }
            let c = [(cx / cnt as f64) as f32, (cy / cnt as f64) as f32, (cz / cnt as f64) as f32];
            for (p, nn, r) in pts.iter() {
                let d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
                let cr = [d[1] * nn[2] - d[2] * nn[1], d[2] * nn[0] - d[0] * nn[2], d[0] * nn[1] - d[1] * nn[0]];
                let j6 = [cr[0], cr[1], cr[2], nn[0], nn[1], nn[2]];
                for a in 0..6 {
                    atb[a] -= (j6[a] * r) as f64;
                    for b in 0..6 { ata[a][b] += (j6[a] * j6[b]) as f64; }
                }
            }
            // a little Tikhonov on the diagonal: a plane-only overlap leaves the in-plane
            // degrees of freedom unconstrained, and a singular solve is worse than a slow one
            let trace: f64 = (0..6).map(|a| ata[a][a]).sum();
            let lambda = (trace / 6.0) * 1e-9 + 1e-12;
            for a in 0..6 { ata[a][a] += lambda; }
            let Some(x) = solve6(ata, atb) else { break };
            let delta = rigid_about(
                [x[0] as f32, x[1] as f32, x[2] as f32],
                [x[3] as f32, x[4] as f32, x[5] as f32], c);
            m = mul4(&delta, &m);
            gate = (gate * 0.85).max(floor);
        }
        res
    }

    pub fn invert_normals(&mut self) {
        for i in 0..self.len() {
            let (mut a, mut b, mut c) = (self.nx[i], self.ny[i], self.nz[i]);
            flip(&mut a, &mut b, &mut c);
            self.nx[i] = a; self.ny[i] = b; self.nz[i] = c;
        }
    }

    /// One scalar per point, for the first `upto` of them (0 for all).
    ///
    /// A tile is fed its neighbours' points as well as its own, and they are there to be found
    /// by the search rather than answered for. Computing a value for them too was a third of
    /// the work on a tile with a thick halo.
    pub fn feature(&mut self, f: Feature, k: usize, radius: f32, upto: usize, mut progress: impl FnMut(usize)) -> Vec<f32> {
        use Feature::*;
        self.build();
        let n = self.len();
        let n = if upto == 0 { n } else { upto.min(n) };
        let mut out = vec![f32::NAN; n];
        let mut scratch: Vec<(f32, u32)> = Vec::with_capacity(256);
        for i in 0..n {
            if f == NeighbourCount {
                self.radius_search(i, radius, &mut scratch);
                out[i] = (scratch.len().saturating_sub(1)) as f32;
                continue;
            }
            let m = self.knn(i, k, &mut scratch);
            if m < 4 {
                continue;
            }
            // distance to the furthest of the k kept, for the density measures
            let mut rmax = 0.0f32;
            for &(d, _) in scratch.iter() {
                if d > rmax { rmax = d; }
            }
            let rmax = rmax.sqrt().max(1e-6);
            let (ev, vecs, cen) = self.local_pca(&scratch);
            let (l0, l1, l2) = (ev[0].max(0.0), ev[1].max(0.0), ev[2].max(0.0));
            let sum = (l0 + l1 + l2).max(1e-18);
            out[i] = match f {
                Roughness => {
                    let d = [self.x[i] as f64 - cen[0], self.y[i] as f64 - cen[1], self.z[i] as f64 - cen[2]];
                    (d[0] * vecs[0][0] + d[1] * vecs[1][0] + d[2] * vecs[2][0]).abs() as f32
                }
                Curvature => (l0 / sum) as f32,
                Planarity => ((l1 - l0) / l2.max(1e-18)) as f32,
                Linearity => ((l2 - l1) / l2.max(1e-18)) as f32,
                Sphericity => (l0 / l2.max(1e-18)) as f32,
                Anisotropy => ((l2 - l0) / l2.max(1e-18)) as f32,
                Omnivariance => (l0 * l1 * l2).max(0.0).powf(1.0 / 3.0) as f32,
                Eigenentropy => {
                    let mut e = 0.0f64;
                    for l in [l0, l1, l2] {
                        let p = (l / sum).max(1e-18);
                        e -= p * p.ln();
                    }
                    e as f32
                }
                Verticality => {
                    let nzv = vecs[2][0].abs().min(1.0);
                    (1.0 - nzv) as f32
                }
                VolumeDensity => (m as f32) / (4.0 / 3.0 * std::f32::consts::PI * rmax.powi(3)),
                SurfaceDensity => (m as f32) / (std::f32::consts::PI * rmax * rmax),
                EigenValue1 => l2 as f32,
                EigenValue2 => l1 as f32,
                EigenValue3 => l0 as f32,
                NeighbourCount => unreachable!(),
            };
            if i % 65536 == 0 { progress(i); }
        }
        out
    }

    /// Statistical outlier removal: drop points whose mean distance to their k nearest
    /// neighbours is more than `n_sigma` above the cloud-wide average of that distance.
    /// Returns 1 to keep, 0 to drop.
    /// The `m` nearest points to point `i`, **including `i` itself**, as CloudCompare's octree
    /// search returns them. Fewer if the cloud has fewer.
    ///
    /// Including the query point is not an oversight in either implementation: CloudCompare
    /// asks its octree for `knn` neighbours and then skips the query point when averaging, so
    /// the mean is over `knn - 1` others. Its own comment says why — asking for `knn + 1`
    /// would be more natural but would not match PCL, and matching PCL was the point.
    fn nearest_set(&self, i: usize, m: usize, scratch: &mut Vec<(f32, u32)>) -> usize {
        let mut r = self.cell;
        // Keep widening until there really are `m` points, or until the search has covered
        // the whole cloud. Stopping after a fixed number of doublings is the kind of
        // shortcut that is invisible on dense data and wrong on exactly the points these
        // filters exist to find: a speck on its own gets whatever happened to be inside the
        // last radius tried, its mean neighbour distance comes out far too small, and it
        // survives a threshold it should have failed.
        let cap = self.extent.max(self.cell);
        loop {
            self.radius_search(i, r, scratch);
            if scratch.len() >= m || r >= cap { break; }
            r = (r * 2.0).min(cap);
        }
        if scratch.len() > m {
            // Ranked on an f64 distance recomputed from the coordinates, not on the grid's
            // f32 squared distance. Two neighbours can be equal to the last bit of an f32 and
            // still be ordered, and on a surface there are a great many of those; picking a
            // different one of a near-tied pair changes which points a threshold drops.
            // Partition rather than sort: only the set of the m closest matters.
            let px = self.x[i] as f64;
            let py = self.y[i] as f64;
            let pz = self.z[i] as f64;
            let d64 = |j: u32| {
                let ju = j as usize;
                let dx = self.x[ju] as f64 - px;
                let dy = self.y[ju] as f64 - py;
                let dz = self.z[ju] as f64 - pz;
                dx * dx + dy * dy + dz * dz
            };
            // Ties broken by the point's place in the file, so the answer does not depend on
            // the order the grid happened to visit cells in, nor on which tile is asking.
            // Two points exactly equidistant from a third do occur, repeated points being the
            // obvious case, and without a rule the chosen one varies between runs.
            let gid = &self.gid;
            scratch.select_nth_unstable_by(m - 1, |a, b| {
                d64(a.1).partial_cmp(&d64(b.1)).unwrap_or(std::cmp::Ordering::Equal)
                    .then(gid[a.1 as usize].cmp(&gid[b.1 as usize]))
            });
            scratch.truncate(m);
        }
        scratch.len()
    }

    /// Statistical outlier removal.
    ///
    /// Based on CloudCompare's SOR filter — `CCCoreLib::CloudSamplingTools::sorFilter` and its
    /// per-cell worker `applySORFilterAtLevel`, read at
    /// <https://github.com/CloudCompare/CCCoreLib> commit
    /// dc8c7d80f4ef8fd6a2c302c8d5f9c35099ba8432. This is a reimplementation in Rust from the
    /// published algorithm, not translated or copied code; CCCoreLib is LGPL-2.0-or-later,
    /// which combines with this project's GPL-3.0-only. The point of following it exactly is
    /// that somebody moving between the two tools gets the same points removed for the same
    /// settings, and CloudCompare in turn follows PCL.
    ///
    /// Four details decide whether the answer matches, and all four are theirs:
    ///
    /// * the `knn` nearest points are gathered **including the query point**, and the query
    ///   point is then skipped, so each mean is over `knn - 1` distances;
    /// * a point whose mean cannot be computed keeps a distance of zero, so it survives —
    ///   this filter never removes a point for being under-populated;
    /// * the mean and standard deviation are taken over **every** point, and the standard
    ///   deviation is the population one, `sqrt(|Σd²/N − µ²|)`;
    /// * the test is `mean ≤ µ + nσ·σ`, inclusive.
    ///
    /// Their octree picks a level with about `knn` points per cell and searches from there;
    /// ours is a uniform grid sized to a few points per cell, expanding the radius until it
    /// holds enough. That is an implementation detail of the neighbour search: both return
    /// the true `knn` nearest, so the result is the same.
    ///
    /// Returns the keep mask, the mean of the mean distances, and the cut-off.
    pub fn sor(&mut self, knn: usize, n_sigma: f32, mut progress: impl FnMut(usize)) -> (Vec<u8>, f32, f32) {
        self.build();
        let n = self.len();
        // CloudCompare refuses a cloud no bigger than knn rather than filtering it; keeping
        // everything says the same thing without an error path the caller has to handle.
        if n <= knn.max(1) {
            return (vec![1u8; n], 0.0, f32::INFINITY);
        }
        let mean_d = self.mean_distances(knn, n, &mut progress);
        let (sum, sum2) = Analyzer::sums(&mean_d);
        let avg = sum / n as f64;
        let sd = (sum2 / n as f64 - avg * avg).abs().sqrt();
        let cut = avg + n_sigma as f64 * sd;
        let keep = mean_d.iter().map(|&d| if (d as f64) <= cut { 1u8 } else { 0u8 }).collect();
        (keep, avg as f32, cut as f32)
    }

    /// The mean distance to the `knn` nearest neighbours, for the first `upto` points.
    ///
    /// A tile holds the points it is responsible for first and its neighbours' points after
    /// them, so it asks for the prefix: the rest are there to be found by the search and are
    /// answered for by the tile that owns them.
    ///
    /// This is the whole cost of SOR. The caller keeps the numbers rather than a summary of
    /// them, works out one threshold over every tile, and compares against it afterwards,
    /// which is why the filter searches each neighbourhood once instead of twice.
    pub fn sor_means(&mut self, knn: usize, upto: usize, mut progress: impl FnMut(usize)) -> Vec<f32> {
        self.mean_distances(knn, upto, &mut progress)
    }
    fn mean_distances(&mut self, knn: usize, upto: usize, progress: &mut impl FnMut(usize)) -> Vec<f32> {
        self.build();
        let n = self.len();
        let knn = knn.max(1);
        let upto = upto.min(n);
        let mut mean_d = vec![0.0f32; upto];
        if n <= knn { return mean_d; }
        let mut scratch: Vec<(f32, u32)> = Vec::with_capacity(256);
        for i in 0..upto {
            self.nearest_set(i, knn, &mut scratch);
            let mut s = 0.0f64;
            let mut c = 0u32;
            for &(_, j) in scratch.iter() {
                let ju = j as usize;
                if ju == i { continue; }
                // recomputed in f64 rather than reusing the grid's f32 squared distance: the
                // threshold is a single number compared against millions of means, so a
                // rounding difference of one part in ten million decides real points
                let dx = self.x[ju] as f64 - self.x[i] as f64;
                let dy = self.y[ju] as f64 - self.y[i] as f64;
                let dz = self.z[ju] as f64 - self.z[i] as f64;
                s += (dx * dx + dy * dy + dz * dz).sqrt();
                c += 1;
            }
            // zero when there was nothing to average, which keeps the point
            mean_d[i] = if c > 0 { (s / c as f64) as f32 } else { 0.0 };
            if i % 65536 == 0 { progress(i); }
        }
        mean_d
    }
    fn sums(d: &[f32]) -> (f64, f64) {
        let mut sum = 0.0f64;
        let mut sum2 = 0.0f64;
        for &v in d {
            sum += v as f64;
            sum2 += (v as f64) * (v as f64);
        }
        (sum, sum2)
    }
    /// First half of a tiled SOR: the sum and the sum of squares of this tile's own mean
    /// distances, and how many there were. The caller adds up the tiles and gets exactly the
    /// mean and standard deviation the whole cloud would have given, because every point is
    /// counted once by the tile that owns it.
    pub fn sor_stats(&mut self, knn: usize, upto: usize, mut progress: impl FnMut(usize)) -> (f64, f64, usize) {
        let d = self.mean_distances(knn, upto, &mut progress);
        let (sum, sum2) = Analyzer::sums(&d);
        (sum, sum2, d.len())
    }
    /// Second half: the keep mask for this tile's own points against a threshold worked out
    /// over the whole cloud.
    pub fn sor_cut(&mut self, knn: usize, cut: f32, upto: usize, mut progress: impl FnMut(usize)) -> Vec<u8> {
        let d = self.mean_distances(knn, upto, &mut progress);
        d.iter().map(|&v| if (v as f64) <= cut as f64 { 1u8 } else { 0u8 }).collect()
    }

    /// Noise filter: drop points that sit too far from the best-fit plane of the points
    /// **around** them.
    ///
    /// Based on CloudCompare's noise filter — `CCCoreLib::CloudSamplingTools::noiseFilter`
    /// and `applyNoiseFilterAtLevel`, read at <https://github.com/CloudCompare/CCCoreLib>
    /// commit dc8c7d80f4ef8fd6a2c302c8d5f9c35099ba8432. Reimplemented in Rust from the
    /// published algorithm, not copied. CCCoreLib is LGPL-2.0-or-later, which combines with
    /// GPL-3.0-only.
    ///
    /// The thing that makes this filter work, and the thing our first version got wrong, is
    /// that **the threshold is local**. The plane is fitted to the neighbours with the query
    /// point left out, the spread is measured among those same neighbours, and the query
    /// point is compared against that. A global threshold over the whole cloud instead
    /// removes detail wherever the surface is smooth and keeps noise wherever it is rough.
    ///
    /// The other details that decide whether the answer matches CloudCompare's:
    ///
    /// * a neighbourhood needs **more than three** points counting the query point, so at
    ///   least three others, before a plane is fitted at all;
    /// * the query point is excluded from the plane fit and from the spread;
    /// * the spread is the population standard deviation of the neighbours' **signed**
    ///   distances to the plane, `sqrt(|Σd²·n − (Σd)²|) / n`;
    /// * the query point's own distance is compared as an absolute value, and the test is
    ///   `≤`, inclusive;
    /// * too few neighbours means the point is kept unless `remove_isolated` is set.
    pub fn noise_filter(&mut self, p: NoiseParams, upto: usize, mut progress: impl FnMut(usize)) -> Vec<u8> {
        self.build();
        let n = self.len();
        // a tile answers for its own points; its halo is there to be found, not judged
        let n = if upto == 0 { n } else { upto.min(n) };
        let mut keep = vec![0u8; n];
        let mut scratch: Vec<(f32, u32)> = Vec::with_capacity(256);
        let mut nb: Vec<(f32, u32)> = Vec::with_capacity(256);
        for i in 0..n {
            if p.use_knn {
                self.nearest_set(i, p.knn.max(1), &mut scratch);
            } else {
                self.radius_search(i, p.radius.max(1e-6), &mut scratch);
            }
            // "more than 3" counting the query point, exactly as CloudCompare tests it
            if scratch.len() <= 3 {
                keep[i] = if p.remove_isolated { 0 } else { 1 };
                continue;
            }
            nb.clear();
            nb.extend(scratch.iter().copied().filter(|&(_, j)| j as usize != i));
            if nb.len() < 3 {
                keep[i] = if p.remove_isolated { 0 } else { 1 };
                continue;
            }
            let (_, vecs, cen) = self.local_pca(&nb);
            let nrm = [vecs[0][0], vecs[1][0], vecs[2][0]];
            let max_d = if p.use_absolute_error {
                p.absolute_error as f64
            } else {
                let mut sum = 0.0f64;
                let mut sum2 = 0.0f64;
                for &(_, j) in nb.iter() {
                    let j = j as usize;
                    let d = (self.x[j] as f64 - cen[0]) * nrm[0]
                          + (self.y[j] as f64 - cen[1]) * nrm[1]
                          + (self.z[j] as f64 - cen[2]) * nrm[2];
                    sum += d;
                    sum2 += d * d;
                }
                let m = nb.len() as f64;
                let stddev = (sum2 * m - sum * sum).abs().sqrt() / m;
                stddev * p.n_sigma as f64
            };
            let d = ((self.x[i] as f64 - cen[0]) * nrm[0]
                   + (self.y[i] as f64 - cen[1]) * nrm[1]
                   + (self.z[i] as f64 - cen[2]) * nrm[2]).abs();
            keep[i] = if d <= max_d { 1 } else { 0 };
            if i % 65536 == 0 { progress(i); }
        }
        keep
    }

    /// Points closer together than `tol` collapse to the first one in the file.
    ///
    /// The survivor is chosen by global index rather than by position in this Analyzer, so a
    /// tile that is looking at part of the cloud removes the same points the whole cloud
    /// would. A removed point does not remove its own neighbours, which is CloudCompare's
    /// behaviour and ours before tiling: the chain always runs towards smaller indices.
    pub fn duplicates(&mut self, tol: f32) -> Vec<u8> {
        self.build();
        let n = self.len();
        let mut keep = vec![1u8; n];
        let mut scratch: Vec<(f32, u32)> = Vec::with_capacity(64);
        let mut order: Vec<u32> = (0..n as u32).collect();
        order.sort_unstable_by_key(|&i| self.gid[i as usize]);
        for oi in 0..n {
            let i = order[oi] as usize;
            if keep[i] == 0 { continue; }
            self.radius_search(i, tol, &mut scratch);
            let gi = self.gid[i];
            for &(_, j) in scratch.iter() {
                let ju = j as usize;
                if self.gid[ju] > gi { keep[ju] = 0; }
            }
        }
        keep
    }

    /// Label points that are within `radius` of each other, largest cluster first.
    /// Returns a per-point label as f32 (NaN where the cluster was below `min_pts`).
    pub fn connected_components(&mut self, radius: f32, min_pts: usize, mut progress: impl FnMut(usize)) -> (Vec<f32>, u32) {
        self.build();
        let n = self.len();
        let mut label = vec![u32::MAX; n];
        let mut scratch: Vec<(f32, u32)> = Vec::with_capacity(256);
        let mut queue: Vec<u32> = Vec::new();
        let mut sizes: Vec<u32> = Vec::new();
        let mut next = 0u32;
        let mut done = 0usize;
        for seed in 0..n {
            if label[seed] != u32::MAX { continue; }
            label[seed] = next;
            queue.clear();
            queue.push(seed as u32);
            let mut size = 0u32;
            while let Some(cur) = queue.pop() {
                size += 1;
                done += 1;
                if done % 65536 == 0 { progress(done); }
                self.radius_search(cur as usize, radius, &mut scratch);
                for &(_, j) in scratch.iter() {
                    let ju = j as usize;
                    if label[ju] == u32::MAX {
                        label[ju] = next;
                        queue.push(j);
                    }
                }
            }
            sizes.push(size);
            next += 1;
        }
        // rank by size so label 0 is the biggest cluster, which is what a user expects
        let mut order: Vec<u32> = (0..next).collect();
        order.sort_by(|&a, &b| sizes[b as usize].cmp(&sizes[a as usize]));
        let mut rank = vec![0u32; next as usize];
        for (r, &c) in order.iter().enumerate() {
            rank[c as usize] = r as u32;
        }
        let mut kept = 0u32;
        for &c in order.iter() {
            if sizes[c as usize] as usize >= min_pts { kept += 1; }
        }
        let out = label
            .iter()
            .map(|&l| {
                if l == u32::MAX { return f32::NAN; }
                if (sizes[l as usize] as usize) < min_pts { f32::NAN } else { rank[l as usize] as f32 }
            })
            .collect();
        (out, kept)
    }

    /// Keep one point per voxel of side `spacing` — the spatial subsample.
    ///
    /// The one kept is the one that comes first in the file. Position in this Analyzer would
    /// do just as well for a cloud held whole, but a tile sees its own points before its
    /// neighbours' and would then keep a different point in every voxel that straddles a
    /// tile edge.
    pub fn spatial_subsample(&mut self, spacing: f32) -> Vec<u8> {
        let inv = 1.0 / spacing.max(1e-5);
        let mut first: FastMap<i64, u32> = FastMap::default();
        let n = self.len();
        for i in 0..n {
            let k = key(
                (self.x[i] * inv).floor() as i32,
                (self.y[i] * inv).floor() as i32,
                (self.z[i] * inv).floor() as i32,
            );
            let g = self.gid[i];
            match first.get_mut(&k) {
                Some(best) => { if g < self.gid[*best as usize] { *best = i as u32; } }
                None => { first.insert(k, i as u32); }
            }
        }
        let mut keep = vec![0u8; n];
        for (_, &i) in first.iter() { keep[i as usize] = 1; }
        keep
    }

    /// Pack the current normals back into the caller's record buffers, leaf by leaf.
    pub fn write_normals(&self, at: usize, recs: &mut [u8]) -> usize {
        const REC: usize = 14;
        let n = recs.len() / REC;
        for i in 0..n {
            let s = at + i;
            if s >= self.len() { break; }
            recs[i * REC + 10] = self.nx[s] as u8;
            recs[i * REC + 11] = self.ny[s] as u8;
            recs[i * REC + 12] = self.nz[s] as u8;
        }
        at + n
    }
}
