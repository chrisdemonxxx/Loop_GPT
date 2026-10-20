/**
 * Start local backend with Railway-injected env, overriding path/port for local disk.
 * Usage (from backend/): railway run --service backend -- node scripts/start-local-railway.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(__dirname, '..')
const privateDir = path.join(backendRoot, '.local-private-store', 'files')
fs.mkdirSync(privateDir, { recursive: true })

process.env.PORT = process.env.LOCAL_PORT || '4000'
process.env.PRIVATE_FILES_DIR = privateDir.replace(/\\/g, '/')
process.env.NODE_ENV = process.env.NODE_ENV || 'development'

// railway.internal is only reachable inside Railway. Prefer the public TCP proxy
// when LOCAL_DATABASE_URL is set, or rewrite using RAILWAY_TCP_PROXY_* if present.
if (process.env.LOCAL_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.LOCAL_DATABASE_URL
} else if (
  process.env.DATABASE_URL?.includes('railway.internal') &&
  process.env.RAILWAY_TCP_PROXY_DOMAIN &&
  process.env.RAILWAY_TCP_PROXY_PORT
) {
  try {
    const u = new URL(process.env.DATABASE_URL)
    u.hostname = process.env.RAILWAY_TCP_PROXY_DOMAIN
    u.port = process.env.RAILWAY_TCP_PROXY_PORT
    process.env.DATABASE_URL = u.toString()
    console.log(`[start-local-railway] rewrote DATABASE_URL host → ${u.hostname}:${u.port}`)
  } catch (err) {
    console.warn('[start-local-railway] could not rewrite DATABASE_URL', err)
  }
}

console.log(`[start-local-railway] PORT=${process.env.PORT}`)
console.log(`[start-local-railway] PRIVATE_FILES_DIR=${process.env.PRIVATE_FILES_DIR}`)
console.log(`[start-local-railway] E2B_DESKTOP_TEMPLATE=${process.env.E2B_DESKTOP_TEMPLATE || '(unset)'}`)
console.log(`[start-local-railway] E2B_API_KEY=${process.env.E2B_API_KEY ? 'set' : 'MISSING'}`)
console.log(`[start-local-railway] DATABASE host=${(() => { try { return new URL(process.env.DATABASE_URL || '').host } catch { return '?' } })()}`)

const child = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: backendRoot,
  stdio: 'inherit',
  env: process.env,
  shell: true,
})
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
