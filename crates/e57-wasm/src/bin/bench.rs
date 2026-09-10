//! Native check + benchmark: validates the fast reader against the `e57` crate
//! on a prefix, then times a full decode + octree build.
use e57_wasm::{core, fast::FastReader, octree::Octree};
use e57::{E57Reader, RecordValue};
use std::fs::File;
use std::io::BufReader;
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("path");
    let check_n: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(3_000_000);

    let mut r = E57Reader::from_file(&path).unwrap();
    let pc = r.pointclouds()[0].clone();
    let nf = pc.prototype.len();

    // ---- 1. validation: column sums over the first check_n records ----
    let t = Instant::now();
    let f = BufReader::with_capacity(1 << 20, File::open(&path).unwrap());
    let mut fr = FastReader::new(f, &pc).unwrap();
    let mut fast_sums = vec![0f64; nf]; let mut got = 0usize;
    while got < check_n {
        let n = fr.fill(1 << 16).unwrap(); if n == 0 { break; }
        let take = n.min(check_n - got);
        for i in 0..nf { for k in 0..take { fast_sums[i] += fr.fields[i].col.get(k); } }
        fr.consume(take); got += take;
        if take < n { break; }
    }
    let tf = t.elapsed().as_secs_f64();

    let t = Instant::now();
    let mut crate_sums = vec![0f64; nf]; let mut cn = 0usize;
    for row in r.pointcloud_raw(&pc).unwrap() {
        let row = row.unwrap();
        for i in 0..nf {
            crate_sums[i] += match &row[i] {
                RecordValue::Single(v) => *v as f64, RecordValue::Double(v) => *v,
                RecordValue::Integer(v) => *v as f64,
                RecordValue::ScaledInteger(v) => match &pc.prototype[i].data_type {
                    e57::RecordDataType::ScaledInteger { scale, offset, .. } => *v as f64 * scale + offset, _ => *v as f64 },
            };
        }
        cn += 1; if cn >= check_n { break; }
    }
    let tc = t.elapsed().as_secs_f64();
    println!("VALIDATE {} records: fast {:.2}s ({:.1} M/s)  crate {:.2}s ({:.1} M/s)  speedup {:.1}x",
        got, tf, got as f64 / tf / 1e6, tc, cn as f64 / tc / 1e6, tc / tf);
    let mut ok = true;
    for i in 0..nf {
        let rel = ((fast_sums[i] - crate_sums[i]).abs()) / crate_sums[i].abs().max(1e-9);
        let pass = rel < 1e-6;
        ok &= pass;
        println!("  field {:2} {:?}: fast={:.4} crate={:.4} {}", i, pc.prototype[i].name, fast_sums[i], crate_sums[i], if pass { "OK" } else { "MISMATCH" });
    }
    println!("VALIDATION {}", if ok { "PASSED" } else { "FAILED" });

    // ---- 2. full decode + octree ----
    let q = core::rotation_of(&pc);
    let (mn, mx) = core::declared_bounds(&pc, q).unwrap();
    let mut tree = Octree::new(mn, mx);
    let pcube = tree.root_bounds();
    let f = BufReader::with_capacity(1 << 20, File::open(&path).unwrap());
    let t = Instant::now();
    let mut pv = 0usize;
    let stats = core::decode(f, &pc, 1, pcube, 50, |_b, n| { pv += n; }, |_d, _t| false, &mut tree).unwrap();
    let td = t.elapsed().as_secs_f64();
    let leaves = tree.leaf_indices();
    println!("\nFULL decode+bin: {} read, {} kept, {} invalid, {:.2}s -> {:.1} M pts/s", stats.read, stats.kept, stats.dropped_invalid, td, stats.kept as f64 / td / 1e6);
    println!("octree: {} nodes, {} leaves, preview {} pts", tree.nodes.len(), leaves.len(), pv);
    let counts: Vec<usize> = leaves.iter().map(|&i| tree.nodes[i].leaf.as_ref().unwrap().count).collect();
    let depths: Vec<u8> = leaves.iter().map(|&i| tree.nodes[i].depth).collect();
    println!("leaf size: min {} max {} mean {}  depth: min {} max {}",
        counts.iter().min().unwrap(), counts.iter().max().unwrap(), counts.iter().sum::<usize>() / counts.len(),
        depths.iter().min().unwrap(), depths.iter().max().unwrap());

    let t = Instant::now();
    for &i in &leaves { tree.nodes[i].leaf.as_mut().unwrap().shuffle(i as u64 * 7919 + 1); }
    println!("shuffle all leaves: {:.2}s", t.elapsed().as_secs_f64());
    let t = Instant::now();
    let mut tb = [0u64; 3];
    for &i in &leaves { let (a, b) = tree.nodes[i].leaf.as_ref().unwrap().qbounds(); tb[0] += a[0] as u64 + b[0] as u64; }
    println!("qbounds all leaves: {:.2}s [{}]", t.elapsed().as_secs_f64(), tb[0]);
}
