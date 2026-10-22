import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  bot: { findFirst: vi.fn() },
  conversation: { findFirst: vi.fn() },
  agentTask: { create: vi.fn() },
}))

vi.mock('../prisma', () => ({ prisma: db, hasDb: true }))

import { AgentTaskError, enqueueAgentTask } from '../agentTasks'

beforeEach(() => {
  vi.clearAllMocks()
  db.bot.findFirst.mockResolvedValue({ id: 'bot-1' })
  db.conversation.findFirst.mockResolvedValue({ id: 'conv-1' })
  db.agentTask.create.mockResolvedValue({
    id: 'task-1',
    kind: 'ops',
    status: 'queued',
    nextAttemptAt: new Date('2026-10-22T12:00:00.000Z'),
    computer: null,
    skillId: null,
  })
})

describe('enqueueAgentTask conversation', () => {
  it('stores the bot thread id on the task', async () => {
    await enqueueAgentTask({ goal: 'Check the inbox', botId: 'bot-1', conversationId: 'conv-1' }, 'owner-1', 'owner-1')
    expect(db.conversation.findFirst).toHaveBeenCalledWith({
      where: { id: 'conv-1', userId: 'owner-1', kind: 'bot', botId: 'bot-1' },
      select: { id: true },
    })
    expect(db.agentTask.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ conversationId: 'conv-1', botId: 'bot-1', userId: 'owner-1' }),
    }))
  })

  it('refuses a thread the owner does not have on this bot', async () => {
    db.conversation.findFirst.mockResolvedValue(null)
    await expect(enqueueAgentTask(
      { goal: 'Check the inbox', botId: 'bot-1', conversationId: 'conv-other' },
      'owner-1',
      'owner-1',
    )).rejects.toBeInstanceOf(AgentTaskError)
    expect(db.agentTask.create).not.toHaveBeenCalled()
  })
})
