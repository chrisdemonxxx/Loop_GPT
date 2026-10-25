/**
 * Cold-boot timeout: under 5 VM minutes does not create a sandbox.
 * 5 or more minutes creates with at least a 10 minute timeout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const remainingVmMinutes = vi.fn()
const findUnique = vi.fn()
const update = vi.fn()
const upsert = vi.fn()
const create = vi.fn()
const connect = vi.fn()
const awaitGnomeDesktop = vi.fn()

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
  restoreWorkspaceIn: vi.fn(async () => 0),
  syncWorkspaceOut: vi.fn(),
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

import { ensureUserBox, getComputerStatus } from '../botBox'

function fakeSandbox(id: string) {
  return {
    sandboxId: id,
    commands: { run: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) },
    stream: {
      start: vi.fn(async () => undefined),
      getAuthKey: () => 'stream-key',
    },
    setTimeout: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
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
})

describe('ensureUserBox boot timeout', () => {
  it('does not create a sandbox when fewer than 5 VM minutes remain', async () => {
    remainingVmMinutes.mockResolvedValue(4)

    await expect(ensureUserBox('user-under-5', 'ada')).rejects.toMatchObject({ code: 'quota' })

    expect(create).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('creates with at least 10 minutes when 5 or more VM minutes remain', async () => {
    remainingVmMinutes.mockResolvedValue(5)
    const sandbox = fakeSandbox('sbx-five')
    create.mockResolvedValue(sandbox)

    const spec = await ensureUserBox('user-five', 'ada')

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toBe('gnome-template')
    expect(create.mock.calls[0][1].timeoutMs).toBeGreaterThanOrEqual(10 * 60_000)
    expect(create.mock.calls[0][1].timeoutMs).toBe(10 * 60_000)
    expect(create.mock.calls[0][1].lifecycle).toEqual({ onTimeout: 'pause', autoResume: true })
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(awaitGnomeDesktop.mock.invocationCallOrder[0])
    expect(sandbox.stream.start).toHaveBeenCalled()
    expect(sandbox.setTimeout).toHaveBeenCalledWith(5 * 60_000)
    expect(sandbox.setTimeout.mock.invocationCallOrder[0]).toBeGreaterThan(sandbox.stream.start.mock.invocationCallOrder[0])
    expect(spec.sandboxId).toBe('sbx-five')
    expect(spec.resumed).toBe(false)
  })

  it('reconnects with the boot timeout, then shrinks to the real budget', async () => {
    remainingVmMinutes.mockResolvedValue(6)
    findUnique.mockResolvedValue({
      sandboxId: 'sbx-persist',
      streamAuthKey: 'auth-key',
      streamUrl: '/old',
      interactiveUrl: null,
    })
    const sandbox = fakeSandbox('sbx-persist')
    connect.mockResolvedValue(sandbox)

    const spec = await ensureUserBox('user-reconnect', 'ada')

    expect(connect).toHaveBeenCalledWith('sbx-persist', { timeoutMs: 10 * 60_000 })
    expect(create).not.toHaveBeenCalled()
    expect(sandbox.setTimeout).toHaveBeenCalledWith(6 * 60_000)
    expect(spec.resumed).toBe(true)
    expect(spec.sandboxId).toBe('sbx-persist')
  })

  it('cold-boots once more without pause-on-timeout when the create stream dies', async () => {
    remainingVmMinutes.mockResolvedValue(30)
    const sandbox = fakeSandbox('sbx-retry')
    create
      .mockRejectedValueOnce(new Error('The sandbox ioqy4xjw5noayftqzn4pz ended before the stream completed. This is likely a sandbox timeout.'))
      .mockResolvedValueOnce(sandbox)

    const spec = await ensureUserBox('user-retry', 'ada')

    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0][1].lifecycle).toEqual({ onTimeout: 'pause', autoResume: true })
    expect(create.mock.calls[1][1].lifecycle).toBeUndefined()
    expect(spec.sandboxId).toBe('sbx-retry')
    expect(JSON.stringify(spec)).not.toContain('ioqy4xjw5noayftqzn4pz')
  })

  it('returns a short message when the second boot stream also dies', async () => {
    remainingVmMinutes.mockResolvedValue(30)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    create.mockRejectedValue(new Error('The sandbox abc123sandbox ended before the stream completed. This is likely a sandbox timeout.'))

    let caught: Error | undefined
    let logged = ''
    try {
      await ensureUserBox('user-retry-fail', 'ada')
    } catch (error) {
      caught = error as Error
    } finally {
      logged = JSON.stringify(warn.mock.calls)
      warn.mockRestore()
    }

    expect(caught?.message).toMatch(/desktop did not finish starting/i)
    expect(caught?.message).not.toContain('abc123sandbox')
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1][1].lifecycle).toBeUndefined()
    expect(logged).toContain('abc123sandbox')
  })

  it('does not report a stored sandbox id as alive until this process probes it', async () => {
    findUnique.mockResolvedValue({
      sandboxId: 'sbx-paused',
      streamAuthKey: 'auth-key',
      streamUrl: '/view-stored',
      interactiveUrl: '/interactive-stored',
      takeoverRequested: true,
    })

    const status = await getComputerStatus('user-paused-only')

    expect(status.alive).toBe(false)
    expect(status.paused).toBe(true)
    expect(status.sandboxId).toBe('sbx-paused')
    expect(status.viewUrl).toBeNull()
    expect(status.interactiveUrl).toBeNull()
    expect(status.takeoverRequested).toBe(true)
    expect(connect).not.toHaveBeenCalled()
  })

  it('reports alive with a view url only after the live handle answers', async () => {
    remainingVmMinutes.mockResolvedValue(30)
    const sandbox = fakeSandbox('sbx-live')
    create.mockResolvedValue(sandbox)
    findUnique.mockResolvedValue(null)
    await ensureUserBox('user-probed', 'ada')
    findUnique.mockResolvedValue({
      sandboxId: 'sbx-live',
      streamAuthKey: 'auth-key',
      streamUrl: '/stored',
      interactiveUrl: '/stored-interactive',
      takeoverRequested: false,
    })

    const status = await getComputerStatus('user-probed')

    expect(status.alive).toBe(true)
    expect(status.paused).toBe(false)
    expect(status.viewUrl).toBe('/view')
    expect(status.interactiveUrl).toBeNull()
    expect(sandbox.commands.run).toHaveBeenCalled()
  })

  it('leaves sandboxId in place when reconnect times out', async () => {
    remainingVmMinutes.mockResolvedValue(30)
    findUnique.mockResolvedValue({
      sandboxId: 'sbx-net',
      streamAuthKey: 'k',
      streamUrl: '/v',
      interactiveUrl: null,
    })
    connect.mockRejectedValue(new Error('connect ETIMEDOUT'))

    await expect(ensureUserBox('user-timeout', 'ada')).rejects.toMatchObject({ code: 'unavailable' })

    expect(create).not.toHaveBeenCalled()
    expect(update.mock.calls.some((call) => (call[0] as { data?: { sandboxId?: string } })?.data?.sandboxId === '')).toBe(false)
  })

  it('kills the sandbox and clears its id when GNOME setup fails', async () => {
    remainingVmMinutes.mockResolvedValue(30)
    const sandbox = fakeSandbox('sbx-gnome')
    create.mockResolvedValue(sandbox)
    awaitGnomeDesktop.mockRejectedValue(new Error('gnome failed'))

    await expect(ensureUserBox('user-gnome', 'ada')).rejects.toThrow(/gnome failed/)

    expect(create).toHaveBeenCalledTimes(1)
    expect(sandbox.kill).toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith({
      where: { userId: 'user-gnome' },
      data: { sandboxId: '' },
    })
  })
})
