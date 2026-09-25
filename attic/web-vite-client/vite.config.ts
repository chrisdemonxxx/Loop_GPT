import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { shellPwa } from './build/pwa.ts'
import { apiOrigin } from './src/security.ts'

export default defineConfig(({ mode }) => {
  // Read only this new web application's explicit public/proxy configuration.
  const env = loadEnv(mode, process.cwd(), ['VITE_API_ORIGIN', 'WEB_DEV_API_ORIGIN'])
  const target = apiOrigin(env.WEB_DEV_API_ORIGIN || 'http://127.0.0.1:3001')
  apiOrigin(env.VITE_API_ORIGIN ?? '')
  return {
    plugins: [react(), shellPwa()],
    base: '/',
    server: { port: 5173, strictPort: true, proxy: { '/api': { target, changeOrigin: true } } },
    preview: { port: 4173, strictPort: true, proxy: { '/api': { target, changeOrigin: true } } },
    build: { sourcemap: false },
  }
})
