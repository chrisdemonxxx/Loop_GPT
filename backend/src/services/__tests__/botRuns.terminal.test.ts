import { beforeEach, describe, expect, it, vi } from 'vitest'

const create = vi.fn()
const update = vi.fn()
const updateMany = vi.fn()
const findMany = vi.fn()

vi.mock('../prisma', () => ({
  hasDb: true,
  prisma: {
    botRun: {
      create: (...args: unknown[]) => create(...args),
      update: (...args: unknown[]) => update(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
}))

import { reconcileStuckBotRuns, startRun, subscribe } from '../botRuns'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  create.mockResolvedValue({})
  update.mockResolvedValue({})
  updateMany.mockResolvedValue({ count: 1 })
})

describe('terminal run writes', () => {
  it('does not let a debounced running snapshot overwrite a completed run', async () => {
    const calls: string[] = []
    update.mockImplementation(async (args: { data: { status: string } }) => {
      calls.push(`update:${args.data.status}`)
    })
    updateMany.mockImplementation(async (args: { data: { status: string }; where: { status?: string } }) => {
      calls.push(`updateMany:${args.data.status}:${args.where.status}`)
    })

    const run = await startRun('task-terminal')
    run.emit({ type: 'status', message: 'working' })
    await vi.advanceTimersByTimeAsync(400)
    await run.complete({ content: 'done', artifacts: [], usage: { tokensIn: 0, tokensOut: 0 } })

    expect(calls).not.toContain('update:running')
    expect(calls.at(-1)).toBe('update:completed')
  })

  it('does not mark a run abandoned when its task already succeeded', async () => {
    const run = await startRun('task-succeeded')
    const seen: string[] = []
    subscribe(run.runId, (event) => { seen.push(event.type) })
    findMany.mockResolvedValue([{
      id: run.runId,
      computer: {},
      task: { status: 'succeeded', leaseExpiresAt: new Date(0) },
    }])

    await reconcileStuckBotRuns()

    expect(update).not.toHaveBeenCalled()
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: run.runId, status: 'running' },
      data: expect.objectContaining({ status: 'completed' }),
    }))
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain('abandoned')
    expect(seen).toContain('done')
  })
})
