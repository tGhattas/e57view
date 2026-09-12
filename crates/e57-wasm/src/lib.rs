pub mod fast;
pub mod octree;
pub mod core;
pub mod mesh;
pub mod analysis;

#[cfg(target_arch = "wasm32")]
mod wasm_api {
    use crate::core;
    use crate::octree::{Octree, REC};
    use e57::{E57Reader, Projection};
    use std::io::{Read, Seek, SeekFrom, Result as IoResult, Error as IoError, ErrorKind};
    use wasm_bindgen::prelude::*;

    // -----------------------------------------------------------------------
    // Read + Seek over a SYNCHRONOUS JS ranged-read callback (FileReaderSync
    // over File.slice() in a Worker). No SharedArrayBuffer, no COOP/COEP.
    // -----------------------------------------------------------------------
    static mut WINDOW_SIZE: usize = 8 * 1024 * 1024;
    #[wasm_bindgen]
    pub fn set_window_size(n: usize) { unsafe { WINDOW_SIZE = n; } }
    fn window_size() -> usize { unsafe { WINDOW_SIZE } }

    pub struct JsRangeSource {
        read_range: js_sys::Function, len: u64, pos: u64,
        win: Vec<u8>, win_len: usize, win_start: u64,
    }
    impl JsRangeSource {
        fn new(read_range: js_sys::Function, len: u64) -> Self {
            Self { read_range, len, pos: 0, win: Vec::new(), win_len: 0, win_start: 0 }
        }
        fn fill(&mut self, at: u64) -> IoResult<()> {
            let want = (window_size() as u64).min(self.len.saturating_sub(at)) as usize;
            if want == 0 { self.win_len = 0; return Ok(()); }
            let res = self.read_range
                .call2(&JsValue::NULL, &JsValue::from_f64(at as f64), &JsValue::from_f64(want as f64))
                .map_err(|_| IoError::new(ErrorKind::Other, "read_range threw"))?;
            let arr = js_sys::Uint8Array::new(&res);
            let n = arr.length() as usize;
            if self.win.len() < n { self.win = vec![0u8; window_size().max(n)]; }
            arr.copy_to(&mut self.win[..n]);
            self.win_start = at; self.win_len = n;
            Ok(())
        }
    }
    impl Read for JsRangeSource {
        fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
            if self.pos >= self.len || buf.is_empty() { return Ok(0); }
            let end = self.win_start + self.win_len as u64;
            if self.win_len == 0 || self.pos < self.win_start || self.pos >= end { self.fill(self.pos)?; }
            if self.win_len == 0 { return Ok(0); }
            let off = (self.pos - self.win_start) as usize;
            let n = buf.len().min(self.win_len - off);
            buf[..n].copy_from_slice(&self.win[off..off + n]);
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

    fn esc(s: &str) -> String {
        let mut o = String::with_capacity(s.len());
        for c in s.chars() { match c {
            '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push(' '), c => o.push(c) } }
        o
    }
    fn os(v: &Option<String>) -> String { match v { Some(s) => format!("\"{}\"", esc(s)), None => "null".into() } }

    /// Shuffle every leaf, compute tight bounds, and hand the blocks to JS.
    pub(crate) fn emit_leaves(tree: &mut Octree, progress: &js_sys::Function, leaf: &js_sys::Function) -> Result<usize, JsValue> {
        let leaves = tree.leaf_indices();
        let nleaves = leaves.len();
        for (li, &ni) in leaves.iter().enumerate() {
            let (o, s) = (tree.nodes[ni].origin, tree.nodes[ni].size);
            let mut lf = tree.nodes[ni].leaf.take().unwrap();
            lf.shuffle(0x9E3779B97F4A7C15 ^ (ni as u64).wrapping_mul(0xBF58476D1CE4E5B9));
            let (qmn, qmx) = lf.qbounds();
            let w = |qv: u16, a: usize| o[a] + (qv as f64 / 65536.0) * s;
            let meta = js_sys::Float64Array::from(&[
                o[0], o[1], o[2], s,
                w(qmn[0], 0), w(qmn[1], 1), w(qmn[2], 2),
                w(qmx[0], 0) + s / 65536.0, w(qmx[1], 1) + s / 65536.0, w(qmx[2], 2) + s / 65536.0,
            ][..]);
            let blocks = js_sys::Array::new();
            for b in lf.blocks.drain(..) { blocks.push(&js_sys::Uint8Array::from(&b[..])); drop(b); }
            leaf.call3(&JsValue::NULL, &blocks, &JsValue::from_f64(lf.count as f64), &meta)?;
            if li % 32 == 0 {
                let _ = progress.call3(&JsValue::NULL, &JsValue::from_f64(1.0), &JsValue::from_f64(li as f64), &JsValue::from_f64(nleaves as f64));
            }
        }
        Ok(nleaves)
    }

    /// Octree sink for points that don't come from an E57: PLY, LAS, a device scan.
    /// Same cells, same preview, same leaf hand-over as `E57Handle::stream`.
    #[wasm_bindgen]
    pub struct PointSink { tree: Octree, pcube: ([f64; 3], f64), every: usize, kept: u64, pbuf: Vec<u8>, pcount: usize }

    #[wasm_bindgen]
    impl PointSink {
        /// `bounds` = [minx,miny,minz,maxx,maxy,maxz] hint (the root grows if points fall outside).
        #[wasm_bindgen(constructor)]
        pub fn new(bounds: &[f64], expected: f64, mem_limit: f64, preview_target: usize) -> Result<PointSink, JsValue> {
            console_error_panic_hook::set_once();
            let est = expected * REC as f64 * 1.25;
            if est > mem_limit {
                return Err(JsValue::from_str(&format!("This load needs about {:.0} MB in memory, over the {:.0} MB limit for this device. Choose a smaller load fraction.", est / 1e6, mem_limit / 1e6)));
            }
            let (mn, mx) = if bounds.len() == 6 { ([bounds[0], bounds[1], bounds[2]], [bounds[3], bounds[4], bounds[5]]) } else { ([-50.0; 3], [50.0; 3]) };
            let tree = Octree::new(mn, mx);
            let pcube = tree.root_bounds();
            let every = if preview_target > 0 { ((expected as usize) / preview_target).max(1) } else { 0 };
            Ok(PointSink { tree, pcube, every, kept: 0, pbuf: Vec::with_capacity(200_000 * REC), pcount: 0 })
        }

        /// Positions relative to whatever origin the caller chose (keep them small: f32 on the GPU).
        pub fn push(&mut self, xyz: &[f64], rgb: &[u8], inten: &[u8], nrm: &[i8], n: usize, preview: &js_sys::Function) -> Result<(), JsValue> {
            let has_c = rgb.len() >= n * 3; let has_i = inten.len() >= n; let has_n = nrm.len() >= n * 3;
            let (po, ps) = self.pcube;
            for i in 0..n {
                let (x, y, z) = (xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
                if !(x.is_finite() && y.is_finite() && z.is_finite()) { continue; }
                let c = if has_c { [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]] } else { [180, 180, 180] };
                let it = if has_i { inten[i] } else { 128 };
                let nn = if has_n { [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]] } else { [0, 0, 127] };
                self.tree.insert([x, y, z], c, it, nn);
                self.kept += 1;
                if self.every > 0 && self.kept % self.every as u64 == 0 {
                    let tx = (x - po[0]) / ps; let ty = (y - po[1]) / ps; let tz = (z - po[2]) / ps;
                    if (0.0..1.0).contains(&tx) && (0.0..1.0).contains(&ty) && (0.0..1.0).contains(&tz) {
                        let qx = ((tx * 65536.0) as u16).to_le_bytes(); let qy = ((ty * 65536.0) as u16).to_le_bytes(); let qz = ((tz * 65536.0) as u16).to_le_bytes();
                        self.pbuf.extend_from_slice(&[qx[0], qx[1], qy[0], qy[1], qz[0], qz[1], c[0], c[1], c[2], it, nn[0] as u8, nn[1] as u8, nn[2] as u8, 0]);
                        self.pcount += 1;
                        if self.pcount >= 200_000 { self.flush_preview(preview)?; }
                    }
                }
            }
            Ok(())
        }

        fn flush_preview(&mut self, preview: &js_sys::Function) -> Result<(), JsValue> {
            if self.pcount == 0 { return Ok(()); }
            let (po, ps) = self.pcube;
            let pmeta = js_sys::Float64Array::from(&[po[0], po[1], po[2], ps][..]);
            let arr = js_sys::Uint8Array::from(&self.pbuf[..]);
            preview.call3(&JsValue::NULL, &arr, &JsValue::from_f64(self.pcount as f64), &pmeta)?;
            self.pbuf.clear(); self.pcount = 0;
            Ok(())
        }

        pub fn finish(&mut self, preview: &js_sys::Function, progress: &js_sys::Function, leaf: &js_sys::Function) -> Result<js_sys::Object, JsValue> {
            self.flush_preview(preview)?;
            let nleaves = emit_leaves(&mut self.tree, progress, leaf)?;
            let out = js_sys::Object::new();
            js_sys::Reflect::set(&out, &"kept".into(), &JsValue::from_f64(self.kept as f64))?;
            js_sys::Reflect::set(&out, &"leaves".into(), &JsValue::from_f64(nleaves as f64))?;
            Ok(out)
        }
    }

    #[wasm_bindgen]
    pub struct E57Handle { inner: E57Reader<JsRangeSource>, read_range: js_sys::Function, len: u64 }

    #[wasm_bindgen]
    impl E57Handle {
        #[wasm_bindgen(constructor)]
        pub fn new(read_range: js_sys::Function, len: f64) -> Result<E57Handle, JsValue> {
            console_error_panic_hook::set_once();
            let src = JsRangeSource::new(read_range.clone(), len as u64);
            let inner = E57Reader::new(src).map_err(|e| JsValue::from_str(&e.to_string()))?;
            Ok(E57Handle { inner, read_range, len: len as u64 })
        }

        /// Everything the UI needs for its scan card. Header + XML only.
        pub fn meta(&self) -> String {
            let pcs = self.inner.pointclouds();
            let imgs = self.inner.images();
            let mut scans = Vec::new();
            for pc in &pcs {
                let q = core::rotation_of(pc);
                let bounds = match core::declared_bounds(pc, q) {
                    Some((mn, mx)) => format!("[{},{},{},{},{},{}]", mn[0], mx[0], mn[1], mx[1], mn[2], mx[2]),
                    None => "null".into(),
                };
                let tr = match &pc.transform {
                    Some(t) => format!("[{},{},{}]", t.translation.x, t.translation.y, t.translation.z),
                    None => "[0,0,0]".into(),
                };
                let m = core::map_fields(pc);
                let none = usize::MAX;
                scans.push(format!(
                    "{{\"name\":{},\"points\":{},\"bounds\":{},\"translation\":{},\"sensorVendor\":{},\"sensorModel\":{},\"hasColor\":{},\"hasIntensity\":{},\"hasNormals\":{},\"cartesian\":{},\"spherical\":{},\"fields\":{}}}",
                    os(&pc.name), pc.records, bounds, tr, os(&pc.sensor_vendor), os(&pc.sensor_model),
                    m.r != none, m.i != none, m.nx != none, m.x != none, m.sr != none, pc.prototype.len()));
            }
            let mut stations = Vec::new();
            for (ii, im) in imgs.iter().enumerate() {
                if let Some(Projection::Spherical(s)) = &im.projection {
                    let (tr, q) = match &im.transform {
                        Some(t) => (format!("[{},{},{}]", t.translation.x, t.translation.y, t.translation.z),
                                    format!("[{},{},{},{}]", t.rotation.w, t.rotation.x, t.rotation.y, t.rotation.z)),
                        None => ("[0,0,0]".into(), "[1,0,0,0]".into()),
                    };
                    stations.push(format!("{{\"image\":{},\"t\":{},\"q\":{},\"w\":{},\"h\":{},\"bytes\":{},\"name\":{}}}",
                        ii, tr, q, s.properties.width, s.properties.height, s.blob.data.length, os(&im.name)));
                }
            }
            format!("{{\"guid\":\"{}\",\"library\":{},\"scans\":[{}],\"images\":{},\"stations\":[{}]}}",
                esc(self.inner.guid()), os(&self.inner.library_version().map(|s| s.to_string())),
                scans.join(","), imgs.len(), stations.join(","))
        }

        /// Raw JPEG/PNG bytes of image `idx` (index into the images2D list).
        pub fn image_blob(&mut self, idx: usize) -> Result<js_sys::Uint8Array, JsValue> {
            let imgs = self.inner.images();
            let im = imgs.get(idx).ok_or_else(|| JsValue::from_str("bad image index"))?.clone();
            let blob = match &im.projection {
                Some(Projection::Spherical(s)) => s.blob.data.clone(),
                Some(Projection::Pinhole(p)) => p.blob.data.clone(),
                Some(Projection::Cylindrical(c)) => c.blob.data.clone(),
                None => match &im.visual_reference { Some(v) => v.blob.data.clone(), None => return Err(JsValue::from_str("image has no blob")) },
            };
            let mut out: Vec<u8> = Vec::with_capacity(blob.length as usize);
            self.inner.blob(&blob, &mut out).map_err(|e| JsValue::from_str(&e.to_string()))?;
            Ok(js_sys::Uint8Array::from(&out[..]))
        }

        /// Decode scan `idx` keeping 1 in `stride` points, into an octree.
        ///
        /// `preview(records: Uint8Array, count, meta: Float64Array[4])` streams a
        /// quick sparse preview during decode (about `preview_target` points).
        /// `progress(phase, done, total) -> bool` — return true to abort.
        /// `leaf(blocks: Array<Uint8Array>, count, meta: Float64Array[10])` is
        /// called once per finished leaf: origin xyz, cube size, tight min xyz,
        /// tight max xyz. Positions are relative to the scan translation.
        pub fn stream(&mut self, idx: usize, stride: usize, preview_target: usize, mem_limit: f64,
                      preview: &js_sys::Function, progress: &js_sys::Function, leaf: &js_sys::Function)
            -> Result<js_sys::Object, JsValue>
        {
            let pcs = self.inner.pointclouds();
            let pc = pcs.get(idx).ok_or_else(|| JsValue::from_str("bad scan index"))?.clone();
            let stride = stride.max(1);
            let expected = (pc.records as usize) / stride;
            let est = expected as f64 * REC as f64 * 1.25;
            if est > mem_limit {
                return Err(JsValue::from_str(&format!(
                    "This load needs about {:.0} MB in memory, over the {:.0} MB limit for this device. Choose a smaller load fraction.",
                    est / 1e6, mem_limit / 1e6)));
            }

            let q = core::rotation_of(&pc);
            let (mn, mx) = core::declared_bounds(&pc, q).unwrap_or(([-50.0; 3], [50.0; 3]));
            let mut tree = Octree::new(mn, mx);
            let pcube = tree.root_bounds();
            let preview_every = if preview_target > 0 { (expected / preview_target).max(1) } else { 0 };

            let src = JsRangeSource::new(self.read_range.clone(), self.len);
            let pmeta = js_sys::Float64Array::from(&[pcube.0[0], pcube.0[1], pcube.0[2], pcube.1][..]);
            let stats = core::decode(src, &pc, stride, pcube, preview_every,
                |buf, n| {
                    let arr = js_sys::Uint8Array::from(buf);
                    let _ = preview.call3(&JsValue::NULL, &arr, &JsValue::from_f64(n as f64), &pmeta);
                },
                |done, total| {
                    progress.call3(&JsValue::NULL, &JsValue::from_f64(0.0), &JsValue::from_f64(done as f64), &JsValue::from_f64(total as f64))
                        .map(|v| v.is_truthy()).unwrap_or(false)
                },
                &mut tree,
            ).map_err(|e| JsValue::from_str(&e.to_string()))?;

            let nleaves = emit_leaves(&mut tree, progress, leaf)?;

            let out = js_sys::Object::new();
            js_sys::Reflect::set(&out, &"read".into(), &JsValue::from_f64(stats.read as f64))?;
            js_sys::Reflect::set(&out, &"kept".into(), &JsValue::from_f64(stats.kept as f64))?;
            js_sys::Reflect::set(&out, &"droppedInvalid".into(), &JsValue::from_f64(stats.dropped_invalid as f64))?;
            js_sys::Reflect::set(&out, &"leaves".into(), &JsValue::from_f64(nleaves as f64))?;
            js_sys::Reflect::set(&out, &"nodes".into(), &JsValue::from_f64(tree.nodes.len() as f64))?;
            Ok(out)
        }
    }
}


#[cfg(target_arch = "wasm32")]
mod wasm_export {
    use e57::{E57Writer, PointCloudWriter, Extension, Record, RecordName, RecordDataType, RecordValue, Transform, Quaternion, Translation};
    use std::io::{Read, Write, Seek, SeekFrom, Result as IoResult, Error as IoError, ErrorKind};
    use wasm_bindgen::prelude::*;

    // -----------------------------------------------------------------------
    // Write + Read + Seek over an OPFS SyncAccessHandle in a worker. The paged
    // writer emits 1 KB pages, so sequential writes are buffered and flushed
    // in 4 MB runs instead of becoming a million JS calls.
    // -----------------------------------------------------------------------
    pub struct JsSink { read_fn: js_sys::Function, write_fn: js_sys::Function,
                        pos: u64, wbuf: Vec<u8>, wstart: u64, file_len: u64 }
    const WBUF: usize = 4 * 1024 * 1024;

    // The paged writer, after every 1 KB page, reads the *next* page back and
    // seeks to the page start again. Served from the pending write buffer those
    // are free; only genuinely new ranges cross into JavaScript.
    impl JsSink {
        fn new(o: &js_sys::Object) -> Result<Self, JsValue> {
            let f = |n: &str| -> Result<js_sys::Function, JsValue> {
                js_sys::Reflect::get(o, &n.into())?.dyn_into::<js_sys::Function>().map_err(|_| JsValue::from_str("sink method missing"))
            };
            Ok(Self { read_fn: f("read")?, write_fn: f("write")?, pos: 0, wbuf: Vec::with_capacity(WBUF), wstart: 0, file_len: 0 })
        }
        fn flush_buf(&mut self) -> IoResult<()> {
            if self.wbuf.is_empty() { return Ok(()); }
            let arr = js_sys::Uint8Array::from(&self.wbuf[..]);
            self.write_fn.call2(&JsValue::NULL, &JsValue::from_f64(self.wstart as f64), &arr)
                .map_err(|_| IoError::new(ErrorKind::Other, "sink.write threw"))?;
            self.wbuf.clear();
            Ok(())
        }
        #[inline] fn buf_end(&self) -> u64 { self.wstart + self.wbuf.len() as u64 }
    }
    impl Write for JsSink {
        fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
            if self.wbuf.is_empty() { self.wstart = self.pos; }
            else if self.pos < self.wstart || self.pos > self.buf_end() { self.flush_buf()?; self.wstart = self.pos; }
            let off = (self.pos - self.wstart) as usize;
            let end = off + buf.len();
            if end > self.wbuf.len() { self.wbuf.resize(end, 0); }
            self.wbuf[off..end].copy_from_slice(buf);
            self.pos += buf.len() as u64;
            if self.pos > self.file_len { self.file_len = self.pos; }
            if self.wbuf.len() >= WBUF { self.flush_buf()?; }
            Ok(buf.len())
        }
        fn flush(&mut self) -> IoResult<()> { self.flush_buf() }
    }
    impl Read for JsSink {
        fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
            if buf.is_empty() || self.pos >= self.file_len { return Ok(0); }   // past EOF: caller zero-fills
            if !self.wbuf.is_empty() && self.pos >= self.wstart && self.pos < self.buf_end() {
                let off = (self.pos - self.wstart) as usize;
                let n = buf.len().min(self.wbuf.len() - off);
                buf[..n].copy_from_slice(&self.wbuf[off..off + n]);
                self.pos += n as u64;
                return Ok(n);
            }
            self.flush_buf()?;
            let want = buf.len().min((self.file_len - self.pos) as usize);
            let v = self.read_fn.call2(&JsValue::NULL, &JsValue::from_f64(self.pos as f64), &JsValue::from_f64(want as f64))
                .map_err(|_| IoError::new(ErrorKind::Other, "sink.read threw"))?;
            let arr = js_sys::Uint8Array::new(&v);
            let n = (arr.length() as usize).min(want);
            arr.slice(0, n as u32).copy_to(&mut buf[..n]);
            self.pos += n as u64;
            Ok(n)
        }
    }
    impl Seek for JsSink {
        fn seek(&mut self, from: SeekFrom) -> IoResult<u64> {
            let np = match from {
                SeekFrom::Start(o) => o as i64,
                SeekFrom::End(o) => self.file_len as i64 + o,
                SeekFrom::Current(o) => self.pos as i64 + o,
            };
            if np < 0 { return Err(IoError::new(ErrorKind::InvalidInput, "negative seek")); }
            self.pos = np as u64;   // nothing to flush: writes land in the buffer wherever they go
            Ok(self.pos)
        }
    }
    impl Drop for JsSink { fn drop(&mut self) { let _ = self.flush_buf(); } }

    /// Streams points into a new E57 file. Field order: xyz f64 (relative to
    /// the pose translation), rgb u8, intensity u8, normal i8.
    #[wasm_bindgen]
    pub struct E57Export {
        pc: Option<PointCloudWriter<'static, JsSink>>,   // dropped before `writer` (field order)
        writer: Option<Box<E57Writer<JsSink>>>,
        has_c: bool, has_i: bool, has_n: bool,
        written: u64,
    }

    #[wasm_bindgen]
    impl E57Export {
        #[wasm_bindgen(constructor)]
        pub fn new(sink: js_sys::Object, guid: &str, name: &str, tx: f64, ty: f64, tz: f64,
                   has_color: bool, has_intensity: bool, has_normals: bool) -> Result<E57Export, JsValue> {
            console_error_panic_hook::set_once();
            let sink = JsSink::new(&sink)?;
            let mut writer = Box::new(E57Writer::new(sink, guid).map_err(|e| JsValue::from_str(&e.to_string()))?);
            if has_normals {
                writer.register_extension(Extension::new("nor", "http://www.libe57.org/E57_NOR_surface_normals.txt"))
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
            }
            let mut proto = vec![Record::CARTESIAN_X_F64, Record::CARTESIAN_Y_F64, Record::CARTESIAN_Z_F64];
            if has_color { proto.extend([Record::COLOR_RED_U8, Record::COLOR_GREEN_U8, Record::COLOR_BLUE_U8]); }
            if has_intensity { proto.push(Record::INTENSITY_UNIT_F32); }
            if has_normals {
                for n in ["normalX", "normalY", "normalZ"] {
                    proto.push(Record { name: RecordName::Unknown { namespace: "nor".into(), name: n.into() },
                                        data_type: RecordDataType::Single { min: Some(-1.0), max: Some(1.0) } });
                }
            }
            // The point cloud writer borrows the file writer for its whole life. The
            // box gives the writer a stable address; `pc` is declared first so it is
            // dropped first, and `finish` consumes it before finalising the file.
            let w: &'static mut E57Writer<JsSink> = unsafe { &mut *(writer.as_mut() as *mut E57Writer<JsSink>) };
            let pc_guid = format!("{{{}-pc}}", guid.trim_matches(|c| c == '{' || c == '}'));
            let mut pc = w.add_pointcloud(&pc_guid, proto).map_err(|e| JsValue::from_str(&e.to_string()))?;
            pc.set_name(Some(name.to_string()));
            pc.set_transform(Some(Transform {
                rotation: Quaternion { w: 1.0, x: 0.0, y: 0.0, z: 0.0 },
                translation: Translation { x: tx, y: ty, z: tz },
            }));
            Ok(E57Export { pc: Some(pc), writer: Some(writer), has_c: has_color, has_i: has_intensity, has_n: has_normals, written: 0 })
        }

        pub fn add_points(&mut self, xyz: &[f64], rgb: &[u8], inten: &[u8], nrm: &[i8], n: usize) -> Result<(), JsValue> {
            let pc = self.pc.as_mut().ok_or_else(|| JsValue::from_str("export already finished"))?;
            let mut vals: Vec<RecordValue> = Vec::with_capacity(10);
            for i in 0..n {
                vals.clear();
                vals.push(RecordValue::Double(xyz[i * 3]));
                vals.push(RecordValue::Double(xyz[i * 3 + 1]));
                vals.push(RecordValue::Double(xyz[i * 3 + 2]));
                if self.has_c { vals.push(RecordValue::Integer(rgb[i * 3] as i64)); vals.push(RecordValue::Integer(rgb[i * 3 + 1] as i64)); vals.push(RecordValue::Integer(rgb[i * 3 + 2] as i64)); }
                if self.has_i { vals.push(RecordValue::Single(inten[i] as f32 / 255.0)); }
                if self.has_n { for k in 0..3 { vals.push(RecordValue::Single((nrm[i * 3 + k] as f32 / 127.0).clamp(-1.0, 1.0))); } }
                pc.add_point(vals.clone()).map_err(|e| JsValue::from_str(&e.to_string()))?;
            }
            self.written += n as u64;
            Ok(())
        }

        pub fn finish(mut self) -> Result<f64, JsValue> {
            if let Some(mut pc) = self.pc.take() {
                pc.finalize().map_err(|e| JsValue::from_str(&e.to_string()))?;
                drop(pc);
            }
            if let Some(mut w) = self.writer.take() {
                w.finalize().map_err(|e| JsValue::from_str(&e.to_string()))?;
                drop(w);
            }
            Ok(self.written as f64)
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm_api::*;
#[cfg(target_arch = "wasm32")]
pub use wasm_export::*;

#[cfg(target_arch = "wasm32")]
mod wasm_mesh {
    use crate::mesh::{Mesh, Mesher};
    use wasm_bindgen::prelude::*;

    /// Surface reconstruction, driven from a worker: feed it the viewer's own leaf records,
    /// then pull the triangles back out. Buffers are moved, not copied, on the way out.
    #[wasm_bindgen]
    pub struct MeshBuilder {
        inner: Mesher,
        out: Option<Mesh>,
    }

    #[wasm_bindgen]
    impl MeshBuilder {
        #[wasm_bindgen(constructor)]
        pub fn new(voxel: f32, trunc_voxels: f32, min_weight: f32) -> MeshBuilder {
            MeshBuilder { inner: Mesher::new(voxel, trunc_voxels, min_weight), out: None }
        }
        /// One octree leaf: its cube origin and size, plus the packed 14-byte records.
        /// `model` is the cloud's 4x4 transform in **row-major** order, or empty for identity.
        pub fn add_leaf(&mut self, ox: f32, oy: f32, oz: f32, size: f32, recs: &[u8], stride: u32, model: &[f32]) {
            let m: Option<[f32; 16]> = if model.len() == 16 { Some(model.try_into().unwrap()) } else { None };
            self.inner.add_records([ox, oy, oz], size, recs, stride as usize, m.as_ref());
        }
        pub fn bricks(&self) -> u32 { self.inner.brick_count() as u32 }
        /// Extract the surface. Returns a JSON summary; the buffers follow.
        pub fn build(&mut self, smooth: u32, density_iso: f32) -> String {
            let (mesh, st) = self.inner.extract(smooth, density_iso);
            let json = format!(
                "{{\"points\":{},\"voxels\":{},\"vertices\":{},\"triangles\":{},\"oriented\":{},\"unoriented\":{},\"boundaryEdges\":{}}}",
                st.points_used, st.voxels, st.vertices, st.triangles, st.oriented, st.unoriented, st.boundary_edges
            );
            self.out = Some(mesh);
            json
        }
        pub fn positions(&mut self) -> Vec<f32> { self.out.as_mut().map(|m| std::mem::take(&mut m.pos)).unwrap_or_default() }
        pub fn normals(&mut self) -> Vec<f32> { self.out.as_mut().map(|m| std::mem::take(&mut m.nrm)).unwrap_or_default() }
        pub fn colors(&mut self) -> Vec<u8> { self.out.as_mut().map(|m| std::mem::take(&mut m.col)).unwrap_or_default() }
        pub fn indices(&mut self) -> Vec<u32> { self.out.as_mut().map(|m| std::mem::take(&mut m.idx)).unwrap_or_default() }
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm_analysis {
    use crate::analysis::{Analyzer, Feature};
    use wasm_bindgen::prelude::*;

    /// Neighbourhood analysis driven from a worker. The caller streams in the viewer's own
    /// leaf records, runs one analysis, then pulls back either a per-point number (a scalar
    /// field), a per-point keep mask, or rewritten normals.
    #[wasm_bindgen]
    pub struct CloudAnalysis {
        inner: Analyzer,
        /// A second cloud to compare or register against. Held here rather than in a separate
        /// object so both share one wasm instance and one heap.
        reference: Option<Analyzer>,
        cursor: usize,
        last_count: u32,
        last_mean: f32,
        last_cut: f32,
    }

    #[inline]
    fn tick(cb: &Option<js_sys::Function>, i: usize) {
        if let Some(f) = cb {
            let _ = f.call1(&JsValue::NULL, &JsValue::from_f64(i as f64));
        }
    }

    #[wasm_bindgen]
    impl CloudAnalysis {
        #[wasm_bindgen(constructor)]
        pub fn new(cell: f32) -> CloudAnalysis {
            CloudAnalysis { inner: Analyzer::new(cell), reference: None, cursor: 0, last_count: 0, last_mean: 0.0, last_cut: 0.0 }
        }
        /// `model` is the cloud's 4x4 transform in **row-major** order, or empty for identity.
        pub fn add_leaf(&mut self, ox: f32, oy: f32, oz: f32, size: f32, recs: &[u8], model: &[f32]) {
            let m: Option<[f32; 16]> = if model.len() == 16 { Some(model.try_into().unwrap()) } else { None };
            self.inner.add_records([ox, oy, oz], size, recs, m.as_ref());
        }
        pub fn len(&self) -> u32 { self.inner.len() as u32 }
        pub fn build(&mut self) { self.inner.build(); }

        // ---------------------------------------------------- the reference cloud
        pub fn start_reference(&mut self, cell: f32) { self.reference = Some(Analyzer::new(cell)); }
        /// One leaf of the reference. `stride` keeps 1 in N, for a cloud bigger than the
        /// analyser will hold; `model` is its own row-major 4x4, so both clouds arrive in the
        /// same frame however each of them is transformed on screen.
        pub fn add_reference_leaf(&mut self, ox: f32, oy: f32, oz: f32, size: f32, recs: &[u8], model: &[f32], stride: u32) {
            let m: Option<[f32; 16]> = if model.len() == 16 { Some(model.try_into().unwrap()) } else { None };
            if let Some(r) = self.reference.as_mut() {
                r.add_records_stride([ox, oy, oz], size, recs, m.as_ref(), stride.max(1) as usize);
            }
        }
        pub fn build_reference(&mut self) { if let Some(r) = self.reference.as_mut() { r.build(); } }
        #[wasm_bindgen(getter)]
        pub fn reference_len(&self) -> u32 { self.reference.as_ref().map(|r| r.len() as u32).unwrap_or(0) }
        #[wasm_bindgen(getter)]
        pub fn reference_normals(&self) -> f32 { self.reference.as_ref().map(|r| r.normal_fraction()).unwrap_or(0.0) }
        /// Point-to-plane registration needs planes, so a reference without usable normals
        /// gets them computed here rather than failing or silently falling back.
        pub fn compute_reference_normals(&mut self, k: u32, progress: Option<js_sys::Function>) {
            if let Some(r) = self.reference.as_mut() { r.compute_normals(k as usize, |i| tick(&progress, i)); }
        }
        pub fn distance_to_reference(&mut self, signed: bool, max_r: f32, progress: Option<js_sys::Function>) -> Vec<f32> {
            let refa = self.reference.take();
            let out = match refa.as_ref() {
                Some(r) => self.inner.distance_to(r, signed, max_r, |i| tick(&progress, i)),
                None => Vec::new(),
            };
            self.reference = refa;
            out
        }
        /// Run ICP and report what it did, as JSON. `max_dist` is the starting rejection gate
        /// in metres; it tightens to 15% of that as the fit settles.
        pub fn icp(&mut self, max_iter: u32, max_dist: f32, sample: u32, progress: Option<js_sys::Function>) -> String {
            let refa = self.reference.take();
            let out = match refa.as_ref() {
                Some(r) => {
                    let res = self.inner.icp(r, max_iter as usize, max_dist, sample as usize, |i, rms| {
                        if let Some(f) = &progress {
                            let _ = f.call2(&JsValue::NULL, &JsValue::from_f64(i as f64), &JsValue::from_f64(rms as f64));
                        }
                    });
                    let m = res.matrix.iter().map(|v| format!("{v}")).collect::<Vec<_>>().join(",");
                    let h = res.rms_history.iter().map(|v| format!("{v}")).collect::<Vec<_>>().join(",");
                    format!("{{\"matrix\":[{}],\"rms\":{},\"rmsHistory\":[{}],\"overlap\":{},\"iterations\":{},\"pairs\":{}}}",
                        m, if res.rms.is_finite() { res.rms } else { -1.0 }, h, res.overlap, res.iterations, res.pairs)
                }
                None => "{\"matrix\":[],\"rms\":-1,\"rmsHistory\":[],\"overlap\":0,\"iterations\":0,\"pairs\":0}".to_string(),
            };
            self.reference = refa;
            out
        }

        pub fn compute_normals(&mut self, k: u32, progress: Option<js_sys::Function>) {
            self.inner.compute_normals(k as usize, |i| tick(&progress, i));
        }
        pub fn orient_normals(&mut self, k: u32, vx: f32, vy: f32, vz: f32, use_viewpoint: bool, progress: Option<js_sys::Function>) {
            let vp = if use_viewpoint { Some([vx, vy, vz]) } else { None };
            self.inner.orient_normals(k as usize, vp, |i| tick(&progress, i));
        }
        /// Turn each normal toward the nearest scanner station. `vps` is a flat x,y,z list in
        /// the same frame as the points (so already through the cloud's model matrix).
        pub fn orient_to_viewpoints(&mut self, vps: &[f32]) { self.inner.orient_to_viewpoints(vps); }
        pub fn invert_normals(&mut self) { self.inner.invert_normals(); }

        /// Normals interleaved as x,y,z signed bytes, for the viewer to patch into its records.
        pub fn normals_bytes(&self) -> Vec<i8> {
            let n = self.inner.len();
            let mut out = vec![0i8; n * 3];
            for i in 0..n {
                out[i * 3] = self.inner.nx[i];
                out[i * 3 + 1] = self.inner.ny[i];
                out[i * 3 + 2] = self.inner.nz[i];
            }
            out
        }

        /// Rewrite the normal bytes of the next leaf, in the order the leaves were added.
        pub fn write_normals(&mut self, recs: &mut [u8]) {
            self.cursor = self.inner.write_normals(self.cursor, recs);
        }
        pub fn rewind(&mut self) { self.cursor = 0; }

        pub fn feature(&mut self, name: &str, k: u32, radius: f32, progress: Option<js_sys::Function>) -> Vec<f32> {
            match Feature::from_str(name) {
                Some(f) => self.inner.feature(f, k as usize, radius, |i| tick(&progress, i)),
                None => Vec::new(),
            }
        }
        /// Returns the keep mask; the mean and cut-off used are reported separately.
        pub fn sor(&mut self, k: u32, n_sigma: f32, progress: Option<js_sys::Function>) -> Vec<u8> {
            let (keep, mu, cut) = self.inner.sor(k as usize, n_sigma, |i| tick(&progress, i));
            self.last_mean = mu;
            self.last_cut = cut;
            keep
        }
        pub fn noise(&mut self, k: u32, n_sigma: f32, progress: Option<js_sys::Function>) -> Vec<u8> {
            self.inner.noise_filter(k as usize, n_sigma, |i| tick(&progress, i))
        }
        pub fn duplicates(&mut self, tol: f32) -> Vec<u8> { self.inner.duplicates(tol) }
        pub fn subsample(&mut self, spacing: f32) -> Vec<u8> { self.inner.spatial_subsample(spacing) }
        pub fn components(&mut self, radius: f32, min_pts: u32, progress: Option<js_sys::Function>) -> Vec<f32> {
            let (labels, n) = self.inner.connected_components(radius, min_pts as usize, |i| tick(&progress, i));
            self.last_count = n;
            labels
        }
        #[wasm_bindgen(getter)]
        pub fn component_count(&self) -> u32 { self.last_count }
        #[wasm_bindgen(getter)]
        pub fn mean_distance(&self) -> f32 { self.last_mean }
        #[wasm_bindgen(getter)]
        pub fn cut_distance(&self) -> f32 { self.last_cut }
    }
}
