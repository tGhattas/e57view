// Native validation of the neighbourhood analyses against shapes with known answers.
use e57_wasm::analysis::{Analyzer, Feature};

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
    let mut a = Analyzer::new(cell);
    a.add_records([0.0, 0.0, 0.0], 100.0, &recs(pts, [0.0, 0.0, 0.0], 100.0));
    a.build();
    a
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

    println!("\n{}", if fails == 0 { "ALL CHECKS PASSED".into() } else { format!("{fails} CHECK(S) FAILED") });
    std::process::exit(if fails == 0 { 0 } else { 1 });
}
