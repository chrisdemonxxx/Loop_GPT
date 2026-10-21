import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dataLocTagger } from './plugins/dataLocTagger';

// Only variables prefixed with VITE_ are exposed to the browser bundle. This is
// the allowlist that keeps server secrets out of client code: anything without
// the prefix is invisible to the frontend by construction.
export default defineConfig({
  plugins: [react(), dataLocTagger()],
  envPrefix: 'VITE_',
  build: {
    outDir: 'dist/client',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
