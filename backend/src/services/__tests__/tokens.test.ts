import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ token: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() } }))
vi.mock('../prisma', () => ({ prisma: db, hasDb: true }))
import { consumeToken, createToken, TTL } from '../tokens'

describe('one-time tokens', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns a random secret but stores only its digest', async () => {
    const before = Date.now()
    const raw = await createToken('user-1', 'reset')
    expect(raw).toMatch(/^[a-f0-9]{48}$/)
    const { data } = db.token.create.mock.calls[0][0]
    expect(data.token).toBe(createHash('sha256').update(raw!).digest('hex'))
    expect(data.token).not.toBe(raw)
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + TTL.reset)
    expect(data.userId).toBe('user-1')
  })

  it('claims a token with a conditional expiry/unused write', async () => {
    db.token.findUnique.mockResolvedValue({ id: 'token-1', userId: 'user-1', type: 'reset', usedAt: null })
    db.token.updateMany.mockResolvedValue({ count: 1 })
    expect(await consumeToken('secret', 'reset')).toBe('user-1')
    expect(db.token.updateMany).toHaveBeenCalledWith({
      where: { id: 'token-1', type: 'reset', usedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: { usedAt: expect.any(Date) },
    })
  })

  it('returns no identity when another request claims the token first', async () => {
    db.token.findUnique.mockResolvedValue({ id: 'token-1', userId: 'user-1', type: 'reset', usedAt: null })
    db.token.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    expect(await Promise.all([consumeToken('secret', 'reset'), consumeToken('secret', 'reset')]))
      .toEqual(['user-1', null])
  })

  it.each([null, { type: 'verify' }, { type: 'reset', usedAt: new Date() }])('rejects missing, wrong-purpose, or used tokens', async (row) => {
    db.token.findUnique.mockResolvedValue(row)
    expect(await consumeToken('secret', 'reset')).toBeNull()
    expect(db.token.updateMany).not.toHaveBeenCalled()
  })

  it('rejects empty input without a query', async () => {
    expect(await consumeToken('', 'reset')).toBeNull()
    expect(db.token.findUnique).not.toHaveBeenCalled()
  })
})
