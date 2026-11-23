import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // MUST stay. In this npm workspace another package can pin a different exact
    // React version, which npm hoists to the root while ours nests under
    // apps/web/node_modules. Dependencies resolving to the hoisted copy then run a
    // SECOND React instance, whose hook dispatcher is null — the app renders
    // nothing at all and the only symptom is "Cannot read properties of null
    // (reading 'useContext')" from minified code. dedupe forces one copy.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    // Keep the web development server separate from the production daemon on 4318.
    port: 8082,
    // Reachable over the tailnet so the phone can hit the dev server directly.
    host: true,
  },
  build: {
    // The daemon serves this directory (docs/architecture.md).
    outDir: 'dist',
    sourcemap: true,
  },
});
