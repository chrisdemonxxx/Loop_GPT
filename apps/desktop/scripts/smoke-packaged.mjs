#!/usr/bin/env node
/** Packaged-app smoke: spawns the built exe with LOOP_SMOKE + LOOP_SMOKE_API.
 *  GUI exes may not stream stdout on Windows, so the verdict is the EXIT CODE:
 *  0 = page loaded (+ /api proxy probe passed) · 3 = API probe failed ·
 *  anything else / timeout = boot failure. */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'release', 'win-unpacked')
const exe = path.join(APP, 'Loop GPT.exe')

const child = spawn(exe, ['.'], {
  cwd: APP,
  env: { ...process.env, LOOP_SMOKE: '1', LOOP_SMOKE_API: '1' },
  stdio: 'ignore',
})

const timeout = setTimeout(() => {
  console.error('[packaged-smoke] TIMED OUT (60s)')
  child.kill('SIGKILL')
  process.exit(1)
}, 60_000)

child.on('exit', (code) => {
  clearTimeout(timeout)
  if (code === 0) { console.log('[packaged-smoke] PASS (exit 0 — loaded + API proxy OK)'); process.exit(0) }
  if (code === 3) { console.error('[packaged-smoke] FAIL — API probe failed (exit 3)'); process.exit(1) }
  console.error(`[packaged-smoke] FAIL — exit ${code}`)
  process.exit(1)
})