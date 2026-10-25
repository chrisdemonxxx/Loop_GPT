import { beforeEach, describe, expect, it, vi } from 'vitest'
import { awaitGnomeDesktop, desktopTemplateId, seedDesktopLaunchers } from '../gnomeSession'

function fakeSandbox(opts: {
  gnomePresent?: boolean
  shellAfter?: number
  marker?: boolean
}) {
  let shellChecks = 0
  const run = vi.fn(async (cmd: string) => {
    if (cmd.includes('test -f /tmp/.loop-gnome-session')) {
      return { exitCode: opts.marker ? 0 : 1 }
    }
    if (cmd.includes('test -x /usr/bin/gnome-shell')) {
      return { exitCode: opts.gnomePresent === false ? 1 : 0 }
    }
    if (cmd.includes('pgrep -x gnome-shell')) {
      shellChecks += 1
      const readyAfter = opts.shellAfter ?? 1
      return { exitCode: shellChecks >= readyAfter ? 0 : 1 }
    }
    return { exitCode: 0, disconnect: async () => undefined }
  })
  return { commands: { run } }
}

describe('gnomeSession', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('desktopTemplateId prefers E2B_DESKTOP_TEMPLATE', () => {
    vi.stubEnv('E2B_DESKTOP_TEMPLATE', 'loop-gnome-desktop')
    vi.stubEnv('BOT_E2B_TEMPLATE', 'other')
    expect(desktopTemplateId()).toBe('loop-gnome-desktop')
  })

  it('awaitGnomeDesktop throws when GNOME binaries are missing', async () => {
    const sandbox = fakeSandbox({ gnomePresent: false })
    await expect(awaitGnomeDesktop(sandbox as any)).rejects.toThrow(/GNOME desktop is not installed/)
  })

  it('awaitGnomeDesktop resolves once gnome-shell is running', async () => {
    vi.useFakeTimers()
    const sandbox = fakeSandbox({ gnomePresent: true, shellAfter: 2 })
    const pending = awaitGnomeDesktop(sandbox as any)
    await vi.advanceTimersByTimeAsync(2500)
    await expect(pending).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('awaitGnomeDesktop fails loudly if shell never appears', async () => {
    vi.useFakeTimers()
    const sandbox = fakeSandbox({ gnomePresent: true, shellAfter: 999 })
    const pending = awaitGnomeDesktop(sandbox as any)
    // Allow both wait loops (20s + 45s) plus a buffer
    const assert = expect(pending).rejects.toThrow(/GNOME session failed to start/)
    await vi.advanceTimersByTimeAsync(80_000)
    await assert
    vi.useRealTimers()
  })

  it('a resumed snapshot waits for gnome-shell and does not swap XFCE', async () => {
    vi.useFakeTimers()
    const sandbox = fakeSandbox({ gnomePresent: true, shellAfter: 2, marker: true })
    const pending = awaitGnomeDesktop(sandbox as any, { resumeSnapshot: true })
    await vi.advanceTimersByTimeAsync(2500)
    await expect(pending).resolves.toBeUndefined()
    const cmds = sandbox.commands.run.mock.calls.map((call) => String(call[0]))
    expect(cmds.some((cmd) => cmd.includes('gnome-session') || cmd.includes('pkill'))).toBe(false)
    vi.useRealTimers()
  })

  it('seedDesktopLaunchers writes Chrome + Terminal desktop entries', async () => {
    const sandbox = fakeSandbox({ gnomePresent: true })
    await seedDesktopLaunchers(sandbox as any)
    const cmd = String(sandbox.commands.run.mock.calls[0]?.[0] || '')
    expect(cmd).toContain('google-chrome.desktop')
    expect(cmd).toContain('terminal.desktop')
    expect(cmd).toContain('/home/user/Desktop')
  })
})
