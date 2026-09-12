// SPDX-License-Identifier: GPL-3.0-only
// Put an SPDX identifier at the top of every source file, and keep it there.
//
//   node tools/spdx.mjs          add the header where it is missing
//   node tools/spdx.mjs --check  list files without one and exit non-zero (this is what CI runs)
//
// It goes on the first line, above the file's own explanation, because that is where every
// tool that scans for licences looks. Files that cannot carry a comment (JSON) are skipped,
// and so is anything generated or vendored — a header on generated code is a lie about who
// wrote it.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ID = 'GPL-3.0-only';
const LINE = `SPDX-License-Identifier: ${ID}`;
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-desktop', 'target', '.git', '.firebase', 'gen',
  'src/wasm',          // wasm-bindgen output
  'shots', 'renders', 'output', 'tmp', 'public',
  'icons',
]);
const STYLES = {
  '.ts': '//', '.mts': '//', '.mjs': '//', '.js': '//', '.rs': '//',
  '.css': '/*', '.html': '<!--', '.sh': '#', '.yml': '#', '.yaml': '#', '.toml': '#',
};
const header = (style) =>
  style === '//' ? `// ${LINE}\n`
  : style === '#' ? `# ${LINE}\n`
  : style === '/*' ? `/* ${LINE} */\n`
  : `<!-- ${LINE} -->\n`;

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(p)) continue;
      yield* walk(p);
    } else if (STYLES[extname(e.name)]) {
      yield p;
    }
  }
}

const check = process.argv.includes('--check');
const missing = [];
let added = 0;
for (const f of walk('.')) {
  if (statSync(f).size === 0) continue;
  let src = readFileSync(f, 'utf8');
  if (src.includes(LINE)) continue;
  if (check) { missing.push(f); continue; }
  const style = STYLES[extname(f)];
  // a shebang, a doctype and a Vite triple-slash directive all have to stay on line one
  const keepFirst = /^(#!|<!doctype|<!DOCTYPE|\/\/\/ <reference)/.test(src);
  if (keepFirst) {
    const nl = src.indexOf('\n') + 1;
    src = src.slice(0, nl) + header(style) + src.slice(nl);
  } else {
    src = header(style) + src;
  }
  writeFileSync(f, src);
  added++;
}
if (check) {
  for (const f of missing) console.log(`no SPDX header: ${f}`);
  console.log(missing.length ? `\n${missing.length} file(s) without ${LINE}` : `every source file carries ${LINE}`);
  process.exit(missing.length ? 1 : 0);
}
console.log(`added ${LINE} to ${added} file(s)`);
