/**
 * Captcha solver client adapters (BYOK) and per-user captcha settings.
 *
 * Decision 7 & 8:
 * - Modes: 'wait' (default) and 'solver'.
 * - reCAPTCHA v2, v2 invisible, and hCaptcha token-injection types.
 * - 50 solves per user per day default cap, configurable up to 500.
 * - 120s timeout with 1 retry.
 * - Strictly disabled on Tor devices (to prevent .onion URL leakage).
 * - Solver adapter interface pluggable for 2captcha, CapMonster, Anti-Captcha, CapSolver.
 */
import axios from 'axios'
import { configStore, type ConnectorConfig } from '../agent/configStore'
import type { ConnectorType } from '../agent/connectors/connectorRegistry'

export type CaptchaHandlingMode = 'wait' | 'solver'
export type CaptchaType = 'recaptcha_v2' | 'recaptcha_v2_invisible' | 'hcaptcha'

export interface CaptchaChallenge {
  type: CaptchaType
  sitekey: string
  pageUrl: string
  dataS?: string
  userAgent?: string
}

export interface CaptchaSolverAdapter {
  name: string
  validateKey(apiKey: string): Promise<{ ok: boolean; balance?: number; error?: string }>
  solve(apiKey: string, challenge: CaptchaChallenge, signal?: AbortSignal): Promise<{ token: string }>
}

/**
 * 2captcha provider implementation.
 * API doc: https://2captcha.com/2captcha-api
 */
export const twoCaptchaAdapter: CaptchaSolverAdapter = {
  name: '2captcha',

  async validateKey(apiKey: string) {
    try {
      const resp = await axios.get('https://2captcha.com/res.php', {
        params: { key: apiKey, action: 'getbalance', json: 1 },
        timeout: 10000,
      })
      if (resp.data?.status === 1) {
        const balance = parseFloat(resp.data.request)
        if (balance <= 0) {
          return { ok: false, balance: 0, error: 'Out of balance' }
        }
        return { ok: true, balance }
      }
      return { ok: false, error: resp.data?.request || 'Invalid key' }
    } catch (err: any) {
      return { ok: false, error: `Unreachable: ${err.message}` }
    }
  },

  async solve(apiKey: string, challenge: CaptchaChallenge, signal?: AbortSignal) {
    const postData: Record<string, string> = {
      key: apiKey,
      json: '1',
      pageurl: challenge.pageUrl,
    }

    if (challenge.type === 'hcaptcha') {
      postData.method = 'hcaptcha'
      postData.sitekey = challenge.sitekey
    } else {
      postData.method = 'userrecaptcha'
      postData.googlekey = challenge.sitekey
      if (challenge.type === 'recaptcha_v2_invisible') {
        postData.invisible = '1'
      }
      if (challenge.dataS) {
        postData['data-s'] = challenge.dataS
      }
    }

    const createResp = await axios.post('https://2captcha.com/in.php', null, {
      params: postData,
      timeout: 15000,
      signal,
    })

    if (createResp.data?.status !== 1) {
      throw new Error(`2captcha submission failed: ${createResp.data?.request || 'Unknown error'}`)
    }

    const taskId = createResp.data.request
    const started = Date.now()
    const TIMEOUT_MS = 120_000

    await delay(5000)

    while (Date.now() - started < TIMEOUT_MS) {
      if (signal?.aborted) throw new Error('Captcha solve aborted')

      const checkResp = await axios.get('https://2captcha.com/res.php', {
        params: { key: apiKey, action: 'get', id: taskId, json: 1 },
        timeout: 10000,
        signal,
      })

      if (checkResp.data?.status === 1) {
        return { token: checkResp.data.request }
      }

      if (checkResp.data?.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`2captcha solve error: ${checkResp.data?.request}`)
      }

      await delay(5000)
    }

    throw new Error('2captcha timed out after 120 seconds')
  },
}

/**
 * Anti-Captcha / CapMonster Cloud JSON v2 compatible adapter.
 */
function createJsonV2Adapter(name: string, baseUrl: string): CaptchaSolverAdapter {
  return {
    name,
    async validateKey(apiKey: string) {
      try {
        const resp = await axios.post(`${baseUrl}/getBalance`, { clientKey: apiKey }, { timeout: 10000 })
        if (resp.data?.errorId === 0) {
          const balance = Number(resp.data.balance ?? 0)
          if (balance <= 0) return { ok: false, balance: 0, error: 'Out of balance' }
          return { ok: true, balance }
        }
        return { ok: false, error: resp.data?.errorCode || 'Invalid key' }
      } catch (err: any) {
        return { ok: false, error: `Unreachable: ${err.message}` }
      }
    },
    async solve(apiKey: string, challenge: CaptchaChallenge, signal?: AbortSignal) {
      const task: Record<string, unknown> = {
        type: challenge.type === 'hcaptcha' ? 'HCaptchaTaskProxyless' : 'RecaptchaV2TaskProxyless',
        websiteURL: challenge.pageUrl,
        websiteKey: challenge.sitekey,
        ...(challenge.type === 'recaptcha_v2_invisible' ? { isInvisible: true } : {}),
      }
      const createResp = await axios.post(`${baseUrl}/createTask`, { clientKey: apiKey, task }, { timeout: 15000, signal })
      if (createResp.data?.errorId !== 0 || !createResp.data?.taskId) {
        throw new Error(`${name} submission failed: ${createResp.data?.errorCode || 'Unknown error'}`)
      }
      const taskId = createResp.data.taskId
      const started = Date.now()
      await delay(5000)
      while (Date.now() - started < 120_000) {
        if (signal?.aborted) throw new Error('Captcha solve aborted')
        const checkResp = await axios.post(`${baseUrl}/getTaskResult`, { clientKey: apiKey, taskId }, { timeout: 10000, signal })
        if (checkResp.data?.errorId !== 0) {
          throw new Error(`${name} solve error: ${checkResp.data?.errorCode || 'error'}`)
        }
        if (checkResp.data?.status === 'ready') {
          const token = checkResp.data?.solution?.gRecaptchaResponse || checkResp.data?.solution?.token
          if (token) return { token: String(token) }
        }
        await delay(5000)
      }
      throw new Error(`${name} timed out after 120 seconds`)
    },
  }
}

export const CAPTCHA_PROVIDERS: Record<string, CaptchaSolverAdapter> = {
  '2captcha': twoCaptchaAdapter,
  'capmonster': createJsonV2Adapter('capmonster', 'https://api.capmonster.cloud'),
  'anticaptcha': createJsonV2Adapter('anticaptcha', 'https://api.anti-captcha.com'),
  'capsolver': createJsonV2Adapter('capsolver', 'https://api.capsolver.com'),
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Per-user captcha settings and daily usage counter.
 */
interface UserCaptchaSettings {
  handling: CaptchaHandlingMode
  dailyCap: number
}

const userCaptchaSettings = new Map<string, UserCaptchaSettings>()
const dailySolveCounts = new Map<string, { day: string; count: number }>()

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

export function getUserCaptchaSettings(userId: string): {
  captchaHandling: CaptchaHandlingMode
  dailyCap: number
  solvesToday: number
  solverConnected: boolean
  solverProvider: string | null
  solverKeyState: 'Connected' | 'Invalid key' | 'Out of balance' | 'Unreachable' | 'Not configured'
} {
  const settings = userCaptchaSettings.get(userId) || { handling: 'wait', dailyCap: 50 }
  const usage = dailySolveCounts.get(userId)
  const solvesToday = usage && usage.day === todayKey() ? usage.count : 0

  const connectors = configStore.listConnectors(userId)
  const solverConn = connectors.find((c) => c.type === 'captcha_solver' && c.enabled)
  if (!solverConn) {
    return {
      captchaHandling: settings.handling,
      dailyCap: settings.dailyCap,
      solvesToday,
      solverConnected: false,
      solverProvider: null,
      solverKeyState: 'Not configured',
    }
  }

  const provider = solverConn.config?.provider || '2captcha'
  let state: 'Connected' | 'Invalid key' | 'Out of balance' | 'Unreachable' | 'Not configured' = 'Connected'
  if (solverConn.lastTestOk === false) {
    const msg = (solverConn.lastTestMessage || '').toLowerCase()
    if (msg.includes('balance')) state = 'Out of balance'
    else if (msg.includes('unreachable')) state = 'Unreachable'
    else state = 'Invalid key'
  }

  return {
    captchaHandling: settings.handling,
    dailyCap: settings.dailyCap,
    solvesToday,
    solverConnected: state === 'Connected',
    solverProvider: provider,
    solverKeyState: state,
  }
}

export function setUserCaptchaSettings(userId: string, update: { captchaHandling?: CaptchaHandlingMode; dailyCap?: number }) {
  const current = userCaptchaSettings.get(userId) || { handling: 'wait', dailyCap: 50 }
  if (update.captchaHandling === 'wait' || update.captchaHandling === 'solver') {
    current.handling = update.captchaHandling
  }
  if (typeof update.dailyCap === 'number' && Number.isFinite(update.dailyCap)) {
    current.dailyCap = Math.min(Math.max(Math.round(update.dailyCap), 1), 500)
  }
  userCaptchaSettings.set(userId, current)
  return getUserCaptchaSettings(userId)
}

export function resetCaptchaSettingsForTests() {
  userCaptchaSettings.clear()
  dailySolveCounts.clear()
}

/**
 * Attempt to solve a captcha challenge with 1 retry and daily cap enforcement.
 * Decision 8: Strictly refuses Tor devices.
 */
export async function trySolveCaptchaForUser(input: {
  userId: string
  family: string
  challenge: CaptchaChallenge
  signal?: AbortSignal
}): Promise<{ solved: true; token: string; provider: string } | { solved: false; reason: string }> {
  if (input.family === 'tor') {
    return { solved: false, reason: 'Captcha solver is disabled on Tor Browser to protect .onion privacy.' }
  }

  const status = getUserCaptchaSettings(input.userId)
  if (status.captchaHandling !== 'solver') {
    return { solved: false, reason: `Captcha handling is set to wait (solver state: ${status.solverKeyState}).` }
  }
  if (!status.solverConnected) {
    return { solved: false, reason: `Captcha solver key is not ready (${status.solverKeyState}).` }
  }
  if (status.solvesToday >= status.dailyCap) {
    return { solved: false, reason: `Daily captcha solve cap (${status.dailyCap}) reached.` }
  }

  const connectors = configStore.listConnectors(input.userId)
  const solverConn = connectors.find((c) => c.type === 'captcha_solver' && c.enabled)
  const apiKey = solverConn?.config?.apiKey
  const providerName = (solverConn?.config?.provider || '2captcha').toLowerCase()
  const adapter = CAPTCHA_PROVIDERS[providerName] || twoCaptchaAdapter

  if (!apiKey) {
    return { solved: false, reason: 'Missing solver API key.' }
  }

  // Try once, plus 1 retry on failure (Decision 8)
  let lastError = 'Solver failed'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { token } = await adapter.solve(apiKey, input.challenge, input.signal)
      const day = todayKey()
      const cur = dailySolveCounts.get(input.userId)
      dailySolveCounts.set(input.userId, {
        day,
        count: (cur && cur.day === day ? cur.count : 0) + 1,
      })
      return { solved: true, token, provider: adapter.name }
    } catch (err: any) {
      lastError = err?.message || 'Solver error'
    }
  }

  return { solved: false, reason: lastError }
}

/**
 * Connector definition for Settings → Connectors.
 */
export const captchaSolverConnectorType: ConnectorType = {
  type: 'captcha_solver',
  name: 'Captcha Solver (BYOK)',
  description: 'Bring-your-own key for 2captcha, CapMonster Cloud, Anti-Captcha, or CapSolver. Used when captcha handling is set to solver.',
  category: 'Browser & Antidetect',
  icon: '🛡️',
  fields: [
    { key: 'provider', label: 'Provider (2captcha, capmonster, anticaptcha, capsolver)', placeholder: '2captcha' },
    { key: 'apiKey', label: 'Solver API Key', secret: true, required: true, placeholder: 'Paste your solver key' },
  ],
  createTools(_cfg: ConnectorConfig) {
    // Captcha solver is invoked automatically by the browser bridge when a challenge appears,
    // not as an arbitrary LLM tool.
    return []
  },
}

export async function probeCaptchaSolverConnector(config: Record<string, string>): Promise<{
  ok: boolean
  invalidCredentials: boolean
  message: string
  ms: number
}> {
  const started = Date.now()
  const providerName = (config.provider || '2captcha').trim().toLowerCase()
  const adapter = CAPTCHA_PROVIDERS[providerName]
  if (!adapter) {
    return {
      ok: false,
      invalidCredentials: true,
      message: `Unsupported captcha provider "${providerName}". Use 2captcha, capmonster, anticaptcha, or capsolver.`,
      ms: Date.now() - started,
    }
  }
  const apiKey = (config.apiKey || '').trim()
  if (!apiKey) {
    return { ok: false, invalidCredentials: true, message: 'API key is required.', ms: Date.now() - started }
  }
  const res = await adapter.validateKey(apiKey)
  const ms = Date.now() - started
  if (res.ok) {
    return {
      ok: true,
      invalidCredentials: false,
      message: `Connected (${adapter.name}${typeof res.balance === 'number' ? ` · balance $${res.balance.toFixed(2)}` : ''})`,
      ms,
    }
  }
  const err = res.error || 'Invalid key'
  const isUnreachable = err.toLowerCase().includes('unreachable')
  return {
    ok: false,
    invalidCredentials: !isUnreachable,
    message: err,
    ms,
  }
}
