// SPDX-License-Identifier: GPL-3.0-only
// A script is a list of steps run in order on the live tab, with each step's result available
// to the next. This runs one end to end and checks the chaining, the variables and the
// stop-on-error rule — not merely that something came back.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roomPly } from './room-fixture.mjs';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
mkdirSync('shots', { recursive: true });
const ROOM = join(tmpdir(), 'e57view-script-room.ply');
const R = roomPly(ROOM, 6, 4, 3, 0.05, 12, 8, 20);

const br = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const p = await (await br.newContext({ viewport: { width: 1200, height: 820 } })).newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };
const idle = () => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 300000 });
const run = (a) => p.evaluate(x => window.__app.runScript(x), a);

await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(async () => { localStorage.clear(); const r = await navigator.storage.getDirectory(); for (const d of ['e57view-cache', 'e57view-undo']) { try { await r.removeEntry(d, { recursive: true }); } catch {} } });
await p.setInputFiles('#file-input', ROOM);
await p.waitForFunction(c => window.__viewer.loaded === c, R.n, { timeout: 120000 });
await p.waitForTimeout(900);
try { await p.click('#modal-btns button:has-text("Not now")', { timeout: 2500 }); } catch {}
await p.evaluate(() => document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed')));
console.log('LOAD:', await p.textContent('#tb-points'), `· ${R.n} points`);

// ---------------------------------------------------------------- a measuring script
// Every step after the first is decided by an earlier one: the floor is fitted inside a box
// built from the cloud's own bounds, and the wall is fitted relative to that floor's height.
let r = await run({
  steps: [
    { cmd: 'set_view', args: { preset: 'fit' } },
    { cmd: 'state', args: {}, save: 'S', label: 'what is loaded' },
    { cmd: 'fitplane', args: { box: { center: ['${S.bounds.local.centre.0}', '${S.bounds.local.centre.1}', '$S.bounds.local.min.2'], half: [2.9, 1.9, 0.03] } }, save: 'floor', label: 'the floor' },
    { cmd: 'inside', args: { box: { center: ['$S.bounds.local.centre.0', '$S.bounds.local.centre.1', '$floor.centroid.2'], half: [2.9, 1.9, 0.03] } }, label: 'points on it' },
    { cmd: 'measure', args: { a: '$S.bounds.local.min', b: '$S.bounds.local.max' }, label: 'the diagonal' },
  ],
});
await idle();
console.log('SCRIPT:', JSON.stringify({ ok: r.ok, ran: r.ran, ms: r.ms }), '·', await p.textContent('#v-script'));
for (const s of r.steps) console.log(`   ${s.i} ${s.cmd.padEnd(10)} ${s.ok ? 'ok' : 'FAILED: ' + s.error}  ${s.ms} ms`);
ok('every step ran', r.ok && r.ran === 5, `${r.ran} of ${r.of}, ${r.failed} failed`);
const floor = r.steps[2].result;
ok('a box built from an earlier step fitted the floor', Math.abs(Math.abs(floor.normal[2]) - 1) < 1e-4, `normal ${floor.normal.map(v => v.toFixed(4)).join(', ')}`);
ok('and it is flat', floor.rms < 0.0005, `RMS ${(floor.rms * 1000).toFixed(4)} mm over ${floor.points} points`);
ok('${...} interpolation put a number in, not a string', typeof r.steps[2].result.centroid[0] === 'number', `centre x ${floor.centroid[0].toFixed(3)}`);
const inside = r.steps[3].result;
ok('a box placed at the fitted height holds the floor', inside.count > 8500 && inside.count <= 9801, `${inside.count} points of the floor's 9,801`);
const diag = r.steps[4].result;
const want = Math.hypot(R.sx, R.sy, R.sz);
ok('two whole-array variables measured the diagonal', Math.abs(diag.dist - want) < 0.02, `${diag.dist.toFixed(4)} m against ${want.toFixed(4)}`);
ok('the panel shows what ran', /5 of 5 steps/.test(await p.textContent('#v-script')), await p.textContent('#v-script'));
await p.screenshot({ path: 'shots/script-run.png' });

// ---------------------------------------------------------------- variables report themselves
ok('the saved names come back', r.variables.includes('$S') && r.variables.includes('$floor') && r.variables.includes('$last') && r.variables.includes('$layers'),
   r.variables.join(' '));

// ---------------------------------------------------------------- errors
r = await run({ steps: [{ cmd: 'state' }, { cmd: 'nonsense' }, { cmd: 'state' }] });
ok('an unknown command stops the script', !r.ok && r.ran === 2 && r.steps[1].stopped, `${r.ran} of ${r.of} ran, failed ${r.failed}`);
ok('and says what went wrong', /unknown command/.test(r.steps[1].error ?? ''), r.steps[1].error);
r = await run({ steps: [{ cmd: 'state' }, { cmd: 'nonsense' }, { cmd: 'state' }], stopOnError: false });
ok('stopOnError:false runs the rest anyway', !r.ok && r.ran === 3 && r.failed === 1, `${r.ran} of ${r.of} ran, ${r.failed} failed`);
r = await run({ steps: [{ cmd: 'state' }, { cmd: 'measure', args: { a: '$nope.x', b: [0, 0, 0] } }] });
ok('an unknown variable is named, with what was available', /no variable \$nope/.test(r.steps[1].error ?? ''), r.steps[1].error);
r = await run({ steps: [{ cmd: 'script', args: { steps: [] } }] });
ok('a script cannot run a script', /cannot run a script/.test(r.steps[0].error ?? ''), r.steps[0].error);

// ---------------------------------------------------------------- a script that changes things
r = await run({
  steps: [
    { cmd: 'regions', args: { op: 'place', at: '$last.bounds.local.centre' } },
    { cmd: 'state', args: {}, save: 'S' },
    { cmd: 'regions', args: { op: 'list' } },
  ],
  vars: { last: { bounds: { local: { centre: [15, 10, 21.5] } } } },
});
await idle();
ok('a caller can seed its own variables', r.ok && r.ran === 3, `${r.ran} of ${r.of}, ${r.failed} failed`);
ok('the region landed where the seed said', Math.abs(r.steps[2].result[0].center[0] - 15) < 0.01, `centre ${r.steps[2].result[0].center.map(v => v.toFixed(2)).join(', ')}`);

// ---------------------------------------------------------------- through the agent surface
const ag = await p.evaluate(() => window.__app.agentRun('script', { steps: [{ cmd: 'state' }, { cmd: 'inside', args: { box: { center: '$last.bounds.local.centre', half: [10, 10, 10] } } }] }));
ok('the same thing works as an agent command', ag.ok && ag.ran === 2, `${ag.ran} of ${ag.of}, ${ag.failed} failed`);
ok('and the second step saw the first', ag.steps[1].result.count === R.n, `${ag.steps[1].result.count} of ${R.n} points inside`);

// ---------------------------------------------------------------- an image is not shipped twice
const shot = await p.evaluate(() => window.__app.agentRun('script', { steps: [{ cmd: 'screenshot', args: { width: 600 } }] }));
ok('a step that answers with a picture reports it, not the bytes', /omitted/.test(String(shot.steps[0].result.png ?? '')), String(shot.steps[0].result.png).slice(0, 70));

// ---------------------------------------------------------------- the panel action
await p.click('#k-script');
await p.waitForSelector('#sc-text', { timeout: 10000 });
await p.fill('#sc-text', JSON.stringify([{ cmd: 'set_view', args: { preset: 'top' } }, { cmd: 'state' }], null, 2));
await p.click('#modal-btns button:has-text("Run")');
await p.waitForFunction(() => /2 of 2 steps/.test(document.getElementById('v-script')?.textContent || ''), null, { timeout: 60000 });
ok('the panel runs one too', /all ok/.test(await p.textContent('#v-script')), await p.textContent('#v-script'));
await p.screenshot({ path: 'shots/script-panel.png' });
try { await p.click('#modal-btns button:has-text("Close")', { timeout: 4000 }); } catch {}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
await br.close();
process.exit(fails === 0 ? 0 : 1);
