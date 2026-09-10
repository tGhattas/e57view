import { openSync, readSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const m = require('./shimpkg/shim.js');
const PATH='/Users/tamer/Downloads/1973-registered.e57';
const fd=openSync(PATH,'r'), size=statSync(PATH).size;
let reads=0, bytes=0;
const rr=(o,l)=>{const b=Buffer.allocUnsafe(Number(l));const n=readSync(fd,b,0,Number(l),Number(o));reads++;bytes+=n;return new Uint8Array(b.buffer,b.byteOffset,n);};

for (const w of [4*1024*1024, 16*1024*1024]) {
  m.set_window_size(w);
  const h=new m.E57Handle(rr,size);
  h.decode(0, 300_000);                      // warmup, discard
  reads=0; bytes=0;
  const t=performance.now();
  const r=h.decode(0, 4_000_000);
  const dt=(performance.now()-t)/1000;
  console.log(`window=${(w/1048576)}MB  ${r.count.toLocaleString()} pts in ${dt.toFixed(2)}s = ${(r.count/dt/1e6).toFixed(2)} M pts/s | jsReads=${reads} pulled=${(bytes/1e6).toFixed(0)}MB`);
  console.log(`   -> full 73.76M scan would take ~${(73757292/(r.count/dt)).toFixed(0)}s single-threaded`);
}
