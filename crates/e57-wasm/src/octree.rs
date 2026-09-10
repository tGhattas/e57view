//! Leaf-only octree for out-of-order point binning.
//!
//! Every point lands in a leaf as a 14-byte record with positions quantised to
//! 16 bits inside that leaf's cube. When a leaf overflows it splits, and the
//! requantisation to the child is exact (halving the cube doubles resolution).
//! At the end each leaf is shuffled, so drawing any prefix of it is a uniform
//! random subsample — continuous level of detail with zero extra storage.

pub const REC: usize = 14;
const BLOCK_RECS: usize = 32 * 1024;
const BLOCK_BYTES: usize = BLOCK_RECS * REC;
pub const MAX_LEAF: usize = 400_000;
pub const MAX_DEPTH: u8 = 12;
const Q: f64 = 65536.0;

pub struct Leaf { pub blocks: Vec<Vec<u8>>, pub count: usize }

impl Leaf {
    fn new() -> Self { Leaf { blocks: Vec::new(), count: 0 } }
    #[inline]
    fn push(&mut self, rec: &[u8; REC]) {
        if self.blocks.last().map_or(true, |b| b.len() >= BLOCK_BYTES) {
            self.blocks.push(Vec::with_capacity(BLOCK_BYTES));
        }
        self.blocks.last_mut().unwrap().extend_from_slice(rec);
        self.count += 1;
    }
    #[inline]
    fn rec_mut(&mut self, i: usize) -> &mut [u8] {
        let b = i / BLOCK_RECS; let o = (i % BLOCK_RECS) * REC;
        &mut self.blocks[b][o..o + REC]
    }
    #[inline]
    fn rec(&self, i: usize) -> &[u8] {
        let b = i / BLOCK_RECS; let o = (i % BLOCK_RECS) * REC;
        &self.blocks[b][o..o + REC]
    }

    /// Fisher-Yates over the blocked storage.
    pub fn shuffle(&mut self, seed: u64) {
        let n = self.count;
        if n < 2 { return; }
        let mut s = seed | 1;
        let mut tmp = [0u8; REC];
        for i in (1..n).rev() {
            // xorshift64*
            s ^= s >> 12; s ^= s << 25; s ^= s >> 27;
            let r = s.wrapping_mul(0x2545F4914F6CDD1D);
            let j = (r % (i as u64 + 1)) as usize;
            if j != i {
                tmp.copy_from_slice(self.rec(i));
                let rj: [u8; REC] = self.rec(j).try_into().unwrap();
                self.rec_mut(i).copy_from_slice(&rj);
                self.rec_mut(j).copy_from_slice(&tmp);
            }
        }
    }

    /// Tight quantised bounds: (min[3], max[3]) in 0..65535.
    pub fn qbounds(&self) -> ([u16; 3], [u16; 3]) {
        let mut mn = [u16::MAX; 3]; let mut mx = [0u16; 3];
        for i in 0..self.count {
            let r = self.rec(i);
            for a in 0..3 {
                let q = u16::from_le_bytes([r[2 * a], r[2 * a + 1]]);
                if q < mn[a] { mn[a] = q; }
                if q > mx[a] { mx[a] = q; }
            }
        }
        (mn, mx)
    }
}

pub struct Node {
    pub origin: [f64; 3],
    pub size: f64,
    pub depth: u8,
    pub children: Option<[u32; 8]>,
    pub leaf: Option<Leaf>,
}

pub struct Octree { pub nodes: Vec<Node>, pub total: usize }

#[inline]
fn quant(p: f64, o: f64, size: f64) -> u16 {
    let t = (p - o) / size * Q;
    if t <= 0.0 { 0 } else if t >= 65535.0 { 65535 } else { t as u16 }
}

impl Octree {
    pub fn new(min: [f64; 3], max: [f64; 3]) -> Self {
        let ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        let size = ext[0].max(ext[1]).max(ext[2]).max(1e-3) * 1.0001;
        let root = Node { origin: min, size, depth: 0, children: None, leaf: Some(Leaf::new()) };
        Octree { nodes: vec![root], total: 0 }
    }

    /// Root cube bounds.
    pub fn root_bounds(&self) -> ([f64; 3], f64) { (self.nodes[0].origin, self.nodes[0].size) }

    /// Grow the root so that `p` is inside. The old root becomes one octant of
    /// a root twice the size; its records need no requantisation.
    fn grow_toward(&mut self, p: [f64; 3]) {
        let (o, s) = (self.nodes[0].origin, self.nodes[0].size);
        let mut no = o; let mut ci = 0usize;
        for a in 0..3 {
            if p[a] < o[a] { no[a] = o[a] - s; ci |= 1 << a; }
        }
        // move old root to a new node index, make node 0 the new root
        let old = std::mem::replace(&mut self.nodes[0],
            Node { origin: no, size: s * 2.0, depth: 0, children: None, leaf: None });
        let old_idx = self.nodes.len() as u32;
        self.nodes.push(old);
        // depths below the old root are now one deeper; only matters for the split cap
        let mut stack = vec![old_idx as usize];
        while let Some(i) = stack.pop() {
            self.nodes[i].depth += 1;
            if let Some(ch) = self.nodes[i].children { stack.extend(ch.iter().map(|&c| c as usize)); }
        }
        let mut ch = [0u32; 8];
        for c in 0..8usize {
            if c == ci { ch[c] = old_idx; continue; }
            let co = [no[0] + if c & 1 != 0 { s } else { 0.0 },
                      no[1] + if c & 2 != 0 { s } else { 0.0 },
                      no[2] + if c & 4 != 0 { s } else { 0.0 }];
            ch[c] = self.nodes.len() as u32;
            self.nodes.push(Node { origin: co, size: s, depth: 1, children: None, leaf: Some(Leaf::new()) });
        }
        self.nodes[0].children = Some(ch);
    }

    #[inline]
    pub fn insert(&mut self, p: [f64; 3], rgb: [u8; 3], inten: u8, nrm: [i8; 3]) {
        // grow root until the point is inside (rare after the first few points)
        loop {
            let (o, s) = (self.nodes[0].origin, self.nodes[0].size);
            let inside = (0..3).all(|a| p[a] >= o[a] && p[a] < o[a] + s);
            if inside { break; }
            if s > 1.0e7 { return; } // absurd coordinate: drop it
            self.grow_toward(p);
        }
        let mut idx = 0usize;
        loop {
            let n = &self.nodes[idx];
            match &n.children {
                Some(ch) => {
                    let h = n.size * 0.5;
                    let ci = (p[0] >= n.origin[0] + h) as usize
                        | (((p[1] >= n.origin[1] + h) as usize) << 1)
                        | (((p[2] >= n.origin[2] + h) as usize) << 2);
                    idx = ch[ci] as usize;
                }
                None => break,
            }
        }
        let (o, size, depth) = { let n = &self.nodes[idx]; (n.origin, n.size, n.depth) };
        let qx = quant(p[0], o[0], size).to_le_bytes();
        let qy = quant(p[1], o[1], size).to_le_bytes();
        let qz = quant(p[2], o[2], size).to_le_bytes();
        let rec: [u8; REC] = [qx[0], qx[1], qy[0], qy[1], qz[0], qz[1],
                              rgb[0], rgb[1], rgb[2], inten,
                              nrm[0] as u8, nrm[1] as u8, nrm[2] as u8, 0];
        let leaf = self.nodes[idx].leaf.as_mut().unwrap();
        leaf.push(&rec);
        self.total += 1;
        if leaf.count > MAX_LEAF && depth < MAX_DEPTH { self.split(idx); }
    }

    fn split(&mut self, idx: usize) {
        let leaf = self.nodes[idx].leaf.take().unwrap();
        let (o, size, depth) = { let n = &self.nodes[idx]; (n.origin, n.size, n.depth) };
        let h = size * 0.5;
        let base = self.nodes.len() as u32;
        for c in 0..8u32 {
            let co = [o[0] + if c & 1 != 0 { h } else { 0.0 },
                      o[1] + if c & 2 != 0 { h } else { 0.0 },
                      o[2] + if c & 4 != 0 { h } else { 0.0 }];
            self.nodes.push(Node { origin: co, size: h, depth: depth + 1, children: None, leaf: Some(Leaf::new()) });
        }
        let ch: [u32; 8] = std::array::from_fn(|i| base + i as u32);
        // re-bin: exact requantisation
        let mut rec = [0u8; REC];
        for i in 0..leaf.count {
            rec.copy_from_slice(leaf.rec(i));
            let mut ci = 0usize;
            for a in 0..3 {
                let q = u16::from_le_bytes([rec[2 * a], rec[2 * a + 1]]);
                let hi = q >= 32768;
                if hi { ci |= 1 << a; }
                let cq = ((q as u32 - if hi { 32768 } else { 0 }) * 2) as u16;
                let b = cq.to_le_bytes();
                rec[2 * a] = b[0]; rec[2 * a + 1] = b[1];
            }
            self.nodes[ch[ci] as usize].leaf.as_mut().unwrap().push(&rec);
        }
        drop(leaf);
        self.nodes[idx].children = Some(ch);
        // a child may already be over the limit if the parent was lopsided
        for c in ch {
            let (cnt, d) = { let n = &self.nodes[c as usize]; (n.leaf.as_ref().map_or(0, |l| l.count), n.depth) };
            if cnt > MAX_LEAF && d < MAX_DEPTH { self.split(c as usize); }
        }
    }

    pub fn leaf_indices(&self) -> Vec<usize> {
        self.nodes.iter().enumerate()
            .filter(|(_, n)| n.leaf.as_ref().map_or(false, |l| l.count > 0))
            .map(|(i, _)| i).collect()
    }
}
