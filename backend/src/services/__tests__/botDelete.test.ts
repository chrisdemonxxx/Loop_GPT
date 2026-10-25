import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  bot: { findFirst: vi.fn(), delete: vi.fn() },
  conversation: { deleteMany: vi.fn() },
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
}))

vi.mock('../prisma', () => ({ prisma: db, hasDb: true }))

import { deleteBot } from '../bots'

beforeEach(() => {
  vi.clearAllMocks()
  db.bot.delete.mockResolvedValue({})
  db.conversation.deleteMany.mockResolvedValue({ count: 1 })
})

describe('deleteBot', () => {
  it('removes the bot\'s own threads with the bot', async () => {
    db.bot.findFirst.mockResolvedValue({ id: 'bot-1', ownerId: 'owner-1', isPrimary: false })
    expect(await deleteBot('owner-1', 'bot-1')).toEqual({ ok: true })
    expect(db.conversation.deleteMany).toHaveBeenCalledWith({ where: { userId: 'owner-1', botId: 'bot-1', kind: 'bot' } })
    expect(db.bot.delete).toHaveBeenCalledWith({ where: { id: 'bot-1' } })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  it('leaves conversations alone when the bot is not the caller\'s', async () => {
    db.bot.findFirst.mockResolvedValue(null)
    await expect(deleteBot('owner-1', 'bot-x')).rejects.toMatchObject({ code: 'not_found' })
    expect(db.conversation.deleteMany).not.toHaveBeenCalled()
    expect(db.bot.delete).not.toHaveBeenCalled()
  })

  it('refuses the primary bot without touching its threads', async () => {
    db.bot.findFirst.mockResolvedValue({ id: 'bot-1', ownerId: 'owner-1', isPrimary: true })
    await expect(deleteBot('owner-1', 'bot-1')).rejects.toMatchObject({ code: 'forbidden' })
    expect(db.conversation.deleteMany).not.toHaveBeenCalled()
  })
})
