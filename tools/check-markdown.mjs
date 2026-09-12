// SPDX-License-Identifier: GPL-3.0-only
// Check the Markdown that people will actually read: every internal link resolves, and every
// mermaid block parses in the same renderer GitHub uses.
//
//   node tools/check-markdown.mjs
import { chromium } from 'playwright';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'THIRD_PARTY.md',
  'CODE_OF_CONDUCT.md', 'FINDINGS.md', ...readdirSync('docs').filter(f => f.endsWith('.md')).map(f => `docs/${f}`)];

let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };

// ---------------------------------------------------------------- links
const broken = [];
let checked = 0;
for (const f of files) {
  if (!existsSync(f)) { broken.push(`${f} (the file itself)`); continue; }
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    let t = m[1];
    if (/^(https?:|mailto:|#)/.test(t)) continue;
    if (t.startsWith('../../')) continue;          // GitHub-relative (security advisories)
    const anchor = t.indexOf('#');
    if (anchor >= 0) t = t.slice(0, anchor);
    if (!t) continue;
    checked++;
    const p = normalize(join(dirname(f), t));
    if (!existsSync(p)) broken.push(`${f} -> ${t}`);
  }
  // images too
  for (const m of src.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const t = m[1];
    if (/^https?:/.test(t)) continue;
    checked++;
    if (!existsSync(normalize(join(dirname(f), t)))) broken.push(`${f} -> ${t} (image)`);
  }
}
ok(`every internal link and image resolves`, !broken.length, broken.length ? broken.join(' | ') : `${checked} checked across ${files.length} files`);

// ---------------------------------------------------------------- mermaid
const blocks = [];
for (const f of files) {
  if (!existsSync(f)) continue;
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/```mermaid\n([\s\S]*?)```/g)) blocks.push({ f, code: m[1] });
}
if (!blocks.length) {
  ok('mermaid diagrams parse', true, 'none to check');
} else {
  // channel:'chrome' on a developer machine, the bundled chromium in CI
  const br = await chromium.launch(process.env.CI ? { headless: true } : { channel: 'chrome', headless: true })
    .catch(() => chromium.launch({ headless: true }));
  const p = await br.newPage();
  await p.goto('about:blank');
  // the same renderer GitHub uses; pinned, so a broken CDN release cannot fail the check quietly
  await p.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js' });
  const loaded = await p.evaluate(() => typeof window.mermaid !== 'undefined');
  if (!loaded) {
    ok('mermaid diagrams parse', false, 'could not load the mermaid renderer (offline?)');
  } else {
    await p.evaluate(() => window.mermaid.initialize({ startOnLoad: false }));
    for (const b of blocks) {
      const r = await p.evaluate(async (code) => {
        try { await window.mermaid.parse(code); return null; }
        catch (e) { return String(e?.message ?? e).slice(0, 300); }
      }, b.code);
      ok(`mermaid in ${b.f} parses`, !r, r ?? `${b.code.split('\n').length} lines`);
      if (!r) {
        // parsing is not rendering; a diagram that parses can still fail to lay out
        const r2 = await p.evaluate(async (code) => {
          try { await window.mermaid.render('m' + Math.random().toString(36).slice(2), code); return null; }
          catch (e) { return String(e?.message ?? e).slice(0, 300); }
        }, b.code);
        ok(`mermaid in ${b.f} renders`, !r2, r2 ?? 'laid out');
      }
    }
  }
  await br.close();
}

// ---------------------------------------------------------------- tables
for (const f of files) {
  if (!existsSync(f)) continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  let bad = 0, tables = 0;
  for (let i = 0; i < lines.length; i++) {
    // a separator row: pipes, dashes, colons and spaces, and at least one dash. Without the
    // dash requirement an empty header row (`| | |`) matches and every such table looks broken.
    if (!/^\s*\|[-: |]+\|\s*$/.test(lines[i]) || !lines[i].includes('-')) continue;
    tables++;
    const cols = (s) => s.split('|').length;
    if (i > 0 && cols(lines[i - 1]) !== cols(lines[i])) bad++;
  }
  if (tables) ok(`tables in ${f} line up`, !bad, `${tables} table${tables > 1 ? 's' : ''}${bad ? `, ${bad} with a header mismatch` : ''}`);
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
