import { describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { authenticateToken, signSession } from '../../routes/auth'
import {
  revokeUserSessions, sessionIatAfter, setSessionCookie, shouldRevokeSessionsOnRoleChange, SESSION_COOKIE,
} from '../auth'

const JWT_SECRET = vi.hoisted(() => {
  process.env.JWT_SECRET = 'test-secret-session-revocation'
  process.env.NODE_ENV = 'test'
  return 'test-secret-session-revocation'
})

const findUnique = vi.fn()
const update = vi.fn()
vi.mock('../../services/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...a: any[]) => findUnique(...a),
      update: (...a: any[]) => update(...a),
    },
  },
  hasDb: true,
}))

async function callMiddleware(token: string): Promise<{ status: number; userId?: string }> {
  return new Promise((resolve) => {
    const req: any = { headers: { authorization: `Bearer ${token}` } }
    const res: any = {
      status(s: number) { this.status = s; return this },
      json() { resolve({ status: this.status }) },
    }
    authenticateToken(req, res, () => resolve({ status: 200, userId: req.userId }))
  })
}

describe('session revocation', () => {
  it('rejects tokens issued before the stamp and accepts the replacement', async () => {
    const stale = jwt.sign({ userId: 'u1' }, JWT_SECRET, { expiresIn: '7d' })
    update.mockImplementation(async ({ data }: { data: { sessionInvalidatedAt: Date } }) => data)
    const invalidatedAt = await revokeUserSessions('u1')
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'u1' },
      data: expect.objectContaining({ sessionInvalidatedAt: invalidatedAt }),
    }))
    const fresh = signSession('u1', sessionIatAfter(invalidatedAt))
    findUnique.mockResolvedValue({ sessionInvalidatedAt: invalidatedAt })
    expect((await callMiddleware(stale)).status).toBe(401)
    const ok = await callMiddleware(fresh)
    expect(ok.status).toBe(200)
    expect(ok.userId).toBe('u1')
  })

  it('writes 2FA changes in the same update as the stamp', async () => {
    update.mockImplementation(async ({ data }: { data: unknown }) => data)
    await revokeUserSessions('u1', { totpEnabled: true })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ totpEnabled: true, sessionInvalidatedAt: expect.any(Date) }),
    }))
  })

  it('revokes sessions only when an admin is demoted', () => {
    expect(shouldRevokeSessionsOnRoleChange('admin', 'user')).toBe(true)
    expect(shouldRevokeSessionsOnRoleChange('user', 'admin')).toBe(false)
    expect(shouldRevokeSessionsOnRoleChange('user', 'user')).toBe(false)
    expect(shouldRevokeSessionsOnRoleChange('admin', undefined)).toBe(false)
  })

  it('sets an httpOnly SameSite cookie and does not put the token in a script-readable attribute', () => {
    const headers: string[] = []
    const res = { append: (_name: string, value: string) => { headers.push(value) } }
    setSessionCookie(res as any, 'header.payload.sig')
    expect(headers).toHaveLength(1)
    expect(headers[0].startsWith(`${SESSION_COOKIE}=`)).toBe(true)
    expect(headers[0]).toContain('HttpOnly')
    expect(headers[0]).toContain('SameSite=Lax')
    expect(headers[0]).not.toContain('Secure')
  })
})
