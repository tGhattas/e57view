// Native validation of the surface reconstruction: mesh shapes whose true surface is known,
// then check the geometry rather than eyeballing a render.
use e57_wasm::mesh::Mesher;
use std::collections::HashMap;

fn sphere_points(r: f32, n: usize) -> Vec<([f32; 3], [f32; 3])> {
    // Fibonacci sphere: even coverage, no pole clustering
    let mut out = Vec::with_capacity(n);
    let ga = std::f32::consts::PI * (3.0 - 5.0f32.sqrt());
    for i in 0..n {
        let y = 1.0 - (i as f32 / (n - 1) as f32) * 2.0;
        let rad = (1.0 - y * y).max(0.0).sqrt();
        let th = ga * i as f32;
        let d = [th.cos() * rad, y, th.sin() * rad];
        out.push(([d[0] * r + 5.0, d[1] * r + 5.0, d[2] * r + 5.0], d));
    }
    out
}

fn plane_points(side: f32, n: usize) -> Vec<([f32; 3], [f32; 3])> {
    let mut out = Vec::new();
    let k = (n as f32).sqrt() as usize;
    for i in 0..k {
        for j in 0..k {
            let x = (i as f32 / (k - 1) as f32 - 0.5) * side;
            let y = (j as f32 / (k - 1) as f32 - 0.5) * side;
            out.push(([x + 3.0, y + 3.0, 2.0], [0.0, 0.0, 1.0]));
        }
    }
    out
}

fn check_manifold(idx: &[u32]) -> (usize, usize) {
    let mut edges: HashMap<(u32, u32), i32> = HashMap::new();
    for t in idx.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            let e = if a < b { (a, b) } else { (b, a) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    let boundary = edges.values().filter(|&&c| c == 1).count();
    let nonmanifold = edges.values().filter(|&&c| c > 2).count();
    (boundary, nonmanifold)
}

fn main() {
    let mut fails = 0;
    let mut check = |name: &str, ok: bool, detail: String| {
        println!("{}  {:<34} {}", if ok { "PASS" } else { "FAIL" }, name, detail);
        if !ok {
            fails += 1;
        }
    };

    // ---------------------------------------------------------------- sphere
    let r = 2.0f32;
    let pts = sphere_points(r, 400_000);
    let t0 = std::time::Instant::now();
    let mut m = Mesher::new(0.05, 2.0, 0.5);
    for (p, n) in &pts {
        m.add_point(*p, Some(*n), (200, 120, 60));
    }
    let splat = t0.elapsed();
    let t1 = std::time::Instant::now();
    let (mesh, st) = m.extract(2, 1.0);
    let extract = t1.elapsed();
    println!(
        "\nsphere r={r} from {} pts · {} bricks · splat {:.2}s · extract {:.2}s · {} verts {} tris",
        pts.len(), m.brick_count(), splat.as_secs_f32(), extract.as_secs_f32(), st.vertices, st.triangles
    );

    check("sphere produced a mesh", st.triangles > 5_000, format!("{} triangles", st.triangles));

    // every vertex should sit on the sphere
    let c = [5.0f32, 5.0, 5.0];
    let mut worst = 0.0f32;
    let mut sum = 0.0f32;
    let nv = mesh.pos.len() / 3;
    for v in 0..nv {
        let d = ((mesh.pos[v * 3] - c[0]).powi(2)
            + (mesh.pos[v * 3 + 1] - c[1]).powi(2)
            + (mesh.pos[v * 3 + 2] - c[2]).powi(2))
        .sqrt();
        let e = (d - r).abs();
        worst = worst.max(e);
        sum += e;
    }
    let mean = sum / nv as f32;
    check("vertices lie on the sphere", mean < 0.01 && worst < 0.05, format!("mean {:.4} m, worst {:.4} m (voxel 0.05)"  , mean, worst));

    // normals must point away from the centre
    let mut outward = 0usize;
    for v in 0..nv {
        let d = [mesh.pos[v * 3] - c[0], mesh.pos[v * 3 + 1] - c[1], mesh.pos[v * 3 + 2] - c[2]];
        let dot = d[0] * mesh.nrm[v * 3] + d[1] * mesh.nrm[v * 3 + 1] + d[2] * mesh.nrm[v * 3 + 2];
        if dot > 0.0 {
            outward += 1;
        }
    }
    let frac = outward as f32 / nv as f32;
    check("normals face outward", frac > 0.99, format!("{:.2}% outward", frac * 100.0));

    let (boundary, nonmanifold) = check_manifold(&mesh.idx);
    check("closed surface, no boundary", boundary == 0, format!("{} boundary edges", boundary));
    check("manifold edges", nonmanifold == 0, format!("{} edges with >2 faces", nonmanifold));

    // surface area should be near 4*pi*r^2
    let mut area = 0.0f32;
    for t in mesh.idx.chunks_exact(3) {
        let (a, b, cc) = (t[0] as usize * 3, t[1] as usize * 3, t[2] as usize * 3);
        let u = [mesh.pos[b] - mesh.pos[a], mesh.pos[b + 1] - mesh.pos[a + 1], mesh.pos[b + 2] - mesh.pos[a + 2]];
        let v = [mesh.pos[cc] - mesh.pos[a], mesh.pos[cc + 1] - mesh.pos[a + 1], mesh.pos[cc + 2] - mesh.pos[a + 2]];
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        area += 0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    }
    let want = 4.0 * std::f32::consts::PI * r * r;
    check("surface area matches", (area - want).abs() / want < 0.05, format!("{:.2} m² vs {:.2} m² ({:+.1}%)", area, want, (area / want - 1.0) * 100.0));

    // colour should survive
    let cok = mesh.col.chunks_exact(3).all(|c| c[0] > 150 && c[1] > 80 && c[2] > 20);
    check("vertex colour carried through", cok, "all vertices near (200,120,60)".into());

    // ---------------------------------------------------------------- plane
    let pl = plane_points(4.0, 250_000);
    let mut m2 = Mesher::new(0.05, 2.0, 0.5);
    for (p, n) in &pl {
        m2.add_point(*p, Some(*n), (30, 200, 90));
    }
    let (mesh2, st2) = m2.extract(1, 1.0);
    let nv2 = mesh2.pos.len() / 3;
    let mut zerr = 0.0f32;
    for v in 0..nv2 {
        zerr = zerr.max((mesh2.pos[v * 3 + 2] - 2.0).abs());
    }
    println!("\nplane 4x4 m from {} pts · {} verts {} tris", pl.len(), st2.vertices, st2.triangles);
    check("plane is flat", zerr < 0.03, format!("worst |z-2.0| = {:.4} m", zerr));
    let (b2, nm2) = check_manifold(&mesh2.idx);
    check("open plane keeps its border", b2 > 100, format!("{} boundary edges", b2));
    check("plane is manifold", nm2 == 0, format!("{} edges with >2 faces", nm2));

    // ---------------------------------------------------------- plane through a model matrix
    // The viewer never bakes a cloud transform into its records, so the mesher has to apply
    // it. Feed the same plane rotated 25 degrees about X, hand the mesher the inverse as the
    // cloud's model matrix, and the surface must come back where the unrotated plane was —
    // which is what keeps a reconstructed surface glued to the points that made it.
    let (sa, ca) = 25.0f32.to_radians().sin_cos();
    let piv = [3.0f32, 3.0, 2.0];
    // row-major rotation about X through piv
    let mut mm = [0.0f32; 16];
    {
        let rr = [[1.0, 0.0, 0.0], [0.0, ca, -sa], [0.0, sa, ca]];
        for i in 0..3 {
            for j in 0..3 { mm[i * 4 + j] = rr[i][j]; }
            mm[i * 4 + 3] = piv[i] - (rr[i][0] * piv[0] + rr[i][1] * piv[1] + rr[i][2] * piv[2]);
        }
        mm[15] = 1.0;
    }
    let mut inv = [0.0f32; 16];
    {
        let rr = [[1.0, 0.0, 0.0], [0.0, ca, sa], [0.0, -sa, ca]];
        for i in 0..3 {
            for j in 0..3 { inv[i * 4 + j] = rr[i][j]; }
            inv[i * 4 + 3] = piv[i] - (rr[i][0] * piv[0] + rr[i][1] * piv[1] + rr[i][2] * piv[2]);
        }
        inv[15] = 1.0;
    }
    // 14-byte records of the rotated plane, exactly as a leaf would hold them
    let mut recs = vec![0u8; pl.len() * 14];
    let kq = 65536.0f32 / 16.0;
    for (i, (p, n)) in pl.iter().enumerate() {
        let rp = [
            mm[0] * p[0] + mm[1] * p[1] + mm[2] * p[2] + mm[3],
            mm[4] * p[0] + mm[5] * p[1] + mm[6] * p[2] + mm[7],
            mm[8] * p[0] + mm[9] * p[1] + mm[10] * p[2] + mm[11],
        ];
        let rn = [
            mm[0] * n[0] + mm[1] * n[1] + mm[2] * n[2],
            mm[4] * n[0] + mm[5] * n[1] + mm[6] * n[2],
            mm[8] * n[0] + mm[9] * n[1] + mm[10] * n[2],
        ];
        let o = i * 14;
        for a in 0..3 {
            let q = (rp[a] * kq).round().clamp(0.0, 65535.0) as u16;
            recs[o + a * 2..o + a * 2 + 2].copy_from_slice(&q.to_le_bytes());
        }
        recs[o + 6] = 30; recs[o + 7] = 200; recs[o + 8] = 90;
        for a in 0..3 { recs[o + 10 + a] = ((rn[a] * 127.0).round().clamp(-127.0, 127.0) as i8) as u8; }
    }
    let mut m4 = Mesher::new(0.05, 2.0, 0.5);
    m4.add_records([0.0, 0.0, 0.0], 16.0, &recs, 1, Some(&inv));
    let (mesh4, st4) = m4.extract(1, 1.0);
    let nv4 = mesh4.pos.len() / 3;
    let mut zerr4 = 0.0f32;
    for v in 0..nv4 { zerr4 = zerr4.max((mesh4.pos[v * 3 + 2] - 2.0).abs()); }
    println!("\nrotated plane meshed through the inverse model · {} verts {} tris", st4.vertices, st4.triangles);
    check("model matrix levels the surface", nv4 > 1000 && zerr4 < 0.04, format!("worst |z-2.0| = {:.4} m over {} verts", zerr4, nv4));
    let mut upn = 0usize;
    for v in 0..nv4 { if mesh4.nrm[v * 3 + 2].abs() > 0.9 { upn += 1; } }
    check("model matrix rotates the normals", upn > nv4 * 95 / 100, format!("{}/{} with |nz|>0.9", upn, nv4));

    // ---------------------------------------------------------------- unoriented fallback
    let mut m3 = Mesher::new(0.06, 2.0, 0.5);
    for (p, _) in &pts {
        m3.add_point(*p, None, (10, 10, 200));
    }
    let (mesh3, st3) = m3.extract(2, 1.0);
    println!("\nsphere without normals (density mode) · {} verts {} tris", st3.vertices, st3.triangles);
    check("density fallback produces a surface", st3.triangles > 1_000, format!("{} triangles", st3.triangles));
    let mut worst3 = 0.0f32;
    for v in 0..mesh3.pos.len() / 3 {
        let d = ((mesh3.pos[v * 3] - c[0]).powi(2) + (mesh3.pos[v * 3 + 1] - c[1]).powi(2) + (mesh3.pos[v * 3 + 2] - c[2]).powi(2)).sqrt();
        worst3 = worst3.max((d - r).abs());
    }
    check("density surface near the true one", worst3 < 0.25, format!("worst {:.3} m", worst3));

    println!("\n{}", if fails == 0 { "ALL CHECKS PASSED".to_string() } else { format!("{fails} CHECK(S) FAILED") });
    std::process::exit(if fails == 0 { 0 } else { 1 });
}
