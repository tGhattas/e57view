// SPDX-License-Identifier: GPL-3.0-only
// Photograph one panel group at the width it really has.
//
//   node tools/panel-shot.mjs agent docs/panel-agent-web.png
//   node tools/panel-shot.mjs agent docs/panel-agent-desktop.png --desktop
//
// The desktop variant loads the desktop bundle and sets the class the Tauri shell sets, which
// is exactly what decides which controls that build shows. It is the same CSS and the same
// markup; what it cannot show is the live port number the running app fills in.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const group = process.argv[2] || 'agent';
const out = process.argv[3] || `docs/panel-${group}.png`;
const desktop = process.argv.includes('--desktop');
const URL_ = process.env.URL || (desktop ? 'http://127.0.0.1:5181/' : 'http://127.0.0.1:5180/');
mkdirSync(dirname(out), { recursive: true });

const br = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const p = await (await br.newContext({ viewport: { width: 1280, height: 1600 }, deviceScaleFactor: 2 })).newPage();

// The page decides it is the desktop build from the Tauri global, and the snippets it writes
// come from the real binary path the shell reports. A stub of exactly the calls the panel
// makes gets the true desktop panel rather than a web one with a class on it.
if (desktop) {
  await p.addInitScript(() => {
    const EXE = '/Applications/e57view.app/Contents/MacOS/e57view';
    window.__TAURI__ = {
      core: {
        invoke: async (cmd) => {
          if (cmd === 'bridge_status') return { port: 7337, viewer: true, agents: 1, hello: 'e57view', exe: EXE };
          if (cmd === 'recents') return [];
          return null;
        },
      },
      event: { listen: async () => () => {}, emit: async () => {} },
      dialog: { open: async () => null, save: async () => null, message: async () => {} },
    };
  });
}

p.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
p.on('console', m => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 200)); });
await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate((d) => {
  if (d) document.body.classList.add('desktop');
  document.getElementById('drop').classList.add('hidden');
  document.getElementById('panel').classList.remove('hidden');
  // one group open, the rest shut, so the picture is of that group
  document.querySelectorAll('#panel .grp').forEach(g => g.classList.add('closed'));
}, desktop);
await p.evaluate((g) => {
  const el = document.querySelector(`[data-grp="${g}"]`);
  el.classList.remove('closed');
  el.scrollIntoView({ block: 'start' });
}, group);
await p.waitForTimeout(desktop ? 1600 : 700);
const el = await p.$(`[data-grp="${group}"]`);
await el.screenshot({ path: out });
const box = await el.boundingBox();
console.log(`${out} · ${Math.round(box.width)} x ${Math.round(box.height)} CSS px`);
await br.close();
