use e57::{E57Reader, CartesianCoordinate};
use std::io::{Read, Seek, SeekFrom, Result as IoResult, Error as IoError, ErrorKind};
use wasm_bindgen::prelude::*;

/// A Read+Seek source backed by a JS callback that performs a SYNCHRONOUS
/// ranged read (FileReaderSync over File.slice() in a Worker, or an OPFS
/// SyncAccessHandle). No SharedArrayBuffer, no COOP/COEP required.
pub struct JsRangeSource {
    read_range: js_sys::Function,
    len: u64,
    pos: u64,
    // windowed cache: collapses thousands of 1KB paged reads into few big pulls
    win: Vec<u8>,
    win_len: usize,
    win_start: u64,
    pub js_calls: u64,
    pub js_bytes: u64,
}

fn window_size() -> usize {
    unsafe { WINDOW_SIZE }
}
static mut WINDOW_SIZE: usize = 1024 * 1024;

#[wasm_bindgen]
pub fn set_window_size(n: usize) { unsafe { WINDOW_SIZE = n; } }

impl JsRangeSource {
    pub fn new(read_range: js_sys::Function, len: f64) -> Self {
        Self { read_range, len: len as u64, pos: 0, win: Vec::new(), win_len: 0, win_start: 0, js_calls: 0, js_bytes: 0 }
    }

    fn fill(&mut self, at: u64) -> IoResult<()> {
        let want = (window_size() as u64).min(self.len - at) as usize;
        let res = self.read_range
            .call2(&JsValue::NULL, &JsValue::from_f64(at as f64), &JsValue::from_f64(want as f64))
            .map_err(|_| IoError::new(ErrorKind::Other, "js read_range threw"))?;
        let arr = js_sys::Uint8Array::new(&res);
        let n = arr.length() as usize;
        if self.win.len() < n { self.win = vec![0u8; window_size()]; }
        arr.copy_to(&mut self.win[..n]);
        self.win_len = n;
        self.win_start = at;
        self.js_calls += 1;
        self.js_bytes += n as u64;
        Ok(())
    }
}

impl Read for JsRangeSource {
    fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
        if self.pos >= self.len || buf.is_empty() { return Ok(0); }
        let we = self.win_start + self.win_len as u64;
        if self.pos < self.win_start || self.pos >= we { self.fill(self.pos)?; }
        if self.win_len == 0 { return Ok(0); }
        let off = (self.pos - self.win_start) as usize;
        let avail = self.win_len - off;
        let n = buf.len().min(avail);
        buf[..n].copy_from_slice(&self.win[off..off+n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for JsRangeSource {
    fn seek(&mut self, from: SeekFrom) -> IoResult<u64> {
        let np = match from {
            SeekFrom::Start(o) => o as i64,
            SeekFrom::End(o) => self.len as i64 + o,
            SeekFrom::Current(o) => self.pos as i64 + o,
        };
        if np < 0 { return Err(IoError::new(ErrorKind::InvalidInput, "negative seek")); }
        self.pos = np as u64;
        Ok(self.pos)
    }
}

#[wasm_bindgen]
pub struct E57Handle { inner: E57Reader<JsRangeSource> }

#[wasm_bindgen]
impl E57Handle {
    /// `read_range(offset:number, length:number) -> Uint8Array`  (synchronous)
    #[wasm_bindgen(constructor)]
    pub fn new(read_range: js_sys::Function, len: f64) -> Result<E57Handle, JsValue> {
        console_error_panic_hook::set_once();
        let src = JsRangeSource::new(read_range, len);
        let inner = E57Reader::new(src).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(E57Handle { inner })
    }

    pub fn scan_count(&self) -> usize { self.inner.pointclouds().len() }
    pub fn total_points(&self) -> f64 { self.inner.pointclouds().iter().map(|p| p.records as f64).sum() }
    pub fn image_count(&self) -> usize { self.inner.images().len() }
    pub fn xml(&self) -> String { self.inner.xml().to_string() }

    /// Decode `max` points of scan `idx` into interleaved typed arrays.
    pub fn decode(&mut self, idx: usize, max: usize) -> Result<js_sys::Object, JsValue> {
        let pc = self.inner.pointclouds().get(idx)
            .ok_or_else(|| JsValue::from_str("bad scan index"))?.clone();
        let mut xyz: Vec<f32> = Vec::with_capacity(max*3);
        let mut rgb: Vec<u8> = Vec::with_capacity(max*3);
        let mut inten: Vec<u8> = Vec::with_capacity(max);
        let iter = self.inner.pointcloud_simple(&pc).map_err(|e| JsValue::from_str(&e.to_string()))?;
        for p in iter.take(max) {
            let p = p.map_err(|e| JsValue::from_str(&e.to_string()))?;
            if let CartesianCoordinate::Valid{x,y,z} = p.cartesian {
                xyz.push(x as f32); xyz.push(y as f32); xyz.push(z as f32);
            } else { continue; }
            match &p.color {
                Some(c) => { rgb.push((c.red*255.0) as u8); rgb.push((c.green*255.0) as u8); rgb.push((c.blue*255.0) as u8); }
                None => { rgb.extend_from_slice(&[200,200,200]); }
            }
            inten.push(p.intensity.map(|i| (i*255.0) as u8).unwrap_or(128));
        }
        let out = js_sys::Object::new();
        js_sys::Reflect::set(&out, &"xyz".into(), &js_sys::Float32Array::from(&xyz[..]))?;
        js_sys::Reflect::set(&out, &"rgb".into(), &js_sys::Uint8Array::from(&rgb[..]))?;
        js_sys::Reflect::set(&out, &"intensity".into(), &js_sys::Uint8Array::from(&inten[..]))?;
        js_sys::Reflect::set(&out, &"count".into(), &JsValue::from_f64((xyz.len()/3) as f64))?;
        Ok(out)
    }
}
