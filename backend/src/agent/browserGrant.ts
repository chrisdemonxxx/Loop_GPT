/**
 * Chat / research tool selection for the paired browser.
 * browser_* tools are not in builtinTools(). web_search only adds or removes
 * web_search and web_fetch. Chat mode stays with no browser tools.
 */

export const WEB_TOOL_NAMES = ['web_search', 'web_fetch'] as const

export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_key',
  'browser_scroll',
  'browser_tabs',
  'browser_wait',
  'browser_console',
  'browser_network',
] as const

const WEB = new Set<string>(WEB_TOOL_NAMES)
const BROWSER = new Set<string>(BROWSER_TOOL_NAMES)

export function applyWebSearchToggle(
  selected: readonly string[],
  webSearch: boolean | undefined,
  selectable: readonly string[],
): string[] {
  if (webSearch === undefined) return [...selected]
  if (webSearch) {
    const extra = WEB_TOOL_NAMES.filter((name) => selectable.includes(name))
    return [...new Set([...selected, ...extra])]
  }
  return selected.filter((name) => !WEB.has(name))
}

/** Grant browser_* only when this turn asked and the named socket is live. */
export function withBrowserGrant(
  selected: readonly string[],
  opts: { mode: string; browser?: boolean; deviceLive: boolean },
): string[] {
  const stripped = selected.filter((name) => !BROWSER.has(name) && !name.startsWith('browser_'))
  if (opts.mode === 'chat') return stripped
  if (opts.browser !== true || !opts.deviceLive) return stripped
  return [...new Set([...stripped, ...BROWSER_TOOL_NAMES])]
}

export const BROWSER_OFFLINE_MESSAGE = 'The paired browser is offline. Use web_search and web_fetch for public pages.'
export const BROWSER_RELEASED_MESSAGE = 'Browser was turned off for this run. Use web_search for later lookups.'
export const BROWSER_ONION_MESSAGE = 'An .onion address is only opened in a paired Tor Browser window.'

const BLOCKED_PROTOCOLS = /^(chrome|about|edge|brave|opera|vivaldi|chrome-extension|moz-extension|extension|view-source|devtools):/i

export function isOnionUrl(value: string | undefined): boolean {
  if (!value || typeof value !== 'string') return false
  try {
    const host = new URL(value).hostname.toLowerCase()
    return host === 'onion' || host.endsWith('.onion')
  } catch {
    return /(^|\.)onion($|\/)/i.test(value) || /\.onion\b/i.test(value)
  }
}

/** Where a navigation URL sits on a tool call. Other tools do not carry one. */
export function navigationUrl(tool: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined
  if (tool === 'browser_navigate' && typeof args.url === 'string') return args.url
  if (tool === 'browser_tabs' && args.action === 'new' && typeof args.url === 'string') return args.url
  return undefined
}

export function blockedBrowserUrl(url: string, appOrigins: readonly string[]): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return 'That address is not a page Loop can open.' }
  if (BLOCKED_PROTOCOLS.test(parsed.protocol) || BLOCKED_PROTOCOLS.test(url)) return 'Loop will not open browser-internal pages.'
  const origin = parsed.origin
  for (const app of appOrigins) {
    if (app && origin === app) return 'Loop will not open its own sign-in storage.'
  }
  return null
}

export interface BrowserCallDecision {
  forward: boolean
  message?: string
}

/** Decide whether a call may be sent to the extension. Onion URLs never leave for a non-Tor device. */
export function evaluateBrowserCall(input: {
  revoked: boolean
  live: boolean
  family: string
  tool: string
  args: Record<string, unknown> | undefined
  appOrigins?: readonly string[]
}): BrowserCallDecision {
  if (input.revoked) return { forward: false, message: BROWSER_RELEASED_MESSAGE }
  if (!input.live) return { forward: false, message: BROWSER_OFFLINE_MESSAGE }
  const url = navigationUrl(input.tool, input.args)
  if (url && isOnionUrl(url) && input.family !== 'tor') return { forward: false, message: BROWSER_ONION_MESSAGE }
  if (url) {
    const blocked = blockedBrowserUrl(url, input.appOrigins || [])
    if (blocked) return { forward: false, message: blocked }
  }
  return { forward: true }
}

/** Toggle-off finishes the call already in flight, then detaches. */
export function shouldDetachAfterCall(inflight: number, revoked: boolean): boolean {
  return revoked && inflight <= 0
}
