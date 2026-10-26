/** Drop cookie and credential fields before a payload leaves the browser. */

export const DROPPED_HEADERS = ['cookie', 'authorization', 'proxy-authorization', 'set-cookie']

const SECRET_KEY = /password|passwd|secret|session[-_]?token|access[-_]?token|refresh[-_]?token|set-cookie|authorization/i
const dropped = new Set(DROPPED_HEADERS)

export function redactPayload(value, key) {
  if (key && SECRET_KEY.test(key)) return '[redacted]'
  if (Array.isArray(value)) {
    if (key && /headers?$/i.test(key)) return redactHeaderList(value)
    return value.map((item) => redactPayload(item))
  }
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [childKey, child] of Object.entries(value)) {
    if (dropped.has(childKey.toLowerCase())) continue
    out[childKey] = SECRET_KEY.test(childKey) ? '[redacted]' : redactPayload(child, childKey)
  }
  return out
}

function redactHeaderList(headers) {
  const kept = []
  for (const header of headers) {
    if (!header || typeof header !== 'object') continue
    const name = String(header.name || '')
    if (dropped.has(name.toLowerCase())) continue
    kept.push(redactPayload(header))
  }
  return kept
}
