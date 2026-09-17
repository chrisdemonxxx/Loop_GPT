import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ message: { findMany: vi.fn() }, conversation: { findFirst: vi.fn() }, user: { findUnique: vi.fn() } }))
vi.mock('../prisma', () => ({ prisma: db, hasDb: true }))
import { getHistory, getOrCreateConversation } from '../chatStore'

describe('database conversation context', () => {
  beforeEach(() => vi.resetAllMocks())

  it('queries the newest window and returns chronological messages', async () => {
    db.message.findMany.mockResolvedValue([
      { id: 'last', createdAt: new Date('2026-01-03'), content: 'last turn' },
      { id: 'previous', createdAt: new Date('2026-01-02'), content: 'previous turn' },
    ])
    expect((await getHistory('conversation', 2)).map((m) => m.content)).toEqual(['previous turn', 'last turn'])
    expect(db.message.findMany).toHaveBeenCalledWith({
      where: { conversationId: 'conversation' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2,
    })
  })

  it('returns no messages for an empty window without querying', async () => {
    expect(await getHistory('conversation', 0)).toEqual([])
    expect(db.message.findMany).not.toHaveBeenCalled()
  })

  it.each([-1, 0.5, NaN, Infinity, 501])('rejects invalid context window %s', async (take) => {
    await expect(getHistory('conversation', take)).rejects.toThrow(RangeError)
  })

  it('retains ownership predicates even for the opted-in development identity', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('ENABLE_DEV_MODE', 'true')
    db.user.findUnique.mockResolvedValue({ id: 'dev-user-123' })
    db.conversation.findFirst.mockResolvedValue(null)
    try {
      expect(await getOrCreateConversation('dev-user-123', 'foreign', 'Title')).toBeNull()
      expect(db.conversation.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign', userId: 'dev-user-123' } })
    } finally { vi.unstubAllEnvs() }
  })

  it('rejects missing identity before database lookup', async () => {
    expect(await getOrCreateConversation(undefined as any, 'foreign', 'Title')).toBeNull()
    expect(db.conversation.findFirst).not.toHaveBeenCalled()
  })
})
