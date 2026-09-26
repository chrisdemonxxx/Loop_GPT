import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  message: { findMany: vi.fn(), findUnique: vi.fn() },
  conversation: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
}))
vi.mock('../prisma', () => ({ prisma: db, hasDb: true }))
import { getHistory, getOrCreateConversation } from '../chatStore'

describe('database conversation context', () => {
  beforeEach(() => vi.resetAllMocks())

  it('queries the newest window and returns chronological messages (no active leaf → legacy flat read)', async () => {
    db.conversation.findUnique.mockResolvedValue({ activeLeafId: null })
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

  it('reads the newest window of the ACTIVE PATH — off-path versions never enter context (§8-22)', async () => {
    db.conversation.findUnique.mockResolvedValue({ activeLeafId: 'a-new' })
    db.message.findUnique.mockResolvedValue({ conversationId: 'conversation' })
    // Skeleton pass (ids + parents): a retry created a sibling answer.
    db.message.findMany
      .mockResolvedValueOnce([
        { id: 'u1', parentId: null }, { id: 'a1', parentId: 'u1' }, { id: 'u2', parentId: 'a1' },
        { id: 'a-old', parentId: 'u2' }, { id: 'a-new', parentId: 'u2' },
      ])
      // Window pass: the full rows of the path's newest slice.
      .mockResolvedValueOnce([
        { id: 'u2', createdAt: new Date('2026-01-02'), content: 'the prompt' },
        { id: 'a-new', createdAt: new Date('2026-01-03'), content: 'the regenerated answer' },
      ])
    const history = await getHistory('conversation', 2)
    expect(history.map((m) => m.content)).toEqual(['the prompt', 'the regenerated answer'])
    // The skeleton pass is light; the window pass fetches only path rows.
    expect(db.message.findMany).toHaveBeenNthCalledWith(1, { where: { conversationId: 'conversation' }, select: { id: true, parentId: true } })
    expect(db.message.findMany).toHaveBeenNthCalledWith(2, { where: { id: { in: ['u2', 'a-new'] } } })
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
