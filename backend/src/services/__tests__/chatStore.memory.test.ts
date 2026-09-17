import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../prisma', () => ({ prisma: null, hasDb: false }))
const memory = vi.hoisted(() => ({ getMessages: vi.fn() }))
vi.mock('../memoryStore', () => ({ memoryStore: memory }))
import { getHistory } from '../chatStore'

describe('memory conversation context', () => {
  beforeEach(() => vi.resetAllMocks())
  it('matches database window semantics', async () => {
    memory.getMessages.mockReturnValue([1, 2, 3].map((id) => ({ id: String(id), createdAt: new Date(id * 1000) })))
    expect((await getHistory('conversation', 2)).map((m) => m.id)).toEqual(['2', '3'])
  })
  it('does not return all messages for take=0', async () => {
    expect(await getHistory('conversation', 0)).toEqual([])
    expect(memory.getMessages).not.toHaveBeenCalled()
  })
})
