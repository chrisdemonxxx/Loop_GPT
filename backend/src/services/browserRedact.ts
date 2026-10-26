/**
 * Strip cookie and credential material from a browser payload.
 * The extension runs the same rules before anything leaves the machine
 * (packages/browser-extension/src/redact.js). This pass is the server check
 * so a buggy client cannot leak what the extension already drops.
 */

export const DROPPED_HEADERS = ['cookie', 'authorization', 'proxy-authorization', 'set-cookie'] as const

const SECRET_KEY = /password|passwd|secret|session[-_]?token|access[-_]?token|refresh[-_]?token|set-cookie|authorization/i

const dropped = new Set<string>(DROPPED_HEADERS)

export function redactPayload(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return '[redacted]'
  if (Array.isArray(value)) {
    if (key && /headers?$/i.test(key)) return redactHeaderList(value)
    return value.map((item) => redactPayload(item))
  }
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (dropped.has(childKey.toLowerCase())) continue
    out[childKey] = SECRET_KEY.test(childKey) ? '[redacted]' : redactPayload(child, childKey)
  }
  return out
}

function redactHeaderList(headers: unknown[]): unknown[] {
  const kept: unknown[] = []
  for (const header of headers) {
    if (!header || typeof header !== 'object') continue
    const name = String((header as { name?: unknown }).name || '')
    if (dropped.has(name.toLowerCase())) continue
    kept.push(redactPayload(header))
  }
  return kept
}
