/**
 * Orphan box reaper: sync-then-kill stale rows, skip freshly touched boxes.
 * Untracked provider sweep is gated off via isE2BConfigured=false.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const findMany = vi.fn()
const findUnique = vi.fn()
const update = vi.fn()
const connect = vi.fn()
const syncWorkspaceOut = vi.fn()

vi.mock('../prisma', () => ({
  prisma: {
    botBox: {
      findMany: (...args: unknown[]) => findMany(...args),
      findUnique: (...args: unknown[]) => findUnique(...args),
      update: (...args: unknown[]) => update(...args),
    },
    botRun: { findMany: vi.fn(async () => []) },
  },
  hasDb: true,
}))

vi.mock('../e2bDesktop', () => ({
  buildVncUrls: vi.fn(),
  isE2BConfigured: () => false,
}))

vi.mock('../botMemory', () => ({
  readBotMemory: vi.fn(() => ''),
}))

vi.mock('../workspaceSync', () => ({
  restoreWorkspaceIn: vi.fn(),
  syncWorkspaceOut: (...args: unknown[]) => syncWorkspaceOut(...args),
  syncWorkspaceThrottled: vi.fn(),
}))

vi.mock('@e2b/desktop', () => ({
  Sandbox: {
    connect: (...args: unknown[]) => connect(...args),
    list: vi.fn(() => ({ hasNext: false, nextItems: async () => [] })),
  },
}))

import { reapOrphanBoxes } from '../botBox'

const STALE_MS = 3 * 60 * 60_000 // older than the 2h reaper window

beforeEach(() => {
  vi.clearAllMocks()
  update.mockResolvedValue({})
  syncWorkspaceOut.mockResolvedValue(1)
})

describe('reapOrphanBoxes', () => {
  it('syncs then kills a stale box and clears the DB pointer', async () => {
    const updatedAt = new Date(Date.now() - STALE_MS)
    findMany.mockResolvedValue([{ userId: 'u1', sandboxId: 'sbx-old', updatedAt }])
    findUnique.mockResolvedValue({ userId: 'u1', sandboxId: 'sbx-old', updatedAt })
    const kill = vi.fn(async () => undefined)
    connect.mockResolvedValue({ kill })

    await reapOrphanBoxes()

    expect(connect).toHaveBeenCalledWith('sbx-old')
    expect(syncWorkspaceOut).toHaveBeenCalled()
    expect(kill).toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { sandboxId: '' },
    })
  })

  it('skips a box that was touched after the stale scan (freshness re-check)', async () => {
    const staleAt = new Date(Date.now() - STALE_MS)
    findMany.mockResolvedValue([{ userId: 'u2', sandboxId: 'sbx-hot', updatedAt: staleAt }])
    // Concurrent wake bumped updatedAt past the idle window.
    findUnique.mockResolvedValue({
      userId: 'u2',
      sandboxId: 'sbx-hot',
      updatedAt: new Date(),
    })

    await reapOrphanBoxes()

    expect(connect).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('clears the DB pointer when the provider sandbox is already gone', async () => {
    const updatedAt = new Date(Date.now() - STALE_MS)
    findMany.mockResolvedValue([{ userId: 'u3', sandboxId: 'sbx-gone', updatedAt }])
    findUnique.mockResolvedValue({ userId: 'u3', sandboxId: 'sbx-gone', updatedAt })
    connect.mockRejectedValue(new Error('sandbox not found'))

    await reapOrphanBoxes()

    expect(update).toHaveBeenCalledWith({
      where: { userId: 'u3' },
      data: { sandboxId: '' },
    })
  })
})
