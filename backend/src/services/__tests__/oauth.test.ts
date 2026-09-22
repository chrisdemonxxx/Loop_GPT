import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'http'
import express from 'express'
import { callbackUrl, publicCallbackBase } from '../oauth'
import { oauthRouter } from '../../routes/oauth'

afterEach(() => vi.unstubAllEnvs())

describe('OAuth callback URL', () => {
  it('prefers OAUTH_CALLBACK_BASE over the request-derived base', () => {
    vi.stubEnv('OAUTH_CALLBACK_BASE', 'https://api.loop-gpt.cyou')
    vi.stubEnv('PUBLIC_API_URL', '')
    expect(publicCallbackBase('http://backend.railway.internal:3001')).toBe('https://api.loop-gpt.cyou')
    expect(callbackUrl('http://backend.railway.internal:3001', 'google'))
      .toBe('https://api.loop-gpt.cyou/api/auth/oauth/google/callback')
  })

  it('falls back to PUBLIC_API_URL when OAUTH_CALLBACK_BASE is unset', () => {
    vi.stubEnv('OAUTH_CALLBACK_BASE', '')
    vi.stubEnv('PUBLIC_API_URL', 'https://api.loop-gpt.cyou')
    expect(callbackUrl('http://backend.railway.internal:3001', 'github'))
      .toBe('https://api.loop-gpt.cyou/api/auth/oauth/github/callback')
  })

  it('uses the request-derived base only when nothing is configured', () => {
    vi.stubEnv('OAUTH_CALLBACK_BASE', '')
    vi.stubEnv('PUBLIC_API_URL', '')
    expect(callbackUrl('https://example.test', 'google')).toBe('https://example.test/api/auth/oauth/google/callback')
  })

  it('takes the first of a comma-separated configured base and strips slashes', () => {
    vi.stubEnv('OAUTH_CALLBACK_BASE', 'https://api.loop-gpt.cyou/,https://other.test')
    expect(publicCallbackBase('http://x')).toBe('https://api.loop-gpt.cyou')
  })
})

describe('OAuth route (FRONTEND_URL is an origin list)', () => {
  let server: Server
  let base: string
  beforeAll(async () => {
    const app = express()
    app.use('/api/auth', oauthRouter)
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()) })
    base = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })

  it('redirects to the FIRST frontend origin, never the whole comma list', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'cid'); vi.stubEnv('GOOGLE_CLIENT_SECRET', 'secret')
    vi.stubEnv('FRONTEND_URL', 'https://loop-gpt.cyou,https://app.loop-gpt.cyou')
    const res = await fetch(`${base}/api/auth/oauth/google`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    // Unit env has no database, so this asserts the error redirect's base origin.
    // The app is exported with trailingSlash, so the path ends `/login/`.
    expect(location.startsWith('https://loop-gpt.cyou/login/?')).toBe(true)
    expect(location).not.toContain(',')
  })
})
