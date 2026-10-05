'use client'

/**
 * `#settings/*` hash routing (S2, blueprint §4.2/§8; contract
 * team/CONTRACT_S2_SETTINGS.md §2). `location.hash` is the single source of
 * truth — read on `hashchange`, pushed by the UI so browser back/forward
 * walks panels. Static-export friendly (no router dependency).
 *
 * Shapes:
 *   #settings/<panel>              e.g. #settings/account
 *   #settings/privacy/<sub>       sub ∈ PRIVACY_SUBS
 *   #settings/capabilities        alias → tools (the contract's mapping row)
 */

export interface SettingsHashRoute { panel: string; sub?: PrivacySub }

export const SETTINGS_PANELS = [
  'general', 'account', 'privacy', 'billing', 'tools', 'memory', 'reflect', 'time', 'code',
  'skills', 'connectors', 'plugins', 'personalization', 'appearance',
] as const

export const PRIVACY_SUBS = [
  'shared-chats', 'shared-artifacts', 'uploaded-files', 'your-feedback', 'memory-preferences',
] as const

export type PrivacySub = (typeof PRIVACY_SUBS)[number]

/** Blueprint panel names that alias to ours. */
const ALIASES: Record<string, string> = { capabilities: 'tools', 'claude-code': 'code', 'time-and-focus': 'time' }

export function normalizePanelId(raw: string): string {
  const id = ALIASES[raw] ?? raw
  if ((SETTINGS_PANELS as readonly string[]).includes(id)) return id
  return 'general'
}

/** Parse a hash into a route, or null when it is not a settings hash. */
export function parseSettingsHash(hash: string): SettingsHashRoute | null {
  const m = /^#settings\/([a-z-]+)(?:\/([a-z-]+))?$/.exec(hash)
  if (!m) return null
  const panel = normalizePanelId(m[1])
  const rawSub = m[2]
  const sub = panel === 'privacy' && rawSub && (PRIVACY_SUBS as readonly string[]).includes(rawSub)
    ? (rawSub as PrivacySub)
    : undefined
  if (m[1] !== 'general' && !ALIASES[m[1]] && !(SETTINGS_PANELS as readonly string[]).includes(m[1])) {
    console.warn(`Unknown settings panel "${m[1]}" — falling back to general`)
  }
  return { panel, sub }
}

export function toSettingsHash(panel: string, sub?: string): string {
  const id = normalizePanelId(panel)
  if (id === 'privacy' && sub && (PRIVACY_SUBS as readonly string[]).includes(sub)) return `#settings/privacy/${sub}`
  return `#settings/${id}`
}

/** Push a settings hash as a history entry (back/forward walks panels). */
export function pushSettingsHash(panel: string, sub?: string): void {
  const next = toSettingsHash(panel, sub)
  if (window.location.hash === next) return
  window.history.pushState(null, '', next)
  // pushState fires no hashchange — notify listeners ourselves so the app
  // reacts the same way to a UI click and a typed URL.
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/** Leave the settings hash via history (back to the pre-hash state). */
export function leaveSettingsHash(): void {
  if (!parseSettingsHash(window.location.hash)) return
  window.history.back()
}

/** React binding: returns the CURRENT route (state-synced) plus helpers.
 *  `onChange` fires for every hashchange — the caller decides open/close/tab.
 *  Safe during prerender: no window, no route. */
export function readCurrentSettingsHash(): SettingsHashRoute | null {
  if (typeof window === 'undefined') return null
  return parseSettingsHash(window.location.hash)
}