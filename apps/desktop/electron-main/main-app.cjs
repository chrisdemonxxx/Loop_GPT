'use strict'

/**
 * main-app: the post-ready remainder (sand's main-app.cjs stage) —
 *  - the local gateway: serves the static export and proxies /api + /v1 to
 *    the backend over real HTTP (headers/bodies/SSE all work; the custom
 *    protocol approach delivered EMPTY headers and broke every authed call)
 *  - the shell window with the sandboxed preload
 *  - lifecycle: single instance, window-state persistence, external links
 *  - one-time session migration from the old loop:// origin
 */
const { app, BrowserWindow, ipcMain, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const core = require('./main-core.cjs')
const { startGateway } = require('./gateway.cjs')

const FALLBACK_PAGE = path.join(__dirname, '..', 'renderer', 'fallback.html')

// ── Single instance ───────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit()
  return
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) { win.isMinimized() ? win.restore() : win.show(); win.focus() }
})

// ── Session migration (loop:// → gateway origin) ──────────────────────────────

/** One-time: the app previously lived at loop://app; localStorage sessions
 *  do not cross origins, so scan the old origin's leveldb for the auth token
 *  and rebuild the user record from the JWT claims. Sand parity: the
 *  reference distribution also migrates session state across origins. */
function readLegacyLoopOriginAuth() {
  try {
    const leveldb = path.join(app.getPath('userData'), 'Local Storage', 'leveldb')
    if (!fs.existsSync(leveldb)) return null
    let token = null
    let user = null
    for (const file of fs.readdirSync(leveldb)) {
      const s = fs.readFileSync(path.join(leveldb, file)).toString('latin1')
      if (!token) {
        const i = s.indexOf('authToken')
        if (i >= 0) {
          const m = s.slice(i).match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)
          if (m) token = m[0]
        }
      }
      if (!user) {
        // The stored-user record (StoredUser JSON): recover the real
        // email/name/role, which the JWT claims may not carry.
        const u = s.match(/\{"id":"[^"]*","email":"[^"]*","name":"[^"]*"(?:,"role":"[^"]*")?\}/)
        if (u) user = u[0]
      }
      if (token && user) break
    }
    if (!token) return null
    if (!user) {
      const claims = JSON.parse(Buffer.from(
        token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64',
      ).toString())
      user = JSON.stringify({
        id: claims.id || '',
        email: claims.email || '',
        name: claims.name || '',
        role: claims.role || 'user',
      })
    }
    return { token, user }
  } catch {
    return null
  }
}

/** Inject a migrated session into the current origin after first load.
 *  Re-migrates the user record if it exists but lost its profile fields
 *  (email empty) — so the header, admin nav, and role UI stay correct. */
async function migrateSessionIfNeeded(win) {
  try {
    const state = await win.webContents.executeJavaScript(
      `(() => { try { return { token: localStorage.getItem('authToken'), user: localStorage.getItem('user') } } catch { return { token: null, user: null } } })()`,
    )
    const userObj = state?.user ? JSON.parse(state.user) : null
    const complete = state?.token && userObj?.email
    if (complete) return
    const legacy = readLegacyLoopOriginAuth()
    if (!legacy) return
    await win.webContents.executeJavaScript(
      `(() => { localStorage.setItem('authToken', ${JSON.stringify(legacy.token)}); localStorage.setItem('user', ${JSON.stringify(legacy.user)}); window.location.href = '/'; })()`,
    )
    console.log('[desktop] migrated loop:// session to the gateway origin')
  } catch (err) {
    console.error('[desktop] session migration skipped:', err.message)
  }
}

// ── Shell window ──────────────────────────────────────────────────────────────

async function createWindow(gatewayUrl) {
  const ws = core.loadWindowState()
  const win = new BrowserWindow({
    width: ws.width,
    height: ws.height,
    x: ws.x,
    y: ws.y,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#08080a',
    title: 'Loop GPT',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron-preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
    if (ws.maximized) win.maximize()
  })

  // Persist bounds (sand parity). Captured on close so drag/resize survives.
  win.on('close', () => {
    const bounds = win.getNormalBounds()
    core.saveWindowState({
      width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y,
      maximized: win.isMaximized(),
    })
  })

  // External http(s) links leave the shell (docs, OAuth providers);
  // everything else stays on the gateway origin (or the dev server).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(gatewayUrl)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const ok = url.startsWith(gatewayUrl) || url.startsWith('http://127.0.0.1') || (core.DEV_URL && url.startsWith(core.DEV_URL))
    if (!ok) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
    }
  })

  const start = core.DEV_URL || gatewayUrl
  await win.loadURL(start).catch((err) => console.error('[desktop] load failed:', err))
  await migrateSessionIfNeeded(win)

  // Smoke mode (CI gate): exit 0 the moment the first page renders. With
  // LOOP_SMOKE_API the gate also proves the /api proxy path end-to-end by
  // fetching /api/version from INSIDE the renderer.
  if (core.SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      console.log('SMOKE_OK')
      if (process.env.LOOP_SMOKE_API) {
        try {
          const probe = await win.webContents.executeJavaScript(`
            new Promise((resolve, reject) => {
              const t = setTimeout(() => reject(new Error('timeout')), 15000)
              fetch('/api/version')
                .then(async (r) => { clearTimeout(t); resolve(r.status + ' ' + (await r.text()).slice(0, 120)) })
                .catch((e) => { clearTimeout(t); reject(e) })
            })
          `)
          console.log('SMOKE_API_OK ' + String(probe).replace(/\s+/g, ' '))
        } catch (e) {
          console.log('SMOKE_API_FAIL ' + (e?.message || e))
          app.exit(3)
          return
        }
      }
      app.exit(0)
    })
  }
  return win
}

// ── OAuth popup bridge ────────────────────────────────────────────────────────

/**
 * Google/GitHub sign-in on the desktop: the OAuth flow runs on the REAL
 * site origin (Google's registered redirect URI), in a popup that navigates
 * freely. Once the site's post-login page stores the session in the popup's
 * localStorage, the bridge copies {token, user} into the main window and
 * closes the popup. Zero backend or Google-console changes.
 */
function openOAuthPopup(parentWin, startPath) {
  return new Promise((resolve) => {
    const base = new URL(core.API_BASE).origin
    const startUrl = base + startPath
    const popup = new BrowserWindow({
      width: 520,
      height: 760,
      parent: parentWin,
      show: true,
      autoHideMenuBar: true,
      backgroundColor: '#08080a',
      title: 'Sign in',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    popup.loadURL(startUrl)

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      resolve(result)
      if (!popup.isDestroyed()) popup.destroy()
    }

    // Poll the popup's session: the site's login page stores authToken+user
    // via setAuth on success. 5-minute cap.
    const startedAt = Date.now()
    const poll = setInterval(async () => {
      if (popup.isDestroyed()) { finish({ cancelled: true }); return }
      if (Date.now() - startedAt > 300_000) { finish({ cancelled: true }); return }
      try {
        const auth = await popup.webContents.executeJavaScript(
          `(() => { try { return { token: localStorage.getItem('authToken'), user: localStorage.getItem('user') } } catch { return { token: null, user: null } } })()`,
        )
        if (auth?.token) {
          await parentWin.webContents.executeJavaScript(
            `(() => { localStorage.setItem('authToken', ${JSON.stringify(auth.token)}); localStorage.setItem('user', ${JSON.stringify(auth.user ?? 'null')}); window.location.href = '/'; })()`,
          )
          finish({ ok: true })
        }
      } catch { /* page still navigating */ }
    }, 500)

    popup.on('closed', () => finish({ cancelled: true }))
  })
}

ipcMain.handle('oauth:start', async (event, startPath) => {
  const parentWin = BrowserWindow.fromWebContents(event.sender)
  if (!parentWin) return { cancelled: true }
  if (typeof startPath !== 'string' || !/^\/api\/auth\/oauth\/[\w-]+$/.test(startPath)) {
    return { error: 'invalid oauth path' }
  }
  return openOAuthPopup(parentWin, startPath)
})

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// Window controls from the preload bridge (sender-scoped: only its own window).
ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
ipcMain.on('window:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (w) w.isMaximized() ? w.unmaximize() : w.maximize()
})
ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

app.whenReady().then(async () => {
  // Gateway first: the window needs its origin before load.
  const gw = await startGateway({
    exportDir: core.EXPORT_DIR,
    apiBase: core.API_BASE,
    fallbackPage: FALLBACK_PAGE,
    log: (...a) => console.log('[gateway]', ...a),
  })
  if (!gw) {
    console.error('[desktop] gateway could not bind — cannot serve the app')
    app.exit(1)
    return
  }
  core.saveGatewayDescriptor(gw.port)
  const gatewayUrl = `http://127.0.0.1:${gw.port}`
  await createWindow(gatewayUrl)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(gatewayUrl)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})