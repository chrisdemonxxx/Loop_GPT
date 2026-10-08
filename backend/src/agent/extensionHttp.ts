/**
 * Outbound HTTP for user-configured extensions (custom webhook tools, data
 * plugins, connectors, remote MCP servers). Every request goes through the
 * DNS-pinned public transport with redirects disabled, so a configured URL can
 * never reach a private address, and credentials stay bound to the origin the
 * user configured — a model-supplied path cannot move them to another host.
 */
import { publicRequest, PublicHttpError, validatePublicUrl } from '../services/publicHttp'

export interface ExtensionResponse {
  ok: boolean
  status: number
  text: string
}

export interface ExtensionRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  /** Exact origin the request must stay on (the configured base). */
  origin?: string
}

const PLACEHOLDER = /\{(\w+)\}/g

/**
 * Validate a URL template at configuration time: placeholders may appear in
 * the path or query, never in the scheme/host, and the host must be public.
 * Returns the template's fixed origin.
 */
export function validateUrlTemplate(template: string): string {
  const sample = String(template || '').replace(PLACEHOLDER, 'x')
  const url = validatePublicUrl(sample)
  const rawAuthority = /^https?:\/\/([^/?#]*)/i.exec(String(template))?.[1] ?? ''
  if (rawAuthority.includes('{')) throw new PublicHttpError('blocked_destination', 'Placeholders are not allowed in the host')
  return url.origin
}

/** Join a model-supplied path onto a configured base without leaving its origin. */
export function scopedUrl(base: string, path: string): string {
  const raw = String(path || '')
  // eslint-disable-next-line no-control-regex -- deliberate: rejects control characters in model-supplied paths
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || /[\u0000-\u001f\\]/.test(raw)) {
    throw new PublicHttpError('blocked_destination', 'Only paths relative to the configured base are allowed')
  }
  const root = String(base || '').replace(/\/+$/, '')
  const origin = validatePublicUrl(root).origin
  const url = new URL(`${root}${raw.startsWith('/') || raw.startsWith('?') ? '' : '/'}${raw}`)
  if (url.origin !== origin) throw new PublicHttpError('blocked_destination', 'Request left the configured origin')
  return url.href
}

export async function extensionRequest(url: string, opts: ExtensionRequestOptions = {}): Promise<ExtensionResponse> {
  const target = validatePublicUrl(url)
  if (opts.origin && target.origin !== opts.origin) throw new PublicHttpError('blocked_destination', 'Request left the configured origin')
  try {
    const res = await publicRequest(target.href, {
      method: opts.method || 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 20_000,
      maxBytes: opts.maxBytes ?? 2 * 1024 * 1024,
      redirects: 0,
      allowedOrigins: [target.origin],
    })
    return { ok: true, status: res.status, text: res.body.toString('utf8') }
  } catch (error) {
    if (error instanceof PublicHttpError && error.code === 'http_error' && error.status) {
      return { ok: false, status: error.status, text: '' }
    }
    throw error
  }
}

/** Human-readable failure for a tool result; never echoes internals. */
export function extensionFailure(error: unknown): string {
  if (error instanceof PublicHttpError) {
    if (error.code === 'blocked_destination') return 'Request blocked: the destination is not a permitted public address.'
    if (error.code === 'redirect_rejected') return 'Request blocked: redirects are not followed.'
    if (error.code === 'timeout') return 'Request timed out.'
    if (error.code === 'too_large') return 'Response was too large.'
    if (error.code === 'invalid_request') return 'Request rejected: invalid URL, header or body.'
  }
  return 'Request failed.'
}

/**
 * A `fetch`-compatible adapter for SDKs (MCP Streamable HTTP) that routes
 * through the public transport. Long-lived server-push streams (GET) are not
 * supported and answer 405, which MCP clients treat as "no SSE channel".
 */
export function publicFetch(origin: string) {
  return async (input: string | URL | { url: string }, init: { method?: string; headers?: any; body?: any; signal?: AbortSignal } = {}): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = String(init.method || 'GET').toUpperCase()
    if (method === 'GET') return new Response(null, { status: 405 })
    if (method !== 'POST' && method !== 'DELETE') return new Response(null, { status: 405 })
    const headers: Record<string, string> = {}
    new Headers(init.headers || {}).forEach((value, key) => { headers[key] = value })
    const body = init.body === undefined || init.body === null ? undefined : String(init.body)
    try {
      const res = await publicRequest(href, { method: method as 'POST' | 'DELETE', headers, body, signal: init.signal,
        timeoutMs: 60_000, maxBytes: 4 * 1024 * 1024, redirects: 0, allowedOrigins: [origin] })
      const outHeaders = new Headers()
      for (const [key, value] of Object.entries(res.headers)) {
        if (typeof value === 'string') outHeaders.set(key, value)
        else if (Array.isArray(value)) outHeaders.set(key, value.join(', '))
      }
      return new Response(new Uint8Array(res.body), { status: res.status, headers: outHeaders })
    } catch (error) {
      if (error instanceof PublicHttpError && error.code === 'http_error' && error.status) return new Response(null, { status: error.status })
      throw error
    }
  }
}
