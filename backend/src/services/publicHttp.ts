/** Direct, DNS-pinned public Internet requests. Never use for private services. */
import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { Readable, Transform } from 'node:stream'

export class PublicHttpError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) { super(message) }
}
const blocked = () => new PublicHttpError('blocked_destination', 'Outbound destination is not permitted')
const invalid = () => new PublicHttpError('invalid_request', 'Invalid outbound request')
const networkError = () => new PublicHttpError('network_error', 'Outbound request failed')
const tooLarge = () => new PublicHttpError('too_large', 'Outbound response exceeded its size limit')
const v4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) v4.addSubnet(address, prefix, 'ipv4')
v4.addAddress('168.63.129.16', 'ipv4') // Azure platform virtual address
v4.addAddress('147.75.207.207', 'ipv4') // Packet/Equinix metadata gateway
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6')
const specialV6 = new BlockList()
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) specialV6.addSubnet(address, prefix, 'ipv6')

export function isPublicAddress(address: string): boolean {
  if (typeof address !== 'string' || address.includes('%')) return false
  const family = isIP(address)
  if (family === 4) return !v4.check(address, 'ipv4')
  // Also excludes mapped IPv4, NAT64, loopback, link-local, ULA and multicast.
  return family === 6 && globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6')
}

export function validatePublicUrl(value: string): URL {
      // eslint-disable-next-line no-control-regex -- deliberate: rejects control characters in public URLs
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) throw invalid()
  let url: URL
  try { url = new URL(value) } catch { throw invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw blocked()
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) { if (!isPublicAddress(host)) throw blocked() }
  else if (!host.includes('.') || host.endsWith('.') || host === 'metadata.packet.net' || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host)) throw blocked()
  url.hash = ''
  return url
}

export interface PublicHttpOptions {
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: string | Buffer
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  /** Disabled by default; only anonymous GETs may follow at most three hops. */
  redirects?: number
  /** Exact HTTPS/HTTP origins set by a reviewed server-side adapter, not users. */
  allowedOrigins?: readonly string[]
  /** Trusted server callback, inside the deadline, after DNS and before send. */
  beforeConnect?: () => Promise<void>
}
export interface PublicHttpResponse { body: Buffer; status: number; url: string; headers: http.IncomingHttpHeaders }

function abortError(signal: AbortSignal) {
  return signal.reason instanceof PublicHttpError ? signal.reason : new PublicHttpError('aborted', 'Outbound request cancelled')
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError(signal)) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      () => { signal.removeEventListener('abort', abort); reject(networkError()) })
  })
}

export async function resolvePublicAddress(host: string, signal: AbortSignal) {
  const literal = isIP(host)
  const addresses = literal ? [{ address: host, family: literal }] : await abortable(lookup(host, { all: true, verbatim: true }), signal)
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) => !entry || isIP(entry.address) !== entry.family || !isPublicAddress(entry.address))) throw blocked()
  return addresses.find((entry) => entry.family === 4) || addresses[0]
}

function requestHop(url: URL, address: { address: string; family: number }, options: PublicHttpOptions,
  headers: Record<string, string>, body: Buffer | undefined, maxBytes: number, signal: AbortSignal): Promise<PublicHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false
    let req: http.ClientRequest | undefined, response: http.IncomingMessage | undefined, decoded: Readable | undefined
    let agent: http.Agent | undefined
    const abort = () => finish(abortError(signal))
    const finish = (error?: PublicHttpError, result?: PublicHttpResponse) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (error) { decoded?.destroy(); response?.destroy(); req?.destroy(); agent?.destroy(); reject(error) }
      else { req?.destroy(); agent?.destroy(); resolve(result!) }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    try {
      // Explicitly disable environment proxies on Node versions supporting them.
      // Older versions ignore proxyEnv; neither path uses a global agent.
      agent = url.protocol === 'https:' ? new https.Agent({ keepAlive: false, proxyEnv: {} } as https.AgentOptions)
        : new http.Agent({ keepAlive: false, proxyEnv: {} } as http.AgentOptions)
      req = (url.protocol === 'https:' ? https : http).request(url, {
        method: options.method || 'GET', headers, agent, family: address.family,
        // Keep the original hostname for Host, TLS SNI and certificate checks.
        // Only the socket lookup is replaced; no second DNS lookup or proxy.
        lookup: ((hostname: string, lookupOptions: any, callback: any) => {
          if (hostname !== host) { callback(blocked()); return }
          if (lookupOptions?.all) callback(null, [{ address: address.address, family: address.family }])
          else callback(null, address.address, address.family)
        }) as any,
        maxHeaderSize: 16384,
      }, (res) => {
        response = res
        if (settled) { res.destroy(); return }
        const status = res.statusCode || 0
        res.on('error', () => finish(networkError()))
        res.on('aborted', () => finish(networkError()))
        res.on('close', () => { if (!res.complete) finish(networkError()) })
        if ([301, 302, 303, 307, 308].includes(status)) {
          finish(undefined, { body: Buffer.alloc(0), status, url: url.href, headers: res.headers }); res.destroy(); return
        }
        if (status < 200 || status >= 300) { finish(new PublicHttpError('http_error', `Outbound service returned HTTP ${status}`, status)); return }
        const length = res.headers['content-length']
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { finish(tooLarge()); return }
        const encoding = (res.headers['content-encoding'] || 'identity').trim().toLowerCase()
        decoded = encoding === 'identity' ? res : encoding === 'gzip' ? createGunzip()
          : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined
        if (!decoded) { finish(new PublicHttpError('invalid_response', 'Unsupported outbound response encoding')); return }
        let wireBytes = 0, decodedBytes = 0
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => { wireBytes += chunk.length; if (wireBytes > maxBytes) finish(tooLarge()) })
        decoded.on('error', () => finish(networkError()))
        decoded.on('data', (chunk: Buffer) => {
          if (settled) return
          decodedBytes += chunk.length
          if (decodedBytes > maxBytes) { finish(tooLarge()); return }
          chunks.push(Buffer.from(chunk))
        })
        decoded.on('end', () => finish(undefined, { body: Buffer.concat(chunks), status, url: url.href, headers: res.headers }))
        if (decoded !== res) res.pipe(decoded as Transform)
      })
      req.on('error', () => finish(signal.aborted ? abortError(signal) : networkError()))
      req.end(body)
    } catch { finish(networkError()) }
  })
}

export async function publicRequest(value: string, options: PublicHttpOptions = {}): Promise<PublicHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 20000, maxBytes = options.maxBytes ?? 2 * 1024 * 1024, redirects = options.redirects ?? 0
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024 || !Number.isInteger(redirects) || redirects < 0 || redirects > 3) throw invalid()
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(options.method || 'GET')) throw invalid()
  if (options.body !== undefined && typeof options.body !== 'string' && !Buffer.isBuffer(options.body)) throw invalid()
  if (options.body !== undefined && Buffer.byteLength(options.body) > 65536) throw invalid()
  const body = options.body === undefined ? undefined : Buffer.from(options.body)
  const headers: Record<string, string> = { 'accept-encoding': 'identity' }
  const anonymousHeaders = new Set(['accept', 'accept-language', 'user-agent'])
  let anonymous = !body && (!options.method || options.method === 'GET')
  let headerBytes = 0
  for (const [name, value] of Object.entries(options.headers || {})) {
    const key = name.toLowerCase()
    if (typeof value !== 'string') throw invalid()
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4
    if (headerBytes > 16384) throw invalid()
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization', 'proxy-connection', 'accept-encoding', 'upgrade', 'expect', 'te', 'trailer'].includes(key)) throw invalid()
    try { http.validateHeaderName(name); http.validateHeaderValue(name, value) } catch { throw invalid() }
    if (!anonymousHeaders.has(key)) anonymous = false
    headers[key] = value
  }
  if (redirects && !anonymous) throw new PublicHttpError('redirect_rejected', 'Credential-bearing or non-GET requests cannot follow redirects')
  const control = new AbortController()
  const cancel = () => control.abort(new PublicHttpError('aborted', 'Outbound request cancelled'))
  const timer = setTimeout(() => control.abort(new PublicHttpError('timeout', 'Outbound request timed out')), timeoutMs)
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  try {
    let url = validatePublicUrl(value)
    for (let hop = 0; ; hop++) {
      if (control.signal.aborted) throw abortError(control.signal)
      if ((!anonymous && url.protocol !== 'https:') || (options.allowedOrigins && !options.allowedOrigins.includes(url.origin))) throw blocked()
      const address = await resolvePublicAddress(url.hostname.replace(/^\[|\]$/g, ''), control.signal)
      if (options.beforeConnect) await abortable(options.beforeConnect(), control.signal)
      if (control.signal.aborted) throw abortError(control.signal)
      const response = await requestHop(url, address, options, headers, body, maxBytes, control.signal)
      if (response.status < 300) return response
      if (hop >= redirects || !response.headers.location) throw new PublicHttpError('redirect_rejected', 'Outbound redirect is not permitted')
      let next: URL
      try { next = validatePublicUrl(new URL(response.headers.location, url).href) } catch { throw blocked() }
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw blocked()
      url = next
    }
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel) }
}

export async function fetchPublicText(url: string, options: PublicHttpOptions = {}): Promise<string> {
  return (await publicRequest(url, options)).body.toString('utf8')
}
export async function getPublicJson<T = any>(url: string, options: PublicHttpOptions = {}): Promise<T> {
  const text = await fetchPublicText(url, options)
  try { return JSON.parse(text) as T } catch { throw new PublicHttpError('invalid_response', 'Outbound service returned invalid JSON') }
}
export function postPublicJson<T = any>(url: string, body: unknown, options: PublicHttpOptions = {}): Promise<T> {
  return getPublicJson<T>(url, { ...options, method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...options.headers } })
}
export function postPublicForm(url: string, form: Record<string, string>, options: PublicHttpOptions = {}): Promise<string> {
  return fetchPublicText(url, { ...options, method: 'POST', body: new URLSearchParams(form).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...options.headers } })
}
