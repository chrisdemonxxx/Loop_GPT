'use client'

/**
 * OAuth popup flow (2026-10-05): connector sign-in opens in a centered popup
 * instead of navigating the whole tab away. The backend's callback page
 * postMessages `{source:'loop-oauth', ok, connectorType, error}` to the
 * opener and closes itself; a popup closed without the message means the
 * user backed out.
 *
 * No `noopener`: the callback needs `window.opener` to post the result.
 * The message handler verifies the source window and the marker before
 * acting on anything.
 */
export interface OAuthPopupResult { ok: boolean; connectorType?: string; error?: string }

export function openOAuthPopup(url: string, onDone: (result: OAuthPopupResult) => void): Window | null {
  const w = 560
  const h = 680
  const left = Math.max(0, (window.screenX || 0) + ((window.outerWidth || w) - w) / 2)
  const top = Math.max(0, (window.screenY || 0) + Math.max(0, (window.outerHeight || h) - h) / 3)
  const popup = window.open(url, 'loop-oauth', `width=${w},height=${h},left=${Math.round(left)},top=${Math.round(top)},popup=yes`)

  if (!popup) return null

  let finished = false
  const cleanup = () => {
    finished = true
    window.removeEventListener('message', onMessage)
    window.clearInterval(watcher)
  }
  const onMessage = (e: MessageEvent) => {
    if (e.source !== popup) return
    if (!e.data || e.data.source !== 'loop-oauth') return
    cleanup()
    try { popup.close() } catch { /* already gone */ }
    onDone({ ok: !!e.data.ok, connectorType: e.data.connectorType, error: e.data.error })
  }
  const watcher = window.setInterval(() => {
    if (popup.closed) {
      cleanup()
      onDone({ ok: false, error: 'closed' })
    }
  }, 600)

  window.addEventListener('message', onMessage)
  popup.focus?.()
  return popup
}

/** Human copy for popup outcomes (shared by the tab and the directory). */
export function oauthPopupNotice(result: OAuthPopupResult, providerName: string): { kind: 'ok' | 'error' | 'info'; text: string } {
  if (result.ok) return { kind: 'ok', text: `${providerName} connected.` }
  if (result.error === 'closed') return { kind: 'info', text: '' } // user backed out — silence is correct
  switch (result.error) {
    case 'invalid_state': return { kind: 'error', text: 'That sign-in attempt expired. Try connecting again.' }
    case 'access_denied': return { kind: 'error', text: 'The provider reported the request was denied. Try again and approve the permissions.' }
    case 'token_exchange_failed': return { kind: 'error', text: 'The provider rejected the hand-off. Try connecting again.' }
    case 'popup_blocked': return { kind: 'error', text: 'The sign-in popup was blocked. Allow popups for this site, then connect again.' }
    default: return { kind: 'error', text: 'Could not finish the sign-in. Try connecting again.' }
  }
}