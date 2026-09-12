// SPDX-License-Identifier: GPL-3.0-only
// Surface reconstruction from oriented points.
//
// The scans this viewer opens carry per-point normals (the libE57 `nor` extension), which
// is what makes a good surface cheap: each point is a small piece of oriented plane, so a
// truncated signed distance field can be splatted directly instead of being solved for.
//
//   1. Splat.   For every point, walk the normal from -trunc to +trunc and accumulate the
//               signed distance t into a sparse voxel grid with trilinear weights. Averaging
//               many points per voxel is what removes scanner noise, so the field is far
//               smoother than the points that made it.
//   2. Extract. Naive surface nets: one vertex per sign-changing cell placed at the centroid
//               of its edge crossings, then a quad around every sign-changing grid edge.
//               No lookup tables to mistranscribe, manifold output, and cells with no data
//               simply produce no quad — an open scan stays open instead of being capped.
//   3. Polish.  Taubin smoothing (shrink then unshrink, so volume is preserved) and normals
//               from the field gradient, which are smoother than face normals.
//
// Clouds without normals fall back to a density isosurface, which is blobbier but produces
// something usable rather than nothing.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

// ---------------------------------------------------------------- fast integer-keyed map
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

const B: i32 = 8; // brick edge, in voxels
const BV: usize = (B * B * B) as usize;
const W_MAX: u16 = 60_000;

#[inline]
fn key(bx: i32, by: i32, bz: i32) -> i64 {
    // 21 bits per axis, enough for a 2 million voxel span in each direction
    ((bx as i64 & 0x1F_FFFF) << 42) | ((by as i64 & 0x1F_FFFF) << 21) | (bz as i64 & 0x1F_FFFF)
}
#[inline]
fn div_floor(a: i32, b: i32) -> i32 {
    if a >= 0 { a / b } else { -(((-a) + b - 1) / b) }
}

struct Brick {
    sd: [i16; BV], // signed distance, scaled so i16::MAX == trunc
    w: [u16; BV],
    r: [u8; BV],
    g: [u8; BV],
    b: [u8; BV],
}
impl Brick {
    fn new() -> Box<Brick> {
        Box::new(Brick { sd: [0; BV], w: [0; BV], r: [0; BV], g: [0; BV], b: [0; BV] })
    }
}

pub struct MeshStats {
    pub points_used: u64,
    pub voxels: u64,
    pub vertices: u32,
    pub triangles: u32,
    pub oriented: u64,
    pub unoriented: u64,
    /// Edges with exactly one triangle: the rim of every hole and of the scan's own border.
    /// Divided by the triangle count it is the one number that says whether this surface is
    /// complete enough to measure against, which is what an agent needs to know.
    pub boundary_edges: u32,
}

/// Count edges used by exactly one triangle.
fn boundary_edges(idx: &[u32]) -> u32 {
    let mut seen: FastMap<u64, u32> = FastMap::default();
    seen.reserve(idx.len());
    for t in idx.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            let e = if a < b { (a as u64) << 32 | b as u64 } else { (b as u64) << 32 | a as u64 };
            *seen.entry(e).or_insert(0) += 1;
        }
    }
    seen.values().filter(|&&c| c == 1).count() as u32
}

pub struct Mesh {
    pub pos: Vec<f32>,
    pub nrm: Vec<f32>,
    pub col: Vec<u8>,
    pub idx: Vec<u32>,
}

pub struct Mesher {
    voxel: f32,
    inv_voxel: f32,
    trunc: f32,     // in metres
    sd_scale: f32,  // metres per i16 step
    min_w: f32,
    bricks: FastMap<i64, Box<Brick>>,
    pts: u64,
    oriented: u64,
    unoriented: u64,
    // cache of the last brick touched: consecutive samples nearly always land in it
    last_key: i64,
    last_ptr: *mut Brick,
}

impl Mesher {
    pub fn new(voxel: f32, trunc_voxels: f32, min_weight: f32) -> Mesher {
        let voxel = voxel.max(1e-4);
        let trunc = (trunc_voxels.max(0.75)) * voxel;
        Mesher {
            voxel,
            inv_voxel: 1.0 / voxel,
            trunc,
            sd_scale: trunc / 32767.0,
            min_w: min_weight.max(0.0),
            bricks: FastMap::default(),
            pts: 0,
            oriented: 0,
            unoriented: 0,
            last_key: i64::MIN,
            last_ptr: std::ptr::null_mut(),
        }
    }

    #[inline]
    fn brick_mut(&mut self, bx: i32, by: i32, bz: i32) -> *mut Brick {
        let k = key(bx, by, bz);
        if k == self.last_key && !self.last_ptr.is_null() {
            return self.last_ptr;
        }
        let p: *mut Brick = &mut **self.bricks.entry(k).or_insert_with(Brick::new);
        self.last_key = k;
        self.last_ptr = p;
        p
    }

    /// Accumulate one sample of the field at grid coordinate (gx,gy,gz).
    #[inline]
    fn accum(&mut self, gx: i32, gy: i32, gz: i32, sd: f32, w: f32, rgb: (u8, u8, u8)) {
        if w <= 0.0 {
            return;
        }
        let (bx, by, bz) = (div_floor(gx, B), div_floor(gy, B), div_floor(gz, B));
        let (lx, ly, lz) = (gx - bx * B, gy - by * B, gz - bz * B);
        let i = (lx + ly * B + lz * B * B) as usize;
        let br = self.brick_mut(bx, by, bz);
        // Safety: `br` points into a Box owned by self.bricks, which is not resized while used.
        unsafe {
            let br = &mut *br;
            let wn = (w * 256.0) as u32;
            let w0 = br.w[i] as u32;
            let wsum = w0 + wn;
            if wsum == 0 {
                return;
            }
            let old = br.sd[i] as f32 * self.sd_scale;
            let blended = (old * w0 as f32 + sd * wn as f32) / wsum as f32;
            br.sd[i] = (blended / self.sd_scale).clamp(-32767.0, 32767.0) as i16;
            br.r[i] = ((br.r[i] as u32 * w0 + rgb.0 as u32 * wn) / wsum) as u8;
            br.g[i] = ((br.g[i] as u32 * w0 + rgb.1 as u32 * wn) / wsum) as u8;
            br.b[i] = ((br.b[i] as u32 * w0 + rgb.2 as u32 * wn) / wsum) as u8;
            br.w[i] = wsum.min(W_MAX as u32) as u16;
        }
    }

    /// Splat one oriented point: walk its normal across the truncation band.
    pub fn add_point(&mut self, p: [f32; 3], n: Option<[f32; 3]>, rgb: (u8, u8, u8)) {
        self.pts += 1;
        match n {
            Some(n) => {
                self.oriented += 1;
                let steps = (self.trunc * self.inv_voxel).ceil().max(1.0) as i32;
                for s in -steps..=steps {
                    let t = s as f32 * self.voxel;
                    if t.abs() > self.trunc {
                        continue;
                    }
                    // The field value at p + t*n is t: positive on the side the normal faces.
                    let fx = (p[0] + t * n[0]) * self.inv_voxel;
                    let fy = (p[1] + t * n[1]) * self.inv_voxel;
                    let fz = (p[2] + t * n[2]) * self.inv_voxel;
                    // linear falloff so samples near the surface dominate
                    let wt = 1.0 - (t.abs() / self.trunc) * 0.75;
                    self.trilinear(fx, fy, fz, t, wt, rgb);
                }
            }
            None => {
                self.unoriented += 1;
                let fx = p[0] * self.inv_voxel;
                let fy = p[1] * self.inv_voxel;
                let fz = p[2] * self.inv_voxel;
                // density mode: no signed distance, just occupancy
                self.trilinear(fx, fy, fz, 0.0, 1.0, rgb);
            }
        }
    }

    #[inline]
    fn trilinear(&mut self, fx: f32, fy: f32, fz: f32, sd: f32, w: f32, rgb: (u8, u8, u8)) {
        let ix = fx.floor();
        let iy = fy.floor();
        let iz = fz.floor();
        let tx = fx - ix;
        let ty = fy - iy;
        let tz = fz - iz;
        let (ix, iy, iz) = (ix as i32, iy as i32, iz as i32);
        for (dz, wz) in [(0, 1.0 - tz), (1, tz)] {
            if wz <= 0.0 {
                continue;
            }
            for (dy, wy) in [(0, 1.0 - ty), (1, ty)] {
                let wzy = wz * wy;
                if wzy <= 0.0 {
                    continue;
                }
                for (dx, wx) in [(0, 1.0 - tx), (1, tx)] {
                    let ww = wzy * wx * w;
                    if ww > 0.001 {
                        self.accum(ix + dx, iy + dy, iz + dz, sd, ww, rgb);
                    }
                }
            }
        }
    }

    /// Records are the viewer's 14-byte layout: u16 x,y,z quantised in the leaf cube,
    /// u8 r,g,b, u8 intensity, i8 nx,ny,nz, pad.
    ///
    /// `model` is the cloud's 4x4 transform, **row-major**, or None for identity. The points
    /// on screen are the raw records seen through that matrix, so the surface has to be built
    /// through it as well or it will not sit on the cloud it came from.
    pub fn add_records(&mut self, origin: [f32; 3], size: f32, recs: &[u8], stride: usize, model: Option<&[f32; 16]>) {
        const REC: usize = 14;
        let n = recs.len() / REC;
        let k = size / 65536.0;
        let step = stride.max(1);
        let mut i = 0usize;
        while i < n {
            let o = i * REC;
            let qx = u16::from_le_bytes([recs[o], recs[o + 1]]) as f32;
            let qy = u16::from_le_bytes([recs[o + 2], recs[o + 3]]) as f32;
            let qz = u16::from_le_bytes([recs[o + 4], recs[o + 5]]) as f32;
            let mut p = [origin[0] + qx * k, origin[1] + qy * k, origin[2] + qz * k];
            let rgb = (recs[o + 6], recs[o + 7], recs[o + 8]);
            let nx = recs[o + 10] as i8;
            let ny = recs[o + 11] as i8;
            let nz = recs[o + 12] as i8;
            // (0,0,127) is the placeholder written when a file carries no normals
            let mut n = if nx == 0 && ny == 0 && nz == 127 {
                None
            } else {
                let (a, b, c) = (nx as f32 / 127.0, ny as f32 / 127.0, nz as f32 / 127.0);
                let len = (a * a + b * b + c * c).sqrt();
                if len > 0.35 {
                    Some([a / len, b / len, c / len])
                } else {
                    None
                }
            };
            if let Some(m) = model {
                p = [
                    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
                    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
                    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
                ];
                if let Some(v) = n {
                    let tx = m[0] * v[0] + m[1] * v[1] + m[2] * v[2];
                    let ty = m[4] * v[0] + m[5] * v[1] + m[6] * v[2];
                    let tz = m[8] * v[0] + m[9] * v[1] + m[10] * v[2];
                    let l = (tx * tx + ty * ty + tz * tz).sqrt();
                    n = if l > 1e-9 { Some([tx / l, ty / l, tz / l]) } else { None };
                }
            }
            self.add_point(p, n, rgb);
            i += step;
        }
    }

    pub fn voxel_count(&self) -> u64 {
        self.bricks.len() as u64 * BV as u64
    }
    pub fn brick_count(&self) -> usize {
        self.bricks.len()
    }

    // ------------------------------------------------------------ extraction
    #[inline]
    fn sample(&self, gx: i32, gy: i32, gz: i32) -> Option<(f32, f32, [u8; 3])> {
        let (bx, by, bz) = (div_floor(gx, B), div_floor(gy, B), div_floor(gz, B));
        let br = self.bricks.get(&key(bx, by, bz))?;
        let (lx, ly, lz) = (gx - bx * B, gy - by * B, gz - bz * B);
        let i = (lx + ly * B + lz * B * B) as usize;
        Some((br.sd[i] as f32 * self.sd_scale, br.w[i] as f32 / 256.0, [br.r[i], br.g[i], br.b[i]]))
    }

    /// Field value used for the isosurface, with the confidence behind it.
    ///
    /// Oriented data uses the signed distance and refuses voxels too few points reached, so
    /// an unscanned gap stays a gap. Density-only data uses (iso - weight): there empty space
    /// is meaningful — it is the outside — so a voxel with no data is valid and positive,
    /// otherwise the field never crosses zero and no surface is found at all.
    #[inline]
    fn field(&self, gx: i32, gy: i32, gz: i32, density: bool, iso: f32) -> Option<(f32, [u8; 3], f32)> {
        match self.sample(gx, gy, gz) {
            Some((sd, w, c)) => {
                if density {
                    Some((iso - w, c, w))
                } else if w < self.min_w {
                    None
                } else {
                    Some((sd, c, w))
                }
            }
            None => {
                if density {
                    Some((iso, [0, 0, 0], 0.0))
                } else {
                    None
                }
            }
        }
    }

    pub fn extract(&self, smooth_iters: u32, density_iso: f32) -> (Mesh, MeshStats) {
        let density = self.oriented * 4 < self.unoriented; // mostly unoriented input
        let iso = density_iso.max(0.001);

        // cells that straddle the surface get one vertex each
        let mut cell_vert: FastMap<i64, u32> = FastMap::default();
        let mut pos: Vec<f32> = Vec::new();
        let mut col: Vec<u8> = Vec::new();

        // Corner offsets of a cell, and the 12 edges as corner index pairs.
        const CORNER: [[i32; 3]; 8] = [
            [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
            [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
        ];
        const EDGE: [[usize; 2]; 12] = [
            [0, 1], [2, 3], [4, 5], [6, 7],
            [0, 2], [1, 3], [4, 6], [5, 7],
            [0, 4], [1, 5], [2, 6], [3, 7],
        ];

        let brick_keys: Vec<(i32, i32, i32)> = self
            .bricks
            .keys()
            .map(|k| {
                let sx = |v: i64| ((v << 43) >> 43) as i32; // sign-extend 21 bits
                (sx(k >> 42), sx(k >> 21), sx(*k))
            })
            .collect();

        let mut f = [0.0f32; 8];
        let mut c8 = [[0u8; 3]; 8];
        let mut w8 = [0.0f32; 8];
        for &(bx, by, bz) in &brick_keys {
            for lz in 0..B {
                for ly in 0..B {
                    for lx in 0..B {
                        let (gx, gy, gz) = (bx * B + lx, by * B + ly, bz * B + lz);
                        let mut ok = true;
                        let mut neg = 0u32;
                        for ci in 0..8 {
                            match self.field(gx + CORNER[ci][0], gy + CORNER[ci][1], gz + CORNER[ci][2], density, iso) {
                                Some((v, c, w)) => {
                                    f[ci] = v;
                                    c8[ci] = c;
                                    w8[ci] = w;
                                    if v < 0.0 {
                                        neg += 1;
                                    }
                                }
                                None => {
                                    ok = false;
                                    break;
                                }
                            }
                        }
                        if !ok || neg == 0 || neg == 8 {
                            continue;
                        }
                        // vertex at the centroid of the zero crossings on the cell's edges
                        let (mut sx, mut sy, mut sz) = (0.0f32, 0.0f32, 0.0f32);
                        let (mut cr, mut cg, mut cb) = (0.0f32, 0.0f32, 0.0f32);
                        let mut nx = 0.0f32;
                        for e in EDGE.iter() {
                            let (a, b) = (e[0], e[1]);
                            if (f[a] < 0.0) == (f[b] < 0.0) {
                                continue;
                            }
                            let t = f[a] / (f[a] - f[b]);
                            let t = if t.is_finite() { t.clamp(0.0, 1.0) } else { 0.5 };
                            sx += CORNER[a][0] as f32 + t * (CORNER[b][0] - CORNER[a][0]) as f32;
                            sy += CORNER[a][1] as f32 + t * (CORNER[b][1] - CORNER[a][1]) as f32;
                            sz += CORNER[a][2] as f32 + t * (CORNER[b][2] - CORNER[a][2]) as f32;
                            // colour from whichever end actually holds data
                            let (ca, cb_) = (w8[a].max(1e-6), w8[b].max(1e-6));
                            let (wa, wb) = (ca * (1.0 - t), cb_ * t);
                            let wsum = (wa + wb).max(1e-6);
                            cr += (c8[a][0] as f32 * wa + c8[b][0] as f32 * wb) / wsum;
                            cg += (c8[a][1] as f32 * wa + c8[b][1] as f32 * wb) / wsum;
                            cb += (c8[a][2] as f32 * wa + c8[b][2] as f32 * wb) / wsum;
                            nx += 1.0;
                        }
                        if nx == 0.0 {
                            continue;
                        }
                        let idx = (pos.len() / 3) as u32;
                        pos.push((gx as f32 + sx / nx) * self.voxel);
                        pos.push((gy as f32 + sy / nx) * self.voxel);
                        pos.push((gz as f32 + sz / nx) * self.voxel);
                        col.push((cr / nx) as u8);
                        col.push((cg / nx) as u8);
                        col.push((cb / nx) as u8);
                        cell_vert.insert(key(gx, gy, gz), idx);
                    }
                }
            }
        }

        // A quad around every grid edge whose endpoints straddle the surface. The four cells
        // sharing that edge each own a vertex, so the surface closes without any table.
        let mut idx: Vec<u32> = Vec::new();
        let quad = |idx: &mut Vec<u32>, a: u32, b: u32, c: u32, d: u32, flip: bool| {
            if flip {
                idx.extend_from_slice(&[a, c, b, a, d, c]);
            } else {
                idx.extend_from_slice(&[a, b, c, a, c, d]);
            }
        };
        for &(bx, by, bz) in &brick_keys {
            for lz in 0..B {
                for ly in 0..B {
                    for lx in 0..B {
                        let (gx, gy, gz) = (bx * B + lx, by * B + ly, bz * B + lz);
                        let v0 = match self.field(gx, gy, gz, density, iso) {
                            Some((v, _, _)) => v,
                            None => continue,
                        };
                        for axis in 0..3 {
                            let (ex, ey, ez) = match axis {
                                0 => (gx + 1, gy, gz),
                                1 => (gx, gy + 1, gz),
                                _ => (gx, gy, gz + 1),
                            };
                            let v1 = match self.field(ex, ey, ez, density, iso) {
                                Some((v, _, _)) => v,
                                None => continue,
                            };
                            if (v0 < 0.0) == (v1 < 0.0) {
                                continue;
                            }
                            // the four cells that share this edge
                            let cells = match axis {
                                0 => [
                                    (gx, gy - 1, gz - 1), (gx, gy, gz - 1),
                                    (gx, gy, gz), (gx, gy - 1, gz),
                                ],
                                1 => [
                                    (gx - 1, gy, gz - 1), (gx - 1, gy, gz),
                                    (gx, gy, gz), (gx, gy, gz - 1),
                                ],
                                _ => [
                                    (gx - 1, gy - 1, gz), (gx, gy - 1, gz),
                                    (gx, gy, gz), (gx - 1, gy, gz),
                                ],
                            };
                            let mut vs = [0u32; 4];
                            let mut have = true;
                            for (i, c) in cells.iter().enumerate() {
                                match cell_vert.get(&key(c.0, c.1, c.2)) {
                                    Some(&v) => vs[i] = v,
                                    None => {
                                        have = false;
                                        break;
                                    }
                                }
                            }
                            if !have {
                                continue;
                            }
                            quad(&mut idx, vs[0], vs[1], vs[2], vs[3], v0 >= 0.0);
                        }
                    }
                }
            }
        }

        let mut mesh = Mesh { pos, nrm: Vec::new(), col, idx };
        if smooth_iters > 0 {
            taubin(&mut mesh, smooth_iters);
        }
        face_normals(&mut mesh);
        let stats = MeshStats {
            points_used: self.pts,
            voxels: self.voxel_count(),
            vertices: (mesh.pos.len() / 3) as u32,
            triangles: (mesh.idx.len() / 3) as u32,
            oriented: self.oriented,
            unoriented: self.unoriented,
            boundary_edges: boundary_edges(&mesh.idx),
        };
        (mesh, stats)
    }
}

/// Taubin λ|μ smoothing: a shrinking pass followed by a slightly larger inflating pass, so
/// the surface loses noise without losing volume the way repeated Laplacian passes do.
fn taubin(m: &mut Mesh, iters: u32) {
    let nv = m.pos.len() / 3;
    if nv == 0 || m.idx.is_empty() {
        return;
    }
    // neighbour lists in CSR form
    let mut deg = vec![0u32; nv];
    for t in m.idx.chunks_exact(3) {
        for k in 0..3 {
            deg[t[k] as usize] += 2;
        }
    }
    let mut start = vec![0u32; nv + 1];
    for i in 0..nv {
        start[i + 1] = start[i] + deg[i];
    }
    let mut fill = start.clone();
    let mut nbr = vec![0u32; start[nv] as usize];
    for t in m.idx.chunks_exact(3) {
        for k in 0..3 {
            let a = t[k] as usize;
            let b = t[(k + 1) % 3];
            let c = t[(k + 2) % 3];
            nbr[fill[a] as usize] = b;
            fill[a] += 1;
            nbr[fill[a] as usize] = c;
            fill[a] += 1;
        }
    }
    let lambda = 0.5f32;
    let mu = -0.53f32;
    let mut buf = m.pos.clone();
    for it in 0..(iters * 2) {
        let f = if it % 2 == 0 { lambda } else { mu };
        for v in 0..nv {
            let (s, e) = (start[v] as usize, start[v + 1] as usize);
            if e == s {
                buf[v * 3] = m.pos[v * 3];
                buf[v * 3 + 1] = m.pos[v * 3 + 1];
                buf[v * 3 + 2] = m.pos[v * 3 + 2];
                continue;
            }
            let (mut ax, mut ay, mut az) = (0.0f32, 0.0f32, 0.0f32);
            for &n in &nbr[s..e] {
                let n = n as usize * 3;
                ax += m.pos[n];
                ay += m.pos[n + 1];
                az += m.pos[n + 2];
            }
            let inv = 1.0 / (e - s) as f32;
            buf[v * 3] = m.pos[v * 3] + f * (ax * inv - m.pos[v * 3]);
            buf[v * 3 + 1] = m.pos[v * 3 + 1] + f * (ay * inv - m.pos[v * 3 + 1]);
            buf[v * 3 + 2] = m.pos[v * 3 + 2] + f * (az * inv - m.pos[v * 3 + 2]);
        }
        std::mem::swap(&mut m.pos, &mut buf);
    }
}

/// Area-weighted vertex normals.
fn face_normals(m: &mut Mesh) {
    let nv = m.pos.len() / 3;
    m.nrm = vec![0.0; nv * 3];
    for t in m.idx.chunks_exact(3) {
        let (a, b, c) = (t[0] as usize * 3, t[1] as usize * 3, t[2] as usize * 3);
        let u = [m.pos[b] - m.pos[a], m.pos[b + 1] - m.pos[a + 1], m.pos[b + 2] - m.pos[a + 2]];
        let v = [m.pos[c] - m.pos[a], m.pos[c + 1] - m.pos[a + 1], m.pos[c + 2] - m.pos[a + 2]];
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        for &i in &[a, b, c] {
            m.nrm[i] += n[0];
            m.nrm[i + 1] += n[1];
            m.nrm[i + 2] += n[2];
        }
    }
    for v in 0..nv {
        let i = v * 3;
        let l = (m.nrm[i] * m.nrm[i] + m.nrm[i + 1] * m.nrm[i + 1] + m.nrm[i + 2] * m.nrm[i + 2]).sqrt();
        if l > 1e-12 {
            m.nrm[i] /= l;
            m.nrm[i + 1] /= l;
            m.nrm[i + 2] /= l;
        } else {
            m.nrm[i + 2] = 1.0;
        }
    }
}
