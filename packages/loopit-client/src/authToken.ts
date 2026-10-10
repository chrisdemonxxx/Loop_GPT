import { ApiError } from './errors'

/** Same-origin Loop-IT gateway. Nginx sends this prefix to the Loop-IT API. */
export const LOOPIT_API_BASE = '/api/loopit'

/**
 * Cookie-authenticated mint on the Loop-GPT API.
 * Contract: POST /api/loopit/token -> { token, expiresAt }.
 */
export const LOOPIT_TOKEN_PATH = '/api/loopit/token'

/** Refresh this long before the minted token actually expires. */
export const TOKEN_REFRESH_SKEW_MS = 30_000

export interface MintedToken {
  token: string
  /** ISO-8601 timestamp, or unix seconds / milliseconds. */
  expiresAt: string | number
}

export interface TokenStoreOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  skewMs?: number
  tokenPath?: string
}

export interface TokenStore {
  getToken: (force?: boolean) => Promise<string>
  clear: () => void
}

/** True when `nowMs` is inside the refresh window or past expiry. */
export function tokenNeedsRefresh(expiresAtMs: number, nowMs: number, skewMs = TOKEN_REFRESH_SKEW_MS): boolean {
  return nowMs >= expiresAtMs - skewMs
}

/** Accepts an ISO string, a unix-seconds number, or a unix-milliseconds number. */
export function parseExpiresAt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed && !trimmed.includes('T') && !trimmed.includes('-')) {
      const asNumber = Number(trimmed)
      if (Number.isFinite(asNumber)) return asNumber < 1e12 ? asNumber * 1000 : asNumber
    }
    const ms = Date.parse(trimmed)
    if (!Number.isNaN(ms)) return ms
  }
  throw new ApiError(502, 'token response missing expiresAt')
}

/**
 * In-memory bearer for the Loop-IT gateway.
 *
 * The Loop-GPT session cookie mints the token. The bearer is never written to
 * sessionStorage or localStorage; a reload drops it and the next call mints again.
 */
export function createTokenStore(options: TokenStoreOptions = {}): TokenStore {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const skewMs = options.skewMs ?? TOKEN_REFRESH_SKEW_MS
  const tokenPath = options.tokenPath ?? LOOPIT_TOKEN_PATH

  let cached: { token: string; expiresAtMs: number } | null = null
  let inflight: Promise<string> | null = null
  let generation = 0

  function clear() {
    cached = null
    generation += 1
    inflight = null
  }

  async function mint(gen: number): Promise<string> {
    let response: Response
    try {
      response = await fetchImpl(tokenPath, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
    } catch (cause) {
      throw new ApiError(0, cause instanceof Error ? cause.message : 'Failed to fetch')
    }
    if (!response.ok) {
      throw new ApiError(response.status, await readError(response))
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ApiError(502, 'token response was not JSON')
    }
    const record = body && typeof body === 'object' ? body as { token?: unknown; expiresAt?: unknown } : {}
    if (typeof record.token !== 'string' || record.token.length === 0) {
      throw new ApiError(502, 'token response missing token')
    }
    const expiresAtMs = parseExpiresAt(record.expiresAt)
    if (gen === generation) cached = { token: record.token, expiresAtMs }
    return record.token
  }

  async function getToken(force = false): Promise<string> {
    if (!force && cached && !tokenNeedsRefresh(cached.expiresAtMs, now(), skewMs)) {
      return cached.token
    }
    if (!force && inflight) return inflight
    const gen = ++generation
    const run = mint(gen)
    inflight = run
    try {
      return await run
    } finally {
      if (inflight === run) inflight = null
    }
  }

  return { getToken, clear }
}

async function readError(response: Response): Promise<string> {
  const body = await response.text()
  let message = body || `${response.status} ${response.statusText}`
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown; message?: unknown }
    if (typeof parsed.detail === 'string') message = parsed.detail
    else if (typeof parsed.error === 'string') message = parsed.error
    else if (typeof parsed.message === 'string') message = parsed.message
  } catch { /* keep raw body */ }
  return message
}
