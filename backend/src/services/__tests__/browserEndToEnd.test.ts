import http from 'http'
import express from 'express'
import { WebSocket } from 'ws'
import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import browserRouter from '../../routes/browser'
import {
  attachBrowserSocket,
  armBrowserRun,
  createBrowserGrant,
  createPairCode,
  endBrowserRun,
  getOctoConnectionStatus,
  invokeBrowserTool,
  listDevices,
  resetBrowserBridgeForTests,
  startOctoProfileOnMachine,
} from '../browserBridge'
import {
  getUserCaptchaSettings,
  resetCaptchaSettingsForTests,
  setUserCaptchaSettings,
} from '../captchaSolver'
import { configStore } from '../../agent/configStore'
import { connectorRegistry } from '../../agent/connectors/connectorRegistry'
import { browserToolDefinitions } from '../../agent/tools/browserTools'
// @ts-ignore — ESM extension modules
import { createBuffers } from '../../../../packages/browser-extension/src/buffers.js'
// @ts-ignore — ESM extension modules
import { blockedReason, isOnion, isRiskyIntent, looksSensitive } from '../../../../packages/browser-extension/src/protocol.js'

vi.mock('../../routes/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const uid = req.headers['x-test-user']
    if (!uid) return res.status(401).json({ error: 'Authentication required.' })
    req.userId = String(uid)
    next()
  },
}))

describe('Browser Agent End-to-End Integration', () => {
  let server: http.Server
  let baseUrl: string
  let wsUrl: string

  beforeEach(async () => {
    process.env.BROWSER_BRIDGE_SECRET = 'test-bridge-secret-12345'
    resetBrowserBridgeForTests()
    resetCaptchaSettingsForTests()
    configStore.saveConnectors('user-captcha', [])
    configStore.saveConnectors('user-tor', [])
    configStore.saveConnectors('user-octo', [])

    const app = express()
    app.use(express.json())
    app.use('/api/browser', browserRouter)
    server = http.createServer(app)
    attachBrowserSocket(server)

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
    wsUrl = `ws://127.0.0.1:${addr.port}/api/browser/pair`
  })

  afterEach(async () => {
    resetBrowserBridgeForTests()
    resetCaptchaSettingsForTests()
    configStore.saveConnectors('user-captcha', [])
    configStore.saveConnectors('user-tor', [])
    configStore.saveConnectors('user-octo', [])
    vi.restoreAllMocks()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function pairMockExtension(opts: {
    userId: string
    installId: string
    family?: 'chromium' | 'firefox' | 'tor'
    browserName?: string
    profileLabel?: string
    packageVersion?: string
    octoLocalAvailable?: boolean
    onCall?: (msg: { id: string; tool: string; args: Record<string, unknown> }) => Record<string, unknown> | Promise<Record<string, unknown>>
    onEndRun?: (msg: { runId: string; closeTabs: boolean }) => void
  }): Promise<{ deviceId: string; deviceToken: string; ws: WebSocket }> {
    const { code } = createPairCode(opts.userId)
    const ws = new WebSocket(`${wsUrl}?code=${encodeURIComponent(code)}`)

    return new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          installId: opts.installId,
          family: opts.family || 'chromium',
          packageKind: opts.family || 'chromium',
          browserName: opts.browserName || 'Chrome',
          profileLabel: opts.profileLabel || 'Personal',
          packageVersion: opts.packageVersion || '1.0.0',
          octoLocalAvailable: opts.octoLocalAvailable ?? true,
        }))
      })
      ws.on('message', async (raw) => {
        const msg = JSON.parse(String(raw))
        if (msg.type === 'paired') {
          resolve({ deviceId: msg.deviceId, deviceToken: msg.deviceToken, ws })
          return
        }
        if (msg.type === 'error') {
          reject(new Error(msg.error))
          return
        }
        if (msg.type === 'call' && opts.onCall) {
          const result = await opts.onCall(msg)
          // Match real session.js envelope shape: { type: 'result', id, result }
          ws.send(JSON.stringify({ type: 'result', id: msg.id, result }))
        }
        if (msg.type === 'end_run' && opts.onEndRun) {
          opts.onEndRun(msg)
        }
      })
      ws.on('error', reject)
    })
  }

  it('pairs over WebSocket, unwraps nested extension results, and captures console & network deltas', async () => {
    const { deviceId } = await pairMockExtension({
      userId: 'user-1',
      installId: 'inst_chromium_001',
      onCall: ({ tool, args }) => {
        if (tool === 'browser_navigate') {
          return {
            ok: true,
            url: args.url,
            title: 'Dashboard',
            summary: 'Opened Dashboard',
            delta: {
              console: [{ level: 'error', text: 'Uncaught ReferenceError: foo is not defined' }],
              network: [{ method: 'GET', url: 'https://example.com/api/me', status: 200 }],
              consoleTruncated: 3,
              networkTruncated: 0,
            },
          }
        }
        return { ok: true, summary: 'ok' }
      },
    })

    const devices = await listDevices('user-1')
    expect(devices).toHaveLength(1)
    expect(devices[0].id).toBe(deviceId)
    expect(devices[0].online).toBe(true)
    expect(devices[0].versionSkew).toBe(false)

    // Unarmed run is strictly refused
    const unarmed = await invokeBrowserTool({
      userId: 'user-1',
      deviceId,
      runId: 'run-unarmed',
      source: 'chat',
      tool: 'browser_navigate',
      args: { url: 'https://example.com' },
    })
    expect(unarmed.isError).toBe(true)
    expect(unarmed.content).toMatch(/not authorized/i)

    // Armed run succeeds and unwraps message.result + delta
    armBrowserRun({ runId: 'run-1', userId: 'user-1', deviceId, source: 'chat' })
    const res = await invokeBrowserTool({
      userId: 'user-1',
      deviceId,
      runId: 'run-1',
      source: 'chat',
      tool: 'browser_navigate',
      args: { url: 'https://example.com' },
    })
    expect(res.isError).toBeUndefined()
    expect(res.content).toContain('Opened Dashboard')
    expect(res.content).toContain('[Console: 1 line(s) (+3 more, call browser_console)]')
    expect(res.content).toContain('[Network: 1 request(s)]')
  })

  it('rejects pairing an already-owned installId to a different user with paired_elsewhere', async () => {
    await pairMockExtension({
      userId: 'user-owner',
      installId: 'inst_shared_999',
    })

    await expect(
      pairMockExtension({
        userId: 'user-intruder',
        installId: 'inst_shared_999',
      }),
    ).rejects.toThrow('paired_elsewhere')
  })

  it('enforces single-use / bound BrowserGrant on POST /api/browser/invoke for Build runs', async () => {
    const { deviceId } = await pairMockExtension({
      userId: 'user-build',
      installId: 'inst_build_001',
      onCall: () => ({ ok: true, title: 'Build App', snapshot: 'button: Submit', summary: 'Build App' }),
    })

    // 1. Call without grant or armed run -> 403
    const deniedResp = await fetch(`${baseUrl}/api/browser/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-loop-browser-bridge': 'test-bridge-secret-12345',
      },
      body: JSON.stringify({
        userId: 'user-build',
        deviceId,
        runId: 'run_unarmed_99',
        tool: 'browser_snapshot',
        args: {},
      }),
    })
    expect(deniedResp.status).toBe(403)

    // 2. Issue grant via POST /api/browser/grants
    const grantResp = await fetch(`${baseUrl}/api/browser/grants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': 'user-build',
      },
      body: JSON.stringify({ deviceId, source: 'build' }),
    })
    expect(grantResp.status).toBe(200)
    const { grantId } = await grantResp.json()
    expect(grantId).toMatch(/^bgr_/)

    // 3. Invoke with grantId arms the run and executes
    const okResp = await fetch(`${baseUrl}/api/browser/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-loop-browser-bridge': 'test-bridge-secret-12345',
      },
      body: JSON.stringify({
        grantId,
        userId: 'user-build',
        deviceId,
        runId: 'run_armed_1',
        tool: 'browser_snapshot',
        args: {},
      }),
    })
    expect(okResp.status).toBe(200)
    const body = await okResp.json()
    expect(body.content).toContain('Page: Build App')
    expect(body.content).toContain('button: Submit')

    // 4. Attempting to reuse the same grantId for a DIFFERENT runId is rejected
    const reuseResp = await fetch(`${baseUrl}/api/browser/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-loop-browser-bridge': 'test-bridge-secret-12345',
      },
      body: JSON.stringify({
        grantId,
        userId: 'user-build',
        deviceId,
        runId: 'run_hijack_2',
        tool: 'browser_snapshot',
        args: {},
      }),
    })
    expect(reuseResp.status).toBe(403)
  })

  it('handles captcha in wait mode (with solverKeyState) and automatically solves & injects in solver mode', async () => {
    let injectedToken = ''
    const { deviceId } = await pairMockExtension({
      userId: 'user-captcha',
      installId: 'inst_captcha_01',
      onCall: ({ tool, args }) => {
        if (tool === 'browser_navigate') {
          return {
            ok: true,
            needsYou: {
              reason: 'captcha',
              message: 'Continue in your browser',
              captchaInfo: {
                type: 'recaptcha_v2',
                sitekey: '6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-',
                pageUrl: 'https://example.com/challenge',
              },
            },
            captchaInfo: {
              type: 'recaptcha_v2',
              sitekey: '6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-',
              pageUrl: 'https://example.com/challenge',
            },
            url: 'https://example.com/challenge',
            title: 'Security Check',
          }
        }
        if (tool === 'browser_inject_captcha') {
          injectedToken = String(args.token || '')
          return {
            ok: true,
            url: 'https://example.com/unlocked',
            title: 'Unlocked Page',
            snapshot: 'h1: Welcome',
            summary: 'Unlocked Page',
          }
        }
        return { ok: true }
      },
    })

    configStore.saveConnectors('user-captcha', [])
    setUserCaptchaSettings('user-captcha', { captchaHandling: 'wait', dailyCap: 10 })
    armBrowserRun({ runId: 'run-cap-1', userId: 'user-captcha', deviceId, source: 'chat' })

    // Default mode is 'wait', solver key not configured
    const waitRes = await invokeBrowserTool({
      userId: 'user-captcha',
      deviceId,
      runId: 'run-cap-1',
      source: 'chat',
      tool: 'browser_navigate',
      args: { url: 'https://example.com/challenge' },
    })
    expect(waitRes.data?.needsYou).toBe(true)
    expect(waitRes.data?.solverKeyState).toBe('Not configured')
    expect(waitRes.content).toContain('Captcha solver: Not configured')

    // Configure BYOK solver connector and switch user to 'solver' mode
    configStore.saveConnectors('user-captcha', [
      {
        id: 'conn_cap',
        type: 'captcha_solver',
        name: '2Captcha',
        enabled: true,
        config: { provider: '2captcha', apiKey: 'test-2captcha-key' },
        lastTestOk: true,
        lastTestMessage: 'Connected',
        ownerId: 'user-captcha',
      },
    ])
    setUserCaptchaSettings('user-captcha', { captchaHandling: 'solver', dailyCap: 10 })

    // Mock 2captcha adapter solve
    const { twoCaptchaAdapter } = await import('../captchaSolver')
    vi.spyOn(twoCaptchaAdapter, 'solve').mockResolvedValue({ token: 'SOLVED_RECAPTCHA_TOKEN_XYZ' })

    const solvedRes = await invokeBrowserTool({
      userId: 'user-captcha',
      deviceId,
      runId: 'run-cap-1',
      source: 'chat',
      tool: 'browser_navigate',
      args: { url: 'https://example.com/challenge' },
    })
    expect(injectedToken).toBe('SOLVED_RECAPTCHA_TOKEN_XYZ')
    expect(solvedRes.data?.needsYou).toBeUndefined()
    expect(solvedRes.data?.captchaSolved).toBe(true)
    expect(solvedRes.content).toContain('Unlocked Page')
    expect(getUserCaptchaSettings('user-captcha').solvesToday).toBe(1)
  })

  it('strictly blocks third-party captcha solvers on Tor Browser devices (.onion protection)', async () => {
    let solverCalled = false
    const { twoCaptchaAdapter } = await import('../captchaSolver')
    vi.spyOn(twoCaptchaAdapter, 'solve').mockImplementation(async () => {
      solverCalled = true
      return { token: 'SHOULD_NEVER_HAPPEN' }
    })

    configStore.saveConnectors('user-tor', [
      {
        id: 'conn_cap_tor',
        type: 'captcha_solver',
        name: '2Captcha',
        enabled: true,
        config: { provider: '2captcha', apiKey: 'test-key' },
        lastTestOk: true,
        ownerId: 'user-tor',
      },
    ])
    setUserCaptchaSettings('user-tor', { captchaHandling: 'solver' })

    const { deviceId } = await pairMockExtension({
      userId: 'user-tor',
      installId: 'inst_tor_001',
      family: 'tor',
      browserName: 'Tor Browser',
      onCall: () => ({
        ok: true,
        needsYou: {
          reason: 'captcha',
          message: 'Continue in your browser',
          captchaInfo: {
            type: 'hcaptcha',
            sitekey: 'sitekey-onion',
            pageUrl: 'http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/',
          },
        },
      }),
    })

    armBrowserRun({ runId: 'run-tor-1', userId: 'user-tor', deviceId, source: 'chat' })
    const res = await invokeBrowserTool({
      userId: 'user-tor',
      deviceId,
      runId: 'run-tor-1',
      source: 'chat',
      tool: 'browser_navigate',
      args: { url: 'http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/' },
    })

    expect(solverCalled).toBe(false)
    expect(res.data?.needsYou).toBe(true)
  })

  it('tracks Octo profile lifecycle: stops only profiles started by Loop and leaves pre-running profiles open', async () => {
    const stoppedProfiles: string[] = []
    const { deviceId } = await pairMockExtension({
      userId: 'user-octo',
      installId: 'inst_octo_relay',
      family: 'chromium',
      octoLocalAvailable: true,
      onCall: ({ tool, args }) => {
        if (tool === 'octo_local_status') {
          return {
            ok: true,
            reachable: true,
            activeProfiles: [{ uuid: 'prof-already-open' }],
          }
        }
        if (tool === 'octo_local_start') {
          return {
            ok: true,
            uuid: args.uuid,
            wsEndpoint: 'ws://127.0.0.1:54321/devtools/browser/abc',
          }
        }
        if (tool === 'octo_local_stop') {
          stoppedProfiles.push(String(args.uuid))
          return { ok: true, uuid: args.uuid }
        }
        return { ok: true }
      },
    })

    configStore.saveConnectors('user-octo', [
      {
        id: 'octo_1',
        type: 'octo',
        name: 'Octo Browser',
        enabled: true,
        config: { token: 'octo-cloud-secret' },
        lastTestOk: true,
        ownerId: 'user-octo',
      },
    ])

    const status = await getOctoConnectionStatus('user-octo')
    expect(status.status).toBe('Connected')
    expect(status.localClientReachable).toBe(true)
    expect(status.activeProfileIds).toContain('prof-already-open')

    armBrowserRun({ runId: 'run-octo-1', userId: 'user-octo', deviceId, source: 'chat' })

    // Starting an already-open profile -> startedByLoop: false
    const reuse = await startOctoProfileOnMachine('user-octo', 'prof-already-open', 'run-octo-1')
    expect(reuse.ok).toBe(true)
    expect(reuse.startedByLoop).toBe(false)

    // Starting a closed profile -> startedByLoop: true
    const fresh = await startOctoProfileOnMachine('user-octo', 'prof-started-by-loop', 'run-octo-1')
    expect(fresh.ok).toBe(true)
    expect(fresh.startedByLoop).toBe(true)

    // Ending the run stops ONLY 'prof-started-by-loop'
    endBrowserRun('user-octo', 'run-octo-1', true)
    await new Promise((r) => setTimeout(r, 80))
    expect(stoppedProfiles).toEqual(['prof-started-by-loop'])
  })

  it('enforces extension ring buffer caps, error priority, and risky action heuristics', () => {
    const buffers = createBuffers()

    // Push 60 info logs and 5 error logs
    for (let i = 0; i < 60; i++) {
      buffers.pushConsole({ level: 'log', text: `log line ${i}` })
    }
    for (let i = 0; i < 5; i++) {
      buffers.pushConsole({ level: 'error', text: `error line ${i}` })
    }

    // Push 45 network requests with 10KB bodies each
    for (let i = 0; i < 45; i++) {
      buffers.noteRequest(`req_${i}`, { method: 'GET', url: `https://example.com/${i}`, status: 200 })
      buffers.attachBody(`req_${i}`, 'x'.repeat(10_000))
    }

    const delta = buffers.takeDelta()
    // Capped at 50 console lines and 40 network requests
    expect(delta.console).toHaveLength(50)
    expect(delta.consoleTruncated).toBe(15)
    // All 5 error lines are prioritized and preserved in the delta
    expect(delta.console.filter((c: any) => c.level === 'error')).toHaveLength(5)
    expect(delta.network).toHaveLength(40)
    expect(delta.networkTruncated).toBe(5)
    // Each inline body is capped at 4KB (4096) and total body bytes across the delta <= 16KB (16384)
    const totalInlineBytes = delta.network.reduce((sum: number, n: any) => sum + (n.body ? n.body.length : 0), 0)
    expect(totalInlineBytes).toBeLessThanOrEqual(16384)

    // Risky action heuristics + model intent
    expect(isRiskyIntent('purchase')).toBe(true)
    expect(isRiskyIntent('submit')).toBe(true)
    expect(isRiskyIntent('read')).toBe(false)
    expect(looksSensitive('Read more', 'purchase', {})).toBe(true)
    expect(looksSensitive('Place order', undefined, {})).toBe(true)
    expect(looksSensitive('Card number', undefined, { autocomplete: 'cc-number' })).toBe(true)
    expect(looksSensitive('Next page', 'navigate', {})).toBe(false)

    // Blocked protocols and app origins
    expect(blockedReason('chrome://extensions', ['http://localhost:3000'])).toMatch(/browser-internal/)
    expect(blockedReason('http://localhost:3000/chat', ['http://localhost:3000'])).toMatch(/sign-in storage/)
    expect(isOnion('http://expyuzz4wqqyqhjn.onion/index.html')).toBe(true)

    // Verify octo and captcha_solver are registered in connectorRegistry and write tools require approval
    expect(connectorRegistry.hasType('octo')).toBe(true)
    expect(connectorRegistry.hasType('captcha_solver')).toBe(true)
    const tools = browserToolDefinitions()
    const clickTool = tools.find((t) => t.name === 'browser_click')
    expect((clickTool?.parameters as any)?.properties?.intent?.enum).toContain('purchase')
  })
})
