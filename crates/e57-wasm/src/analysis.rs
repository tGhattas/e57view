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

pub struct Analyzer {
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub z: Vec<f32>,
    pub nx: Vec<i8>,
    pub ny: Vec<i8>,
    pub nz: Vec<i8>,
    cell: f32,
    inv_cell: f32,
    // CSR-style grid: cell key -> slice of `order`
    starts: FastMap<i64, (u32, u32)>,
    order: Vec<u32>,
    built: bool,
}

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

impl Analyzer {
    pub fn new(cell: f32) -> Analyzer {
        let cell = cell.max(1e-4);
        Analyzer {
            x: Vec::new(), y: Vec::new(), z: Vec::new(),
            nx: Vec::new(), ny: Vec::new(), nz: Vec::new(),
            cell, inv_cell: 1.0 / cell,
            starts: FastMap::default(), order: Vec::new(), built: false,
        }
    }

    pub fn len(&self) -> usize { self.x.len() }

    /// Decode one octree leaf's 14-byte records into the flat arrays.
    pub fn add_records(&mut self, origin: [f32; 3], size: f32, recs: &[u8]) {
        const REC: usize = 14;
        let n = recs.len() / REC;
        let k = size / 65536.0;
        self.x.reserve(n); self.y.reserve(n); self.z.reserve(n);
        for i in 0..n {
            let o = i * REC;
            let qx = u16::from_le_bytes([recs[o], recs[o + 1]]) as f32;
            let qy = u16::from_le_bytes([recs[o + 2], recs[o + 3]]) as f32;
            let qz = u16::from_le_bytes([recs[o + 4], recs[o + 5]]) as f32;
            self.x.push(origin[0] + qx * k);
            self.y.push(origin[1] + qy * k);
            self.z.push(origin[2] + qz * k);
            self.nx.push(recs[o + 10] as i8);
            self.ny.push(recs[o + 11] as i8);
            self.nz.push(recs[o + 12] as i8);
        }
        self.built = false;
    }

    /// One counting pass builds the grid; nothing is allocated per cell.
    pub fn build(&mut self) {
        if self.built { return; }
        let n = self.x.len();
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

    /// Indices within `radius` of point i, searching the 27 cells around it.
    /// `out` is reused by the caller to avoid an allocation per point.
    #[inline]
    fn radius_search(&self, i: usize, radius: f32, out: &mut Vec<(f32, u32)>) {
        out.clear();
        let (px, py, pz) = (self.x[i], self.y[i], self.z[i]);
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
            scratch.select_nth_unstable_by(k, |a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
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

    /// Make neighbouring normals agree, then flip the whole cloud outward.
    ///
    /// A breadth-first walk over the neighbour graph propagates orientation from a seed,
    /// flipping any normal that disagrees with the one it came from. That is the spirit of
    /// a minimum spanning tree traversal without the cost of building one. Each connected
    /// component is then flipped as a unit so its normals point away from the cloud centre,
    /// or toward a viewpoint when one is supplied.
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
            while let Some(cur) = queue.pop() {
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
                        self.nx[ju] = -self.nx[ju].max(-127);
                        self.ny[ju] = -self.ny[ju].max(-127);
                        self.nz[ju] = -self.nz[ju].max(-127);
                        if self.nx[ju] == 0 && self.ny[ju] == 0 && self.nz[ju] == 127 { self.nz[ju] = 126; }
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
                    self.nx[pu] = -self.nx[pu].max(-127);
                    self.ny[pu] = -self.ny[pu].max(-127);
                    self.nz[pu] = -self.nz[pu].max(-127);
                    if self.nx[pu] == 0 && self.ny[pu] == 0 && self.nz[pu] == 127 { self.nz[pu] = 126; }
                }
            }
        }
    }

    pub fn invert_normals(&mut self) {
        for i in 0..self.len() {
            self.nx[i] = -self.nx[i].max(-127);
            self.ny[i] = -self.ny[i].max(-127);
            self.nz[i] = -self.nz[i].max(-127);
            if self.nx[i] == 0 && self.ny[i] == 0 && self.nz[i] == 127 { self.nz[i] = 126; }
        }
    }

    /// One scalar per point.
    pub fn feature(&mut self, f: Feature, k: usize, radius: f32, mut progress: impl FnMut(usize)) -> Vec<f32> {
        use Feature::*;
        self.build();
        let n = self.len();
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
    pub fn sor(&mut self, k: usize, n_sigma: f32, mut progress: impl FnMut(usize)) -> (Vec<u8>, f32, f32) {
        self.build();
        let n = self.len();
        let mut mean_d = vec![0.0f32; n];
        let mut scratch: Vec<(f32, u32)> = Vec::with_capacity(256);
        for i in 0..n {
            let m = self.knn(i, k, &mut scratch);
            if m < 2 {
                mean_d[i] = f32::INFINITY;
                continue;
            }
            let mut s = 0.0f32;
            let mut c = 0u32;
            for &(d, j) in scratch.iter() {
                if j as usize == i { continue; }
                s += d.sqrt();
                c += 1;
            }
            mean_d[i] = if c > 0 { s / c as f32 } else { f32::INFINITY };
            if i % 65536 == 0 { progress(i); }
        }
        let finite: Vec<f32> = mean_d.iter().copied().filter(|v| v.is_finite()).collect();
        let mu = finite.iter().sum::<f32>() / finite.len().max(1) as f32;
        let var = finite.iter().map(|v| (v - mu) * (v - mu)).sum::<f32>() / finite.len().max(1) as f32;
        let sd = var.sqrt();
        let cut = mu + n_sigma * sd;
        let keep = mean_d.iter().map(|&d| if d <= cut { 1u8 } else { 0u8 }).collect();
        (keep, mu, cut)
    }

    /// Noise filter: drop points that sit too far from the best-fit plane of their
    /// neighbourhood, which removes speckle while leaving real edges alone.
    pub fn noise_filter(&mut self, k: usize, n_sigma: f32, mut progress: impl FnMut(usize)) -> Vec<u8> {
        self.build();
        let n = self.len();
        let mut dist = vec![0.0f32; n];
        let mut scratch: Vec<(f32, u32)> = Vec::with_capacity(256);
        for i in 0..n {
            let m = self.knn(i, k, &mut scratch);
            if m < 4 {
                dist[i] = 0.0;
                continue;
            }
            let (_, vecs, cen) = self.local_pca(&scratch);
            let d = [self.x[i] as f64 - cen[0], self.y[i] as f64 - cen[1], self.z[i] as f64 - cen[2]];
            dist[i] = (d[0] * vecs[0][0] + d[1] * vecs[1][0] + d[2] * vecs[2][0]).abs() as f32;
            if i % 65536 == 0 { progress(i); }
        }
        let mu = dist.iter().sum::<f32>() / n.max(1) as f32;
        let var = dist.iter().map(|v| (v - mu) * (v - mu)).sum::<f32>() / n.max(1) as f32;
        let cut = mu + n_sigma * var.sqrt();
        dist.iter().map(|&d| if d <= cut { 1u8 } else { 0u8 }).collect()
    }

    /// Points closer together than `tol` collapse to the first one seen.
    pub fn duplicates(&mut self, tol: f32) -> Vec<u8> {
        self.build();
        let n = self.len();
        let mut keep = vec![1u8; n];
        let mut scratch: Vec<(f32, u32)> = Vec::with_capacity(64);
        for i in 0..n {
            if keep[i] == 0 { continue; }
            self.radius_search(i, tol, &mut scratch);
            for &(_, j) in scratch.iter() {
                let ju = j as usize;
                if ju > i { keep[ju] = 0; }
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
    pub fn spatial_subsample(&mut self, spacing: f32) -> Vec<u8> {
        let inv = 1.0 / spacing.max(1e-5);
        let mut taken: FastMap<i64, ()> = FastMap::default();
        let n = self.len();
        let mut keep = vec![0u8; n];
        for i in 0..n {
            let k = key(
                (self.x[i] * inv).floor() as i32,
                (self.y[i] * inv).floor() as i32,
                (self.z[i] * inv).floor() as i32,
            );
            if taken.insert(k, ()).is_none() {
                keep[i] = 1;
            }
        }
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
