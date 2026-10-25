import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  bot: { findFirst: vi.fn() },
  conversation: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  agentTask: { create: vi.fn(), findMany: vi.fn() },
  message: { create: vi.fn() },
}))

vi.mock('../prisma', () => ({ prisma: db, hasDb: true }))

import { AgentTaskError, enqueueAgentTask, listAgentTasks } from '../agentTasks'

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
  db.conversation.findUnique.mockResolvedValue({ activeLeafId: null })
  db.conversation.update.mockResolvedValue({})
  db.message.create.mockResolvedValue({
    id: 'msg-1',
    role: 'user',
    content: 'Check the inbox',
    createdAt: new Date('2026-10-22T12:00:00.000Z'),
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
    expect(db.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: 'user', content: 'Check the inbox', conversationId: 'conv-1' }),
    }))
  })

  it('lists a user thread newest-first and includes the latest run result', async () => {
    db.agentTask.findMany.mockResolvedValue([
      { id: 'new', createdAt: new Date('2026-10-24T12:00:00Z'), runs: [{ result: 'newest answer' }] },
      { id: 'old', createdAt: new Date('2026-10-24T11:00:00Z'), runs: [{ result: null }] },
    ])
    const tasks = await listAgentTasks({ scope: { userId: 'owner-1' }, conversationId: 'conv-1' })
    expect(db.agentTask.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { createdAt: 'desc' },
      where: expect.objectContaining({
        userId: 'owner-1',
        conversationId: 'conv-1',
        goal: { not: '__interactive_computer__' },
      }),
    }))
    expect(tasks.map((task) => task.id)).toEqual(['new', 'old'])
    expect(tasks[0].result).toBe('newest answer')
    expect(tasks[1].result).toBeNull()
    expect('runs' in tasks[0]).toBe(false)
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
