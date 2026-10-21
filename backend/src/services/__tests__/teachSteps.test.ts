import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryRaw = vi.fn()
const findUnique = vi.fn()
const update = vi.fn()

vi.mock('../prisma', () => ({
  hasDb: true,
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: (...args: unknown[]) => queryRaw(...args),
      botRun: {
        findUnique: (...args: unknown[]) => findUnique(...args),
        update: (...args: unknown[]) => update(...args),
      },
    }),
    botRun: {
      findUnique: (...args: unknown[]) => findUnique(...args),
    },
  },
}))

import { clearTeachSteps, loadTeachSteps, recordTeachStep } from '../teachSteps'

const click = { at: 10, kind: 'click' as const, x: 640, y: 400 }

function row(overrides: Record<string, unknown> = {}) {
  return {
    status: 'running',
    takeoverRequested: true,
    computer: { sandboxId: 'sbx-1' },
    task: { kind: 'teach', userId: 'user-1' },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearTeachSteps('run-1')
  queryRaw.mockResolvedValue([{ '?column?': 1 }])
  findUnique.mockResolvedValue(row())
  update.mockImplementation(async ({ data }: { data: { computer: { teachSteps?: unknown[] } } }) => {
    findUnique.mockResolvedValue(row({ computer: data.computer }))
  })
})

describe('recordTeachStep', () => {
  it('appends a framebuffer step on a live teach takeover and mirrors it for the worker', async () => {
    const result = await recordTeachStep('run-1', 'user-1', click)
    expect(result).toEqual({ ok: true, stored: true })
    expect(update).toHaveBeenCalledTimes(1)
    const written = update.mock.calls[0][0].data.computer
    expect(written.sandboxId).toBe('sbx-1')
    expect(written.teachSteps).toEqual([click])

    clearTeachSteps('run-1')
    await expect(loadTeachSteps('run-1')).resolves.toEqual([click])
  })

  it('stores a step on a running teach run before takeover is flagged', async () => {
    findUnique.mockResolvedValue(row({ takeoverRequested: false }))
    const result = await recordTeachStep('run-1', 'user-1', click)
    expect(result).toEqual({ ok: true, stored: true })
    expect(update).toHaveBeenCalledTimes(1)
    const written = update.mock.calls[0][0].data.computer
    expect(written.sandboxId).toBe('sbx-1')
    expect(written.teachSteps).toEqual([click])
    await expect(loadTeachSteps('run-1')).resolves.toEqual([click])
  })

  it('does not store a step for a non-teach run', async () => {
    findUnique.mockResolvedValue(row({ task: { kind: 'ops', userId: 'user-1' }, takeoverRequested: true }))
    const result = await recordTeachStep('run-1', 'user-1', click)
    expect(result).toEqual({ ok: true, stored: false })
    expect(update).not.toHaveBeenCalled()
    await expect(loadTeachSteps('run-1')).resolves.toEqual([])
  })

  it('rejects a click without framebuffer coordinates only while recording', async () => {
    const result = await recordTeachStep('run-1', 'user-1', { at: 1, kind: 'click' })
    expect(result).toMatchObject({ ok: false, status: 400, code: 'invalid_request' })
    expect(update).not.toHaveBeenCalled()
  })

  it('hides runs the caller does not own', async () => {
    const result = await recordTeachStep('run-1', 'someone-else', click)
    expect(result).toMatchObject({ ok: false, status: 404 })
    expect(update).not.toHaveBeenCalled()
  })
})
