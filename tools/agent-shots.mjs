// SPDX-License-Identifier: GPL-3.0-only
// Photograph the Agent panel in each of its states, against a real session.
//
//   node tools/agent-shots.mjs            # web build, live session on production
//   node tools/agent-shots.mjs --desktop  # desktop build, stubbed shell
//
// A live session is started for real rather than faked in the DOM, so the badge, the expiry
// and the dot in the tab are the ones a user would see.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const desktop = process.argv.includes('--desktop');
const URL_ = process.env.URL || (desktop ? 'http://127.0.0.1:5181/' : 'https://e57view.web.app/');
mkdirSync('docs', { recursive: true });

const br = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const ctx = await br.newContext({ viewport: { width: 1280, height: 1600 }, deviceScaleFactor: 2,
  permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 180)));

if (desktop) {
  await p.addInitScript(() => {
    const EXE = '/Applications/e57view.app/Contents/MacOS/e57view';
    window.__TAURI__ = {
      core: { invoke: async (c) => c === 'bridge_status' ? { port: 7337, viewer: true, agents: 1, exe: EXE } : c === 'recents' ? [] : null },
      event: { listen: async () => () => {}, emit: async () => {} },
      dialog: { open: async () => null, save: async () => null, message: async () => {} },
    };
  });
}
await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(() => {
  document.getElementById('drop').classList.add('hidden');
  document.getElementById('panel').classList.remove('hidden');
  document.querySelectorAll('#panel .grp').forEach(g => g.classList.add('closed'));
  const g = document.querySelector('[data-grp="agent"]');
  g.classList.remove('closed');
  g.scrollIntoView({ block: 'start' });
});
const shoot = async (name) => {
  await p.waitForTimeout(600);
  const el = await p.$('[data-grp="agent"]');
  const out = `docs/agent-${desktop ? 'desktop' : 'web'}-${name}.png`;
  await el.screenshot({ path: out });
  const b = await el.boundingBox();
  console.log(`${out} · ${Math.round(b.width)} x ${Math.round(b.height)}`);
};

const tab = (t) => p.click(`#tab-${t}`);
await tab('mcp'); await shoot('mcp');
await tab('script'); await shoot('scripts');

if (!desktop) {
  await tab('http');
  await shoot('http-idle');
  await p.click('#k-agenturl');
  await p.waitForFunction(() => /^Copied/.test((document.getElementById('v-agenturl')?.textContent || '').trim()), null, { timeout: 30000 });
  await shoot('http-readonly');
  await p.click('#http-live #k-agentedits2');
  await p.waitForTimeout(900);
  await shoot('http-edits');
  await p.click('#k-agentstop');
  await p.waitForTimeout(1200);
}
await br.close();
