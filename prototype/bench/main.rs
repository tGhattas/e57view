use e57::*;
use std::time::Instant;
fn main(){
    let path=std::env::args().nth(1).unwrap();
    let mut r=E57Reader::from_file(&path).unwrap();
    let imgs=r.images();
    println!("total images: {}", imgs.len());
    let mut total_bytes=0u64;
    let mut poses=Vec::new();
    for im in &imgs {
        if let Some(Projection::Spherical(s))=&im.projection {
            total_bytes+=s.blob.data.length;
            if let Some(t)=&im.transform { poses.push((t.translation.x,t.translation.y,t.translation.z)); }
        }
    }
    println!("spherical panorama payload: {:.0} MB total, avg {:.1} MB each", total_bytes as f64/1e6, total_bytes as f64/imgs.len() as f64/1e6);
    println!("distinct camera positions: {}", poses.len());
    if poses.len()>=2 {
        let d=((poses[0].0-poses[1].0).powi(2)+(poses[0].1-poses[1].1).powi(2)).sqrt();
        println!("spacing between first two stations: {:.2} m", d);
        let (mut mnx,mut mxx)=(f64::MAX,f64::MIN);
        for p in &poses { if p.0<mnx{mnx=p.0}; if p.0>mxx{mxx=p.0}; }
        println!("station X span: {:.1} m", mxx-mnx);
    }
    // extract one panorama to prove blob reads work
    if let Some(im)=imgs.iter().find(|i| matches!(i.projection,Some(Projection::Spherical(_)))) {
        if let Some(Projection::Spherical(s))=&im.projection {
            let t=Instant::now();
            let mut buf:Vec<u8>=Vec::new();
            let n=r.blob(&s.blob.data,&mut buf).unwrap();
            let dt=t.elapsed().as_secs_f64();
            println!("\nextracted panorama: {} bytes in {:.2}s ({:.0} MB/s)", n, dt, n as f64/dt/1e6);
            println!("  {}x{} px, format={:?}, JPEG magic={:02X?}", s.properties.width, s.properties.height, s.blob.format, &buf[..4.min(buf.len())]);
            std::fs::write("/tmp/pano0.jpg",&buf).unwrap();
            println!("  wrote /tmp/pano0.jpg");
        }
    }
}
