import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOOPIT_TOKEN_PATH,
  createLoopitClient,
  createTokenStore,
  isServiceMissing,
  parseExpiresAt,
  tokenNeedsRefresh,
  ApiError,
} from '@loop/loopit-client'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('parseExpiresAt', () => {
  it('reads an ISO timestamp', () => {
    expect(parseExpiresAt('2026-10-07T12:00:00.000Z')).toBe(Date.parse('2026-10-07T12:00:00.000Z'))
  })

  it('treats small numbers as unix seconds', () => {
    expect(parseExpiresAt(1_700_000_000)).toBe(1_700_000_000_000)
    expect(parseExpiresAt('1700000000')).toBe(1_700_000_000_000)
  })

  it('keeps millisecond numbers', () => {
    expect(parseExpiresAt(1_700_000_000_000)).toBe(1_700_000_000_000)
  })

  it('rejects a missing expiry', () => {
    expect(() => parseExpiresAt(null)).toThrow(/expiresAt/)
  })
})

describe('tokenNeedsRefresh', () => {
  it('refreshes inside the skew window and after expiry', () => {
    expect(tokenNeedsRefresh(100_000, 0, 30_000)).toBe(false)
    expect(tokenNeedsRefresh(100_000, 70_000, 30_000)).toBe(true)
    expect(tokenNeedsRefresh(100_000, 100_000, 30_000)).toBe(true)
  })
})

describe('createTokenStore', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('reuses a live token and mints again once it is inside the skew window', async () => {
    let now = 1_000_000
    const fetchImpl = vi.fn(async () => json({ token: `t-${now}`, expiresAt: new Date(now + 120_000).toISOString() }))
    const store = createTokenStore({ fetchImpl, now: () => now, skewMs: 30_000 })
    await expect(store.getToken()).resolves.toBe('t-1000000')
    await expect(store.getToken()).resolves.toBe('t-1000000')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now = 1_000_000 + 120_000 - 1_000
    await expect(store.getToken()).resolves.toBe(`t-${now}`)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('shares one mint across concurrent callers', async () => {
    let resolveFetch: (response: Response) => void = () => {}
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve }))
    const store = createTokenStore({ fetchImpl, now: () => 0, skewMs: 30_000 })
    const first = store.getToken()
    const second = store.getToken()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    resolveFetch(json({ token: 'shared', expiresAt: new Date(120_000).toISOString() }))
    await expect(first).resolves.toBe('shared')
    await expect(second).resolves.toBe('shared')
  })

  it('posts to the cookie-authenticated token route and does not touch web storage', async () => {
    const sessionSet = vi.spyOn(window.sessionStorage, 'setItem')
    const localSet = vi.spyOn(window.localStorage, 'setItem')
    const fetchImpl = vi.fn(async () => json({ token: 'mem', expiresAt: new Date(Date.now() + 120_000).toISOString() }))
    const store = createTokenStore({ fetchImpl })
    await store.getToken()
    expect(fetchImpl).toHaveBeenCalledWith(LOOPIT_TOKEN_PATH, expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }))
    expect(sessionSet).not.toHaveBeenCalled()
    expect(localSet).not.toHaveBeenCalled()
  })
})

describe('isServiceMissing', () => {
  it('treats an HTML 404 as a missing gateway and a JSON 404 as a missing run', () => {
    expect(isServiceMissing(new ApiError(404, '<!DOCTYPE html><html></html>'))).toBe(true)
    expect(isServiceMissing(new ApiError(404, 'run not found'))).toBe(false)
    expect(isServiceMissing(new ApiError(0, 'Failed to fetch'))).toBe(false)
  })
})

describe('mint response contract', () => {
  it('parses the exact JSON POST /api/loopit/token returns', async () => {
    // Mirrors the backend route (backend/src/routes/loopit.ts) whose own test
    // asserts these fields are emitted. This is the seam that once broke the
    // whole Build page: the client parsed {token, expiresAt} while the route
    // answered {access_token, expires_in}. Pinning both halves together.
    const mintResponse = {
      access_token: 'id.tok.en',
      token: 'id.tok.en',
      token_type: 'bearer',
      expires_in: 900,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      org: 'ws_1',
      role: 'owner',
    }
    const fetchImpl = vi.fn(async () => json(mintResponse))
    const store = createTokenStore({ fetchImpl })
    await expect(store.getToken()).resolves.toBe('id.tok.en')
    expect(fetchImpl).toHaveBeenCalledWith(LOOPIT_TOKEN_PATH, expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }))
  })
})

describe('createLoopitClient token refresh', () => {
  it('mints a new bearer after a 401 and retries the call once', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/token')) {
        const minted = fetchImpl.mock.calls.filter((call) => String(call[0]).endsWith('/token')).length
        return json({ token: minted === 1 ? 'old' : 'new', expiresAt: new Date(Date.now() + 120_000).toISOString() })
      }
      const auth = new Headers(init?.headers).get('Authorization')
      if (auth === 'Bearer old') return new Response('expired', { status: 401 })
      return json([])
    })
    const client = createLoopitClient({ fetchImpl })
    await expect(client.listRuns()).resolves.toEqual([])
    const auths = fetchImpl.mock.calls
      .filter((call) => String(call[0]).endsWith('/runs'))
      .map((call) => new Headers(call[1]?.headers).get('Authorization'))
    expect(auths).toEqual(['Bearer old', 'Bearer new'])
  })
})
