/**
 * Dedicated desktop create uses the same boot floor as the persistent box:
 * under 5 minutes does not call Sandbox.create; 5 or more uses at least 10.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const create = vi.fn()
const awaitGnomeDesktop = vi.fn(async () => undefined)

vi.mock('@e2b/desktop', () => ({
  Sandbox: {
    create: (...args: unknown[]) => create(...args),
    connect: vi.fn(),
  },
}))

vi.mock('../gnomeSession', () => ({
  awaitGnomeDesktop: (...args: unknown[]) => awaitGnomeDesktop(...args),
  desktopTemplateId: () => 'gnome-template',
  seedDesktopLaunchers: vi.fn(async () => undefined),
}))

vi.mock('../agentTasks', () => {
  class AgentTaskError extends Error {
    code: string
    constructor(code: string, detail?: string) {
      super(detail || code)
      this.code = code
    }
  }
  return { AgentTaskError }
})

import { createDesktop } from '../e2bDesktop'

function fakeDesktop(id: string) {
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
  process.env.E2B_API_KEY = 'test-key'
  process.env.E2B_DESKTOP_TEMPLATE = 'gnome-template'
  awaitGnomeDesktop.mockResolvedValue(undefined)
})

describe('createDesktop boot timeout', () => {
  it('does not create a sandbox when fewer than 5 minutes are budgeted', async () => {
    await expect(createDesktop({ timeoutMs: 4 * 60_000 })).rejects.toMatchObject({ code: 'quota' })
    expect(create).not.toHaveBeenCalled()
  })

  it('creates with at least 10 minutes when 5 or more are budgeted', async () => {
    const desktop = fakeDesktop('sbx-desktop')
    create.mockResolvedValue(desktop)

    const client = await createDesktop({ timeoutMs: 5 * 60_000 })
    await client.startStream()

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][1].timeoutMs).toBeGreaterThanOrEqual(10 * 60_000)
    expect(create.mock.calls[0][1].timeoutMs).toBe(10 * 60_000)
    expect(create.mock.calls[0][1].lifecycle).toEqual({ onTimeout: 'pause', autoResume: true })
    expect(desktop.stream.start).toHaveBeenCalled()
    expect(desktop.setTimeout).toHaveBeenCalledWith(5 * 60_000)
    expect(desktop.setTimeout.mock.invocationCallOrder[0]).toBeGreaterThan(desktop.stream.start.mock.invocationCallOrder[0])
  })
})
