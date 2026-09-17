import jwt from 'jsonwebtoken'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/prisma', () => ({ prisma: null, hasDb: false }))
vi.mock('../../services/email', () => ({ welcomeEmail: vi.fn(), verifyEmail: vi.fn() }))
const secret = 'unit-test-only-identity-secret-at-least-32-chars'
let auth: typeof import('../../routes/auth')
beforeAll(async () => { vi.stubEnv('JWT_SECRET', secret); auth = await import('../../routes/auth') })
afterEach(() => { vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('ENABLE_DEV_MODE', 'false') })
afterAll(() => vi.unstubAllEnvs())

function response() {
  const res: any = { status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}

describe('authentication identity boundaries', () => {
  it.each([{}, { userId: null }, { userId: 7 }, { userId: '' }, { userId: '   ' }, { userId: 'x'.repeat(129) }])('rejects unusable identity claims %j', (claims) => {
    const req: any = { headers: { authorization: `Bearer ${jwt.sign(claims, secret)}` } }
    const res = response(); const next = vi.fn()
    auth.authenticateToken(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
  it('accepts a signed string identity', () => {
    const req: any = { headers: { authorization: `Bearer ${jwt.sign({ userId: 'alice' }, secret)}` } }
    const next = vi.fn()
    auth.authenticateToken(req, response(), next)
    expect(req.userId).toBe('alice')
    expect(next).toHaveBeenCalledOnce()
  })
  it('rejects an unexpected signing algorithm', () => {
    const req: any = { headers: { authorization: `Bearer ${jwt.sign({ userId: 'alice' }, secret, { algorithm: 'HS384' })}` } }
    const res = response(); const next = vi.fn()
    auth.authenticateToken(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
  it('does not enable guest authentication merely because NODE_ENV is development', () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('ENABLE_DEV_MODE', 'false')
    const res = response(); const next = vi.fn()
    auth.authenticateToken({ headers: {} } as any, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
  it('requires both development and explicit opt-in for a guest', () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('ENABLE_DEV_MODE', 'true')
    const req: any = { headers: {} }; const next = vi.fn()
    auth.authenticateToken(req, response(), next)
    expect(req.userId).toBe('dev-user-123')
    expect(next).toHaveBeenCalledOnce()
  })
  it('does not replace an invalid supplied authorization header with a guest', () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('ENABLE_DEV_MODE', 'true')
    const res = response(); const next = vi.fn()
    auth.authenticateToken({ headers: { authorization: 'Basic invalid' } } as any, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
  it('never enables production guest authentication', () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('ENABLE_DEV_MODE', 'true')
    const res = response(); const next = vi.fn()
    auth.authenticateToken({ headers: {} } as any, res, next)
    expect(next).not.toHaveBeenCalled()
  })
  it('never grants administration without a database', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('ENABLE_DEV_MODE', 'true')
    const res = response(); const next = vi.fn()
    await auth.requireAdmin({ userId: 'dev-user-123' } as any, res, next)
    expect(res.status).toHaveBeenCalledWith(503)
    expect(next).not.toHaveBeenCalled()
  })
})
