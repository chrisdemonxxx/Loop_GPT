import type { Server } from 'node:http'
import express from 'express'
import jwt from 'jsonwebtoken'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncHandler, errorLogger } from '../errorLogger'

// Real Express routing, JSON/query parsing, JWTs and loopback HTTP. Every DB and
// OAuth/email effect is mocked: no configured database or provider is contacted.
const fixtures = vi.hoisted(() => {
  const table = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(),
    create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() })
  return { db: { user: table(), usageEvent: table(), apiKey: table(), apiUsage: table(), apiReservation: table(),
    mediaJob: table(), accountedVideoJob: table(), voucher: table(), payment: table(), token: table(), $transaction: vi.fn() },
    exchange: vi.fn(), email: vi.fn(), provider: vi.fn() }
})
vi.mock('../../services/prisma', () => ({ prisma: fixtures.db, hasDb: true }))
vi.mock('../../services/oauth', () => ({ enabledProviders: () => ['google'], providerEnabled: () => true,
  authorizeUrl: () => { throw new Error('Unexpected OAuth initiation') }, callbackUrl: () => 'https://callback.example.invalid', exchangeCode: fixtures.exchange }))
vi.mock('../../services/email', () => ({ welcomeEmail: fixtures.email, alertEmail: fixtures.email,
  verifyEmail: fixtures.email, resetPasswordEmail: fixtures.email, voucherRedeemedEmail: fixtures.email }))
vi.mock('../../agent/llmClient', () => ({ createClient: fixtures.provider }))
vi.mock('../../services/providerHttp', () => ({ providerRequest: fixtures.provider }))

const secret = 'request-boundary-fixture-only-at-least-32-chars'
const userId = 'request-boundary-user'
const email = 'signup@example.invalid'
const detail = 'fixture-private-database-detail'
let server: Server, base: string, token: string
let forwarded: unknown[] = []
let unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => { unhandled.push(reason) }

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', secret)
  vi.stubEnv('FRONTEND_URL', 'https://client.example.invalid')
  vi.stubEnv('OAUTH_BRIDGE_TARGET', '')
  vi.stubEnv('ENABLE_DEV_MODE', 'false')
  const [account, oauth, developer, media, admin, v1, files] = await Promise.all([
    import('../../routes/account'), import('../../routes/oauth'), import('../../routes/developer'),
    import('../../routes/media'), import('../../routes/admin'), import('../../routes/v1'), import('../../routes/files'),
  ])
  const app = express()
  app.set('env', 'production')
  app.use(express.json())
  app.use('/api/account', account.default)
  app.use('/api/auth', oauth.oauthRouter)
  app.use('/api/developer', developer.default)
  app.use('/api/media', media.default)
  app.use('/api/admin', admin.default)
  app.use('/api/files', files.filesRouter)
  app.use('/v1', v1.default)
  app.get('/health', (_req, res) => { res.json({ ok: true }) })
  app.get('/fixture/sync', asyncHandler(() => { throw new Error(detail) }))
  app.get('/fixture/late', asyncHandler(async (_req, res) => {
    res.set('Content-Type', 'text/event-stream')
    res.write('data: started\n\n')
    await new Promise(resolve => setTimeout(resolve, 10))
    throw new Error(detail)
  }))
  app.get('/fixture/ended', asyncHandler(async (_req, res) => {
    res.json({ ok: true })
    await Promise.resolve()
    throw new Error(detail)
  }))
  const observe: express.ErrorRequestHandler = (error, _req, _res, next) => { forwarded.push(error); next(error) }
  app.use(observe, errorLogger)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback listener')
  base = `http://127.0.0.1:${address.port}`
  token = jwt.sign({ userId }, secret)
  process.on('unhandledRejection', onUnhandled)
})

beforeEach(() => {
  forwarded = []; unhandled = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const value of Object.values(fixtures.db)) {
    const methods = typeof value === 'function' ? [value] : Object.values(value)
    for (const method of methods) method.mockReset().mockRejectedValue(new Error(detail))
  }
  fixtures.db.user.findUnique.mockResolvedValue({ id: userId, email, name: 'Fixture', role: 'admin' })
  fixtures.db.usageEvent.findMany.mockResolvedValue([])
  fixtures.db.apiKey.findUnique.mockResolvedValue({ id: 'fixture-key', revoked: false,
    user: { id: userId, apiPlan: null, apiBalanceMicros: 1000000n, unlimited: true } })
  fixtures.email.mockReset().mockResolvedValue(undefined)
  fixtures.provider.mockReset().mockImplementation(() => { throw new Error('Provider traffic forbidden') })
  fixtures.exchange.mockReset().mockResolvedValue({ email, name: 'Fixture', providerId: 'fixture-oauth-id' })
  fixtures.db.user.create.mockImplementation(async ({ data }) => ({ id: userId, ...data }))
})
afterEach(async () => {
  // Rejected route promises must reach the request boundary, never the process.
  await new Promise(resolve => setImmediate(resolve))
  expect(unhandled).toEqual([])
  expect(fixtures.provider).not.toHaveBeenCalled()
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(detail)
  vi.restoreAllMocks()
})
afterAll(async () => {
  process.off('unhandledRejection', onUnhandled)
  if (server) await new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve())
  })
  vi.unstubAllEnvs()
})

async function request(path: string, options: { body?: unknown; bearer?: string; method?: string } = {}) {
  return fetch(`${base}${path}`, { method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${options.bearer ?? token}`, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body), redirect: 'manual', signal: AbortSignal.timeout(5000) })
}
async function healthy() { expect(await (await request('/health')).json()).toEqual({ ok: true }) }

describe('strict account usage query over real HTTP', () => {
  it.each(['1.5', '0', '-1', '201', '99999999999999999', 'NaN', 'Infinity', 'false', 'null', '',
    '1e2', '0x10', '+1', '01', ' 1 ', '1\n'])('rejects limit=%j before database access', async value => {
    const response = await request(`/api/account/usage?limit=${encodeURIComponent(value)}`)
    expect(response.status).toBe(400)
    expect(fixtures.db.usageEvent.findMany).not.toHaveBeenCalled()
    expect(forwarded).toEqual([])
    await healthy()
  })
  it.each(['limit=1&limit=2', 'limit[]=1', 'limit[0]=1', 'limit[value]=1', 'limit=1&extra=2'])('rejects query shape %s', async query => {
    expect((await request(`/api/account/usage?${query}`)).status).toBe(400)
    expect(fixtures.db.usageEvent.findMany).not.toHaveBeenCalled()
  })
  it.each([['', 50], ['?limit=1', 1], ['?limit=200', 200]])('accepts %s with take=%s', async (query, take) => {
    const response = await request(`/api/account/usage${query}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ events: [], hasDb: true })
    expect(fixtures.db.usageEvent.findMany).toHaveBeenCalledWith({ where: { userId }, orderBy: { createdAt: 'desc' }, take })
  })
  it('contains a database rejection and serves the next usage request', async () => {
    fixtures.db.usageEvent.findMany.mockRejectedValueOnce(new Error(detail))
    const failed = await request('/api/account/usage?limit=1')
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'Internal server error' })
    expect(failed.headers.get('cache-control')).toBe('no-store')
    expect(forwarded).toHaveLength(1)
    expect((forwarded[0] as Error).message).toBe('Request operation failed')
    expect((await request('/api/account/usage?limit=1')).status).toBe(200)
  })
})

describe('mounted async route and middleware failure containment', () => {
  it.each([
    ['/api/account/me', undefined], ['/api/account/redeem', { code: 'fixture' }],
    ['/api/auth/verify', { token: 'fixture' }], ['/api/auth/forgot', { email }],
    ['/api/auth/reset', { token: 'fixture', password: 'fixture-password' }],
    ['/api/auth/resend-verification', {}], ['/api/developer/overview', undefined],
    ['/api/developer/keys', undefined], ['/api/developer/keys', {}],
    ['/api/media/jobs', undefined], ['/api/media/jobs/missing', undefined],
    ['/api/media/jobs/missing/cancel', {}], ['/api/admin/stats', undefined],
    ['/api/admin/vouchers', undefined], ['/api/admin/vouchers', {}],
    ['/api/admin/payments', undefined], ['/api/admin/payments', { userId, amount: 1 }],
  ])('contains failure at %s', async (path, body) => {
    // redeemVoucher ordinarily handles voucher transaction errors itself. The
    // account view after a successful invite grant must also remain contained.
    if (path === '/api/account/redeem') {
      vi.stubEnv('ADMIN_INVITE_CODE', 'FIXTURE')
      fixtures.db.user.update.mockResolvedValue({ id: userId })
    }
    try {
      const response = await request(path, { body })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'Internal server error' })
      expect(forwarded).toHaveLength(1)
      await healthy()
    } finally { vi.stubEnv('ADMIN_INVITE_CODE', '') }
  })
  it.each(['/v1/models', '/api/files/fixture/content'])('contains API-key lookup rejection at %s without reaching protected work', async path => {
    fixtures.db.apiKey.findUnique.mockRejectedValueOnce(new Error(detail))
    const response = await request(path, { bearer: 'sk-loop-fixture-only' })
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain(detail)
    expect(forwarded).toHaveLength(1)
    await healthy()
  })
  it.each(['/v1/usage', '/v1/videos/generations/missing'])('preserves the API error envelope for %s', async path => {
    const response = await request(path, { bearer: 'sk-loop-fixture-only' })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { message: 'Internal server error', type: 'api_error', code: 'request_failed', param: null } })
    await healthy()
  })
  it('contains synchronous throws in wrapped handlers', async () => {
    expect((await request('/fixture/sync')).status).toBe(500)
    expect(forwarded).toHaveLength(1)
    await healthy()
  })
  it('closes a partial SSE response without appending JSON or leaking details', async () => {
    const response = await request('/fixture/late')
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    let received = ''
    await expect((async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        received += new TextDecoder().decode(value)
      }
    })()).rejects.toThrow()
    expect(received).toContain('data: started')
    expect(received).not.toContain('Internal server error')
    expect(received).not.toContain(detail)
    await healthy()
  })
  it('contains rejection after a response has already ended', async () => {
    expect(await (await request('/fixture/ended')).json()).toEqual({ ok: true })
    await healthy()
    expect(forwarded).toHaveLength(1)
  })
})

describe('OAuth public registration never provisions administrators', () => {
  it.each([[0, ''], [0, email], [5, email], [5, 'other@example.invalid']])('creates role:user with prior count %s and ADMIN_EMAIL=%s', async (count, adminEmail) => {
    vi.stubEnv('ADMIN_EMAIL', adminEmail)
    fixtures.db.user.findUnique.mockResolvedValueOnce(null)
    fixtures.db.user.count.mockResolvedValue(count)
    const state = jwt.sign({ provider: 'google' }, secret, { expiresIn: '10m' })
    const response = await request(`/api/auth/oauth/google/callback?code=fixture&state=${encodeURIComponent(state)}`)
    expect(response.status).toBe(302)
    expect(fixtures.exchange).toHaveBeenCalledOnce()
    expect(fixtures.db.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({ email, role: 'user' }) })
    expect(fixtures.db.user.count).not.toHaveBeenCalled()
    expect(fixtures.db.user.update).not.toHaveBeenCalled()
    const redirect = new URL(response.headers.get('location')!)
    expect(redirect.searchParams.get('role')).toBe('user')
    expect(jwt.verify(redirect.searchParams.get('token')!, secret)).toMatchObject({ userId })
  })
  it('also creates ordinary users through a form-post callback', async () => {
    fixtures.db.user.findUnique.mockResolvedValueOnce(null)
    vi.stubEnv('ADMIN_EMAIL', email)
    const response = await fetch(`${base}/api/auth/oauth/google/callback`, { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: 'fixture', state: jwt.sign({ provider: 'google' }, secret) }), signal: AbortSignal.timeout(5000) })
    expect(response.status).toBe(302)
    expect(fixtures.db.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({ role: 'user' }) })
  })
  it('preserves the role of an existing explicitly provisioned administrator', async () => {
    const state = jwt.sign({ provider: 'google' }, secret)
    const response = await request(`/api/auth/oauth/google/callback?code=fixture&state=${encodeURIComponent(state)}`)
    expect(response.status).toBe(302)
    expect(new URL(response.headers.get('location')!).searchParams.get('role')).toBe('admin')
    expect(fixtures.db.user.create).not.toHaveBeenCalled()
    expect(fixtures.db.user.update).not.toHaveBeenCalled()
  })
})
