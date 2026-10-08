import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { byBodyField, byIp, byUser, clientIp, rateLimiter } from '../rateLimiter'

function req(opts: { ip?: string; headers?: Record<string, string>; body?: any; userId?: string } = {}): Request {
  return { ip: opts.ip ?? '203.0.113.9', headers: opts.headers ?? {}, body: opts.body, userId: opts.userId, socket: {} } as any
}

function res() {
  const out: any = { statusCode: 200, headers: {} as Record<string, string> }
  out.setHeader = (k: string, v: string) => { out.headers[k] = v }
  out.status = (code: number) => { out.statusCode = code; return out }
  out.json = (body: unknown) => { out.body = body; return out }
  return out as Response & { statusCode: number; headers: Record<string, string> }
}

/** Run a limiter once; true when the request was let through. */
function pass(limiter: ReturnType<typeof rateLimiter>, request: Request) {
  const next = vi.fn()
  const response = res()
  limiter(request, response, next)
  return { passed: next.mock.calls.length === 1, response }
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('PROXY_SHARED_SECRET', 'proxy-fixture-secret')
})
afterEach(() => { vi.unstubAllEnvs() })

describe('clientIp', () => {
  it('ignores a client-supplied X-Forwarded-For without the proxy secret', () => {
    expect(clientIp(req({ headers: { 'x-forwarded-for': '1.2.3.4' } }))).toBe('203.0.113.9')
    expect(clientIp(req({ headers: { 'x-forwarded-for': '1.2.3.4', 'x-loop-proxy-auth': 'wrong' } }))).toBe('203.0.113.9')
  })
  it('trusts the proxy-asserted address only with the shared secret', () => {
    const headers = { 'x-forwarded-for': '198.51.100.7, 10.0.0.1', 'x-loop-proxy-auth': 'proxy-fixture-secret' }
    expect(clientIp(req({ headers }))).toBe('198.51.100.7')
  })
  it('falls back to req.ip when no secret is configured', () => {
    vi.stubEnv('PROXY_SHARED_SECRET', '')
    const headers = { 'x-forwarded-for': '198.51.100.7', 'x-loop-proxy-auth': '' }
    expect(clientIp(req({ headers }))).toBe('203.0.113.9')
  })
})

describe('key helpers', () => {
  it('byBodyField normalizes and skips when absent', () => {
    const byEmail = byBodyField('email')
    expect(byEmail(req({ body: { email: '  Victim@Example.COM ' } }))).toBe('email:victim@example.com')
    expect(byEmail(req({ body: {} }))).toBeUndefined()
    expect(byEmail(req({ body: { email: ['a@b.c'] } }))).toBeUndefined()
  })
  it('byUser prefers the authenticated user, else the IP', () => {
    expect(byUser(req({ userId: 'u1' }))).toBe('user:u1')
    expect(byUser(req())).toBe('ip:203.0.113.9')
    expect(byIp(req({ userId: 'u1' }))).toBe('ip:203.0.113.9')
  })
})

describe('rateLimiter', () => {
  it('limits per key and answers 429 with Retry-After', () => {
    const limiter = rateLimiter(60_000, 2, { key: byIp })
    expect(pass(limiter, req()).passed).toBe(true)
    expect(pass(limiter, req()).passed).toBe(true)
    const blocked = pass(limiter, req())
    expect(blocked.passed).toBe(false)
    expect(blocked.response.statusCode).toBe(429)
    expect(Number(blocked.response.headers['Retry-After'])).toBeGreaterThan(0)
    // A different address has its own bucket.
    expect(pass(limiter, req({ ip: '203.0.113.10' })).passed).toBe(true)
  })
  it('cannot be dodged by rotating a spoofed X-Forwarded-For', () => {
    const limiter = rateLimiter(60_000, 1, { key: byIp })
    expect(pass(limiter, req({ headers: { 'x-forwarded-for': '1.1.1.1' } })).passed).toBe(true)
    expect(pass(limiter, req({ headers: { 'x-forwarded-for': '2.2.2.2' } })).passed).toBe(false)
  })
  it('keys a per-account budget across many source addresses', () => {
    const limiter = rateLimiter(60_000, 2, { key: byBodyField('email') })
    const body = { email: 'target@example.com' }
    expect(pass(limiter, req({ ip: '198.51.100.1', body })).passed).toBe(true)
    expect(pass(limiter, req({ ip: '198.51.100.2', body })).passed).toBe(true)
    expect(pass(limiter, req({ ip: '198.51.100.3', body })).passed).toBe(false)
    // No email in the body: this limiter does not apply.
    expect(pass(limiter, req({ body: {} })).passed).toBe(true)
  })
  it('gives every limiter its own store', () => {
    const general = rateLimiter(60_000, 1)
    const login = rateLimiter(60_000, 1)
    expect(pass(general, req()).passed).toBe(true)
    expect(pass(login, req()).passed).toBe(true)
    expect(pass(general, req()).passed).toBe(false)
  })
  it('resets after the window', () => {
    vi.useFakeTimers()
    try {
      const limiter = rateLimiter(1_000, 1, { key: byIp })
      expect(pass(limiter, req()).passed).toBe(true)
      expect(pass(limiter, req()).passed).toBe(false)
      vi.advanceTimersByTime(1_001)
      expect(pass(limiter, req()).passed).toBe(true)
    } finally { vi.useRealTimers() }
  })
})
