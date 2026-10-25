import { beforeEach, describe, expect, it, vi } from 'vitest'

const findFirst = vi.fn()
const createTask = vi.fn()
const update = vi.fn()
const createRun = vi.fn()

vi.mock('../prisma', () => ({
  hasDb: true,
  prisma: {
    agentTask: {
      findFirst: (...args: unknown[]) => findFirst(...args),
      create: (...args: unknown[]) => createTask(...args),
    },
    botRun: {
      update: (...args: unknown[]) => update(...args),
      create: (...args: unknown[]) => createRun(...args),
    },
  },
}))

vi.mock('../agentTasks', () => ({
  remainingVmMinutes: vi.fn(async () => 30),
  AgentTaskError: class AgentTaskError extends Error {
    code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  },
}))

import { recordInteractiveVmMinutes } from '../botComputerMeter'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'))
  update.mockResolvedValue({})
  createRun.mockResolvedValue({})
})

describe('recordInteractiveVmMinutes', () => {
  it('does not move lastSettledAt when no whole minute has elapsed', async () => {
    findFirst.mockResolvedValueOnce(null)
    createTask.mockResolvedValue({ id: 'task-1', runs: [] })

    await expect(recordInteractiveVmMinutes('user-1')).resolves.toBe(1)
    const first = createRun.mock.calls[0][0].data.computer
    expect(first.minutes).toBe(1)
    expect(first.lastSettledAt).toBe('2026-10-24T12:00:00.000Z')

    findFirst.mockResolvedValue({
      id: 'task-1',
      runs: [{ id: 'run-1', computer: first }],
    })
    vi.setSystemTime(new Date('2026-10-24T12:00:30.000Z'))

    await expect(recordInteractiveVmMinutes('user-1')).resolves.toBe(0)
    expect(update).not.toHaveBeenCalled()

    vi.setSystemTime(new Date('2026-10-24T12:02:30.000Z'))
    await expect(recordInteractiveVmMinutes('user-1')).resolves.toBe(2)
    expect(update.mock.calls[0][0].data.computer).toMatchObject({
      minutes: 3,
      lastSettledAt: '2026-10-24T12:02:30.000Z',
    })
  })
})
