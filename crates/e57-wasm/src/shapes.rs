// SPDX-License-Identifier: GPL-3.0-only
// Fitting primitives to points, and finding them without being told where to look.
//
// Every fit here answers with an RMS as well as its parameters, because the parameters alone
// are never enough: a cylinder fitted to a flat wall has a radius and an axis and means
// nothing, and the only thing that says so is the residual. The detector is RANSAC — draw a
// minimal sample, count how many points agree, keep the best — because scan data is exactly
// the case it was invented for: mostly structure, with enough outliers that a least-squares
// fit over everything would be dragged off by them.

/// Gaussian elimination with partial pivoting, for the small dense systems below.
pub fn gauss(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    for col in 0..n {
        let mut piv = col;
        for r in (col + 1)..n { if a[r][col].abs() > a[piv][col].abs() { piv = r; } }
        if a[piv][col].abs() < 1e-16 { return None; }
        if piv != col { a.swap(piv, col); b.swap(piv, col); }
        let d = a[col][col];
        for r in (col + 1)..n {
            let f = a[r][col] / d;
            if f == 0.0 { continue; }
            for c in col..n { a[r][c] -= f * a[col][c]; }
            b[r] -= f * b[col];
        }
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let mut s = b[i];
        for j in (i + 1)..n { s -= a[i][j] * x[j]; }
        x[i] = s / a[i][i];
        if !x[i].is_finite() { return None; }
    }
    Some(x)
}

/// Eigen decomposition of a symmetric 3x3, ascending. (A second copy of the one in
/// analysis.rs would be a waste; this module borrows it.)
pub use crate::analysis::eigen_sym3_pub as eigen3;

fn centroid(idx: &[u32], p: &[f32]) -> [f64; 3] {
    let mut c = [0.0f64; 3];
    for &i in idx { for a in 0..3 { c[a] += p[i as usize * 3 + a] as f64; } }
    let n = idx.len().max(1) as f64;
    [c[0] / n, c[1] / n, c[2] / n]
}

#[derive(Clone, Debug)]
pub struct Plane { pub n: [f64; 3], pub c: [f64; 3], pub rms: f64, pub worst: f64 }
#[derive(Clone, Debug)]
pub struct Sphere { pub c: [f64; 3], pub r: f64, pub rms: f64, pub worst: f64 }
#[derive(Clone, Debug)]
pub struct Cylinder { pub axis: [f64; 3], pub c: [f64; 3], pub r: f64, pub rms: f64, pub worst: f64, pub length: f64 }
#[derive(Clone, Debug)]
pub struct Circle { pub n: [f64; 3], pub c: [f64; 3], pub r: f64, pub rms: f64, pub worst: f64 }

/// Least-squares plane: the smallest eigenvector of the covariance, which is the direction in
/// which the points vary least.
pub fn fit_plane(idx: &[u32], p: &[f32]) -> Option<Plane> {
    if idx.len() < 3 { return None; }
    let c = centroid(idx, p);
    let mut cov = [[0.0f64; 3]; 3];
    for &i in idx {
        let d = [p[i as usize * 3] as f64 - c[0], p[i as usize * 3 + 1] as f64 - c[1], p[i as usize * 3 + 2] as f64 - c[2]];
        for a in 0..3 { for b in 0..3 { cov[a][b] += d[a] * d[b]; } }
    }
    let n = idx.len() as f64;
    for a in 0..3 { for b in 0..3 { cov[a][b] /= n; } }
    let (_, vecs) = eigen3(cov);
    let mut nrm = [vecs[0][0], vecs[1][0], vecs[2][0]];
    let l = (nrm[0] * nrm[0] + nrm[1] * nrm[1] + nrm[2] * nrm[2]).sqrt();
    if l < 1e-12 { return None; }
    for a in 0..3 { nrm[a] /= l; }
    if nrm[2] < 0.0 { for a in 0..3 { nrm[a] = -nrm[a]; } }
    let (mut ss, mut worst) = (0.0f64, 0.0f64);
    for &i in idx {
        let d = (p[i as usize * 3] as f64 - c[0]) * nrm[0] + (p[i as usize * 3 + 1] as f64 - c[1]) * nrm[1] + (p[i as usize * 3 + 2] as f64 - c[2]) * nrm[2];
        ss += d * d; worst = worst.max(d.abs());
    }
    Some(Plane { n: nrm, c, rms: (ss / n).sqrt(), worst })
}

/// Sphere: the algebraic fit first (linear, so it cannot fail to converge), then a few
/// Gauss-Newton steps on the true geometric residual, which is what the RMS then means.
pub fn fit_sphere(idx: &[u32], p: &[f32]) -> Option<Sphere> {
    if idx.len() < 4 { return None; }
    // x^2+y^2+z^2 + a x + b y + c z + d = 0
    let mut ata = vec![vec![0.0f64; 4]; 4];
    let mut atb = vec![0.0f64; 4];
    for &i in idx {
        let (x, y, z) = (p[i as usize * 3] as f64, p[i as usize * 3 + 1] as f64, p[i as usize * 3 + 2] as f64);
        let row = [x, y, z, 1.0];
        let rhs = -(x * x + y * y + z * z);
        for a in 0..4 { atb[a] += row[a] * rhs; for b in 0..4 { ata[a][b] += row[a] * row[b]; } }
    }
    let s = gauss(ata, atb)?;
    let mut c = [-s[0] / 2.0, -s[1] / 2.0, -s[2] / 2.0];
    let r2 = c[0] * c[0] + c[1] * c[1] + c[2] * c[2] - s[3];
    if !(r2 > 0.0) { return None; }
    let mut r = r2.sqrt();
    // Gauss-Newton on |p - c| - r, unknowns (c, r)
    for _ in 0..12 {
        let mut ata = vec![vec![0.0f64; 4]; 4];
        let mut atb = vec![0.0f64; 4];
        for &i in idx {
            let d = [p[i as usize * 3] as f64 - c[0], p[i as usize * 3 + 1] as f64 - c[1], p[i as usize * 3 + 2] as f64 - c[2]];
            let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            if len < 1e-12 { continue; }
            let res = len - r;
            let j = [-d[0] / len, -d[1] / len, -d[2] / len, -1.0];
            for a in 0..4 { atb[a] -= j[a] * res; for b in 0..4 { ata[a][b] += j[a] * j[b]; } }
        }
        let Some(step) = gauss(ata, atb) else { break };
        for a in 0..3 { c[a] += step[a]; }
        r += step[3];
        if step.iter().all(|v| v.abs() < 1e-10) { break; }
    }
    if !(r > 0.0) { return None; }
    let (mut ss, mut worst) = (0.0f64, 0.0f64);
    for &i in idx {
        let d = [p[i as usize * 3] as f64 - c[0], p[i as usize * 3 + 1] as f64 - c[1], p[i as usize * 3 + 2] as f64 - c[2]];
        let e = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt() - r;
        ss += e * e; worst = worst.max(e.abs());
    }
    Some(Sphere { c, r, rms: (ss / idx.len() as f64).sqrt(), worst })
}

/// Cylinder. The axis comes from the normals: every normal of a cylinder is perpendicular to
/// its axis, so the normal set spans a plane and the axis is the direction they vary least in.
/// With the axis known the rest is a circle in the plane across it.
pub fn fit_cylinder(idx: &[u32], p: &[f32], nrm: &[f32]) -> Option<Cylinder> {
    if idx.len() < 6 || nrm.len() < p.len() { return None; }
    let mut cov = [[0.0f64; 3]; 3];
    let mut used = 0usize;
    for &i in idx {
        let n = [nrm[i as usize * 3] as f64, nrm[i as usize * 3 + 1] as f64, nrm[i as usize * 3 + 2] as f64];
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if l < 1e-6 { continue; }
        used += 1;
        for a in 0..3 { for b in 0..3 { cov[a][b] += n[a] * n[b] / (l * l); } }
    }
    if used < 6 { return None; }
    let (_, vecs) = eigen3(cov);
    let mut axis = [vecs[0][0], vecs[1][0], vecs[2][0]];
    let l = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    if l < 1e-12 { return None; }
    for a in 0..3 { axis[a] /= l; }
    if axis[2] < 0.0 { for a in 0..3 { axis[a] = -axis[a]; } }
    // an orthonormal frame across the axis
    let tmp = if axis[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let mut u = [tmp[1] * axis[2] - tmp[2] * axis[1], tmp[2] * axis[0] - tmp[0] * axis[2], tmp[0] * axis[1] - tmp[1] * axis[0]];
    let ul = (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]).sqrt();
    for a in 0..3 { u[a] /= ul; }
    let v = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
    // a 2D circle in that frame
    let mut ata = vec![vec![0.0f64; 3]; 3];
    let mut atb = vec![0.0f64; 3];
    let mut proj: Vec<(f64, f64, f64)> = Vec::with_capacity(idx.len());
    for &i in idx {
        let q = [p[i as usize * 3] as f64, p[i as usize * 3 + 1] as f64, p[i as usize * 3 + 2] as f64];
        let a2 = q[0] * u[0] + q[1] * u[1] + q[2] * u[2];
        let b2 = q[0] * v[0] + q[1] * v[1] + q[2] * v[2];
        let t = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
        proj.push((a2, b2, t));
        let row = [a2, b2, 1.0];
        let rhs = -(a2 * a2 + b2 * b2);
        for x in 0..3 { atb[x] += row[x] * rhs; for y in 0..3 { ata[x][y] += row[x] * row[y]; } }
    }
    let s = gauss(ata, atb)?;
    let (cu, cv) = (-s[0] / 2.0, -s[1] / 2.0);
    let r2 = cu * cu + cv * cv - s[2];
    if !(r2 > 0.0) { return None; }
    let mut r = r2.sqrt();
    let (mut cu, mut cv) = (cu, cv);
    for _ in 0..10 {
        let mut ata = vec![vec![0.0f64; 3]; 3];
        let mut atb = vec![0.0f64; 3];
        for &(a2, b2, _) in proj.iter() {
            let d = [a2 - cu, b2 - cv];
            let len = (d[0] * d[0] + d[1] * d[1]).sqrt();
            if len < 1e-12 { continue; }
            let res = len - r;
            let j = [-d[0] / len, -d[1] / len, -1.0];
            for x in 0..3 { atb[x] -= j[x] * res; for y in 0..3 { ata[x][y] += j[x] * j[y]; } }
        }
        let Some(step) = gauss(ata, atb) else { break };
        cu += step[0]; cv += step[1]; r += step[2];
        if step.iter().all(|q| q.abs() < 1e-11) { break; }
    }
    let (mut ss, mut worst, mut tmin, mut tmax) = (0.0f64, 0.0f64, f64::MAX, f64::MIN);
    for &(a2, b2, t) in proj.iter() {
        let e = ((a2 - cu).powi(2) + (b2 - cv).powi(2)).sqrt() - r;
        ss += e * e; worst = worst.max(e.abs());
        tmin = tmin.min(t); tmax = tmax.max(t);
    }
    let mid = (tmin + tmax) / 2.0;
    let c = [u[0] * cu + v[0] * cv + axis[0] * mid, u[1] * cu + v[1] * cv + axis[1] * mid, u[2] * cu + v[2] * cv + axis[2] * mid];
    Some(Cylinder { axis, c, r, rms: (ss / proj.len() as f64).sqrt(), worst, length: tmax - tmin })
}

/// Circle: a plane, then a 2D circle in it. The RMS is the 3D distance to the ring, so it
/// includes any out-of-plane scatter rather than hiding it.
pub fn fit_circle(idx: &[u32], p: &[f32]) -> Option<Circle> {
    let pl = fit_plane(idx, p)?;
    let tmp = if pl.n[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let mut u = [tmp[1] * pl.n[2] - tmp[2] * pl.n[1], tmp[2] * pl.n[0] - tmp[0] * pl.n[2], tmp[0] * pl.n[1] - tmp[1] * pl.n[0]];
    let ul = (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]).sqrt();
    for a in 0..3 { u[a] /= ul; }
    let v = [pl.n[1] * u[2] - pl.n[2] * u[1], pl.n[2] * u[0] - pl.n[0] * u[2], pl.n[0] * u[1] - pl.n[1] * u[0]];
    let mut ata = vec![vec![0.0f64; 3]; 3];
    let mut atb = vec![0.0f64; 3];
    let mut proj: Vec<(f64, f64, f64)> = Vec::with_capacity(idx.len());
    for &i in idx {
        let q = [p[i as usize * 3] as f64 - pl.c[0], p[i as usize * 3 + 1] as f64 - pl.c[1], p[i as usize * 3 + 2] as f64 - pl.c[2]];
        let a2 = q[0] * u[0] + q[1] * u[1] + q[2] * u[2];
        let b2 = q[0] * v[0] + q[1] * v[1] + q[2] * v[2];
        let w = q[0] * pl.n[0] + q[1] * pl.n[1] + q[2] * pl.n[2];
        proj.push((a2, b2, w));
        let row = [a2, b2, 1.0];
        let rhs = -(a2 * a2 + b2 * b2);
        for x in 0..3 { atb[x] += row[x] * rhs; for y in 0..3 { ata[x][y] += row[x] * row[y]; } }
    }
    let s = gauss(ata, atb)?;
    let (cu, cv) = (-s[0] / 2.0, -s[1] / 2.0);
    let r2 = cu * cu + cv * cv - s[2];
    if !(r2 > 0.0) { return None; }
    let r = r2.sqrt();
    let (mut ss, mut worst) = (0.0f64, 0.0f64);
    for &(a2, b2, w) in proj.iter() {
        let dr = ((a2 - cu).powi(2) + (b2 - cv).powi(2)).sqrt() - r;
        let e = (dr * dr + w * w).sqrt();
        ss += e * e; worst = worst.max(e);
    }
    let c = [pl.c[0] + u[0] * cu + v[0] * cv, pl.c[1] + u[1] * cu + v[1] * cv, pl.c[2] + u[2] * cu + v[2] * cv];
    Some(Circle { n: pl.n, c, r, rms: (ss / proj.len() as f64).sqrt(), worst })
}

// ---------------------------------------------------------------- detection
pub struct Detected {
    pub kind: &'static str,
    pub params: Vec<f64>,     // plane: n,c ; sphere: c,r ; cylinder: axis,c,r
    pub rms: f64,
    pub support: usize,
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    fn pick(&mut self, n: usize) -> usize { (self.next() % n.max(1) as u64) as usize }
}

/// RANSAC over the points, one shape at a time, removing each shape's inliers before looking
/// for the next. Removing them *is* the non-maximum suppression: two fits of the same wall
/// cannot both survive, because the second has nothing left to be supported by.
pub fn detect(
    p: &[f32], nrm: &[f32], tol: f32, min_pts: usize, max_shapes: usize,
    want: (bool, bool, bool), trials: usize, seed: u64,
    mut progress: impl FnMut(usize),
) -> (Vec<Detected>, Vec<i32>) {
    let n = p.len() / 3;
    let mut label = vec![-1i32; n];
    let mut out: Vec<Detected> = Vec::new();
    let mut live: Vec<u32> = (0..n as u32).collect();
    let has_n = nrm.len() >= p.len();
    let tol = tol as f64;
    let mut rng = Rng(seed | 1);
    for shape in 0..max_shapes {
        if live.len() < min_pts { break; }
        progress(shape);
        let mut best: Option<(Detected, Vec<u32>)> = None;
        for _ in 0..trials {
            let which = {
                let opts: Vec<u8> = [(want.0, 0u8), (want.1, 1), (want.2, 2)].iter().filter(|(w, _)| *w).map(|(_, k)| *k).collect();
                if opts.is_empty() { break; }
                opts[rng.pick(opts.len())]
            };
            let need = match which { 0 => 3, 1 => 4, _ => 8 };
            if live.len() < need { continue; }
            let mut sample: Vec<u32> = Vec::with_capacity(need);
            for _ in 0..need { sample.push(live[rng.pick(live.len())]); }
            let (kind, params, ok) = match which {
                0 => match fit_plane(&sample, p) {
                    Some(pl) => ("plane", vec![pl.n[0], pl.n[1], pl.n[2], pl.c[0], pl.c[1], pl.c[2]], true),
                    None => ("plane", vec![], false),
                },
                1 => match fit_sphere(&sample, p) {
                    Some(s) => ("sphere", vec![s.c[0], s.c[1], s.c[2], s.r], s.r > tol * 2.0),
                    None => ("sphere", vec![], false),
                },
                _ => {
                    if !has_n { ("cylinder", vec![], false) }
                    else { match fit_cylinder(&sample, p, nrm) {
                        Some(cy) => ("cylinder", vec![cy.axis[0], cy.axis[1], cy.axis[2], cy.c[0], cy.c[1], cy.c[2], cy.r], cy.r > tol * 2.0),
                        None => ("cylinder", vec![], false),
                    } }
                }
            };
            if !ok { continue; }
            let inl = inliers(&live, p, kind, &params, tol);
            if inl.len() < min_pts { continue; }
            if best.as_ref().map_or(true, |(b, bi)| inl.len() > bi.len() || (inl.len() == bi.len() && b.rms > 0.0)) {
                best = Some((Detected { kind, params, rms: 0.0, support: inl.len() }, inl));
            }
        }
        let Some((mut d, inl)) = best else { break };
        // refit on everything that agreed, which is what turns a lucky three-point sample
        // into a measurement
        match d.kind {
            "plane" => if let Some(pl) = fit_plane(&inl, p) {
                d.params = vec![pl.n[0], pl.n[1], pl.n[2], pl.c[0], pl.c[1], pl.c[2]]; d.rms = pl.rms;
            },
            "sphere" => if let Some(s) = fit_sphere(&inl, p) {
                d.params = vec![s.c[0], s.c[1], s.c[2], s.r]; d.rms = s.rms;
            },
            _ => if let Some(cy) = fit_cylinder(&inl, p, nrm) {
                d.params = vec![cy.axis[0], cy.axis[1], cy.axis[2], cy.c[0], cy.c[1], cy.c[2], cy.r]; d.rms = cy.rms;
            },
        }
        let final_inl = inliers(&live, p, d.kind, &d.params, tol);
        if final_inl.len() < min_pts { break; }
        d.support = final_inl.len();
        let idx = out.len() as i32;
        for &i in final_inl.iter() { label[i as usize] = idx; }
        let gone: std::collections::HashSet<u32> = final_inl.iter().copied().collect();
        live.retain(|i| !gone.contains(i));
        out.push(d);
    }
    (out, label)
}

fn inliers(live: &[u32], p: &[f32], kind: &str, params: &[f64], tol: f64) -> Vec<u32> {
    let mut out = Vec::new();
    for &i in live {
        let q = [p[i as usize * 3] as f64, p[i as usize * 3 + 1] as f64, p[i as usize * 3 + 2] as f64];
        let d = match kind {
            "plane" => ((q[0] - params[3]) * params[0] + (q[1] - params[4]) * params[1] + (q[2] - params[5]) * params[2]).abs(),
            "sphere" => (((q[0] - params[0]).powi(2) + (q[1] - params[1]).powi(2) + (q[2] - params[2]).powi(2)).sqrt() - params[3]).abs(),
            _ => {
                let d0 = [q[0] - params[3], q[1] - params[4], q[2] - params[5]];
                let t = d0[0] * params[0] + d0[1] * params[1] + d0[2] * params[2];
                let r = [d0[0] - t * params[0], d0[1] - t * params[1], d0[2] - t * params[2]];
                ((r[0] * r[0] + r[1] * r[1] + r[2] * r[2]).sqrt() - params[6]).abs()
            }
        };
        if d <= tol { out.push(i); }
    }
    out
}
