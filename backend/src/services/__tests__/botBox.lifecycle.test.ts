/**
 * Sleep pauses the live sandbox without deleting it.
 * Recover replaces a wedged sandbox and restores the durable mirror.
 * Reset refuses to run without confirm, then boots a clean desktop.
 * Disk reports asleep when the box is down and warns when free space is low.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const remainingVmMinutes = vi.fn()
const findUnique = vi.fn()
const update = vi.fn()
const upsert = vi.fn()
const create = vi.fn()
const connect = vi.fn()
const awaitGnomeDesktop = vi.fn()
const restoreWorkspaceIn = vi.fn(async () => 1)
const syncWorkspaceOut = vi.fn(async () => undefined)

vi.mock('../prisma', () => ({
  prisma: {
    botBox: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      findMany: vi.fn(async () => []),
      update: (...args: unknown[]) => update(...args),
      upsert: (...args: unknown[]) => upsert(...args),
    },
    bot: { findMany: vi.fn(async () => []) },
    botRun: { findMany: vi.fn(async () => []) },
  },
  hasDb: true,
}))

vi.mock('../e2bDesktop', () => ({
  buildVncUrls: () => ({ viewUrl: '/view', interactiveUrl: '/interactive' }),
  isE2BConfigured: () => true,
}))

vi.mock('../gnomeSession', () => ({
  awaitGnomeDesktop: (...args: unknown[]) => awaitGnomeDesktop(...args),
  desktopTemplateId: () => 'gnome-template',
  seedDesktopLaunchers: vi.fn(async () => undefined),
}))

vi.mock('../botMemory', () => ({
  readBotMemory: vi.fn(() => ''),
}))

vi.mock('../workspaceSync', () => ({
  restoreWorkspaceIn: (...args: unknown[]) => restoreWorkspaceIn(...args),
  syncWorkspaceOut: (...args: unknown[]) => syncWorkspaceOut(...args),
  syncWorkspaceThrottled: vi.fn(),
}))

vi.mock('../agentTasks', () => {
  class AgentTaskError extends Error {
    code: string
    constructor(code: string, detail?: string) {
      super(detail || code)
      this.code = code
    }
  }
  return {
    AgentTaskError,
    remainingVmMinutes: (...args: unknown[]) => remainingVmMinutes(...args),
  }
})

vi.mock('@e2b/desktop', () => ({
  Sandbox: {
    create: (...args: unknown[]) => create(...args),
    connect: (...args: unknown[]) => connect(...args),
    list: vi.fn(() => ({ hasNext: false, nextItems: async () => [] })),
  },
}))

import { ensureUserBox, getComputerStatus, parseDfBytes, pauseUserBox, readBoxDisk, recoverUserBox, resetUserBox } from '../botBox'

const LOW_DISK = [
  'Filesystem 1B-blocks Used Available Use% Mounted on',
  '/dev/vda 10000000000 9500000000 500000000 95% /',
  '/dev/vda 10000000000 9600000000 400000000 96% /workspace',
].join('\n')

function fakeSandbox(id: string, stdout = '') {
  return {
    sandboxId: id,
    commands: { run: vi.fn(async () => ({ exitCode: 0, stdout, stderr: '' })) },
    stream: {
      start: vi.fn(async () => undefined),
      getAuthKey: () => 'stream-key',
    },
    setTimeout: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    pause: vi.fn(async () => true),
    createSnapshot: vi.fn(async () => ({ snapshotId: `snap-${id}` })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  create.mockReset()
  connect.mockReset()
  findUnique.mockResolvedValue(null)
  update.mockResolvedValue({})
  upsert.mockResolvedValue({})
  awaitGnomeDesktop.mockResolvedValue(undefined)
  restoreWorkspaceIn.mockResolvedValue(1)
  remainingVmMinutes.mockResolvedValue(30)
})

describe('computer sleep, recover, reset, and disk', () => {
  it('sleep pauses the live sandbox and leaves its id in place', async () => {
    const sandbox = fakeSandbox('sbx-sleep')
    create.mockResolvedValue(sandbox)
    await ensureUserBox('user-sleep', 'ada')
    findUnique.mockResolvedValue({
      sandboxId: 'sbx-sleep',
      streamAuthKey: 'auth-key',
      streamUrl: '/stored',
      interactiveUrl: null,
      takeoverRequested: false,
    })

    const slept = await pauseUserBox('user-sleep')
    const status = await getComputerStatus('user-sleep')

    expect(sandbox.pause).toHaveBeenCalledTimes(1)
    expect(sandbox.kill).not.toHaveBeenCalled()
    expect(slept).toMatchObject({ alive: false, sandboxId: 'sbx-sleep', paused: true })
    expect(status.alive).toBe(false)
    expect(status.paused).toBe(true)
    expect(status.sandboxId).toBe('sbx-sleep')
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-sleep' },
      data: expect.objectContaining({ pausedAt: expect.any(Date) }),
    }))
  })

  it('recover syncs the workspace out, replaces the sandbox, and restores the mirror', async () => {
    const wedged = fakeSandbox('sbx-wedged')
    const fresh = fakeSandbox('sbx-fresh')
    create.mockResolvedValueOnce(wedged).mockResolvedValueOnce(fresh)
    await ensureUserBox('user-recover', 'ada')
    restoreWorkspaceIn.mockClear()
    syncWorkspaceOut.mockClear()

    const spec = await recoverUserBox('user-recover', 'ada')

    expect(syncWorkspaceOut).toHaveBeenCalledWith(wedged, 'user-recover')
    expect(wedged.kill).toHaveBeenCalledTimes(1)
    expect(restoreWorkspaceIn).toHaveBeenCalledWith(fresh, 'user-recover')
    expect(spec.sandboxId).toBe('sbx-fresh')
    expect(spec.resumed).toBe(false)
  })

  it('reset without confirm does not destroy the sandbox', async () => {
    const sandbox = fakeSandbox('sbx-reset')
    create.mockResolvedValue(sandbox)
    await ensureUserBox('user-reset-guard', 'ada')

    await expect(resetUserBox('user-reset-guard', 'ada', { confirm: false })).rejects.toMatchObject({
      code: 'confirm_required',
    })
    expect(sandbox.kill).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('reset with confirm boots a clean desktop and skips the workspace mirror', async () => {
    const dirty = fakeSandbox('sbx-dirty')
    const clean = fakeSandbox('sbx-clean')
    create.mockResolvedValueOnce(dirty).mockResolvedValueOnce(clean)
    const row: Record<string, unknown> = {
      sandboxId: '',
      lastSnapshotId: 'snap-baseline',
      streamAuthKey: 'auth-key',
      streamUrl: null,
      interactiveUrl: null,
      takeoverRequested: false,
    }
    findUnique.mockImplementation(async () => ({ ...row }))
    upsert.mockImplementation(async (args: { create?: Record<string, unknown>; update?: Record<string, unknown> }) => {
      Object.assign(row, args.create, args.update)
      return row
    })
    update.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      Object.assign(row, args.data)
      return row
    })
    await ensureUserBox('user-reset', 'ada')
    restoreWorkspaceIn.mockClear()
    syncWorkspaceOut.mockClear()

    const spec = await resetUserBox('user-reset', 'ada', { confirm: true })

    expect(dirty.kill).toHaveBeenCalledTimes(1)
    expect(syncWorkspaceOut).not.toHaveBeenCalled()
    expect(create.mock.calls.at(-1)?.[0]).toBe('snap-baseline')
    expect(restoreWorkspaceIn).not.toHaveBeenCalled()
    expect(clean.commands.run).toHaveBeenCalledWith(
      expect.stringContaining('/workspace/teach-sessions'),
      expect.any(Object),
    )
    expect(spec.sandboxId).toBe('sbx-clean')
  })

  it('disk warns when free space is under the threshold and reports asleep when the box is down', async () => {
    expect(parseDfBytes(LOW_DISK).warn).toBe(true)
    expect(parseDfBytes(LOW_DISK).rootFreeBytes).toBe(500_000_000)
    expect(parseDfBytes(LOW_DISK).workspaceFreeBytes).toBe(400_000_000)

    const asleep = await readBoxDisk('user-disk-asleep')
    expect(asleep).toMatchObject({ asleep: true, warn: false })

    const sandbox = fakeSandbox('sbx-disk', LOW_DISK)
    create.mockResolvedValue(sandbox)
    await ensureUserBox('user-disk', 'ada')

    const live = await readBoxDisk('user-disk')
    expect(live.asleep).toBe(false)
    expect(live.warn).toBe(true)
    expect(live.workspaceFreeBytes).toBe(400_000_000)
  })

  it('disk reads df output when the command exits nonzero', async () => {
    const sandbox = fakeSandbox('sbx-disk-df', LOW_DISK)
    create.mockResolvedValue(sandbox)
    await ensureUserBox('user-disk-df', 'ada')
    const failure = Object.assign(new Error('df failed'), {
      result: { stdout: LOW_DISK, exitCode: 1 },
    })
    sandbox.commands.run.mockRejectedValue(failure)

    const live = await readBoxDisk('user-disk-df')
    expect(live.asleep).toBe(false)
    expect(live.warn).toBe(true)
    expect(live.rootFreeBytes).toBe(500_000_000)
  })
})
