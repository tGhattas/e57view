// SPDX-License-Identifier: GPL-3.0-only
//! Fast columnar reader for E57 CompressedVector sections.
//!
//! The `e57` crate's readers validate a CRC on every 1 KB page, pull each value
//! out with a 16-byte copy into a u128, box it in a `RecordValue`, and build a
//! `Vec` per point. That is ~4.5 M points/s. This reader skips CRC validation,
//! reads the paged file in multi-megabyte chunks, decodes each field with a
//! type-specific fast path straight into typed columns, and hands batches of
//! columns to a callback. No per-point allocation anywhere.

use e57::{PointCloud, RecordDataType};
use std::io::{Read, Seek, SeekFrom};

const PAGE: u64 = 1024;
const PAYLOAD: u64 = 1020;
/// Physical bytes fetched per refill. Multiple of PAGE.
const CHUNK: usize = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Bulk paged reader: strips the 4-byte CRC from each 1024-byte page without
// computing it, and serves the logical byte stream from a large buffer.
// ---------------------------------------------------------------------------

pub struct BulkPaged<R: Read + Seek> {
    inner: R,
    phys_len: u64,
    buf: Vec<u8>,
    pos: usize,      // read cursor into buf
    next_log: u64,   // logical offset of buf[buf.len()]
    base_log: u64,   // logical offset of buf[0]
    scratch: Vec<u8>,
}

impl<R: Read + Seek> BulkPaged<R> {
    pub fn new(mut inner: R) -> std::io::Result<Self> {
        let phys_len = inner.seek(SeekFrom::End(0))?;
        Ok(Self { inner, phys_len, buf: Vec::new(), pos: 0, next_log: 0, base_log: 0,
                  scratch: vec![0u8; CHUNK] })
    }

    pub fn seek_physical(&mut self, phys: u64) {
        let pages_before = phys / PAGE;
        let log = phys - pages_before * 4;
        self.buf.clear();
        self.pos = 0;
        self.base_log = log;
        self.next_log = log;
    }

    #[inline]
    pub fn logical_pos(&self) -> u64 { self.base_log + self.pos as u64 }

    fn refill(&mut self) -> std::io::Result<bool> {
        // compact consumed bytes
        if self.pos > 0 {
            self.buf.drain(..self.pos);
            self.base_log += self.pos as u64;
            self.pos = 0;
        }
        let page = self.next_log / PAYLOAD;
        let in_page = (self.next_log % PAYLOAD) as usize;
        let phys = page * PAGE;
        if phys >= self.phys_len { return Ok(false); }
        let want = (CHUNK as u64).min(self.phys_len - phys) as usize;
        let want = want - (want % PAGE as usize);
        if want == 0 { return Ok(false); }
        self.inner.seek(SeekFrom::Start(phys))?;
        self.inner.read_exact(&mut self.scratch[..want])?;
        let pages = want / PAGE as usize;
        self.buf.reserve(pages * PAYLOAD as usize);
        for p in 0..pages {
            let s = p * PAGE as usize;
            let src = &self.scratch[s..s + PAYLOAD as usize];
            if p == 0 { self.buf.extend_from_slice(&src[in_page..]); }
            else { self.buf.extend_from_slice(src); }
        }
        self.next_log = (page + pages as u64) * PAYLOAD;
        Ok(true)
    }

    /// Guarantee `n` bytes are available at the cursor.
    #[inline]
    pub fn ensure(&mut self, n: usize) -> std::io::Result<()> {
        while self.buf.len() - self.pos < n {
            if !self.refill()? {
                return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "eof inside compressed vector"));
            }
        }
        Ok(())
    }

    #[inline]
    pub fn take(&mut self, n: usize) -> std::io::Result<&[u8]> {
        self.ensure(n)?;
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn skip_to_logical(&mut self, target: u64) -> std::io::Result<()> {
        let cur = self.logical_pos();
        if target < cur { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "backward skip")); }
        let mut left = (target - cur) as usize;
        while left > 0 {
            let avail = self.buf.len() - self.pos;
            if avail == 0 {
                if !self.refill()? { return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "eof in skip")); }
                continue;
            }
            let n = left.min(avail);
            self.pos += n;
            left -= n;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Per-field decoders writing straight into typed columns
// ---------------------------------------------------------------------------

pub enum Column { F32(Vec<f32>), F64(Vec<f64>), I64(Vec<i64>) }

impl Column {
    #[inline] pub fn len(&self) -> usize {
        match self { Column::F32(v) => v.len(), Column::F64(v) => v.len(), Column::I64(v) => v.len() }
    }
    #[inline] pub fn get(&self, i: usize) -> f64 {
        match self { Column::F32(v) => v[i] as f64, Column::F64(v) => v[i], Column::I64(v) => v[i] as f64 }
    }
    fn drain(&mut self, n: usize) {
        match self { Column::F32(v) => { v.drain(..n); }, Column::F64(v) => { v.drain(..n); }, Column::I64(v) => { v.drain(..n); } }
    }
}

enum Dec {
    Single { lo: Vec<u8> },
    Double { lo: Vec<u8> },
    /// Bit-packed integer, bits <= 57, accumulator path
    Bits { bits: u32, mask: u64, min: i64, acc: u64, nacc: u32, scale: f64, offset: f64, scaled: bool },
    /// Bit-packed integer, 58..=64 bits, u128 path
    Wide { bits: u32, min: i64, acc: u128, nacc: u32, scale: f64, offset: f64, scaled: bool },
    /// min == max: zero bits, value is implied
    Const { value: f64 },
}

pub struct FieldDec { dec: Dec, pub col: Column, pub scale: f64, pub offset: f64 }

impl FieldDec {
    fn new(dt: &RecordDataType) -> Self {
        match dt {
            RecordDataType::Single { .. } => FieldDec { dec: Dec::Single { lo: Vec::new() }, col: Column::F32(Vec::new()), scale: 1.0, offset: 0.0 },
            RecordDataType::Double { .. } => FieldDec { dec: Dec::Double { lo: Vec::new() }, col: Column::F64(Vec::new()), scale: 1.0, offset: 0.0 },
            RecordDataType::Integer { min, max } => Self::packed(*min, *max, 1.0, 0.0, false),
            RecordDataType::ScaledInteger { min, max, scale, offset } => Self::packed(*min, *max, *scale, *offset, true),
        }
    }
    fn packed(min: i64, max: i64, scale: f64, offset: f64, scaled: bool) -> Self {
        let range = max as i128 - min as i128;
        let bits = if range <= 0 { 0 } else { range.ilog2() + 1 };
        let col = if scaled { Column::F64(Vec::new()) } else { Column::I64(Vec::new()) };
        let dec = if bits == 0 {
            Dec::Const { value: if scaled { min as f64 * scale + offset } else { min as f64 } }
        } else if bits <= 57 {
            Dec::Bits { bits, mask: (1u64 << bits) - 1, min, acc: 0, nacc: 0, scale, offset, scaled }
        } else {
            Dec::Wide { bits, min, acc: 0, nacc: 0, scale, offset, scaled }
        };
        FieldDec { dec, col, scale, offset }
    }

    #[inline]
    fn feed(&mut self, data: &[u8]) {
        match &mut self.dec {
            Dec::Single { lo } => {
                let out = match &mut self.col { Column::F32(v) => v, _ => unreachable!() };
                let mut src: &[u8] = data;
                if !lo.is_empty() {
                    // complete the partial value from the previous packet
                    while lo.len() < 4 && !src.is_empty() { lo.push(src[0]); src = &src[1..]; }
                    if lo.len() == 4 { out.push(f32::from_le_bytes([lo[0], lo[1], lo[2], lo[3]])); lo.clear(); }
                    else { return; }
                }
                let whole = src.len() / 4;
                out.reserve(whole);
                for c in src[..whole * 4].chunks_exact(4) {
                    out.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
                }
                lo.extend_from_slice(&src[whole * 4..]);
            }
            Dec::Double { lo } => {
                let out = match &mut self.col { Column::F64(v) => v, _ => unreachable!() };
                let mut src: &[u8] = data;
                if !lo.is_empty() {
                    while lo.len() < 8 && !src.is_empty() { lo.push(src[0]); src = &src[1..]; }
                    if lo.len() == 8 {
                        let mut b = [0u8; 8]; b.copy_from_slice(lo);
                        out.push(f64::from_le_bytes(b)); lo.clear();
                    } else { return; }
                }
                let whole = src.len() / 8;
                out.reserve(whole);
                for c in src[..whole * 8].chunks_exact(8) {
                    let mut b = [0u8; 8]; b.copy_from_slice(c);
                    out.push(f64::from_le_bytes(b));
                }
                lo.extend_from_slice(&src[whole * 8..]);
            }
            Dec::Bits { bits, mask, min, acc, nacc, scale, offset, scaled } => {
                let (bits, mask, min, scale, offset, scaled) = (*bits, *mask, *min, *scale, *offset, *scaled);
                match &mut self.col {
                    Column::F64(out) => {
                        out.reserve(data.len() * 8 / bits as usize + 1);
                        for &b in data {
                            *acc |= (b as u64) << *nacc; *nacc += 8;
                            while *nacc >= bits {
                                let v = (*acc & mask) as i64 + min;
                                *acc >>= bits; *nacc -= bits;
                                out.push(if scaled { v as f64 * scale + offset } else { v as f64 });
                            }
                        }
                    }
                    Column::I64(out) => {
                        out.reserve(data.len() * 8 / bits as usize + 1);
                        for &b in data {
                            *acc |= (b as u64) << *nacc; *nacc += 8;
                            while *nacc >= bits {
                                out.push((*acc & mask) as i64 + min);
                                *acc >>= bits; *nacc -= bits;
                            }
                        }
                    }
                    _ => unreachable!(),
                }
            }
            Dec::Wide { bits, min, acc, nacc, scale, offset, scaled } => {
                let (bits, min, scale, offset, scaled) = (*bits, *min, *scale, *offset, *scaled);
                let mask: u128 = (1u128 << bits) - 1;
                for &b in data {
                    *acc |= (b as u128) << *nacc; *nacc += 8;
                    while *nacc >= bits {
                        let v = ((*acc & mask) as i128 + min as i128) as i64;
                        *acc >>= bits; *nacc -= bits;
                        match &mut self.col {
                            Column::F64(out) => out.push(if scaled { v as f64 * scale + offset } else { v as f64 }),
                            Column::I64(out) => out.push(v),
                            _ => unreachable!(),
                        }
                    }
                }
            }
            Dec::Const { .. } => {}
        }
    }

    /// Const fields produce no bytes; top them up to `n` values.
    fn pad_const(&mut self, n: usize) {
        if let Dec::Const { value } = self.dec {
            let v = value;
            match &mut self.col {
                Column::F64(out) => while out.len() < n { out.push(v) },
                Column::I64(out) => while out.len() < n { out.push(v as i64) },
                Column::F32(out) => while out.len() < n { out.push(v as f32) },
            }
        }
    }
    fn is_const(&self) -> bool { matches!(self.dec, Dec::Const { .. }) }
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

pub struct FastReader<R: Read + Seek> {
    paged: BulkPaged<R>,
    pub fields: Vec<FieldDec>,
    records: u64,
    pub read: u64,
    sizes: Vec<usize>,
}

impl<R: Read + Seek> FastReader<R> {
    pub fn new(inner: R, pc: &PointCloud) -> std::io::Result<Self> {
        let mut paged = BulkPaged::new(inner)?;
        paged.seek_physical(pc.file_offset);
        let h = paged.take(32)?;
        if h[0] != 1 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not a compressed vector section")); }
        let data_offset = u64::from_le_bytes(h[16..24].try_into().unwrap());
        paged.seek_physical(data_offset);
        let fields = pc.prototype.iter().map(|r| FieldDec::new(&r.data_type)).collect::<Vec<_>>();
        let n = fields.len();
        Ok(Self { paged, fields, records: pc.records, read: 0, sizes: vec![0; n] })
    }

    /// Decode packets until at least `min_batch` complete records are available
    /// (or the end). Returns the number of complete records now in the columns.
    pub fn fill(&mut self, min_batch: usize) -> std::io::Result<usize> {
        loop {
            let avail = self.available();
            if avail >= min_batch || self.read + avail as u64 >= self.records { return Ok(avail); }
            if !self.next_packet()? { return Ok(self.available()); }
        }
    }

    #[inline]
    pub fn available(&self) -> usize {
        self.fields.iter().filter(|f| !f.is_const()).map(|f| f.col.len()).min().unwrap_or(0)
    }

    /// Drop the first `n` records from every column.
    pub fn consume(&mut self, n: usize) {
        for f in &mut self.fields { f.col.drain(n); }
        self.read += n as u64;
    }

    fn next_packet(&mut self) -> std::io::Result<bool> {
        let start = self.paged.logical_pos();
        let id = self.paged.take(1)?[0];
        match id {
            0 => { // index packet: skip
                let h = self.paged.take(15)?;
                let len = u16::from_le_bytes([h[1], h[2]]) as u64 + 1;
                self.paged.skip_to_logical(start + len)?;
            }
            2 => { // ignored packet
                let h = self.paged.take(3)?;
                let len = u16::from_le_bytes([h[1], h[2]]) as u64 + 1;
                self.paged.skip_to_logical(start + len)?;
            }
            1 => { // data packet
                let h = self.paged.take(5)?;
                let len = u16::from_le_bytes([h[1], h[2]]) as u64 + 1;
                let nbs = u16::from_le_bytes([h[3], h[4]]) as usize;
                if nbs != self.fields.len() {
                    return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bytestream count != prototype size"));
                }
                {
                    let tbl = self.paged.take(2 * nbs)?;
                    for i in 0..nbs { self.sizes[i] = u16::from_le_bytes([tbl[2 * i], tbl[2 * i + 1]]) as usize; }
                }
                let total: usize = self.sizes.iter().sum();
                self.paged.ensure(total)?;
                // feed each field its stream
                for i in 0..nbs {
                    let n = self.sizes[i];
                    let data = self.paged.take(n)?;
                    self.fields[i].feed(data);
                }
                // const fields keep pace with the longest real column
                let target = self.fields.iter().filter(|f| !f.is_const()).map(|f| f.col.len()).max().unwrap_or(0);
                for f in &mut self.fields { f.pad_const(target); }
                self.paged.skip_to_logical(start + len)?;
            }
            _ => return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "unknown packet id")),
        }
        Ok(true)
    }
}
