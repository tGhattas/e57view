// SPDX-License-Identifier: GPL-3.0-only
use e57::*;

const W: usize = 1000;
const H: usize = 1330;

struct Buf { w:usize, h:usize, rgb:Vec<[f32;3]>, z:Vec<f32>, n:Vec<[f32;3]>, hit:Vec<u32> }
impl Buf {
    fn new(w:usize,h:usize)->Self{ Buf{w,h,rgb:vec![[0.0;3];w*h], z:vec![f32::MIN;w*h], n:vec![[0.0;3];w*h], hit:vec![0;w*h]} }
    #[inline]
    fn splat(&mut self, x:f32, y:f32, depth:f32, c:[f32;3], nrm:[f32;3]){
        let px = x as isize; let py = y as isize;
        if px<0||py<0||px>=self.w as isize||py>=self.h as isize { return; }
        let i = py as usize*self.w + px as usize;
        if depth > self.z[i] { self.z[i]=depth; self.rgb[i]=c; self.n[i]=nrm; }
        self.hit[i]+=1;
    }
}

fn write_ppm(path:&str, w:usize, h:usize, px:&[[f32;3]]) {
    let mut out = Vec::with_capacity(w*h*3+32);
    out.extend_from_slice(format!("P6\n{} {}\n255\n", w, h).as_bytes());
    for p in px {
        for c in 0..3 { out.push((p[c].clamp(0.0,1.0)*255.0) as u8); }
    }
    std::fs::write(path,out).unwrap();
}

// Eye-dome lighting over a linear depth buffer, Potree-style ring kernel
fn edl(z:&[f32], w:usize, h:usize, radius:i32, strength:f32) -> Vec<f32> {
    let mut shade = vec![1.0f32; w*h];
    let ring: Vec<(f32,f32)> = (0..8).map(|k|{ let a=std::f32::consts::TAU*k as f32/8.0; (a.cos(),a.sin())}).collect();
    for y in 0..h { for x in 0..w {
        let i=y*w+x;
        if z[i]==f32::MIN { continue; }
        let d = (-z[i]).max(1e-3).log2();
        let mut sum=0.0; let mut n=0.0;
        for (dx,dy) in &ring {
            let nx=x as i32+(dx*radius as f32).round() as i32;
            let ny=y as i32+(dy*radius as f32).round() as i32;
            if nx<0||ny<0||nx>=w as i32||ny>=h as i32 {continue;}
            let j=ny as usize*w+nx as usize;
            if z[j]==f32::MIN {continue;}
            let dn=(-z[j]).max(1e-3).log2();
            sum += (d-dn).max(0.0); n+=1.0;
        }
        if n>0.0 { shade[i]=(-(sum/n)*300.0*strength).exp(); }
    }}
    shade
}

fn main(){
    let path=std::env::args().nth(1).unwrap();
    let stride: usize = std::env::args().nth(2).and_then(|s|s.parse().ok()).unwrap_or(1);
    let mut r=E57Reader::from_file(&path).unwrap();
    let pc=r.pointclouds()[0].clone();
    let b=pc.cartesian_bounds.clone().unwrap();
    let (x0,x1)=(b.x_min.unwrap(),b.x_max.unwrap());
    let (y0,y1)=(b.y_min.unwrap(),b.y_max.unwrap());
    let (z0,z1)=(b.z_min.unwrap(),b.z_max.unwrap());
    eprintln!("bbox X[{:.1},{:.1}] Y[{:.1},{:.1}] Z[{:.1},{:.1}]",x0,x1,y0,y1,z0,z1);

    let sx=(W as f64-2.0)/(x1-x0); let sy=(H as f64-2.0)/(y1-y0);
    let s=sx.min(sy);
    let ox=(W as f64-(x1-x0)*s)/2.0; let oy=(H as f64-(y1-y0)*s)/2.0;

    let mut top=Buf::new(W,H);
    let mut n=0usize; let mut kept=0usize;

    for row in r.pointcloud_raw(&pc).unwrap(){
        let row=row.unwrap();
        n+=1;
        if stride>1 && n%stride!=0 { continue; }
        let (x,y,z) = match (&row[0],&row[1],&row[2]) {
            (RecordValue::Single(a),RecordValue::Single(b2),RecordValue::Single(c))=>(*a as f64,*b2 as f64,*c as f64),
            _=>continue };
        let nrm = match (&row[3],&row[4],&row[5]) {
            (RecordValue::Single(a),RecordValue::Single(b2),RecordValue::Single(c))=>[*a,*b2,*c],
            _=>[0.0,0.0,1.0] };
        let inten = match &row[6] { RecordValue::Single(v)=>*v, _=>0.5 };
        let (cr,cg,cb) = match (&row[7],&row[8],&row[9]) {
            (RecordValue::Integer(a),RecordValue::Integer(b2),RecordValue::Integer(c))=>(*a as f32/255.0,*b2 as f32/255.0,*c as f32/255.0),
            _=>(0.5,0.5,0.5) };
        let px=(ox+(x-x0)*s) as f32;
        let py=(H as f64-(oy+(y-y0)*s)) as f32;
        top.splat(px,py,z as f32,[cr,cg,cb],nrm);
        // stash intensity in unused channel via separate buffer trick: reuse n[] slot 2? no - keep simple
        let i=(py as isize).max(0).min(H as isize-1) as usize*W + (px as isize).max(0).min(W as isize-1) as usize;
        if top.z[i]==z as f32 { top.n[i]=[nrm[0],nrm[1],inten]; }
        kept+=1;
    }
    eprintln!("read {} pts, splatted {}", n, kept);
    let covered=top.z.iter().filter(|v|**v!=f32::MIN).count();
    eprintln!("pixels covered: {}/{} ({:.1}%)", covered, W*H, covered as f64/(W*H) as f64*100.0);

    // 1. plain RGB
    write_ppm("/tmp/v_rgb.ppm",W,H,&top.rgb);

    // 2. RGB + EDL
    let sh=edl(&top.z,W,H,2,0.32);
    let mut a=vec![[0.0f32;3];W*H];
    for i in 0..W*H { for c in 0..3 { a[i][c]=top.rgb[i][c]*sh[i]; } }
    write_ppm("/tmp/v_rgb_edl.ppm",W,H,&a);

    // 3. intensity (greyscale) + EDL
    let mut b3=vec![[0.0f32;3];W*H];
    for i in 0..W*H { let v=top.n[i][2]*sh[i]; b3[i]=[v,v,v]; }
    write_ppm("/tmp/v_intensity.ppm",W,H,&b3);

    // 4. elevation ramp + EDL
    let mut c4=vec![[0.0f32;3];W*H];
    for i in 0..W*H {
        if top.z[i]==f32::MIN {continue;}
        let t=(((top.z[i] as f64)-z0)/(z1-z0)).clamp(0.0,1.0) as f32;
        // blue -> cyan -> green -> yellow -> red
        let (rr,gg,bb) = if t<0.25 {(0.0,t*4.0,1.0)} else if t<0.5 {(0.0,1.0,1.0-(t-0.25)*4.0)}
                         else if t<0.75 {((t-0.5)*4.0,1.0,0.0)} else {(1.0,1.0-(t-0.75)*4.0,0.0)};
        c4[i]=[rr*sh[i],gg*sh[i],bb*sh[i]];
    }
    write_ppm("/tmp/v_elev.ppm",W,H,&c4);
    eprintln!("wrote 4 PPMs");
}
