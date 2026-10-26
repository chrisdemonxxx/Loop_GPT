import { redactPayload } from './redact.js'
import { blockedReason, isOnion } from './protocol.js'

const APP_ORIGINS = ['http://localhost:3000', 'https://loop-gpt.cyou']
const OCTO_LOCAL_ORIGIN = 'http://127.0.0.1:58888'

export function startBridge(driver, pkg) {
  const status = {
    paired: false,
    pairedElsewhere: false,
    deviceId: null,
    error: '',
  }
  let socket = null

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false
    if (message.type === 'status') {
      sendResponse(status)
      return false
    }
    if (message.type === 'pair') {
      pair(message).then((result) => sendResponse(result)).catch((error) => sendResponse({ ok: false, error: error.message }))
      return true
    }
    if (message.type === 'disconnect') {
      try { socket?.close() } catch { /* gone */ }
      status.paired = false
      sendResponse({ ok: true })
      return false
    }
    return false
  })

  chrome.storage.local.get(['deviceToken', 'apiOrigin', 'pairedElsewhere']).then((stored) => {
    if (stored.pairedElsewhere) {
      status.pairedElsewhere = true
      return
    }
    if (stored.deviceToken && stored.apiOrigin) connect(stored.apiOrigin, { deviceToken: stored.deviceToken })
  }).catch(() => {})

  async function pair(message) {
    if (status.pairedElsewhere) return { ok: false, error: 'paired_elsewhere' }
    const code = String(message.code || '').trim()
    const apiOrigin = String(message.apiOrigin || 'http://localhost:3001').replace(/\/$/, '')
    if (!code) return { ok: false, error: 'Enter the pair code from Settings → Connectors.' }
    await chrome.storage.local.set({
      apiOrigin,
      profileLabel: String(message.profileLabel || '').slice(0, 80),
    })
    await connect(apiOrigin, { code })
    return { ok: status.paired, error: status.error, pairedElsewhere: status.pairedElsewhere }
  }

  function connect(apiOrigin, query) {
    return new Promise((resolve) => {
      try { socket?.close() } catch { /* gone */ }
      const url = new URL(apiOrigin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.pathname = '/api/browser/pair'
      url.search = ''
      if (query.code) url.searchParams.set('code', query.code)
      if (query.deviceToken) url.searchParams.set('deviceToken', query.deviceToken)
      const next = new WebSocket(url.toString())
      socket = next
      const failTimer = setTimeout(() => {
        status.error = 'The pair socket did not answer.'
        try { next.close() } catch { /* gone */ }
        resolve()
      }, 12_000)
      next.addEventListener('open', async () => {
        const stored = await chrome.storage.local.get(['installId', 'profileLabel'])
        let installId = stored.installId
        if (!installId) {
          installId = `inst_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
          await chrome.storage.local.set({ installId })
        }
        const manifest = chrome.runtime.getManifest()
        const octoProbe = pkg.family === 'chromium' ? await probeOctoLocal() : { reachable: false }
        next.send(JSON.stringify({
          type: 'hello',
          installId,
          family: pkg.family,
          packageKind: pkg.packageKind,
          browserName: detectedBrowserName(pkg),
          profileLabel: stored.profileLabel || '',
          packageVersion: manifest.version || pkg.version,
          octoLocalAvailable: Boolean(octoProbe.reachable),
        }))
      })
      next.addEventListener('message', async (event) => {
        let message
        try { message = JSON.parse(event.data) } catch { return }
        if (message.type === 'paired') {
          clearTimeout(failTimer)
          status.paired = true
          status.pairedElsewhere = false
          status.deviceId = message.deviceId
          status.error = ''
          if (message.deviceToken) await chrome.storage.local.set({ deviceToken: message.deviceToken, pairedElsewhere: false })
          resolve()
          return
        }
        if (message.type === 'error') {
          clearTimeout(failTimer)
          status.paired = false
          status.error = String(message.error || 'pair failed')
          status.pairedElsewhere = message.error === 'paired_elsewhere'
          if (status.pairedElsewhere) await chrome.storage.local.set({ pairedElsewhere: true, deviceToken: '' })
          resolve()
          return
        }
        if (message.type === 'call') {
          const result = await runCall(message)
          if (next.readyState === WebSocket.OPEN) {
            const safe = redactPayload(result)
            next.send(JSON.stringify({ type: 'result', id: message.id, ...safe, result: safe }))
          }
          return
        }
        if (message.type === 'end_run') {
          await driver.endRun({ closeTabs: message.closeTabs === true, runId: message.runId })
        }
      })
      next.addEventListener('close', () => {
        clearTimeout(failTimer)
        if (socket === next) {
          status.paired = false
          socket = null
        }
        resolve()
      })
      next.addEventListener('error', () => {
        status.error = status.error || 'Could not reach Loop.'
      })
    })
  }

  async function runCall(message) {
    const tool = String(message.tool || '')
    const args = message.args || {}
    try {
      if (tool === 'octo_local_status') return probeOctoLocal()
      if (tool === 'octo_local_start') return startOctoProfileLocal(args)
      if (tool === 'octo_local_stop') return stopOctoProfileLocal(args)

      if ((tool === 'browser_navigate' || (tool === 'browser_tabs' && args.action === 'new')) && args.url) {
        const url = String(args.url || '')
        const blocked = blockedReason(url, APP_ORIGINS)
        if (blocked) {
          const delta = driver.takeDelta()
          return { ok: false, error: blocked, delta, console: delta.console, network: delta.network }
        }
        if (isOnion(url) && pkg.family !== 'tor') {
          const delta = driver.takeDelta()
          return { ok: false, error: 'An .onion address is only opened in a paired Tor Browser window.', delta, console: delta.console, network: delta.network }
        }
      }
      const outcome = await dispatch(driver, tool, args, pkg)
      const delta = driver.takeDelta()
      return { ...outcome, delta, console: delta.console, network: delta.network }
    } catch (error) {
      const delta = driver.takeDelta()
      return { ok: false, error: error instanceof Error ? error.message : 'The browser action failed.', delta, console: delta.console, network: delta.network }
    }
  }
}

async function probeOctoLocal() {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 1500)
    const res = await fetch(`${OCTO_LOCAL_ORIGIN}/api/profiles/active`, { method: 'GET', signal: ctrl.signal }).finally(() => clearTimeout(timer))
    const body = await res.json().catch(() => ({}))
    return {
      ok: true,
      reachable: res.status >= 200 && res.status < 500,
      activeProfiles: Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [],
    }
  } catch {
    return { ok: true, reachable: false, activeProfiles: [] }
  }
}

async function startOctoProfileLocal(args) {
  const uuid = String(args?.uuid || '').trim()
  if (!uuid) return { ok: false, error: 'Missing Octo profile uuid.' }
  try {
    const res = await fetch(`${OCTO_LOCAL_ORIGIN}/api/profiles/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uuid, headless: false, debug_port: true }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: body?.msg || body?.error || `Octo local start returned ${res.status}` }
    return {
      ok: true,
      uuid,
      wsEndpoint: body?.ws_endpoint || body?.data?.ws_endpoint || '',
      debugPort: body?.debug_port || body?.data?.debug_port || null,
      state: body?.state || 'STARTED',
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Octo desktop app is not reachable on 127.0.0.1:58888.' }
  }
}

async function stopOctoProfileLocal(args) {
  const uuid = String(args?.uuid || '').trim()
  if (!uuid) return { ok: false, error: 'Missing Octo profile uuid.' }
  try {
    const res = await fetch(`${OCTO_LOCAL_ORIGIN}/api/profiles/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uuid }),
    })
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok, uuid, state: body?.state || 'STOPPED' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Octo desktop app is not reachable on 127.0.0.1:58888.' }
  }
}

function detectedBrowserName(pkg) {
  if (pkg.family === 'tor') return 'Tor Browser'
  if (pkg.family === 'firefox') return 'Firefox'
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Vivaldi/.test(ua)) return 'Vivaldi'
  return pkg.browserName || 'Chrome'
}

async function dispatch(driver, tool, args, pkg) {
  switch (tool) {
    case 'browser_navigate': return driver.navigate(String(args.url || ''))
    case 'browser_snapshot': return driver.snapshot()
    case 'browser_screenshot': return driver.screenshot()
    case 'browser_click': return driver.click(args)
    case 'browser_type': return driver.type(args)
    case 'browser_key': return driver.key(args)
    case 'browser_inject_captcha': return driver.injectCaptcha ? driver.injectCaptcha(args) : { ok: false, error: 'Captcha injection unsupported.' }
    case 'browser_scroll': return driver.scroll(args)
    case 'browser_tabs': return driver.tabs(args)
    case 'browser_wait': return driver.wait(args, pkg)
    case 'browser_console': return driver.consolePage(args.page, args.pageSize)
    case 'browser_network': return driver.networkPage(args.page, args.pageSize)
    default: return { ok: false, error: `Unknown browser tool ${tool}` }
  }
}
