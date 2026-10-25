/**
 * Orphan box reaper: sync-then-kill stale rows, skip freshly touched boxes.
 * Stale-row cases keep the untracked sweep off (isE2BConfigured=false).
 * The grace-period cases turn that sweep on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const findMany = vi.fn()
const findUnique = vi.fn()
const update = vi.fn()
const connect = vi.fn()
const list = vi.fn(() => ({ hasNext: false, nextItems: async () => [] as unknown[] }))
const syncWorkspaceOut = vi.fn()
const isE2BConfigured = vi.fn(() => false)

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
  isE2BConfigured: () => isE2BConfigured(),
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
    list: (...args: unknown[]) => list(...args),
  },
}))

import { reapOrphanBoxes } from '../botBox'

const STALE_MS = 3 * 60 * 60_000 // older than the 2h reaper window

function sandboxPage(items: Array<{ sandboxId: string; startedAt?: Date }>) {
  let pending = true
  return {
    get hasNext() { return pending },
    async nextItems() {
      pending = false
      return items
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  update.mockResolvedValue({})
  syncWorkspaceOut.mockResolvedValue(1)
  isE2BConfigured.mockReturnValue(false)
  list.mockImplementation(() => ({ hasNext: false, nextItems: async () => [] }))
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

  it('does not kill an untracked sandbox that started just now', async () => {
    isE2BConfigured.mockReturnValue(true)
    findMany.mockResolvedValue([])
    const kill = vi.fn(async () => undefined)
    connect.mockResolvedValue({ kill })
    list.mockImplementation((opts?: { query?: { metadata?: { loopGpt?: string } } }) => {
      const tag = opts?.query?.metadata?.loopGpt
      if (tag === 'bot-box') return sandboxPage([{ sandboxId: 'sbx-booting', startedAt: new Date() }])
      if (tag === 'bot-desktop') return sandboxPage([{ sandboxId: 'sbx-desktop-booting', startedAt: new Date() }])
      return sandboxPage([])
    })

    await reapOrphanBoxes()

    expect(connect).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('kills an untracked sandbox that started more than 15 minutes ago', async () => {
    isE2BConfigured.mockReturnValue(true)
    findMany.mockResolvedValue([])
    const kill = vi.fn(async () => undefined)
    connect.mockResolvedValue({ kill })
    const startedAt = new Date(Date.now() - 20 * 60 * 1000)
    list.mockImplementation((opts?: { query?: { metadata?: { loopGpt?: string } } }) => {
      const tag = opts?.query?.metadata?.loopGpt
      if (tag === 'bot-box') return sandboxPage([{ sandboxId: 'sbx-stale-untracked', startedAt }])
      return sandboxPage([])
    })

    await reapOrphanBoxes()

    expect(connect).toHaveBeenCalledWith('sbx-stale-untracked')
    expect(kill).toHaveBeenCalled()
  })
})
