// Agent session security + behaviour, against a real viewer tab.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const URL_ = process.env.URL || 'https://opensketch.web.app/';
const ORIGIN = new URL(URL_).origin;
const ply = join(tmpdir(), 'e57view-agent.ply');
{ const L = ['ply','format ascii 1.0','element vertex 4096','property float x','property float y','property float z','property uchar red','property uchar green','property uchar blue','end_header'];
  for (let z=0;z<4;z++) for (let y=0;y<32;y++) for (let x=0;x<32;x++) L.push(`${x} ${y} ${z} 190 175 150`);
  writeFileSync(ply, L.join('\n')); }

const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 200)));
await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(() => localStorage.clear());
await p.setInputFiles('#file-input', ply);
await p.waitForFunction(() => /loaded in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 90000 });
await p.waitForTimeout(900);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 3000 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));

await p.bringToFront();
await p.click('#k-agenturl');
try { await p.waitForFunction(() => /copied with its token/.test(document.getElementById('v-agenturl')?.textContent || ''), null, { timeout: 25000 }); }
catch { console.log('  status was:', await p.textContent('#v-agenturl')); throw new Error('Copy agent URL did not complete'); }
const blob = await p.evaluate(() => navigator.clipboard.readText());
const sid = blob.match(/"session":"([a-z0-9]+)"/)[1];
const token = blob.match(/Bearer ([a-f0-9]+)/)[1];
console.log(`SESSION ${sid} · token ${token.length} hex chars`);
console.log('URL in the clipboard has no token:', !blob.split('\n').find(l => l.startsWith('Viewer page:'))?.includes(token));

const call = async (body, hdr = {}) => {
  const r = await fetch(`${ORIGIN}/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...hdr }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
const auth = { Authorization: `Bearer ${token}` };
const ok = (label, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' · ' + extra : ''}`);

let r = await call({ session: sid, cmd: 'state' });
ok('no token rejected', r.status === 401, `http ${r.status}`);
r = await call({ session: sid, cmd: 'state' }, { Authorization: 'Bearer ' + 'f'.repeat(64) });
ok('wrong token rejected', r.status === 401, `http ${r.status}`);
r = await call({ session: sid, cmd: 'state' }, auth);
ok('valid token accepted', r.status === 200 && r.j.result?.points === 4096, `http ${r.status} · ${r.j.result?.points} pts`);

r = await call({ session: sid, cmd: 'history', args: { op: 'undo' } }, auth);
ok('edit blocked while read-only', r.status === 403, `http ${r.status}`);
await p.click('#k-agentedits');
await p.waitForTimeout(1200);
r = await call({ session: sid, cmd: 'history', args: { op: 'undo' } }, auth);
ok('edit allowed after Allow edits', r.status === 200, `http ${r.status}`);
await p.click('#k-agentedits');
await p.waitForTimeout(1200);

// merge fix: a preset must not linger into the next set_view
await call({ session: sid, cmd: 'set_view', args: { preset: 'top', shot: false } }, auth);
const want = { p: [40, 30, 12], t: [15.5, 15.5, 1.5] };
r = await call({ session: sid, cmd: 'set_view', args: { pose: want, shot: false } }, auth);
const got = r.j.result?.p?.map(v => +v.toFixed(2));
ok('pose applied after a preset', JSON.stringify(got) === JSON.stringify(want.p), `got ${JSON.stringify(got)}`);

r = await call({ session: sid, cmd: 'screenshot', args: { width: 900 } }, auth);
const bytes = JSON.stringify(r.j).length;
ok('screenshot returns one image', !!r.j.shot && !r.j.result?.png, `${(bytes/1024).toFixed(0)} KB body`);

await p.click('#k-agentstop');
await p.waitForTimeout(1500);
r = await call({ session: sid, cmd: 'state' }, auth);
ok('stopped session revoked', r.status === 401, `http ${r.status}`);
await b.close();
