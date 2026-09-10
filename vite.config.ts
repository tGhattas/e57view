import { defineConfig } from 'vite';
export default defineConfig({
  server: { port: 5180, host: '127.0.0.1' },
  worker: { format: 'es' },
  assetsInclude: ['**/*.wasm'],
});
