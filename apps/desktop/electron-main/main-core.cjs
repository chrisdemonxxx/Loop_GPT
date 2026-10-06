'use strict'

/**
 * main-core: critical pre-ready init (sand's main-core.cjs stage).
 * Everything here MUST complete before the app becomes ready:
 *  - the runtime config resolution (export dir, API base, dev URL, port)
 *  - the window-state store (userData/window-state.json, sand parity)
 *  - the gateway descriptor store (userData/gateway.json, sand parity:
 *    the reference distribution keeps a gateway descriptor in userData too)
 *
 * Exports `ready` (the boot gate) and `noteStartupFailed` for the loader.
 */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// ── Runtime config ───────────────────────────────────────────────────────────

/** Packaged: the static export ships as an extraResource next to the exe.
 *  Repo: apps/web/out (built by `npm run build -w apps/web`). */
const EXPORT_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'renderer-export')
  : path.resolve(__dirname, '..', '..', 'web', 'out')

/** The backend origin the gateway proxies /api + /v1 to (the nginx role).
 *  Override with LOOP_API_URL for local backends. */
const API_BASE = (process.env.LOOP_API_URL || 'https://loop-gpt.cyou').replace(/\/+$/, '')

/** Dev mode: load the Next dev server instead of the static export. */
const DEV_URL = process.env.LOOP_DEV_URL || null

/** Smoke mode: exit 0 with a marker after the first page load (CI gate). */
const SMOKE = !!process.env.LOOP_SMOKE

// ── Window state (sand parity: userData/window-state.json) ────────────────────

const STATE_FILE = 'window-state.json'

function statePath() {
  return path.join(app.getPath('userData'), STATE_FILE)
}

function loadWindowState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8')
    const s = JSON.parse(raw)
    return {
      width: Number.isFinite(s.width) ? s.width : 1440,
      height: Number.isFinite(s.height) ? s.height : 900,
      x: Number.isFinite(s.x) ? s.x : undefined,
      y: Number.isFinite(s.y) ? s.y : undefined,
      maximized: !!s.maximized,
    }
  } catch {
    return { width: 1440, height: 900, x: undefined, y: undefined, maximized: false }
  }
}

function saveWindowState(state) {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify(state))
  } catch { /* private mode / read-only FS: non-fatal */ }
}

// ── Gateway descriptor (sand parity: userData/gateway.json) ───────────────────

const GATEWAY_FILE = 'gateway.json'

function gatewayDescriptorPath() {
  return path.join(app.getPath('userData'), GATEWAY_FILE)
}

function saveGatewayDescriptor(port) {
  try {
    fs.mkdirSync(path.dirname(gatewayDescriptorPath()), { recursive: true })
    fs.writeFileSync(gatewayDescriptorPath(), JSON.stringify({ port, startedAt: new Date().toISOString() }))
  } catch { /* non-fatal */ }
}

function loadGatewayDescriptor() {
  try {
    return JSON.parse(fs.readFileSync(gatewayDescriptorPath(), 'utf8'))
  } catch {
    return null
  }
}

// ── Boot gate ─────────────────────────────────────────────────────────────────

// Today the core stage is synchronous; the promise keeps the staged contract
// so future async pre-ready work (app lock, crash reporting bootstrap) slots
// in without touching the loader.
const ready = Promise.resolve()

function noteStartupFailed(err) {
  // Startup must never die silently in a GUI process — the marker line is the
  // CI contract (scripts/smoke.mjs) and console.error feeds the terminal.
  console.error('[desktop] startup failed:', err)
  process.exitCode = 1
  app.quit()
}

module.exports = {
  EXPORT_DIR, API_BASE, DEV_URL, SMOKE,
  loadWindowState, saveWindowState,
  saveGatewayDescriptor, loadGatewayDescriptor,
  ready, noteStartupFailed,
}