import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  bot: { findFirst: vi.fn() },
  conversation: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  message: { create: vi.fn() },
}))

vi.mock('../prisma', () => ({ prisma: db, hasDb: true }))

import { createBotThread, listBotThreads, openBotThread } from '../bots'

const bot = { id: 'bot-1', name: 'Helm', ownerId: 'owner-1' }

beforeEach(() => {
  vi.clearAllMocks()
  db.bot.findFirst.mockResolvedValue(bot)
  db.conversation.create.mockResolvedValue({ id: 'conv-new', title: 'New chat', botId: 'bot-1', kind: 'bot' })
  db.message.create.mockResolvedValue({ id: 'msg-1' })
  db.conversation.update.mockResolvedValue({})
})

describe('bot threads', () => {
  it('reopens the latest thread', async () => {
    db.conversation.findFirst.mockResolvedValue({ id: 'conv-old', title: 'Helm' })
    const thread = await openBotThread('owner-1', 'bot-1', 'Ada')
    expect(thread.id).toBe('conv-old')
    expect(db.conversation.create).not.toHaveBeenCalled()
  })

  it('always inserts on the create path, even when a thread already exists', async () => {
    db.conversation.findFirst.mockResolvedValue({ id: 'conv-old', title: 'Helm' })
    const thread = await createBotThread('owner-1', 'bot-1', 'Ada')
    expect(thread.id).toBe('conv-new')
    expect(db.conversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'owner-1',
        botId: 'bot-1',
        kind: 'bot',
        title: 'New chat',
      }),
    })
    expect(db.conversation.findFirst).not.toHaveBeenCalled()
  })

  it('lists only this bot\'s threads, newest first', async () => {
    const updatedAt = new Date('2026-10-22T12:00:00.000Z')
    const createdAt = new Date('2026-10-21T12:00:00.000Z')
    db.conversation.findMany.mockResolvedValue([{ id: 'conv-2', title: 'Later', createdAt, updatedAt }])
    const threads = await listBotThreads('owner-1', 'bot-1')
    expect(db.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'owner-1', botId: 'bot-1', kind: 'bot', incognito: false },
      orderBy: { updatedAt: 'desc' },
    }))
    expect(threads).toEqual([{
      id: 'conv-2',
      title: 'Later',
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    }])
  })
})
