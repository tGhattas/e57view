// SPDX-License-Identifier: GPL-3.0-only
// LAZ compression round trip and decode rate, against a file the crate writes itself.
// No laszip or pdal on this machine, so the fixture is generated rather than borrowed —
// which also means the expected bytes are known exactly rather than trusted.
use laz::{LasZipCompressor, LasZipDecompressor, LazItemRecordBuilder, LazVlr};
use std::io::{Cursor, Seek, SeekFrom};
use std::time::Instant;

const N: usize = 5_000_000;
const REC: usize = 26; // LAS point format 2: x,y,z i32, intensity u16, flags, rgb u16 x3

fn make_points() -> Vec<u8> {
    // a terrain-ish surface, because laszip's predictors do much better on real structure
    // than on noise and a rate measured on noise would be a lie
    let mut out = vec![0u8; N * REC];
    let side = (N as f64).sqrt() as i32;
    for i in 0..N {
        let (gx, gy) = ((i as i32 % side), (i as i32 / side));
        let x = 100_000 + gx * 25;
        let y = 200_000 + gy * 25;
        let z = 30_000 + ((gx as f64 * 0.01).sin() * 900.0 + (gy as f64 * 0.013).cos() * 700.0) as i32;
        let o = i * REC;
        out[o..o + 4].copy_from_slice(&x.to_le_bytes());
        out[o + 4..o + 8].copy_from_slice(&y.to_le_bytes());
        out[o + 8..o + 12].copy_from_slice(&z.to_le_bytes());
        out[o + 12..o + 14].copy_from_slice(&(((i % 2048) as u16) << 4).to_le_bytes());
        out[o + 14] = 0x09;
        for (k, c) in [(i % 255) as u16, ((i * 7) % 255) as u16, ((i * 13) % 255) as u16].iter().enumerate() {
            out[o + 20 + k * 2..o + 22 + k * 2].copy_from_slice(&(c << 8).to_le_bytes());
        }
    }
    out
}

fn main() {
    let mut fails = 0;
    let mut ck = |name: &str, ok: bool, d: String| {
        println!("{}  {:<40} {}", if ok { "PASS" } else { "FAIL" }, name, d);
        if !ok { fails += 1; }
    };

    let raw = make_points();
    let items = LazItemRecordBuilder::default_for_point_format_id(2, 0).unwrap();
    let vlr = LazVlr::from_laz_items(items);

    let t0 = Instant::now();
    let mut comp = LasZipCompressor::new(Cursor::new(Vec::<u8>::new()), vlr.clone()).unwrap();
    comp.compress_many(&raw).unwrap();
    comp.done().unwrap();
    let compressed = comp.into_inner().into_inner();
    let write_s = t0.elapsed().as_secs_f64();

    let ratio = compressed.len() as f64 / raw.len() as f64;
    println!(
        "\n{} points · {:.1} MB raw -> {:.1} MB laz ({:.1}%) · compressed {:.2}s ({:.1} M pts/s)",
        N, raw.len() as f64 / 1e6, compressed.len() as f64 / 1e6, ratio * 100.0,
        write_s, N as f64 / write_s / 1e6
    );
    ck("compression is worth doing", ratio < 0.5, format!("{:.1}% of the raw records", ratio * 100.0));

    let t1 = Instant::now();
    let mut src = Cursor::new(&compressed);
    src.seek(SeekFrom::Start(0)).unwrap();
    let mut dec = LasZipDecompressor::new(src, vlr).unwrap();
    let mut back = vec![0u8; N * REC];
    // a chunk at a time, the way the viewer reads it
    let chunk = 262_144;
    let mut at = 0;
    while at < N {
        let n = chunk.min(N - at);
        dec.decompress_many(&mut back[at * REC..(at + n) * REC]).unwrap();
        at += n;
    }
    let read_s = t1.elapsed().as_secs_f64();
    println!("decompressed {:.2}s · {:.1} M pts/s · {:.0} MB/s of output",
             read_s, N as f64 / read_s / 1e6, raw.len() as f64 / read_s / 1e6);

    ck("every byte round-trips", back == raw, format!("{} bytes", back.len()));
    ck("decode is fast enough to stream", N as f64 / read_s > 5e6,
       format!("{:.1} M pts/s", N as f64 / read_s / 1e6));

    // seeking to a point index, which is what makes a partial read possible
    let mut src2 = Cursor::new(&compressed);
    src2.seek(SeekFrom::Start(0)).unwrap();
    let items2 = LazItemRecordBuilder::default_for_point_format_id(2, 0).unwrap();
    let mut dec2 = LasZipDecompressor::new(src2, LazVlr::from_laz_items(items2)).unwrap();
    let idx = N as u64 / 2;
    dec2.seek(idx).unwrap();
    let mut one = vec![0u8; REC];
    dec2.decompress_many(&mut one).unwrap();
    ck("seeking lands on the right point", one == raw[idx as usize * REC..(idx as usize + 1) * REC],
       format!("point {idx}"));

    println!("\n{}", if fails == 0 { "ALL CHECKS PASSED".to_string() } else { format!("{fails} CHECK(S) FAILED") });
    std::process::exit(if fails == 0 { 0 } else { 1 });
}
