// SPDX-License-Identifier: GPL-3.0-only
// Native validation of the neighbourhood analyses against shapes with known answers.
use e57_wasm::analysis::{Analyzer, Feature};
use e57_wasm::shapes;

fn recs(pts: &[[f32; 3]], origin: [f32; 3], size: f32) -> Vec<u8> {
    let k = 65536.0 / size;
    let mut out = vec![0u8; pts.len() * 14];
    for (i, p) in pts.iter().enumerate() {
        let q = |v: f32, o: f32| (((v - o) * k).round().clamp(0.0, 65535.0)) as u16;
        let o = i * 14;
        out[o..o + 2].copy_from_slice(&q(p[0], origin[0]).to_le_bytes());
        out[o + 2..o + 4].copy_from_slice(&q(p[1], origin[1]).to_le_bytes());
        out[o + 4..o + 6].copy_from_slice(&q(p[2], origin[2]).to_le_bytes());
        out[o + 6] = 200; out[o + 7] = 200; out[o + 8] = 200;
        out[o + 12] = 127;            // the "no normal" placeholder
    }
    out
}
fn mk(pts: &[[f32; 3]], cell: f32) -> Analyzer {
    mk_m(pts, cell, None)
}
/// Same, but seen through a row-major 4x4 model matrix — what the viewer does when the cloud
/// carries a transform it has not baked into the records.
fn mk_m(pts: &[[f32; 3]], cell: f32, model: Option<&[f32; 16]>) -> Analyzer {
    let mut a = Analyzer::new(cell);
    a.add_records([0.0, 0.0, 0.0], 100.0, &recs(pts, [0.0, 0.0, 0.0], 100.0), model);
    a.build();
    a
}
/// Row-major rotation about X by `deg`, translating about `c` so the shape stays in the
/// positive octant the 16-bit quantisation lives in.
fn rot_x(deg: f32, c: [f32; 3]) -> [f32; 16] {
    let (s, k) = (deg.to_radians().sin(), deg.to_radians().cos());
    // R about the point c:  p' = R (p - c) + c
    let r = [[1.0, 0.0, 0.0], [0.0, k, -s], [0.0, s, k]];
    let mut m = [0.0f32; 16];
    for i in 0..3 {
        for j in 0..3 { m[i * 4 + j] = r[i][j]; }
        m[i * 4 + 3] = c[i] - (r[i][0] * c[0] + r[i][1] * c[1] + r[i][2] * c[2]);
    }
    m[15] = 1.0;
    m
}
fn med(v: &mut Vec<f32>) -> f32 {
    v.retain(|x| x.is_finite());
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() { f32::NAN } else { v[v.len() / 2] }
}

fn main() {
    let mut fails = 0;
    let mut ck = |name: &str, ok: bool, d: String| {
        println!("{}  {:<38} {}", if ok { "PASS" } else { "FAIL" }, name, d);
        if !ok { fails += 1; }
    };

    // ---------------------------------------------------------------- plane
    let mut plane = Vec::new();
    for i in 0..120 { for j in 0..120 {
        plane.push([10.0 + i as f32 * 0.05, 10.0 + j as f32 * 0.05, 20.0]);
    }}
    let mut a = mk(&plane, 0.2);
    a.compute_normals(16, |_| {});
    let vertical = a.nz.iter().filter(|&&v| v.abs() > 120).count();
    ck("plane normals point along z", vertical > plane.len() * 99 / 100, format!("{}/{} with |nz|>0.94", vertical, plane.len()));
    // A perfectly flat patch has lambda0 = 0, so planarity reduces to lambda1/lambda2. The
    // k-nearest set on a square grid is diamond shaped rather than circular, which puts that
    // ratio near 0.92 and not 1.0. What matters is that planarity dominates linearity.
    let mut pl = a.feature(Feature::Planarity, 16, 0.3, |_| {});
    let mut li = a.feature(Feature::Linearity, 16, 0.3, |_| {});
    let (mp, ml) = (med(&mut pl), med(&mut li));
    ck("plane reads as planar", mp > 0.90, format!("planarity median {:.3}", mp));
    ck("plane is not linear", ml < 0.10 && mp > ml * 8.0, format!("linearity median {:.3}, {:.0}x less than planarity", ml, mp / ml.max(1e-6)));
    let mut f = a.feature(Feature::Roughness, 16, 0.3, |_| {});
    ck("plane roughness is ~0", med(&mut f) < 0.002, format!("median {:.5} m", med(&mut f)));
    let mut f = a.feature(Feature::Curvature, 16, 0.3, |_| {});
    ck("plane curvature is ~0", med(&mut f) < 0.01, format!("median {:.5}", med(&mut f)));
    let mut f = a.feature(Feature::Verticality, 16, 0.3, |_| {});
    ck("horizontal plane verticality ~0", med(&mut f) < 0.06, format!("median {:.3}", med(&mut f)));

    // a wall should read as vertical
    let mut wall = Vec::new();
    for i in 0..120 { for j in 0..120 {
        wall.push([10.0 + i as f32 * 0.05, 20.0, 10.0 + j as f32 * 0.05]);
    }}
    let mut w = mk(&wall, 0.2);
    let mut f = w.feature(Feature::Verticality, 16, 0.3, |_| {});
    ck("wall verticality ~1", med(&mut f) > 0.94, format!("median {:.3}", med(&mut f)));

    // ---------------------------------------------------------------- line
    let line: Vec<[f32; 3]> = (0..900).map(|i| [10.0 + i as f32 * 0.01, 10.0, 10.0]).collect();
    let mut l = mk(&line, 0.2);
    let mut f = l.feature(Feature::Linearity, 12, 0.3, |_| {});
    ck("line linearity is ~1", med(&mut f) > 0.95, format!("median {:.3}", med(&mut f)));

    // ---------------------------------------------------------------- sphere, normals + orientation
    let n = 40_000;
    let ga = std::f32::consts::PI * (3.0 - 5.0f32.sqrt());
    let c = [20.0f32, 20.0, 20.0];
    let r = 3.0f32;
    let sphere: Vec<[f32; 3]> = (0..n).map(|i| {
        let y = 1.0 - (i as f32 / (n - 1) as f32) * 2.0;
        let rad = (1.0 - y * y).max(0.0).sqrt();
        let th = ga * i as f32;
        [c[0] + th.cos() * rad * r, c[1] + y * r, c[2] + th.sin() * rad * r]
    }).collect();
    let mut s = mk(&sphere, 0.3);
    s.compute_normals(18, |_| {});
    let mut agree = 0;
    for i in 0..s.len() {
        let d = [s.x[i] - c[0], s.y[i] - c[1], s.z[i] - c[2]];
        let dot = d[0] * s.nx[i] as f32 + d[1] * s.ny[i] as f32 + d[2] * s.nz[i] as f32;
        if dot.abs() > 0.85 * 127.0 * r { agree += 1; }
    }
    ck("sphere normals are radial", agree > s.len() * 96 / 100, format!("{}/{} aligned with the radius", agree, s.len()));
    s.orient_normals(18, None, |_| {});
    let outward = (0..s.len()).filter(|&i| {
        let d = [s.x[i] - c[0], s.y[i] - c[1], s.z[i] - c[2]];
        d[0] * s.nx[i] as f32 + d[1] * s.ny[i] as f32 + d[2] * s.nz[i] as f32 > 0.0
    }).count();
    ck("orientation makes them all outward", outward > s.len() * 98 / 100, format!("{:.1}% outward", outward as f32 / s.len() as f32 * 100.0));
    s.invert_normals();
    let inward = (0..s.len()).filter(|&i| {
        let d = [s.x[i] - c[0], s.y[i] - c[1], s.z[i] - c[2]];
        (d[0] * s.nx[i] as f32 + d[1] * s.ny[i] as f32 + d[2] * s.nz[i] as f32) < 0.0
    }).count();
    ck("invert flips them", inward > s.len() * 98 / 100, format!("{:.1}% inward", inward as f32 / s.len() as f32 * 100.0));

    // ------------------------------------------------- interior room, station orientation
    // Points on the *inside* faces of a box with the scanner in the middle. "Away from the
    // cloud centroid" is exactly wrong here, so this is the case the per-point station flip
    // exists for: every wall must end up facing the station.
    let (lo, hi) = (10.0f32, 16.0f32);
    let mid = (lo + hi) / 2.0;
    let station = [mid, mid, mid];
    let mut room: Vec<[f32; 3]> = Vec::new();
    let step = 0.06f32;
    let cells = ((hi - lo) / step) as usize;
    for i in 0..=cells { for j in 0..=cells {
        let (u, v) = (lo + i as f32 * step, lo + j as f32 * step);
        room.push([u, v, lo]); room.push([u, v, hi]);          // floor, ceiling
        room.push([u, lo, v]); room.push([u, hi, v]);          // two walls
        room.push([lo, u, v]); room.push([hi, u, v]);          // two walls
    }}
    let mut rm = mk(&room, 0.15);
    rm.compute_normals(16, |_| {});
    rm.orient_normals(16, None, |_| {});
    let toward = |a: &Analyzer| (0..a.len()).filter(|&i| {
        let d = [station[0] - a.x[i], station[1] - a.y[i], station[2] - a.z[i]];
        d[0] * a.nx[i] as f32 + d[1] * a.ny[i] as f32 + d[2] * a.nz[i] as f32 > 0.0
    }).count();
    let before = toward(&rm);
    rm.orient_to_viewpoints(&[station[0], station[1], station[2]]);
    let after = toward(&rm);
    ck("centroid vote gets an interior wrong", (before as f32) < rm.len() as f32 * 0.75,
       format!("{:.1}% faced the station", before as f32 / rm.len() as f32 * 100.0));
    ck("station flip faces them all inward", after > rm.len() * 99 / 100,
       format!("{:.1}% of {} face the station", after as f32 / rm.len() as f32 * 100.0, rm.len()));

    // many stations: nearest-station orientation must still be right everywhere
    let mut many = Vec::new();
    for k in 0..4 { for a in 0..3 { many.push(station[a] + if a == 0 { k as f32 * 0.4 - 0.6 } else { 0.0 }); } }
    let mut rm2 = mk(&room, 0.15);
    rm2.compute_normals(16, |_| {});
    rm2.orient_normals(16, None, |_| {});
    rm2.orient_to_viewpoints(&many);
    let after2 = (0..rm2.len()).filter(|&i| {
        // nearest of the four stations, recomputed here independently
        let mut best = (f32::INFINITY, 0usize);
        for k in 0..many.len() / 3 {
            let d = (many[k * 3] - rm2.x[i]).powi(2) + (many[k * 3 + 1] - rm2.y[i]).powi(2) + (many[k * 3 + 2] - rm2.z[i]).powi(2);
            if d < best.0 { best = (d, k); }
        }
        let k = best.1;
        let d = [many[k * 3] - rm2.x[i], many[k * 3 + 1] - rm2.y[i], many[k * 3 + 2] - rm2.z[i]];
        d[0] * rm2.nx[i] as f32 + d[1] * rm2.ny[i] as f32 + d[2] * rm2.nz[i] as f32 > 0.0
    }).count();
    ck("four stations, all face their nearest", after2 > rm2.len() * 99 / 100,
       format!("{:.1}% correct", after2 as f32 / rm2.len() as f32 * 100.0));

    // ------------------------------------------------- model matrix through the analyser
    // A plane tilted 30 degrees, read back through the inverse rotation as the cloud's model
    // matrix: the analyser must see a level plane, which is what lets verticality and the
    // rest of the features describe the cloud on screen rather than the raw records.
    let tilt_c = [12.0f32, 12.0, 20.0];
    let tilted: Vec<[f32; 3]> = {
        let m = rot_x(30.0, tilt_c);
        plane.iter().map(|p| [
            m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
            m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
            m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
        ]).collect()
    };
    let mut t_raw = mk(&tilted, 0.2);
    let mut f = t_raw.feature(Feature::Verticality, 16, 0.3, |_| {});
    let v_raw = med(&mut f);
    let inv = rot_x(-30.0, tilt_c);
    let mut t_lev = mk_m(&tilted, 0.2, Some(&inv));
    let mut f = t_lev.feature(Feature::Verticality, 16, 0.3, |_| {});
    let v_lev = med(&mut f);
    // verticality is 1 - |nz| of the surface normal, so a 30 degree tilt reads 1 - cos(30)
    ck("tilted plane reads tilted raw", (v_raw - 0.134).abs() < 0.02, format!("verticality {:.3}, 1-cos(30) = 0.134", v_raw));
    ck("inverse model levels it", v_lev < 0.06, format!("verticality {:.3} through the model", v_lev));
    // and the normals come back rotated with it
    t_lev.compute_normals(16, |_| {});
    let up = t_lev.nz.iter().filter(|&&v| v.abs() > 120).count();
    ck("levelled normals point along z", up > t_lev.len() * 98 / 100, format!("{}/{}", up, t_lev.len()));

    // ---------------------------------------------------------------- outliers
    let mut noisy = plane.clone();
    let planted = 150;
    for i in 0..planted {
        noisy.push([10.0 + (i % 12) as f32 * 0.4, 10.0 + (i / 12) as f32 * 0.4, 21.5 + (i % 5) as f32 * 0.3]);
    }
    let mut o = mk(&noisy, 0.2);
    let (keep, mu, cut) = o.sor(16, 1.0, |_| {});
    let dropped_out = (plane.len()..noisy.len()).filter(|&i| keep[i] == 0).count();
    let dropped_in = (0..plane.len()).filter(|&i| keep[i] == 0).count();
    ck("SOR drops the planted outliers", dropped_out > planted * 9 / 10, format!("{}/{} planted removed, mean {:.4} cut {:.4}", dropped_out, planted, mu, cut));
    ck("SOR keeps the surface", dropped_in < plane.len() / 50, format!("{} of {} surface points lost", dropped_in, plane.len()));

    let mut o2 = mk(&noisy, 0.2);
    let keep2 = o2.noise_filter(16, 1.0, |_| {});
    let nf_out = (plane.len()..noisy.len()).filter(|&i| keep2[i] == 0).count();
    ck("noise filter drops off-surface points", nf_out > planted * 8 / 10, format!("{}/{} removed", nf_out, planted));

    // ---------------------------------------------------------------- duplicates
    let mut dup = plane.clone();
    for p in plane.iter().take(400) { dup.push(*p); }
    let mut d = mk(&dup, 0.2);
    let keep = d.duplicates(0.001);
    let removed = keep.iter().filter(|&&k| k == 0).count();
    ck("duplicates removed exactly once", removed == 400, format!("{} removed, expected 400", removed));

    // ---------------------------------------------------------------- components
    let mut two = Vec::new();
    for i in 0..40 { for j in 0..40 {
        two.push([5.0 + i as f32 * 0.05, 5.0 + j as f32 * 0.05, 5.0]);
        two.push([40.0 + i as f32 * 0.05, 40.0 + j as f32 * 0.05, 5.0]);
    }}
    let mut cc = mk(&two, 0.3);
    let (labels, kept) = cc.connected_components(0.15, 10, |_| {});
    let distinct: std::collections::HashSet<u32> = labels.iter().filter(|v| v.is_finite()).map(|v| *v as u32).collect();
    ck("two blobs give two components", kept == 2 && distinct.len() == 2, format!("{} clusters kept", kept));

    // ---------------------------------------------------------------- subsample
    let mut sub = mk(&plane, 0.2);
    let keep = sub.spatial_subsample(0.2);
    let n_keep = keep.iter().filter(|&&k| k == 1).count();
    let want = (6.0f32 / 0.2).powi(2) as usize;         // the plane is 6 x 6 m
    ck("spatial subsample hits the spacing", (n_keep as i64 - want as i64).abs() < (want as i64 / 4), format!("{} kept, about {} expected", n_keep, want));

    // ---------------------------------------------------- fine registration (point-to-plane ICP)
    // The room again, as the reference. A copy is moved by a known rigid transform with noise
    // on top; ICP has to undo it. A tighter quantisation cube than the rest of this file uses,
    // because the tolerance here is a millimetre and 100 m / 65536 is 1.5 of them.
    let cube = ([8.0f32, 8.0, 8.0], 20.0f32);
    let mk_cube = |pts: &[[f32; 3]], cell: f32| {
        let mut a = Analyzer::new(cell);
        a.add_records(cube.0, cube.1, &recs(pts, cube.0, cube.1), None);
        a.build();
        a
    };
    let known = {
        // 2 degrees about Z through the room centre, then 0.15 m of translation
        let (s2, c2) = 2.0f32.to_radians().sin_cos();
        let piv = [mid, mid, mid];
        let rr = [[c2, -s2, 0.0], [s2, c2, 0.0], [0.0, 0.0, 1.0]];
        let mut m = [0.0f32; 16];
        for i in 0..3 {
            for j in 0..3 { m[i * 4 + j] = rr[i][j]; }
            m[i * 4 + 3] = piv[i] - (rr[i][0] * piv[0] + rr[i][1] * piv[1] + rr[i][2] * piv[2]);
        }
        m[3] += 0.15; m[7] -= 0.08; m[11] += 0.05;
        m[15] = 1.0;
        m
    };
    let apply = |m: &[f32; 16], p: &[f32; 3]| [
        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
        m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
        m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
    // a cheap deterministic jitter, so the test is repeatable
    let mut seed = 0x9E3779B9u32;
    let mut noise = move || { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; (seed as f32 / u32::MAX as f32 - 0.5) * 0.002 };
    let moved: Vec<[f32; 3]> = room.iter().map(|p| {
        let q = apply(&known, p);
        [q[0] + noise(), q[1] + noise(), q[2] + noise()]
    }).collect();

    let mut reference = mk_cube(&room, 0.15);
    reference.compute_normals(16, |_| {});
    let report = |name: &str, m: &[f32; 16]| {
        // m composed with the known transform should be the identity
        let mut c = [0.0f32; 16];
        for r in 0..4 { for k in 0..4 {
            let mut t = 0.0; for q in 0..4 { t += m[r * 4 + q] * known[q * 4 + k]; }
            c[r * 4 + k] = t;
        }}
        let trans = (c[3] * c[3] + c[7] * c[7] + c[11] * c[11]).sqrt();
        let tr = (c[0] + c[5] + c[10]).clamp(-1.0, 3.0);
        let ang = (((tr - 1.0) / 2.0).clamp(-1.0, 1.0)).acos().to_degrees();
        println!("      {name}: residual {:.4} mm and {:.4} deg", trans * 1000.0, ang);
        (trans, ang)
    };

    let mut moving = mk_cube(&moved, 0.15);
    let r = moving.icp(&reference, 40, 0.45, 200_000, |_, _| {});
    let (trans, ang) = report("full overlap", &r.matrix);
    ck("ICP undoes a known transform", trans < 0.001 && ang < 0.05,
       format!("RMS {:.3} mm, {} pairs, {:.0}% overlap, {} iterations", r.rms * 1000.0, r.pairs, r.overlap * 100.0, r.iterations));
    ck("and converges rather than drifting", r.rms_history.len() >= 2 && r.rms <= r.rms_history[0],
       format!("RMS {:.3} -> {:.3} mm over {} iterations", r.rms_history[0] * 1000.0, r.rms * 1000.0, r.rms_history.len()));

    // 60% overlap: the moving cloud only covers part of the reference
    let cut = lo + (hi - lo) * 0.6;
    let partial: Vec<[f32; 3]> = moved.iter().filter(|p| {
        // the same 60% slice measured in the reference frame, so the walls stay walls
        let q = [p[0], p[1], p[2]];
        q[0] <= cut + 0.2
    }).copied().collect();
    let mut moving2 = mk_cube(&partial, 0.15);
    let r2 = moving2.icp(&reference, 40, 0.45, 200_000, |_, _| {});
    let (t2, a2) = report("60% overlap", &r2.matrix);
    ck("ICP works at 60% overlap", t2 < 0.001 && a2 < 0.05,
       format!("{} of {} points, RMS {:.3} mm, {:.0}% of pairs kept", partial.len(), moved.len(), r2.rms * 1000.0, r2.overlap * 100.0));

    // and cloud-to-cloud distance on the registered result
    let mut aligned = mk_cube(&room.iter().map(|p| [p[0] + 0.01, p[1], p[2]]).collect::<Vec<_>>(), 0.15);
    let d = aligned.distance_to(&reference, false, 2.0, |_| {});
    let mut dv: Vec<f32> = d.iter().copied().filter(|v| v.is_finite()).collect();
    let md = med(&mut dv);
    ck("cloud-to-cloud distance reads the offset", (md - 0.01).abs() < 0.002,
       format!("median {:.4} m against a planted 0.0100 m", md));
    let ds = aligned.distance_to(&reference, true, 2.0, |_| {});
    let signed_span = ds.iter().copied().filter(|v| v.is_finite()).fold((f32::MAX, f32::MIN), |(a, b), v| (a.min(v), b.max(v)));
    ck("signed distance keeps both sides", signed_span.0 < -0.005 && signed_span.1 > 0.005,
       format!("{:.4} to {:.4} m", signed_span.0, signed_span.1));

    // ---------------------------------------------------------------- fitting primitives
    // Known shapes with a millimetre of noise on them, because a fit that is only tested on
    // exact data is only tested on the one case that never happens.
    let mut rs = 0x2545F4914F6CDD1Du64;
    let mut jit = move |amp: f32| { rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; (rs as f32 / u64::MAX as f32 - 0.5) * 2.0 * amp };

    // a plane tilted 20 degrees, 1 mm of noise
    let (sp, cp) = 20.0f32.to_radians().sin_cos();
    let planep: Vec<[f32; 3]> = (0..80).flat_map(|i| (0..80).map(move |j| (i, j)).collect::<Vec<_>>()).map(|(i, j)| {
        let (x, y) = (i as f32 * 0.05, j as f32 * 0.05);
        [20.0 + x, 20.0 + y * cp, 20.0 + y * sp]
    }).map(|p| [p[0] + jit(0.001), p[1] + jit(0.001), p[2] + jit(0.001)]).collect();
    let flat: Vec<f32> = planep.iter().flat_map(|p| p.iter().copied()).collect();
    let idx: Vec<u32> = (0..planep.len() as u32).collect();
    let pl = shapes::fit_plane(&idx, &flat).unwrap();
    let want_n = [0.0f64, -(sp as f64), cp as f64];
    let dotn = (pl.n[0] * want_n[0] + pl.n[1] * want_n[1] + pl.n[2] * want_n[2]).abs();
    ck("plane normal is the true one", dotn > 0.99999, format!("{:.5} deg off, RMS {:.3} mm", dotn.clamp(-1.0, 1.0).acos().to_degrees(), pl.rms * 1000.0));
    ck("plane RMS is the noise, not more", pl.rms < 0.0012 && pl.rms > 0.0002, format!("{:.3} mm against 1 mm of jitter", pl.rms * 1000.0));

    // a sphere of radius 1.25 at a known centre
    let sc = [30.0f64, 12.0, 7.5];
    let sr = 1.25f64;
    let ga2 = std::f32::consts::PI * (3.0 - 5.0f32.sqrt());
    let sph: Vec<f32> = (0..20_000).flat_map(|i| {
        let y = 1.0 - (i as f32 / 19_999.0) * 2.0;
        let rad = (1.0 - y * y).max(0.0).sqrt();
        let th = ga2 * i as f32;
        [sc[0] as f32 + th.cos() * rad * sr as f32 + jit(0.001),
         sc[1] as f32 + y * sr as f32 + jit(0.001),
         sc[2] as f32 + th.sin() * rad * sr as f32 + jit(0.001)]
    }).collect();
    let sidx: Vec<u32> = (0..(sph.len() / 3) as u32).collect();
    let sf = shapes::fit_sphere(&sidx, &sph).unwrap();
    let cerr = ((sf.c[0] - sc[0]).powi(2) + (sf.c[1] - sc[1]).powi(2) + (sf.c[2] - sc[2]).powi(2)).sqrt();
    ck("sphere centre to under a millimetre", cerr < 0.001, format!("{:.4} mm off", cerr * 1000.0));
    ck("sphere radius to under a millimetre", (sf.r - sr).abs() < 0.001, format!("{:.5} m against {sr}, RMS {:.3} mm", sf.r, sf.rms * 1000.0));

    // a cylinder about a tilted axis, with its true normals
    let axis = { let v = [0.3f64, 0.0, 1.0]; let l = (v[0] * v[0] + v[2] * v[2]).sqrt(); [v[0] / l, 0.0, v[2] / l] };
    let u = [axis[2], 0.0, -axis[0]];
    let w = [0.0f64, 1.0, 0.0];
    let cyr = 0.4f64;
    let cyc = [5.0f64, 6.0, 7.0];
    let mut cyl: Vec<f32> = Vec::new();
    let mut cyn: Vec<f32> = Vec::new();
    for i in 0..200 {
        for k in 0..60 {
            let t = -1.5 + 3.0 * (i as f64 / 199.0);
            let a = 2.0 * std::f64::consts::PI * (k as f64 / 60.0);
            let n = [u[0] * a.cos() + w[0] * a.sin(), u[1] * a.cos() + w[1] * a.sin(), u[2] * a.cos() + w[2] * a.sin()];
            for d in 0..3 { cyl.push((cyc[d] + axis[d] * t + n[d] * cyr) as f32 + jit(0.0005)); }
            for d in 0..3 { cyn.push(n[d] as f32); }
        }
    }
    let cidx: Vec<u32> = (0..(cyl.len() / 3) as u32).collect();
    let cf = shapes::fit_cylinder(&cidx, &cyl, &cyn).unwrap();
    let adot = (cf.axis[0] * axis[0] + cf.axis[1] * axis[1] + cf.axis[2] * axis[2]).abs().clamp(0.0, 1.0);
    ck("cylinder axis to under a tenth of a degree", adot.acos().to_degrees() < 0.1, format!("{:.4} deg off", adot.acos().to_degrees()));
    ck("cylinder radius to under a millimetre", (cf.r - cyr).abs() < 0.001, format!("{:.5} m against {cyr}, RMS {:.3} mm", cf.r, cf.rms * 1000.0));

    // a circle in a tilted plane
    let mut cir: Vec<f32> = Vec::new();
    for k in 0..2000 {
        let a = 2.0 * std::f64::consts::PI * (k as f64 / 2000.0);
        for d in 0..3 { cir.push((cyc[d] + (u[d] * a.cos() + w[d] * a.sin()) * 0.8) as f32 + jit(0.0005)); }
    }
    let ciidx: Vec<u32> = (0..(cir.len() / 3) as u32).collect();
    let cir_f = shapes::fit_circle(&ciidx, &cir).unwrap();
    ck("circle radius and centre", (cir_f.r - 0.8).abs() < 0.001 && ((cir_f.c[0] - cyc[0]).powi(2) + (cir_f.c[1] - cyc[1]).powi(2) + (cir_f.c[2] - cyc[2]).powi(2)).sqrt() < 0.001,
       format!("r {:.5} m against 0.8, centre {:.4} mm off", cir_f.r, ((cir_f.c[0] - cyc[0]).powi(2) + (cir_f.c[1] - cyc[1]).powi(2) + (cir_f.c[2] - cyc[2]).powi(2)).sqrt() * 1000.0));

    // ---------------------------------------------------------------- detection
    // three walls of a room, a sphere sitting in it, and a fifth of the points as pure noise
    let mut scene: Vec<f32> = Vec::new();
    let mut snrm: Vec<f32> = Vec::new();
    let push = |s: &mut Vec<f32>, n: &mut Vec<f32>, p: [f32; 3], q: [f32; 3]| { s.extend_from_slice(&p); n.extend_from_slice(&q); };
    for i in 0..100 { for k in 0..100 {
        let (a, b) = (i as f32 * 0.06, k as f32 * 0.06);
        push(&mut scene, &mut snrm, [a + jit(0.001), b + jit(0.001), jit(0.001)], [0.0, 0.0, 1.0]);          // floor
        push(&mut scene, &mut snrm, [a + jit(0.001), jit(0.001), b + jit(0.001)], [0.0, 1.0, 0.0]);          // wall y=0
        push(&mut scene, &mut snrm, [jit(0.001), a + jit(0.001), b + jit(0.001)], [1.0, 0.0, 0.0]);          // wall x=0
    }}
    let ball = [3.0f32, 3.0, 1.2];
    for i in 0..8000 {
        let y = 1.0 - (i as f32 / 7999.0) * 2.0;
        let rad = (1.0 - y * y).max(0.0).sqrt();
        let th = ga2 * i as f32;
        let d = [th.cos() * rad, y, th.sin() * rad];
        push(&mut scene, &mut snrm, [ball[0] + d[0] * 0.5 + jit(0.001), ball[1] + d[1] * 0.5 + jit(0.001), ball[2] + d[2] * 0.5 + jit(0.001)], d);
    }
    let planted = scene.len() / 3;
    for _ in 0..(planted / 5) {
        push(&mut scene, &mut snrm, [jit(3.0) + 3.0, jit(3.0) + 3.0, jit(3.0) + 3.0], [0.0, 0.0, 1.0]);
    }
    let t_det = std::time::Instant::now();
    let (found, labels) = shapes::detect(&scene, &snrm, 0.006, 4000, 6, (true, true, true), 300, 12345, |_| {});
    println!("\n  detection: {} points ({} noise), {} shapes in {:.2}s",
             scene.len() / 3, (scene.len() / 3) - planted, found.len(), t_det.elapsed().as_secs_f32());
    for f in found.iter() { println!("      {} · {} points · RMS {:.2} mm", f.kind, f.support, f.rms * 1000.0); }
    let planes = found.iter().filter(|f| f.kind == "plane").count();
    let spheres = found.iter().filter(|f| f.kind == "sphere").count();
    ck("RANSAC finds the three planted planes", planes >= 3, format!("{planes} planes"));
    ck("and the planted sphere", spheres >= 1, format!("{spheres} spheres"));
    if let Some(sp) = found.iter().find(|f| f.kind == "sphere") {
        let d = ((sp.params[0] - ball[0] as f64).powi(2) + (sp.params[1] - ball[1] as f64).powi(2) + (sp.params[2] - ball[2] as f64).powi(2)).sqrt();
        ck("the sphere it found is the one that was planted", d < 0.01 && (sp.params[3] - 0.5).abs() < 0.01,
           format!("centre {:.1} mm off, r {:.4} m against 0.5", d * 1000.0, sp.params[3]));
    }
    let claimed = labels.iter().filter(|&&l| l >= 0).count();
    ck("the noise is left unclaimed", claimed >= planted * 9 / 10 && claimed <= planted + planted / 20,
       format!("{claimed} of {planted} real points labelled, {} noise points present", (scene.len() / 3) - planted));

    // ------------------------------------------------------------- point to triangle
    // A unit cube at the origin, two triangles a face. Nearest-vertex would answer 0.866 for
    // a point above the centre of the top face; point-to-triangle has to answer 1.0.
    let cube_v: Vec<f32> = vec![
        0.0, 0.0, 0.0,  1.0, 0.0, 0.0,  1.0, 1.0, 0.0,  0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,  1.0, 0.0, 1.0,  1.0, 1.0, 1.0,  0.0, 1.0, 1.0];
    let cube_i: Vec<u32> = vec![
        0,2,1, 0,3,2,   4,5,6, 4,6,7,          // bottom (down), top (up)
        0,1,5, 0,5,4,   1,2,6, 1,6,5,
        2,3,7, 2,7,6,   3,0,4, 3,4,7];
    let grid = e57_wasm::meshdist::MeshGrid::new(cube_v.clone(), cube_i.clone());
    let d = |p: [f32; 3]| grid.distance(p, 100.0).map(|(d, _)| d).unwrap_or(f32::NAN);
    ck("a point above a face measures to the face", (d([0.5, 0.5, 3.0]) - 2.0).abs() < 1e-4,
       format!("{:.5} m against 2.0 (nearest vertex would say {:.3})", d([0.5, 0.5, 3.0]), (0.5f32.powi(2) * 2.0 + 4.0).sqrt()));
    ck("a point off a corner measures to the corner", (d([-1.0, -1.0, -1.0]) - 3f32.sqrt()).abs() < 1e-4,
       format!("{:.5} m against {:.5}", d([-1.0, -1.0, -1.0]), 3f32.sqrt()));
    ck("a point off an edge measures to the edge", (d([-3.0, 0.5, -4.0]) - 5.0).abs() < 1e-4,
       format!("{:.5} m against 5.0", d([-3.0, 0.5, -4.0])));
    ck("a point on the surface measures zero", d([0.25, 0.75, 1.0]) < 1e-5, format!("{:.7} m", d([0.25, 0.75, 1.0])));
    ck("a point inside measures to the nearest wall", (d([0.5, 0.5, 0.5]) - 0.5).abs() < 1e-4,
       format!("{:.5} m against 0.5", d([0.5, 0.5, 0.5])));
    // a shell of points at a known offset: what the driver checks in the browser
    let mut off = Vec::new();
    for i in 0..40 { for j in 0..40 {
        off.push([i as f32 / 39.0, j as f32 / 39.0, 1.25]);
    }}
    let flat: Vec<f32> = off.iter().flat_map(|p| p.iter().copied()).collect();
    let ds = grid.distances(&flat, false, 100.0, |_| {});
    let worst = ds.iter().fold(0.0f32, |m, &v| m.max((v - 0.25).abs()));
    ck("a plane of points 25 cm above reads 25 cm", worst < 1e-4, format!("worst {:.4} mm off", worst * 1000.0));

    println!("\n{}", if fails == 0 { "ALL CHECKS PASSED".into() } else { format!("{fails} CHECK(S) FAILED") });
    std::process::exit(if fails == 0 { 0 } else { 1 });
}
