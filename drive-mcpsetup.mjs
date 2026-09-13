// SPDX-License-Identifier: GPL-3.0-only
// The Agent panel's MCP setup: one server, six clients, two builds.
//
// What has to be right is the text somebody pastes, so that is what this checks — the exact
// command and arguments for each client, for both the desktop binary and the Node server, and
// that the Copy button copies what is on the screen rather than a regenerated approximation
// of it. The desktop forms are checked through the same pure generator the panel uses, since
// they do not depend on which build is rendering them.
import { chromium } from 'playwright';

const URL_ = process.env.URL || 'http://127.0.0.1:5180/';
let fails = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' · ' + d : ''}`); if (!c) fails++; };

const br = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const ctx = await br.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 200)));
await p.goto(URL_, { waitUntil: 'networkidle' });
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle' });
// the panel is hidden until a scan is open; this test is about the panel, not about a scan
const openPanel = () => p.evaluate(() => {
  document.getElementById('drop').classList.add('hidden');
  document.getElementById('panel').classList.remove('hidden');
  document.querySelectorAll('#panel .grp').forEach(g => g.classList.remove('closed'));
});
await openPanel();

const clients = await p.evaluate(() => window.__app.mcpClients);
ok('the panel offers a client for each of the tools people use', clients.length >= 6,
   clients.map(c => c.name).join(', '));
for (const want of ['Claude Code', 'Codex CLI', 'Cursor', 'Claude Desktop']) {
  ok(`  ${want} is one of them`, clients.some(c => c.name === want), '');
}

/** The blocks the panel is actually showing, read out of the DOM. */
const shown = () => p.evaluate(() =>
  Array.from(document.querySelectorAll('#mcp-snips .snipwrap')).map(w => ({
    label: w.querySelector('.sniplabel')?.textContent ?? '',
    text: w.querySelector('pre')?.textContent ?? '',
    copyId: w.querySelector('button')?.id ?? '',
  })));
const pick = async (id) => {
  await p.selectOption('#k-mcpclient', id);
  await p.waitForTimeout(60);
  return shown();
};

// ---------------------------------------------------------------- the web build, in the DOM
console.log('\n--- web build (the Node server) ---');
for (const c of clients) {
  const blocks = await pick(c.id);
  const all = blocks.map(b => b.text).join('\n');
  ok(`${c.name}: the download line comes first`, /curl -fsSL \S+\/mcp\.mjs -o e57view-mcp\.mjs/.test(blocks[0]?.text ?? ''),
     (blocks[0]?.text ?? '').slice(0, 60));
  ok(`${c.name}: it registers node and the server file`, /node/.test(all) && /e57view-mcp\.mjs/.test(all), '');
  ok(`${c.name}: nothing names the desktop binary`, !/--mcp/.test(all), '');
}

const cc = await pick('claude-code');
ok('Claude Code gets `claude mcp add`', cc.some(b => b.text.startsWith('claude mcp add e57view -- node ')),
   cc[1]?.text ?? '');

const cx = await pick('codex');
ok('Codex shows both forms', cx.length === 3, `${cx.length} blocks: ${cx.map(b => b.label.split(' —')[0]).join(' | ')}`);
ok('Codex CLI form is `codex mcp add <name> -- <command> [args]`',
   cx.some(b => /^codex mcp add e57view -- node /.test(b.text)), cx[1]?.text ?? '');
ok('Codex names the version that introduced it', cx.some(b => /0\.36/.test(b.label)), cx[1]?.label ?? '');
const toml = cx.find(b => b.text.startsWith('[mcp_servers.'));
ok('Codex config form uses the documented TOML keys',
   !!toml && /^\[mcp_servers\.e57view\]$/m.test(toml.text) && /^command = "/m.test(toml.text) && /^args = \[/m.test(toml.text),
   (toml?.text ?? '').replace(/\n/g, ' · '));
ok('and says which file it goes in', /~\/\.codex\/config\.toml/.test(toml?.label ?? ''), toml?.label ?? '');

for (const [id, file] of [['cursor', '.cursor/mcp.json'], ['claude-desktop', 'claude_desktop_config.json'],
                          ['gemini', '~/.gemini/settings.json'], ['windsurf', '~/.codeium/windsurf/mcp_config.json']]) {
  const b = (await pick(id)).slice(1);
  const json = b.find(x => x.text.trim().startsWith('{'));
  let parsed = null;
  try { parsed = JSON.parse(json?.text ?? ''); } catch {}
  ok(`${id}: the JSON parses and has mcpServers.e57view`,
     !!parsed?.mcpServers?.e57view?.command, JSON.stringify(parsed?.mcpServers?.e57view ?? null));
  ok(`${id}: it names ${file}`, b.some(x => x.label.includes(file)), b.map(x => x.label).join(' | '));
}

// ---------------------------------------------------------------- Copy copies what is shown
await pick('codex');
for (const i of [0, 1, 2]) {
  const { text, copied } = await p.evaluate(async (idx) => {
    const wraps = document.querySelectorAll('#mcp-snips .snipwrap');
    const w = wraps[idx];
    const text = w.querySelector('pre').textContent;
    w.querySelector('button').click();
    await new Promise(r => setTimeout(r, 120));
    return { text, copied: await navigator.clipboard.readText() };
  }, i);
  ok(`Copy on block ${i} copies exactly what is shown`, copied === text,
     copied === text ? `${text.length} characters` : `clipboard "${copied.slice(0, 40)}" vs shown "${text.slice(0, 40)}"`);
}

// ---------------------------------------------------------------- the choice is remembered
await pick('windsurf');
await p.reload({ waitUntil: 'networkidle' });
await openPanel();
ok('the chosen client survives a reload', (await p.inputValue('#k-mcpclient')) === 'windsurf',
   await p.inputValue('#k-mcpclient'));

// ---------------------------------------------------------------- the desktop build's forms
console.log('\n--- desktop build (the app registering itself) ---');
const EXES = [
  ['macOS', '/Applications/e57view.app/Contents/MacOS/e57view'],
  ['Linux', '/usr/bin/e57view'],
  ['Windows', 'C:\\Program Files\\e57view\\e57view.exe'],
];
for (const [plat, exe] of EXES) {
  const byClient = await p.evaluate(([exe, ids]) => {
    const t = window.__app.mcpDesktopTarget(exe);
    const out = {};
    for (const id of ids) out[id] = window.__app.mcpBlocks(id, t);
    return out;
  }, [exe, clients.map(c => c.id)]);

  const cc = byClient['claude-code'];
  ok(`${plat}: Claude Code registers this binary with --mcp`,
     cc.length === 1 && cc[0].text.startsWith('claude mcp add e57view -- ') && cc[0].text.endsWith(' --mcp') && cc[0].text.includes(exe),
     cc[0].text);
  const cx = byClient['codex'];
  ok(`${plat}: Codex CLI form names the binary and --mcp`,
     cx[0].text.startsWith('codex mcp add e57view -- ') && cx[0].text.includes(exe) && cx[0].text.endsWith(' --mcp'),
     cx[0].text);
  ok(`${plat}: Codex TOML args are exactly ["--mcp"]`,
     /\nargs = \["--mcp"\]$/.test(cx[1].text), cx[1].text.split('\n').pop());
  // a Windows path has backslashes, which a TOML basic string and JSON both have to escape
  const tomlCmd = /^command = (".*")$/m.exec(cx[1].text)?.[1];
  ok(`${plat}: the TOML command string round-trips to the real path`,
     tomlCmd && JSON.parse(tomlCmd) === exe, `${tomlCmd} -> ${tomlCmd ? JSON.parse(tomlCmd) : '?'}`);
  for (const id of ['cursor', 'claude-desktop', 'gemini', 'windsurf']) {
    const j = JSON.parse(byClient[id][0].text);
    ok(`${plat}: ${id} JSON has the binary and ["--mcp"]`,
       j.mcpServers.e57view.command === exe && JSON.stringify(j.mcpServers.e57view.args) === '["--mcp"]',
       JSON.stringify(j.mcpServers.e57view));
  }
  ok(`${plat}: no download step, because there is nothing to download`,
     Object.values(byClient).every(b => !b.some(x => /curl/.test(x.text))), '');
}
// the shell form has to survive a path with a space in it
const spaced = await p.evaluate(() =>
  window.__app.mcpBlocks('claude-code', window.__app.mcpDesktopTarget('/Users/a b/e57view'))[0].text);
ok('a path with a space is quoted for the shell', spaced.includes('"/Users/a b/e57view"'), spaced);

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
await br.close();
process.exit(fails === 0 ? 0 : 1);
