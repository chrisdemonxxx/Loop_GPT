import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../agent/artifacts', () => ({
  saveArtifact: vi.fn(async (name: string, bytes: Buffer) => ({ id: 'a1', kind: 'file', name, size: bytes.length })),
}))

import { ComputerSession, ComputerTakeoverTimeout, COMPUTER_FALLBACK_SCREEN } from '../../services/computerSession'
import type { DesktopClient } from '../../services/e2bDesktop'
import { saveArtifact } from '../../agent/artifacts'

function fakeClient(calls: string[] = []): DesktopClient {
  return {
    sandboxId: 'sbx-1',
    startStream: async () => {
      calls.push('startStream')
      return { sandboxId: 'sbx-1', streamAuthKey: 'key', viewUrl: 'https://v', interactiveUrl: 'https://i' }
    },
    screenshot: async () => { calls.push('screenshot'); return Buffer.from('png-bytes') },
    click: async () => { calls.push('click') },
    moveMouse: async () => { calls.push('move') },
    scroll: async () => { calls.push('scroll') },
    drag: async () => { calls.push('drag') },
    typeText: async () => { calls.push('type') },
    press: async () => { calls.push('press') },
    launch: async (application: string) => { calls.push(`launch:${application}`) },
    wait: async (ms) => { calls.push(`wait:${ms}`) },
    runCommand: async (command: string) => {
      calls.push(`cmd:${command.split(' ')[0]}`)
      if (command.includes('xdpyinfo')) return { stdout: '  dimensions: 1280x800 pixels', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
    kill: async () => { calls.push('kill') },
  }
}

function makeOpts(overrides: Record<string, unknown> = {}) {
  const events: any[] = []
  return {
    events,
    opts: {
      runId: 'run-1',
      userId: 'user-1',
      conversationId: 'convo-1',
      ttlMinutes: 30,
      emit: (e: any) => events.push(e),
      isTakeoverRequested: async () => false,
      sleep: async () => {},
      ...overrides,
    } as any,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('ComputerSession.start (Grok-style boot sequence)', () => {
  it('boots: stream → blanking off → Chrome → real screen sync, with staged statuses', async () => {
    const calls: string[] = []
    const createDesktopFn = vi.fn(async () => fakeClient(calls))
    const { events, opts } = makeOpts({ createDesktopFn })
    const session = await ComputerSession.start(opts)
    expect(calls).toEqual([
      'startStream', 'cmd:xset', 'launch:google-chrome', 'cmd:xdpyinfo',
    ])
    expect(session.screen).toEqual({ width: 1280, height: 800 })
    const statuses = events.filter((e) => e.type === 'status').map((e) => e.message)
    expect(statuses.some((m: string) => m.includes('booted'))).toBe(true)
    expect(statuses.some((m: string) => m.includes('Desktop ready (1280x800)'))).toBe(true)
    expect(session.info.viewUrl).toBe('https://v')
    await session.close()
  })

  it('survives a missing Chrome and falls back to default geometry', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    client.launch = async () => { throw new Error('no chrome') }
    client.runCommand = async (command: string) => {
      calls.push(`cmd:${command.split(' ')[0]}`)
      if (command.includes('xdpyinfo')) return { stdout: 'garbage', stderr: '', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    const { events, opts } = makeOpts({ createDesktopFn: async () => client })
    const session = await ComputerSession.start(opts)
    expect(session.screen).toEqual(COMPUTER_FALLBACK_SCREEN)
    expect(events.some((e) => e.type === 'status' && e.message.includes('Chrome is not available'))).toBe(true)
    await session.close()
  })

  it('kills the desktop if the stream fails to start (no leaked VM)', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    client.startStream = async () => { throw new Error('vnc down') }
    const { opts } = makeOpts({ createDesktopFn: async () => client })
    await expect(ComputerSession.start(opts)).rejects.toThrow('vnc down')
    expect(calls).toContain('kill')
  })
})

describe('parseScreenDimensions', () => {
  it('parses xdpyinfo output and rejects junk', () => {
    expect(ComputerSession.parseScreenDimensions('  dimensions:    1920x1080 pixels (508mm x 285mm)')).toEqual({ width: 1920, height: 1080 })
    expect(ComputerSession.parseScreenDimensions('no dimensions here')).toEqual(COMPUTER_FALLBACK_SCREEN)
    expect(ComputerSession.parseScreenDimensions('dimensions: 10x10 pixels')).toEqual(COMPUTER_FALLBACK_SCREEN)
  })
})

describe('takeover guard', () => {
  it('returns immediately when no takeover is requested', async () => {
    const { opts } = makeOpts()
    const session = await ComputerSession.start({ ...opts, createDesktopFn: async () => fakeClient() })
    await expect(session.guard()).resolves.toBeUndefined()
    await session.close()
  })

  it('pauses while the operator drives and resumes on release', async () => {
    const sequence = [true, true, false]
    const { events, opts } = makeOpts({
      isTakeoverRequested: async () => sequence.shift() ?? false,
    })
    const session = await ComputerSession.start({ ...opts, createDesktopFn: async () => fakeClient() })
    await session.guard()
    const statuses = events.filter((e) => e.type === 'status').map((e) => e.message)
    expect(statuses.some((m: string) => m.includes('takeover'))).toBe(true)
    expect(statuses.some((m: string) => m.includes('released'))).toBe(true)
    await session.close()
  })

  it('throws ComputerTakeoverTimeout past the takeover window', async () => {
    const { opts } = makeOpts({
      takeoverTimeoutMs: 4000,
      isTakeoverRequested: async () => true,
    })
    const session = await ComputerSession.start({ ...opts, createDesktopFn: async () => fakeClient() })
    await expect(session.guard()).rejects.toBeInstanceOf(ComputerTakeoverTimeout)
    await session.close()
  })
})

describe('screenshot + act', () => {
  it('persists the frame as an artifact, emits it, and returns a data URI', async () => {
    const { events, opts } = makeOpts()
    const session = await ComputerSession.start({ ...opts, createDesktopFn: async () => fakeClient() })
    const shot = await session.screenshot()
    expect(saveArtifact).toHaveBeenCalledWith('computer-001.png', expect.any(Buffer), { userId: 'user-1', conversationId: 'convo-1' })
    expect(shot.imageDataUri.startsWith('data:image/png;base64,')).toBe(true)
    expect(events.some((e) => e.type === 'artifact')).toBe(true)
    const second = await session.screenshot()
    expect(saveArtifact).toHaveBeenLastCalledWith('computer-002.png', expect.any(Buffer), expect.anything())
    expect(second.imageDataUri).toBeTruthy()
    await session.close()
  })

  it('act = guard → action → settle → screenshot, in order', async () => {
    const calls: string[] = []
    const { opts } = makeOpts()
    const session = await ComputerSession.start({ ...opts, createDesktopFn: async () => fakeClient(calls) })
    calls.length = 0 // startStream noise is not part of the act sequence
    await session.act('click(10,20)', (client) => client.click(10, 20, 'left'))
    expect(calls).toEqual(['click', 'wait:400', 'screenshot'])
    await session.close()
  })
})

describe('metering + teardown', () => {
  it('meters whole minutes (rounded up) and kills once', async () => {
    const calls: string[] = []
    let now = 1_000_000
    const { opts } = makeOpts({ now: () => now })
    const session = await ComputerSession.start({ ...opts, createDesktopFn: async () => fakeClient(calls) })
    now += 90_000 // 1.5 minutes
    expect(session.minutes()).toBe(2)
    await session.close()
    await session.close()
    expect(calls.filter((c) => c === 'kill')).toHaveLength(1)
  })
})
