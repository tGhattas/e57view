import { defineConfig, type Plugin } from 'vite';

/** The desktop build must not reach the network at all.
 *
 *  Everything that would is in index.html rather than the module graph — the analytics tag
 *  and the Google Fonts stylesheet — so it is taken out here rather than guarded at runtime:
 *  a guard still ships the code, and "no network" should be true of the bytes, not only of
 *  the behaviour. The font stacks already name system-ui and ui-monospace as their fallbacks,
 *  so dropping the stylesheet costs the typeface and nothing else. */
const SESSION_STUB = '\0e57view-no-session';

function offline(): Plugin {
  return {
    name: 'e57view-offline',
    // before vite's own resolver, or './session' is already an absolute path by the time we see it
    enforce: 'pre',
    /** The cloud agent relay is Firebase, and Firebase is half a megabyte of network client.
     *  main.ts only ever reaches it through a guarded dynamic import, so nothing calls it in
     *  the desktop build — but a guarded import still emits the chunk, and an offline app
     *  should not ship a Firestore client at all. Resolve it to a stub that says why. */
    resolveId(id) {
      if (id === './session' || id === './session.ts') return SESSION_STUB;
      return null;
    },
    load(id) {
      if (id !== SESSION_STUB) return null;
      const no = `() => { throw new Error('The hosted agent session is a web-build feature. This app serves MCP itself, with no network: see the Agent panel.'); }`;
      return [
        `export const ensureAuth = ${no};`,
        `export const createAgentSession = ${no};`,
        `export const setAgentEdits = async () => {};`,
        `export const stopAgentSession = async () => {};`,
        `export const watchAgentSession = () => () => {};`,
      ].join('\n');
    },
    transformIndexHtml(html) {
      return html
        .replace(/<script>\s*\(function \(\) \{[\s\S]*?googletagmanager[\s\S]*?\}\)\(\);\s*<\/script>\s*/m, '')
        .replace(/<link rel="preconnect" href="https:\/\/fonts[^>]*>\s*/g, '')
        .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\s*/g, '')
        // the web-only install snippet names a URL this build never fetches; a string is
        // still a claim, and "no network" should be true of the bytes
        .replace(/<pre class="snip web-only" id="v-mcp">[\s\S]*?<\/pre>/,
                 '<pre class="snip web-only" id="v-mcp"></pre>')
        .replace('<title>e57view</title>', '<title>e57view</title>\n<meta name="e57view-build" content="desktop">');
    },
  };
}

export default defineConfig(({ mode }) => {
  const desktop = mode === 'desktop';
  return {
    server: { port: 5180, host: '127.0.0.1', strictPort: false },
    worker: { format: 'es' },
    assetsInclude: ['**/*.wasm'],
    define: { __DESKTOP__: JSON.stringify(desktop) },
    plugins: desktop ? [offline()] : [],
    build: { outDir: desktop ? 'dist-desktop' : 'dist', emptyOutDir: true },
  };
});
