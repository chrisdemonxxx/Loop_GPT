import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openOAuthPopup, oauthPopupNotice } from '../oauthPopup'

describe('openOAuthPopup (2026-10-05 connector OAuth UX)', () => {
  type Done = (r: { ok: boolean; connectorType?: string; error?: string }) => void

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  function stubPopup(closed = false) {
    const popup = { closed, close: vi.fn(), focus: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    return { popup, open }
  }

  it('returns null when the browser blocks the popup', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const onDone = vi.fn()
    expect(openOAuthPopup('https://provider/authorize', onDone)).toBeNull()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('resolves ok when the callback page postMessages the result', () => {
    const { popup, open } = stubPopup()
    const onDone = vi.fn()
    openOAuthPopup('https://provider/authorize', onDone)
    expect(open).toHaveBeenCalledOnce()
    expect(open.mock.calls[0][0]).toContain('authorize')
    // The real callback posts {source:'loop-oauth', ok:true, connectorType}
    window.dispatchEvent(new MessageEvent('message', {
      source: popup as unknown as Window,
      data: { source: 'loop-oauth', ok: true, connectorType: 'gmail' },
    }))
    expect(onDone).toHaveBeenCalledWith({ ok: true, connectorType: 'gmail' })
    expect(popup.close).toHaveBeenCalled()
    // No late close-watcher firing after the result landed.
    vi.advanceTimersByTime(2000)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('ignores messages from other windows and without the marker', () => {
    const { popup } = stubPopup()
    const onDone = vi.fn()
    openOAuthPopup('https://provider/authorize', onDone)
    window.dispatchEvent(new MessageEvent('message', { source: window, data: { source: 'loop-oauth', ok: true } }))
    window.dispatchEvent(new MessageEvent('message', { source: popup as unknown as Window, data: { ok: true } }))
    expect(onDone).not.toHaveBeenCalled()
  })

  it('reports failure errors from the callback (e.g. access_denied)', () => {
    const { popup } = stubPopup()
    const onDone = vi.fn()
    openOAuthPopup('https://provider/authorize', onDone)
    window.dispatchEvent(new MessageEvent('message', {
      source: popup as unknown as Window,
      data: { source: 'loop-oauth', ok: false, connectorType: 'gmail', error: 'access_denied' },
    }))
    expect(onDone).toHaveBeenCalledWith({ ok: false, connectorType: 'gmail', error: 'access_denied' })
  })

  it('treats a user-closed popup as a silent cancel (no scary error)', () => {
    const { popup } = stubPopup()
    const onDone = vi.fn()
    openOAuthPopup('https://provider/authorize', onDone)
    ;(popup as any).closed = true
    vi.advanceTimersByTime(700)
    expect(onDone).toHaveBeenCalledWith({ ok: false, error: 'closed' })
    expect(oauthPopupNotice({ ok: false, error: 'closed' }, 'Gmail')).toEqual({ kind: 'info', text: '' })
  })

  it('maps the outcome copy (shared by tab and directory)', () => {
    expect(oauthPopupNotice({ ok: true, connectorType: 'gmail' }, 'Gmail')).toEqual({ kind: 'ok', text: 'Gmail connected.' })
    expect(oauthPopupNotice({ ok: false, error: 'popup_blocked' }, 'Gmail').text).toContain('popup was blocked')
    expect(oauthPopupNotice({ ok: false, error: 'whatever' }, 'Gmail').kind).toBe('error')
  })
})