// SPDX-License-Identifier: GPL-3.0-only
// Agent session security + behaviour, against a real viewer tab.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const URL_ = process.env.URL || 'https://e57view.web.app/';
const ORIGIN = new URL(URL_).origin;
// A solid slab plus isolated specks floating clear of it, which the noise detector should find.
const ply = join(tmpdir(), 'e57view-agent.ply');
const SLAB = 32 * 32 * 4;
const SPECKS = [];
for (let i = 0; i < 8; i++) for (let k = 0; k < 4; k++) SPECKS.push([44 + i * 3, 44 + (i % 3) * 3, 7 + k * 0.2]);
const NPTS = SLAB + SPECKS.length;
{ const L = ['ply','format ascii 1.0',`element vertex ${NPTS}`,'property float x','property float y','property float z','property uchar red','property uchar green','property uchar blue','end_header'];
  for (let z=0;z<4;z++) for (let y=0;y<32;y++) for (let x=0;x<32;x++) L.push(`${x} ${y} ${z} 190 175 150`);
  for (const [x,y,z] of SPECKS) L.push(`${x} ${y} ${z} 230 230 230`);
  writeFileSync(ply, L.join('\n')); }

const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 200)));
await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(() => localStorage.clear());
await p.setInputFiles('#file-input', ply);
await p.waitForFunction(() => /loaded in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 90000 });
console.log(`FIXTURE ${NPTS} points (${SPECKS.length} floating specks)`);
await p.waitForTimeout(900);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 3000 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));

const ok = (label, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' · ' + extra : ''}`);

await p.bringToFront();
// a hidden tab's controls are not clickable, so switch to it the way a user does
await p.click('#tab-http');
const access = () => p.evaluate(() => ({
  badge: document.getElementById('v-access')?.textContent.trim() ?? '',
  note: document.getElementById('v-accessnote')?.textContent.trim() ?? '',
  live: !document.getElementById('http-live').classList.contains('hidden'),
  idle: !document.getElementById('http-idle').classList.contains('hidden'),
  dot: document.getElementById('tab-http').className,
  // one status line now, carrying the state; a confirmation sits on the button instead
  left: document.querySelector('#http-live .statusline')?.textContent.trim() ?? '',
}));
const before = await access();
ok('before a session the HTTP tab shows the choice, not a state', before.idle && !before.live, JSON.stringify(before.idle));
ok('and the tab carries no dot', !/live|warn/.test(before.dot), before.dot);
ok('with no copy button, because there is nothing to copy yet',
   !(await p.evaluate(() => !!document.getElementById('k-agentcopy')?.offsetParent)), '');

await p.click('#k-agenturl');
try { await p.waitForFunction(() => /^Copied/.test((document.getElementById('v-agenturl')?.textContent || '').trim()), null, { timeout: 25000 }); }
catch { console.log('  status was:', await p.textContent('#v-agenturl')); throw new Error('Copy agent URL did not complete'); }
// the confirmation is read now, while it is up; four seconds later the line goes back to
// saying what the session is, which is the next check
const toast = (await p.textContent('#v-agenturl')).trim();
const blob = await p.evaluate(() => navigator.clipboard.readText());
const sid = blob.match(/"session":"([a-z0-9]+)"/)[1];
const token = blob.match(/Bearer ([a-f0-9]+)/)[1];
console.log(`SESSION ${sid} · token ${token.length} hex chars`);
const live = await access();
console.log('ACCESS', JSON.stringify({ badge: live.badge, left: live.left }));
ok('starting a session swaps in the live block', live.live && !live.idle, '');
ok('the access level is stated in full', live.badge === 'READ-ONLY', live.badge);
ok('with a line saying what that means', /cannot change or save/.test(live.note), live.note);
// the start confirmation holds the line for four seconds, then it says what the session is
await p.waitForTimeout(4600);
const settled = await access();
ok('and the one status line then says live, the access level and the time left',
   /^live · read-only · expires in \d+ h/.test(settled.left), settled.left);
ok('the tab carries a dot', /live/.test(live.dot), live.dot);
ok('the copied text leads with the access level', /^# READ-ONLY/m.test(blob), blob.split('\n')[0]);
ok('and the confirmation said which kind of session', /read-only session/.test(toast), toast);

// the instructions must be gettable again, because a confirmation people miss is how the
// first copy gets lost
const conn = await p.evaluate(() => ({
  hasButton: !!document.getElementById('k-agentcopy')?.offsetParent,
  preview: document.getElementById('v-agentconn')?.textContent?.trim() ?? '',
  lines: document.querySelectorAll('#http-live .statusline').length,
}));
ok('a live session offers Copy connection details', conn.hasButton, '');
ok('the box shows the URL with the token masked', /session=/.test(conn.preview) && /Bearer \.\.\.\w{4}$/.test(conn.preview),
   conn.preview.replace('\n', ' | '));
ok('and the token itself is not on screen', !conn.preview.includes(token), `token is ${token.length} chars`);
ok('there is one status line in the tab, not two', conn.lines === 1, `${conn.lines}`);

await p.click('#k-agentcopy');
await p.waitForTimeout(400);
const copied1 = await p.evaluate(() => navigator.clipboard.readText());
ok('copying again gives the read-only text', /^# READ-ONLY/.test(copied1) && copied1.includes(token),
   copied1.split('\n')[0]);
ok('and the button says so next to itself',
   /Copied/.test(await p.textContent('#k-agentcopy')), await p.textContent('#k-agentcopy'));
console.log('URL in the clipboard has no token:', !blob.split('\n').find(l => l.startsWith('Viewer page:'))?.includes(token));

const call = async (body, hdr = {}) => {
  const r = await fetch(`${ORIGIN}/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...hdr }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
const auth = { Authorization: `Bearer ${token}` };

let r = await call({ session: sid, cmd: 'state' });
ok('no token rejected', r.status === 401, `http ${r.status}`);
r = await call({ session: sid, cmd: 'state' }, { Authorization: 'Bearer ' + 'f'.repeat(64) });
ok('wrong token rejected', r.status === 401, `http ${r.status}`);
r = await call({ session: sid, cmd: 'state' }, auth);
ok('valid token accepted', r.status === 200 && r.j.result?.points === NPTS, `http ${r.status} · ${r.j.result?.points} pts`);

r = await call({ session: sid, cmd: 'history', args: { op: 'undo' } }, auth);
ok('edit blocked while read-only', r.status === 403, `http ${r.status}`);
await p.click('#http-live #k-agentedits2');
await p.waitForTimeout(1200);
r = await call({ session: sid, cmd: 'history', args: { op: 'undo' } }, auth);
ok('edit allowed after Allow edits', r.status === 200, `http ${r.status}`);
const hot = await access();
ok('and the badge flips to EDITS ALLOWED', hot.badge === 'EDITS ALLOWED', hot.badge);
ok('with a line saying what that means', /crop, delete/.test(hot.note), hot.note);
ok('and the tab dot turns to a warning', /warn/.test(hot.dot), hot.dot);
// a session flipped to edits must copy as edits, not as what it was when it started
await p.click('#k-agentcopy');
await p.waitForTimeout(400);
const copied2 = await p.evaluate(() => navigator.clipboard.readText());
ok('copying after the flip gives the edits-allowed text', /^# EDITS ALLOWED/.test(copied2),
   copied2.split('\n')[0]);
// a command was just run over the session, and the line reports that while it runs; give it
// the couple of seconds that takes before reading the settled state
try { await p.waitForFunction(() => /^live/.test((document.querySelector('#http-live .statusline')?.textContent || '').trim()), null, { timeout: 6000 }); } catch {}
const oneLine = await p.evaluate(() => {
  const el = document.querySelector('#http-live .statusline');
  return { n: document.querySelectorAll('#http-live .statusline').length, text: el?.textContent?.trim() ?? '' };
});
ok('and the single status line says live, the access level and the time left',
   oneLine.n === 1 && /^live · edits allowed · expires in \d+ h/.test(oneLine.text), `${oneLine.n} line: ${oneLine.text}`);
await p.click('#http-live #k-agentedits2');
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

// an apply must return a plain summary: the undo record cannot cross Firestore
await p.click('#http-live #k-agentedits2'); await p.waitForTimeout(1200);
r = await call({ session: sid, cmd: 'regions', args: { op: 'add', shot: false,
  region: { kind: 'box', role: 'delete', center: [54.5, 47, 7.3], half: [11, 4, 1], label: 'specks' } } }, auth);
ok('agent can add a delete region', r.status === 200 && !!r.j.result?.id, r.j.result?.label ?? '');
r = await call({ session: sid, cmd: 'regions', args: { op: 'apply', shot: false } }, auth);
const ap = r.j.result || {};
ok('apply replies with a summary', r.status === 200 && r.j.ok !== false && ap.dropped === SPECKS.length && !('undo' in ap),
   `kept ${ap.kept} dropped ${ap.dropped}`);
r = await call({ session: sid, cmd: 'history', args: { op: 'undo', shot: false } }, auth);
ok('undo restores through the endpoint', r.status === 200 && r.j.result?.points === NPTS, `${r.j.result?.points} pts`);
await p.click('#http-live #k-agentedits2'); await p.waitForTimeout(800);

await p.click('#k-agentstop');
await p.waitForTimeout(1500);
r = await call({ session: sid, cmd: 'state' }, auth);
ok('stopped session revoked', r.status === 401, `http ${r.status}`);
const gone = await access();
ok('and the tab goes back to offering a new session', gone.idle && !gone.live, '');
ok('with no dot on it', !/live|warn/.test(gone.dot), gone.dot);
ok('and the copy button is gone with it',
   !(await p.evaluate(() => !!document.getElementById('k-agentcopy')?.offsetParent)), '');

// closing the window must kill the token by itself
const p2 = await ctx.newPage();
await p2.goto(URL_, { waitUntil: 'networkidle' });
await p2.setInputFiles('#file-input', ply);
await p2.waitForFunction(() => /loaded in/.test(document.getElementById('tb-points')?.textContent || ''), null, { timeout: 90000 });
await p2.waitForTimeout(900);
try { await p2.click('#modal-btns button:has-text("Not now")', { timeout: 3000 }); } catch {}
await p2.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
await p2.bringToFront();
await p2.click('#k-agenturl');
await p2.waitForFunction(() => /^Copied/.test((document.getElementById('v-agenturl')?.textContent || '').trim()), null, { timeout: 30000 });
const blob2 = await p2.evaluate(() => navigator.clipboard.readText());
const sid2 = blob2.match(/"session":"([a-z0-9]+)"/)[1];
const auth2 = { Authorization: `Bearer ${blob2.match(/Bearer ([a-f0-9]+)/)[1]}` };
r = await call({ session: sid2, cmd: 'state' }, auth2);
ok('second session works before close', r.status === 200, `http ${r.status}`);
await p2.close();
await new Promise(r => setTimeout(r, 2500));
r = await call({ session: sid2, cmd: 'state' }, auth2);
ok('token dies when the window closes', r.status === 401, `http ${r.status}`);
await b.close();
