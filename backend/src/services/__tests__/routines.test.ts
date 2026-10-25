import { beforeEach, describe, expect, it, vi } from 'vitest'

const enqueueAgentTask = vi.fn()
const cancelAgentTask = vi.fn()
const findFirst = vi.fn()
const findMany = vi.fn()
const updateMany = vi.fn()

vi.mock('../prisma', () => ({
  hasDb: true,
  prisma: {
    agentTask: {
      findFirst: (...args: unknown[]) => findFirst(...args),
      findMany: (...args: unknown[]) => findMany(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
    },
  },
}))

vi.mock('../agentTasks', () => ({
  enqueueAgentTask: (...args: unknown[]) => enqueueAgentTask(...args),
  cancelAgentTask: (...args: unknown[]) => cancelAgentTask(...args),
}))

import { createRoutine, deleteRoutine, listRoutines } from '../routines'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('routines', () => {
  it('copies allowed tools, computer, and conversation onto the scheduled task', async () => {
    enqueueAgentTask.mockResolvedValue({
      id: 'routine-1',
      goal: 'Check deploys',
      schedule: '6h',
      skillId: null,
      botId: 'bot-1',
      status: 'queued',
      nextAttemptAt: new Date('2026-10-24T12:00:00Z'),
      createdAt: new Date('2026-10-24T12:00:00Z'),
    })

    await createRoutine('user-1', {
      goal: 'Check deploys',
      schedule: '6h',
      botId: 'bot-1',
      allowedTools: ['web_search', 'execute_code'],
      computer: { enabled: true, ttlMinutes: 30 },
      conversationId: 'conv-1',
    })

    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'scheduled',
        goal: 'Check deploys',
        schedule: '6h',
        botId: 'bot-1',
        allowedTools: ['web_search', 'execute_code'],
        computer: { enabled: true, ttlMinutes: 30 },
        conversationId: 'conv-1',
      }),
      'user-1',
      'user-1',
    )
  })

  it('includes the latest run result text', async () => {
    findMany.mockResolvedValue([{
      id: 'routine-1',
      goal: 'Check deploys',
      schedule: '6h',
      skillId: null,
      botId: 'bot-1',
      status: 'queued',
      nextAttemptAt: new Date('2026-10-24T18:00:00Z'),
      createdAt: new Date('2026-10-24T12:00:00Z'),
      runs: [{
        id: 'run-1',
        status: 'completed',
        error: null,
        result: 'All green',
        startedAt: new Date('2026-10-24T12:05:00Z'),
        completedAt: new Date('2026-10-24T12:06:00Z'),
      }],
    }])

    const routines = await listRoutines('user-1')

    expect(routines[0].result).toBe('All green')
    expect(routines[0].runs[0].result).toBe('All green')
  })

  it('does not turn a database error into an empty list', async () => {
    findMany.mockRejectedValue(new Error('db down'))
    await expect(listRoutines('user-1')).rejects.toThrow(/db down/)
  })

  it('cancels a dead-lettered routine', async () => {
    findFirst.mockResolvedValue({ status: 'dead_letter' })
    updateMany.mockResolvedValue({ count: 1 })

    await expect(deleteRoutine('user-1', 'routine-1')).resolves.toBe(true)

    expect(cancelAgentTask).not.toHaveBeenCalled()
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'routine-1', userId: 'user-1', kind: 'scheduled', status: 'dead_letter' },
      data: {
        status: 'cancelled',
        leaseToken: null,
        leaseExpiresAt: null,
        cancelRequested: false,
      },
    })
  })

  it('cancels a paused routine whose last run already finished', async () => {
    findFirst.mockResolvedValue({ status: 'succeeded' })
    updateMany.mockResolvedValue({ count: 1 })

    await expect(deleteRoutine('user-1', 'routine-1')).resolves.toBe(true)

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'routine-1', userId: 'user-1', kind: 'scheduled', status: 'succeeded' },
      data: {
        status: 'cancelled',
        leaseToken: null,
        leaseExpiresAt: null,
        cancelRequested: false,
      },
    })
  })
})
