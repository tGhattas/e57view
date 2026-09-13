// SPDX-License-Identifier: GPL-3.0-only
// The desktop bundle must not contain a single outbound URL.
//
//   npm run build:desktop && node tools/check-offline.mjs
//
// "Works offline" is a claim about the bytes that ship, not about what happens to run. A
// guarded fetch still ships the code and the address; this greps the built bundle for both.
// It is cheap and it has already caught two things — the analytics tag and a URL sitting in a
// <pre> that nobody would ever fetch but which was still, on disk, a promise being broken.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const DIR = process.argv[2] || 'dist-desktop';
// the two XML namespaces SVG requires are identifiers, not addresses: nothing fetches them
const ALLOWED = [/^https?:\/\/www\.w3\.org\//];
const TEXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.txt', '.map', '.webmanifest']);

let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };

if (!existsSync(DIR)) {
  console.log(`No ${DIR}. Build it first: npm run build:desktop`);
  process.exit(1);
}

function* walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

const urls = new Map();       // url -> the files it appears in
let bytes = 0, files = 0;
for (const f of walk(DIR)) {
  bytes += statSync(f).size;
  files++;
  if (!TEXT.has(extname(f))) continue;
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bhttps?:\/\/[^\s"'`)\\<>]+/g)) {
    const u = m[0];
    if (ALLOWED.some(r => r.test(u))) continue;
    if (!urls.has(u)) urls.set(u, new Set());
    urls.get(u).add(f.slice(DIR.length + 1));
  }
}
ok('no http(s) address survives in the desktop bundle', urls.size === 0,
   urls.size ? [...urls].map(([u, f]) => `${u} (${[...f].join(', ')})`).join(' | ') : `${files} files, ${(bytes / 1e6).toFixed(1)} MB`);

// the two things that would make it phone home even without a literal URL
const all = [...walk(DIR)].filter(f => TEXT.has(extname(f))).map(f => [f, readFileSync(f, 'utf8')]);
const analytics = all.filter(([, s]) => /googletagmanager|gtag\(|dataLayer/.test(s)).map(([f]) => f);
ok('no analytics tag', !analytics.length, analytics.join(', ') || 'none');
const firebase = all.filter(([, s]) => /firebaseapp\.com|firestore\.googleapis|initializeApp\(/.test(s)).map(([f]) => f);
ok('no Firebase client', !firebase.length, firebase.join(', ') || 'none');
// the only socket the app may open
const ws = new Set();
for (const [, s] of all) for (const m of s.matchAll(/\bwss?:\/\/[^\s"'`)\\<>$]*/g)) ws.add(m[0]);
const offBox = [...ws].filter(u => !/127\.0\.0\.1|localhost/.test(u));
ok('the only websocket is on loopback', !offBox.length, offBox.join(', ') || [...ws].join(', ') || 'none');

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
