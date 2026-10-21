import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { dataLocTagger } from './plugins/dataLocTagger';

// Only VITE_-prefixed vars reach the browser bundle.
export default defineConfig({
  plugins: [react(), tailwindcss(), dataLocTagger()],
  envPrefix: 'VITE_',
  server: {
    port: 5173,
    host: true,
  },
});
