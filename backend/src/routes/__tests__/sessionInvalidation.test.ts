import { describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { authenticateToken, tokenPredatesReset } from '../auth'

/**
 * Password-reset session invalidation: authenticateToken must reject JWTs
 * issued before User.sessionInvalidatedAt (stamped by POST /api/auth/reset),
 * and accept tokens issued after it (and when no stamp exists).
 */

// auth.ts reads JWT_SECRET at module load — set it before the import.
const JWT_SECRET = vi.hoisted(() => {
  process.env.JWT_SECRET = 'test-secret-session-invalidation'
  process.env.NODE_ENV = 'production'
  return 'test-secret-session-invalidation'
})

const findUnique = vi.fn()
vi.mock('../../services/prisma', () => ({
  prisma: { user: { findUnique: (...a: any[]) => findUnique(...a) } },
  hasDb: true,
}))

async function callMiddleware(token: string | undefined): Promise<{ status: number; userId?: string; error?: any }> {
  return new Promise((resolve) => {
    const req: any = { headers: token ? { authorization: `Bearer ${token}` } : {} }
    const res: any = {
      status(s: number) { this.status = s; return this },
      json(b: any) { resolve({ status: this.status, error: b?.error }) },
    }
    authenticateToken(req, res, () => resolve({ status: 200, userId: req.userId }))
  })
}

describe('session invalidation on password reset', () => {
  it('rejects a token issued BEFORE the reset stamp', async () => {
    const token = jwt.sign({ userId: 'u1' }, JWT_SECRET, { expiresIn: '7d' }) // iat = now
    // Reset happened 1s AFTER the token was issued.
    findUnique.mockResolvedValue({ sessionInvalidatedAt: new Date(Date.now() + 1000) })
    const r = await callMiddleware(token)
    expect(r.status).toBe(401)
    expect(r.error).toMatch(/password reset/i)
  })

  it('accepts a token issued AFTER the reset stamp', async () => {
    const token = jwt.sign({ userId: 'u1' }, JWT_SECRET, { expiresIn: '7d' })
    // Reset happened 1h before the token was issued.
    findUnique.mockResolvedValue({ sessionInvalidatedAt: new Date(Date.now() - 3600_000) })
    const r = await callMiddleware(token)
    expect(r.status).toBe(200)
    expect(r.userId).toBe('u1')
  })

  it('accepts a token when no stamp exists (never reset)', async () => {
    const token = jwt.sign({ userId: 'u1' }, JWT_SECRET, { expiresIn: '7d' })
    findUnique.mockResolvedValue({ sessionInvalidatedAt: null })
    const r = await callMiddleware(token)
    expect(r.status).toBe(200)
  })

  it('fails open when the DB read errors (signature already verified)', async () => {
    const token = jwt.sign({ userId: 'u1' }, JWT_SECRET, { expiresIn: '7d' })
    findUnique.mockRejectedValue(new Error('db down'))
    const r = await callMiddleware(token)
    expect(r.status).toBe(200)
  })

  it('rejects invalid signatures regardless of stamps', async () => {
    const token = jwt.sign({ userId: 'u1' }, 'wrong-secret', { expiresIn: '7d' })
    const r = await callMiddleware(token)
    expect(r.status).toBe(401)
  })
})

describe('tokenPredatesReset (pure helper)', () => {
  it('compares iat seconds against the reset instant', () => {
    const resetAt = new Date('2026-09-22T12:00:00Z')
    expect(tokenPredatesReset(Math.floor(resetAt.getTime() / 1000) - 1, resetAt)).toBe(true)
    expect(tokenPredatesReset(Math.floor(resetAt.getTime() / 1000) + 1, resetAt)).toBe(false)
  })
})
