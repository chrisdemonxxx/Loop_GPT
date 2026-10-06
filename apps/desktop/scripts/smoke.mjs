#!/usr/bin/env node
/**
 * Desktop shell smoke gate: launches the packaged-path Electron app against
 * the static export, asserts the first page load completes (the main process
 * logs SMOKE_OK and exits 0), and fails loudly otherwise.
 *
 * Requires apps/web/out (run `npm run build -w apps/web` first).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')

const exportIndex = path.resolve(APP, '..', 'web', 'out', 'index.html')
if (!existsSync(exportIndex)) {
  console.error('[smoke] apps/web/out/index.html missing — run `npm run build -w apps/web` first')
  process.exit(1)
}

// Hoisting-proof binary resolution: require('electron') from node resolves to
// the absolute path of the downloaded electron executable.
const requireFromApp = createRequire(path.join(APP, 'package.json'))
let electronBinary
try {
  electronBinary = requireFromApp('electron')
} catch {
  console.error('[smoke] electron binary not found — run `npm install` first')
  process.exit(1)
}
if (!existsSync(electronBinary)) {
  console.error(`[smoke] electron binary missing at ${electronBinary} — run its install script`)
  process.exit(1)
}

const child = spawn(electronBinary, ['.', '--smoke'], {
  cwd: APP,
  env: { ...process.env, LOOP_SMOKE: '1', LOOP_SMOKE_API: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let out = ''
const timeout = setTimeout(() => {
  console.error('[smoke] TIMED OUT (60s) — the window never finished loading')
  child.kill('SIGKILL')
  process.exit(1)
}, 60_000)

child.stdout.on('data', (d) => { out += d; process.stdout.write(d) })
child.stderr.on('data', (d) => { out += d; process.stderr.write(d) })

child.on('exit', (code) => {
  clearTimeout(timeout)
  if (code === 0 && out.includes('SMOKE_OK')) {
    console.log('[smoke] PASS — shell booted, protocol served, page loaded')
    process.exit(0)
  }
  console.error(`[smoke] FAIL — exit ${code}`)
  process.exit(1)
})