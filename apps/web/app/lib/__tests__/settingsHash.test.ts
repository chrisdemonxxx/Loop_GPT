import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSettingsHash, toSettingsHash, pushSettingsHash, leaveSettingsHash, PRIVACY_SUBS, SETTINGS_PANELS } from '../settingsHash'

describe('settings hash routing (S2, contract §2)', () => {
  beforeEach(() => { window.location.hash = '' })
  afterEach(() => { window.location.hash = '' })

  it('parses panel hashes', () => {
    expect(parseSettingsHash('#settings/account')).toEqual({ panel: 'account' })
    expect(parseSettingsHash('#settings/privacy/uploaded-files')).toEqual({ panel: 'privacy', sub: 'uploaded-files' })
  })

  it('aliases the blueprint panel names to ours', () => {
    expect(parseSettingsHash('#settings/capabilities')!.panel).toBe('tools')
    expect(parseSettingsHash('#settings/claude-code')!.panel).toBe('code')
    expect(parseSettingsHash('#settings/time-and-focus')!.panel).toBe('time')
  })

  it('falls back to general for unknown panels (with a console warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseSettingsHash('#settings/teleport')).toEqual({ panel: 'general' })
    expect(warn).toHaveBeenCalledOnce()
  })

  it('rejects non-settings and malformed hashes', () => {
    expect(parseSettingsHash('')).toBeNull()
    expect(parseSettingsHash('#other')).toBeNull()
    expect(parseSettingsHash('#settings/')).toBeNull()
  })

  it('ignores an invalid privacy sub but keeps the privacy panel', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseSettingsHash('#settings/privacy/not-a-sub')).toEqual({ panel: 'privacy' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('round-trips every panel and privacy sub', () => {
    for (const panel of SETTINGS_PANELS) {
      expect(parseSettingsHash(toSettingsHash(panel))!.panel).toBe(panel)
    }
    for (const sub of PRIVACY_SUBS) {
      expect(parseSettingsHash(toSettingsHash('privacy', sub))).toEqual({ panel: 'privacy', sub })
    }
  })

  it('pushSettingsHash creates a history entry and fires hashchange', () => {
    const onHash = vi.fn()
    window.addEventListener('hashchange', onHash)
    pushSettingsHash('billing')
    expect(window.location.hash).toBe('#settings/billing')
    expect(onHash).toHaveBeenCalledOnce()
    pushSettingsHash('billing') // no-op on the same hash
    expect(onHash).toHaveBeenCalledOnce()
    window.removeEventListener('hashchange', onHash)
  })

  it('leaveSettingsHash walks back exactly one entry', async () => {
    window.history.replaceState(null, '', '/chat')
    pushSettingsHash('general')
    pushSettingsHash('memory')
    expect(window.location.hash).toBe('#settings/memory')
    // jsdom fires popstate/hashchange asynchronously on history.back().
    const awaitHash = async (expected: string) => {
      for (let i = 0; i < 100 && window.location.hash !== expected; i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(window.location.hash).toBe(expected)
    }
    leaveSettingsHash()
    await awaitHash('#settings/general')
    leaveSettingsHash()
    await awaitHash('')
  })
})