// Distance from points to a triangle mesh.
//
// Point-to-triangle, not point-to-nearest-vertex: a coarse mesh's vertices can be a long way
// from its surface, and the difference is the whole measurement. Triangles go into a uniform
// grid by their bounding boxes, so a query only tests the triangles that could be nearest —
// the same trick as the neighbour search, one dimension of geometry further along.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Default)]
pub struct FxHasher { h: u64 }
impl Hasher for FxHasher {
    fn finish(&self) -> u64 { self.h }
    fn write(&mut self, bytes: &[u8]) { for &b in bytes { self.h = (self.h ^ b as u64).wrapping_mul(0x1000_0000_1b3); } }
    fn write_i64(&mut self, i: i64) {
        let mut h = (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        h ^= h >> 29; h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9); h ^= h >> 32;
        self.h = h;
    }
    fn write_u64(&mut self, i: u64) { self.write_i64(i as i64) }
}
type FastMap<K, V> = HashMap<K, V, BuildHasherDefault<FxHasher>>;

#[inline]
fn key(x: i32, y: i32, z: i32) -> i64 {
    ((x as i64 & 0x1F_FFFF) << 42) | ((y as i64 & 0x1F_FFFF) << 21) | (z as i64 & 0x1F_FFFF)
}

/// Squared distance from a point to a triangle, and the sign of the side it is on.
/// The classic region test: project into the triangle's plane, and if the projection falls
/// outside, clamp to the nearest edge or vertex.
#[inline]
fn point_tri_sq(p: [f32; 3], a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> (f32, f32) {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    let d1 = ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2];
    let d2 = ac[0] * ap[0] + ac[1] * ap[1] + ac[2] * ap[2];
    let n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    let side = ap[0] * n[0] + ap[1] * n[1] + ap[2] * n[2];
    let closest = if d1 <= 0.0 && d2 <= 0.0 { a } else {
        let bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
        let d3 = ab[0] * bp[0] + ab[1] * bp[1] + ab[2] * bp[2];
        let d4 = ac[0] * bp[0] + ac[1] * bp[1] + ac[2] * bp[2];
        if d3 >= 0.0 && d4 <= d3 { b } else {
            let vc = d1 * d4 - d3 * d2;
            if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
                let v = d1 / (d1 - d3);
                [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]
            } else {
                let cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
                let d5 = ab[0] * cp[0] + ab[1] * cp[1] + ab[2] * cp[2];
                let d6 = ac[0] * cp[0] + ac[1] * cp[1] + ac[2] * cp[2];
                if d6 >= 0.0 && d5 <= d6 { c } else {
                    let vb = d5 * d2 - d1 * d6;
                    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
                        let w = d2 / (d2 - d6);
                        [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]
                    } else {
                        let va = d3 * d6 - d5 * d4;
                        if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
                            let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                            [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]
                        } else {
                            let denom = 1.0 / (va + vb + vc);
                            let v = vb * denom;
                            let w = vc * denom;
                            [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
                        }
                    }
                }
            }
        }
    };
    let d = [p[0] - closest[0], p[1] - closest[1], p[2] - closest[2]];
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2], side)
}

pub struct MeshGrid {
    cell: f32,
    inv: f32,
    cells: FastMap<i64, Vec<u32>>,
    pos: Vec<f32>,
    idx: Vec<u32>,
}

impl MeshGrid {
    /// The cell size is the mean triangle extent, so a triangle lands in a handful of cells
    /// rather than one enormous one or ten thousand small ones.
    pub fn new(pos: Vec<f32>, idx: Vec<u32>) -> MeshGrid {
        let tris = idx.len() / 3;
        let mut mean = 0.0f64;
        for t in 0..tris {
            let mut lo = [f32::MAX; 3];
            let mut hi = [f32::MIN; 3];
            for k in 0..3 {
                let v = idx[t * 3 + k] as usize * 3;
                for a in 0..3 { lo[a] = lo[a].min(pos[v + a]); hi[a] = hi[a].max(pos[v + a]); }
            }
            mean += ((hi[0] - lo[0]) + (hi[1] - lo[1]) + (hi[2] - lo[2])) as f64 / 3.0;
        }
        let cell = ((mean / tris.max(1) as f64) as f32).max(1e-4);
        let inv = 1.0 / cell;
        let mut cells: FastMap<i64, Vec<u32>> = FastMap::default();
        for t in 0..tris {
            let mut lo = [f32::MAX; 3];
            let mut hi = [f32::MIN; 3];
            for k in 0..3 {
                let v = idx[t * 3 + k] as usize * 3;
                for a in 0..3 { lo[a] = lo[a].min(pos[v + a]); hi[a] = hi[a].max(pos[v + a]); }
            }
            let l = [(lo[0] * inv).floor() as i32, (lo[1] * inv).floor() as i32, (lo[2] * inv).floor() as i32];
            let h = [(hi[0] * inv).floor() as i32, (hi[1] * inv).floor() as i32, (hi[2] * inv).floor() as i32];
            // a triangle spanning an absurd number of cells is registered by its ends only;
            // the expanding search still finds it
            let span = ((h[0] - l[0] + 1) as i64) * ((h[1] - l[1] + 1) as i64) * ((h[2] - l[2] + 1) as i64);
            if span > 512 {
                for k in 0..3 {
                    let v = idx[t * 3 + k] as usize * 3;
                    let c = key((pos[v] * inv).floor() as i32, (pos[v + 1] * inv).floor() as i32, (pos[v + 2] * inv).floor() as i32);
                    cells.entry(c).or_default().push(t as u32);
                }
                continue;
            }
            for z in l[2]..=h[2] { for y in l[1]..=h[1] { for x in l[0]..=h[0] {
                cells.entry(key(x, y, z)).or_default().push(t as u32);
            }}}
        }
        MeshGrid { cell, inv, cells, pos, idx }
    }

    /// Distance from one point to the nearest triangle, searching outward a ring at a time
    /// and stopping once no unsearched cell can be closer than the best already found.
    pub fn distance(&self, p: [f32; 3], max_r: f32) -> Option<(f32, f32)> {
        let c = [(p[0] * self.inv).floor() as i32, (p[1] * self.inv).floor() as i32, (p[2] * self.inv).floor() as i32];
        let mut best = f32::INFINITY;
        let mut side = 0.0f32;
        let max_ring = ((max_r * self.inv).ceil() as i32).max(1).min(256);
        for r in 0..=max_ring {
            for dz in -r..=r { for dy in -r..=r { for dx in -r..=r {
                if r > 0 && dx.abs() != r && dy.abs() != r && dz.abs() != r { continue; }   // shell only
                let Some(list) = self.cells.get(&key(c[0] + dx, c[1] + dy, c[2] + dz)) else { continue };
                for &t in list {
                    let t = t as usize;
                    let a = self.idx[t * 3] as usize * 3;
                    let b = self.idx[t * 3 + 1] as usize * 3;
                    let cc = self.idx[t * 3 + 2] as usize * 3;
                    let (d2, s) = point_tri_sq(p,
                        [self.pos[a], self.pos[a + 1], self.pos[a + 2]],
                        [self.pos[b], self.pos[b + 1], self.pos[b + 2]],
                        [self.pos[cc], self.pos[cc + 1], self.pos[cc + 2]]);
                    if d2 < best { best = d2; side = s; }
                }
            }}}
            // every point within r cells has been covered, so anything closer would already be here
            if best.is_finite() && best.sqrt() <= r as f32 * self.cell { break; }
            if r as f32 * self.cell > max_r { break; }
        }
        if best.is_finite() { Some((best.sqrt(), side)) } else { None }
    }

    /// Distance for a whole cloud. `signed` reports which side of the surface each point is on.
    pub fn distances(&self, pts: &[f32], signed: bool, max_r: f32, mut progress: impl FnMut(usize)) -> Vec<f32> {
        let n = pts.len() / 3;
        let mut out = vec![f32::NAN; n];
        for i in 0..n {
            if let Some((d, s)) = self.distance([pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]], max_r) {
                out[i] = if signed && s < 0.0 { -d } else { d };
            }
            if i % 65536 == 0 { progress(i); }
        }
        out
    }
}
