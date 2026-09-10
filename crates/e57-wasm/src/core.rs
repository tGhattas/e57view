//! Decode a scan into an octree. Shared by the wasm API and the native bench.

use crate::fast::FastReader;
use crate::octree::{Octree, REC};
use e57::{PointCloud, RecordDataType, RecordName, RecordValue};
use std::io::{Read, Seek};

pub struct FieldMap {
    pub x: usize, pub y: usize, pub z: usize, pub cinv: usize,
    pub sr: usize, pub saz: usize, pub sel: usize, pub sinv: usize,
    pub r: usize, pub g: usize, pub b: usize, pub i: usize,
    pub nx: usize, pub ny: usize, pub nz: usize,
}
const NONE: usize = usize::MAX;

fn range_of(dt: &RecordDataType, lim: Option<(f64, f64)>) -> (f64, f64) {
    if let Some(l) = lim { if l.1 > l.0 { return l; } }
    match dt {
        RecordDataType::Single { min, max } => (min.map(|v| v as f64).unwrap_or(0.0), max.map(|v| v as f64).unwrap_or(1.0)),
        RecordDataType::Double { min, max } => (min.unwrap_or(0.0), max.unwrap_or(1.0)),
        RecordDataType::Integer { min, max } => (*min as f64, *max as f64),
        RecordDataType::ScaledInteger { min, max, scale, offset } => (*min as f64 * scale + offset, *max as f64 * scale + offset),
    }
}
fn rv(v: &Option<RecordValue>) -> Option<f64> {
    v.as_ref().map(|v| match v {
        RecordValue::Single(f) => *f as f64, RecordValue::Double(f) => *f,
        RecordValue::Integer(i) => *i as f64, RecordValue::ScaledInteger(i) => *i as f64,
    })
}

pub fn map_fields(pc: &PointCloud) -> FieldMap {
    let mut m = FieldMap { x: NONE, y: NONE, z: NONE, cinv: NONE, sr: NONE, saz: NONE, sel: NONE, sinv: NONE,
                           r: NONE, g: NONE, b: NONE, i: NONE, nx: NONE, ny: NONE, nz: NONE };
    for (k, rec) in pc.prototype.iter().enumerate() {
        match &rec.name {
            RecordName::CartesianX => m.x = k, RecordName::CartesianY => m.y = k, RecordName::CartesianZ => m.z = k,
            RecordName::CartesianInvalidState => m.cinv = k,
            RecordName::SphericalRange => m.sr = k, RecordName::SphericalAzimuth => m.saz = k,
            RecordName::SphericalElevation => m.sel = k, RecordName::SphericalInvalidState => m.sinv = k,
            RecordName::ColorRed => m.r = k, RecordName::ColorGreen => m.g = k, RecordName::ColorBlue => m.b = k,
            RecordName::Intensity => m.i = k,
            RecordName::Unknown { name, .. } => {
                let n = name.to_ascii_lowercase();
                if n == "normalx" || n == "nx" { m.nx = k }
                else if n == "normaly" || n == "ny" { m.ny = k }
                else if n == "normalz" || n == "nz" { m.nz = k }
            }
            _ => {}
        }
    }
    m
}

#[inline]
fn rot(q: [f64; 4], x: f64, y: f64, z: f64) -> [f64; 3] {
    let (w, qx, qy, qz) = (q[0], q[1], q[2], q[3]);
    let tx = 2.0 * (qy * z - qz * y); let ty = 2.0 * (qz * x - qx * z); let tz = 2.0 * (qx * y - qy * x);
    [x + w * tx + (qy * tz - qz * ty), y + w * ty + (qz * tx - qx * tz), z + w * tz + (qx * ty - qy * tx)]
}

/// Rotated axis-aligned bounds of the declared local bounds, if any.
pub fn declared_bounds(pc: &PointCloud, q: [f64; 4]) -> Option<([f64; 3], [f64; 3])> {
    let b = pc.cartesian_bounds.as_ref()?;
    let (x0, x1, y0, y1, z0, z1) = (b.x_min?, b.x_max?, b.y_min?, b.y_max?, b.z_min?, b.z_max?);
    let mut mn = [f64::MAX; 3]; let mut mx = [f64::MIN; 3];
    for c in 0..8 {
        let p = rot(q, if c & 1 != 0 { x1 } else { x0 }, if c & 2 != 0 { y1 } else { y0 }, if c & 4 != 0 { z1 } else { z0 });
        for a in 0..3 { mn[a] = mn[a].min(p[a]); mx[a] = mx[a].max(p[a]); }
    }
    Some((mn, mx))
}

pub fn rotation_of(pc: &PointCloud) -> [f64; 4] {
    match &pc.transform { Some(t) => [t.rotation.w, t.rotation.x, t.rotation.y, t.rotation.z], None => [1.0, 0.0, 0.0, 0.0] }
}

pub struct DecodeStats { pub read: u64, pub kept: u64, pub dropped_invalid: u64 }

/// Decode with stride into an octree. `preview` receives records quantised to
/// `pcube` (origin, size) — a fixed cube — every `preview_every`-th kept point,
/// batched. `progress(read, total)` returning true aborts.
pub fn decode<R: Read + Seek>(
    inner: R, pc: &PointCloud, stride: usize,
    pcube: ([f64; 3], f64), preview_every: usize,
    mut preview: impl FnMut(&[u8], usize),
    mut progress: impl FnMut(u64, u64) -> bool,
    tree: &mut Octree,
) -> std::io::Result<DecodeStats> {
    let m = map_fields(pc);
    let has_cart = m.x != NONE && m.y != NONE && m.z != NONE;
    let has_sph = m.sr != NONE && m.saz != NONE && m.sel != NONE;
    if !has_cart && !has_sph {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "scan has neither cartesian nor spherical coordinates"));
    }
    let types: Vec<RecordDataType> = pc.prototype.iter().map(|r| r.data_type.clone()).collect();
    let ilim = pc.intensity_limits.as_ref().and_then(|l| Some((rv(&l.intensity_min)?, rv(&l.intensity_max)?)));
    let clim = pc.color_limits.as_ref().and_then(|l| Some((rv(&l.red_min)?, rv(&l.red_max)?)));
    let (imin, imax) = if m.i != NONE { range_of(&types[m.i], ilim) } else { (0.0, 1.0) };
    let (cmin, cmax) = if m.r != NONE { range_of(&types[m.r], clim) } else { (0.0, 255.0) };
    let iscale = 255.0 / (imax - imin).max(1e-12);
    let cscale = 255.0 / (cmax - cmin).max(1e-12);
    let q = rotation_of(pc);
    let identity = (q[0] - 1.0).abs() < 1e-12 && q[1].abs() < 1e-12 && q[2].abs() < 1e-12 && q[3].abs() < 1e-12;

    let mut fr = FastReader::new(inner, pc)?;
    let stride = stride.max(1);
    let total = pc.records;
    let mut kept = 0u64; let mut dropped = 0u64;
    let mut pbuf: Vec<u8> = Vec::with_capacity(200_000 * REC);
    let mut pcount = 0usize;
    let mut next_progress = 1_000_000u64;
    let (po, ps) = pcube;

    loop {
        let n = fr.fill(1 << 16)?;
        if n == 0 { break; }
        let base = fr.read;
        for k in 0..n {
            let rec_no = base + k as u64;
            if stride > 1 && (rec_no as usize) % stride != 0 { continue; }
            // validity
            if has_cart && m.cinv != NONE && fr.fields[m.cinv].col.get(k) != 0.0 { dropped += 1; continue; }
            if !has_cart && m.sinv != NONE && fr.fields[m.sinv].col.get(k) != 0.0 { dropped += 1; continue; }
            let (mut x, mut y, mut z) = if has_cart {
                (fr.fields[m.x].col.get(k), fr.fields[m.y].col.get(k), fr.fields[m.z].col.get(k))
            } else {
                let r = fr.fields[m.sr].col.get(k); let az = fr.fields[m.saz].col.get(k); let el = fr.fields[m.sel].col.get(k);
                let ce = el.cos();
                (r * ce * az.cos(), r * ce * az.sin(), r * el.sin())
            };
            if !(x.is_finite() && y.is_finite() && z.is_finite()) { dropped += 1; continue; }
            if !identity { let p = rot(q, x, y, z); x = p[0]; y = p[1]; z = p[2]; }

            let rgb = if m.r != NONE {
                [((fr.fields[m.r].col.get(k) - cmin) * cscale).clamp(0.0, 255.0) as u8,
                 ((fr.fields[m.g].col.get(k) - cmin) * cscale).clamp(0.0, 255.0) as u8,
                 ((fr.fields[m.b].col.get(k) - cmin) * cscale).clamp(0.0, 255.0) as u8]
            } else { [180, 180, 180] };
            let inten = if m.i != NONE { ((fr.fields[m.i].col.get(k) - imin) * iscale).clamp(0.0, 255.0) as u8 } else { 128 };
            let nrm = if m.nx != NONE {
                let (mut nx, mut ny, mut nz) = (fr.fields[m.nx].col.get(k), fr.fields[m.ny].col.get(k), fr.fields[m.nz].col.get(k));
                if !identity { let p = rot(q, nx, ny, nz); nx = p[0]; ny = p[1]; nz = p[2]; }
                [(nx.clamp(-1.0, 1.0) * 127.0) as i8, (ny.clamp(-1.0, 1.0) * 127.0) as i8, (nz.clamp(-1.0, 1.0) * 127.0) as i8]
            } else { [0, 0, 127] };

            tree.insert([x, y, z], rgb, inten, nrm);
            kept += 1;

            if preview_every > 0 && kept % preview_every as u64 == 0 {
                let tx = (x - po[0]) / ps; let ty = (y - po[1]) / ps; let tz = (z - po[2]) / ps;
                if (0.0..1.0).contains(&tx) && (0.0..1.0).contains(&ty) && (0.0..1.0).contains(&tz) {
                    let qx = ((tx * 65536.0) as u16).to_le_bytes();
                    let qy = ((ty * 65536.0) as u16).to_le_bytes();
                    let qz = ((tz * 65536.0) as u16).to_le_bytes();
                    pbuf.extend_from_slice(&[qx[0], qx[1], qy[0], qy[1], qz[0], qz[1], rgb[0], rgb[1], rgb[2], inten,
                                             nrm[0] as u8, nrm[1] as u8, nrm[2] as u8, 0]);
                    pcount += 1;
                    if pcount >= 200_000 { preview(&pbuf, pcount); pbuf.clear(); pcount = 0; }
                }
            }
        }
        fr.consume(n);
        if fr.read >= next_progress {
            next_progress += 1_000_000;
            if progress(fr.read, total) { break; }
        }
        if fr.read >= total { break; }
    }
    if pcount > 0 { preview(&pbuf, pcount); }
    Ok(DecodeStats { read: fr.read, kept, dropped_invalid: dropped })
}
