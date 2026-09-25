/** Bounded direct transports: public providers and an isolated operator-owned sidecar. */
import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { isPublicAddress, resolvePublicAddress, validatePublicUrl } from './publicHttp'

export class ProviderHttpError extends Error {
  constructor(public readonly code: string, public readonly status?: number) {
    super('Provider transport request failed')
    this.name = 'ProviderHttpError'
  }
}
export interface ProviderHttpOptions {
  method?: 'GET' | 'POST' | 'HEAD'
  headers?: Record<string, string>
  body?: string | Buffer
  allowedOrigins?: readonly string[]
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
}
export interface ProviderResponse {
  status: number
  ok: true
  url: string
  headers: Headers
  body: Buffer
  json(): Promise<any>
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}
export type SidecarHttpOptions = Omit<ProviderHttpOptions, 'allowedOrigins'>
export type SidecarPath = '/health' | '/api/generate' | '/api/analyze' | '/api/vision-chat'
const error = (code: string, status?: number) => new ProviderHttpError(code, status)
      // eslint-disable-next-line no-control-regex -- deliberate: rejects control characters in sidecar request bodies
const unsafeRaw = /[\s\u0000-\u001f\u007f-\u009f\\]/
const headerLimit = 16 * 1024
const requestLimit = 32 * 1024 * 1024
const plainHeaders = new Set(['content-type', 'accept', 'user-agent', 'anthropic-version'])
const credentialHeaders = new Set(['authorization', 'x-api-key'])

function bound(value: number | undefined, fallback: number, ceiling: number): number {
  const result = value === undefined ? fallback : value
  if (!Number.isInteger(result) || result < 1 || result > ceiling) throw error('invalid_request')
  return result
}
function publicUrl(raw: string): URL {
  if (typeof raw !== 'string' || unsafeRaw.test(raw) || raw.includes('#')) throw error('invalid_request')
  if (/^https?:\/\/[^/?#]*@/i.test(raw)) throw error('blocked_destination')
  try {
    const url = validatePublicUrl(raw)
    if (url.protocol !== 'https:') throw error('blocked_destination')
    return url
  } catch { throw error('blocked_destination') }
}
function prepare(url: URL, options: ProviderHttpOptions, internal: boolean) {
  const timeoutMs = bound(options.timeoutMs, 120_000, 1_800_000)
  const maxBytes = bound(options.maxBytes, 8 * 1024 * 1024, 96 * 1024 * 1024)
  const method = options.method === undefined ? 'GET' : options.method
  if (!['GET', 'POST', 'HEAD'].includes(method)) throw error('invalid_request')
  if (options.body !== undefined && (method !== 'POST' ||
      (typeof options.body !== 'string' && !Buffer.isBuffer(options.body)))) throw error('invalid_request')
  if (options.body !== undefined && Buffer.byteLength(options.body) > requestLimit) throw error('too_large')
  if (typeof options.body === 'string') {
    try { JSON.parse(options.body) } catch { throw error('invalid_request') }
  }
  const body = options.body === undefined ? undefined : Buffer.from(options.body)
  const headers: Record<string, string> = { 'accept-encoding': 'identity' }
  let credentials = false
  if (options.headers !== undefined && (!options.headers || typeof options.headers !== 'object' || Array.isArray(options.headers))) throw error('invalid_request')
  for (const [name, value] of Object.entries(options.headers || {})) {
    const key = name.toLowerCase()
    if ((!plainHeaders.has(key) && !credentialHeaders.has(key)) || Object.prototype.hasOwnProperty.call(headers, key) ||
      // eslint-disable-next-line no-control-regex -- deliberate: rejects control characters in provider headers
        typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw error('invalid_request')
    try { http.validateHeaderName(name); http.validateHeaderValue(name, value) } catch { throw error('invalid_request') }
    if (credentialHeaders.has(key)) {
      if (internal || !(key === 'authorization' ? /^Bearer [\x21-\x7e]{1,8000}$/ : /^[\x21-\x7e]{1,8000}$/).test(value)) throw error('invalid_request')
      credentials = true
    }
    headers[key] = value
  }
  if (body !== undefined) {
    headers['content-type'] ??= 'application/json'
    headers['content-length'] = String(body.length)
  } else if (method === 'POST') headers['content-length'] = '0'
  // Include the automatically generated Host, Connection and final CRLF.
  let bytes = Buffer.byteLength(url.host) + 8 + 19 + 2
  for (const [name, value] of Object.entries(headers)) bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4
  if (bytes > headerLimit) throw error('invalid_request')
  if (!internal) {
    if (credentials && options.allowedOrigins === undefined) throw error('blocked_destination')
    if (options.allowedOrigins !== undefined) {
      if (!Array.isArray(options.allowedOrigins)) throw error('invalid_request')
      for (const origin of options.allowedOrigins) {
        if (publicUrl(origin).origin !== origin) throw error('invalid_request')
      }
      if (!options.allowedOrigins.includes(url.origin)) throw error('blocked_destination')
    }
  }
  return { timeoutMs, maxBytes, method, body, headers }
}

const privateV4 = new BlockList()
for (const [address, prefix] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) privateV4.addSubnet(address, prefix, 'ipv4')
const privateV6 = new BlockList()
privateV6.addSubnet('fc00::', 7, 'ipv6')
privateV6.addAddress('::1', 'ipv6')
const metadataV6 = new BlockList()
metadataV6.addAddress('fd00:ec2::254', 'ipv6')
function sidecarAddress(address: string, secure: boolean): boolean {
  if (address.includes('%')) return false
  const family = isIP(address)
  if (family === 4 && privateV4.check(address, 'ipv4')) return true
  if (family === 6 && privateV6.check(address, 'ipv6') && !metadataV6.check(address, 'ipv6')) return true
  return secure && isPublicAddress(address)
}
function sidecarUrl(path: SidecarPath): URL {
  if (!['/health', '/api/generate', '/api/analyze', '/api/vision-chat'].includes(path)) throw error('invalid_request')
  const raw = process.env.IMAGE_API_URL || 'http://localhost:8081'
  if (raw.length > 8192 || unsafeRaw.test(raw) || /[?#%]/.test(raw) || /\/(?:\.|\.\.)(?:\/|$)/.test(raw)) throw error('invalid_request')
  let base: URL
  try { base = new URL(raw) } catch { throw error('invalid_request') }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      !/^https?:\/\//i.test(raw) || /^https?:\/\/[^/]*@/i.test(raw) ||
      /(?:^|\.)(?:metadata|metadata\.google\.internal|metadata\.packet\.net)\.?$/.test(base.hostname)) throw error('blocked_destination')
  base.pathname = base.pathname.replace(/\/+$/, '') + path
  return base
}
function aborted(signal: AbortSignal): ProviderHttpError {
  return signal.reason instanceof ProviderHttpError ? signal.reason : error('aborted')
}
/** Always detach the listener; late DNS settlement can never dispatch a request. */
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (failure?: ProviderHttpError, value?: T) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      if (failure) reject(failure); else resolve(value!)
    }
    const cancel = () => finish(aborted(signal))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    promise.then(value => finish(undefined, value), () => finish(error('network_error')))
  })
}
async function resolveSidecar(host: string, secure: boolean, signal: AbortSignal) {
  const literal = isIP(host)
  const addresses = literal ? [{ address: host, family: literal }] : await wait(lookup(host, { all: true, verbatim: true }), signal)
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(entry => !entry || isIP(entry.address) !== entry.family || !sidecarAddress(entry.address, secure))) throw error('blocked_destination')
  return addresses.find(entry => entry.family === 4) || addresses[0]
}

function responseValue(url: URL, status: number, headers: Headers, body: Buffer): ProviderResponse {
  return {
    status, ok: true, url: url.href, headers, body,
    async json() { try { return JSON.parse(body.toString('utf8')) } catch { throw error('invalid_response') } },
    async text() { return body.toString('utf8') },
    async arrayBuffer() { const copy = new Uint8Array(body.length); copy.set(body); return copy.buffer },
  }
}
function dispatch(url: URL, address: { address: string; family: number }, config: ReturnType<typeof prepare>, signal: AbortSignal): Promise<ProviderResponse> {
  return new Promise((resolve, reject) => {
    let settled = false
    let req: http.ClientRequest | undefined, res: http.IncomingMessage | undefined, agent: http.Agent | undefined
    const chunks: Buffer[] = []
    let tail: Buffer | undefined
    let used = 0
    const finish = (failure?: ProviderHttpError, result?: ProviderResponse) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      chunks.length = 0
      tail = undefined
      used = 0
      res?.destroy(); req?.destroy(); agent?.destroy()
      if (failure) reject(failure); else resolve(result!)
    }
    const cancel = () => finish(aborted(signal))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) { cancel(); return }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const pinnedLookup = ((hostname: string, options: any, callback: any) => {
      if (settled || signal.aborted || hostname !== host) { callback(error('blocked_destination')); return }
      if (options?.all) callback(null, [{ address: address.address, family: address.family }])
      else callback(null, address.address, address.family)
    }) as NonNullable<http.RequestOptions['lookup']>
    try {
      const agentOptions = { keepAlive: false, rejectUnauthorized: true, proxyEnv: {}, family: address.family, lookup: pinnedLookup }
      agent = url.protocol === 'https:' ? new https.Agent(agentOptions) : new http.Agent(agentOptions)
      req = (url.protocol === 'https:' ? https : http).request(url, {
        method: config.method, headers: config.headers, agent, family: address.family,
        lookup: pinnedLookup, rejectUnauthorized: true, maxHeaderSize: headerLimit,
      }, incoming => {
        // Keep an error sink even on late/destroyed streams.
        incoming.on('error', () => finish(error('network_error')))
        if (settled) { incoming.destroy(); return }
        res = incoming
        incoming.on('aborted', () => finish(error('network_error')))
        incoming.on('close', () => { if (!settled) finish(error('invalid_response')) })
        try {
          const status = incoming.statusCode || 0
          if (status < 200 || status >= 300) { finish(error(status >= 300 && status < 400 ? 'redirect_rejected' : 'http_error', status)); return }
          const headers = new Headers()
          let bytes = 2
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value === undefined) continue
            for (const item of Array.isArray(value) ? value : [value]) {
              bytes += Buffer.byteLength(name) + Buffer.byteLength(item) + 4
              headers.append(name, item)
            }
          }
          // rawHeaders retains duplicate field overhead otherwise lost in parsing.
          let rawBytes = 2
          for (let i = 0; i < incoming.rawHeaders.length; i += 2) rawBytes += Buffer.byteLength(incoming.rawHeaders[i]) + Buffer.byteLength(incoming.rawHeaders[i + 1]) + 4
          if (Math.max(bytes, rawBytes) > headerLimit) { finish(error('too_large')); return }
          if ((headers.get('content-encoding') ?? 'identity').trim().toLowerCase() !== 'identity') { finish(error('invalid_response')); return }
          const transferEncoding = headers.get('transfer-encoding')
          if (transferEncoding !== null && transferEncoding.trim().toLowerCase() !== 'chunked') { finish(error('invalid_response')); return }
          const length = headers.get('content-length')
          if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) { finish(error('invalid_response')); return }
          if (length !== null && Number(length) > config.maxBytes) { finish(error('too_large')); return }
          if (length !== null && headers.has('transfer-encoding')) { finish(error('invalid_response')); return }
          let received = 0
          incoming.on('data', (chunk: Buffer) => {
            if (settled) return
            if (!Buffer.isBuffer(chunk)) { finish(error('invalid_response')); return }
            received += chunk.length
            if (received > config.maxBytes) { finish(error('too_large')); return }
            if (((config.method === 'HEAD' || status === 204) && received > 0) ||
                (config.method !== 'HEAD' && length !== null && received > Number(length))) { finish(error('invalid_response')); return }
            // Fixed-size blocks bound allocation/object overhead even if a peer
            // deliberately sends millions of single-byte HTTP chunks.
            let offset = 0
            while (offset < chunk.length) {
              tail ??= Buffer.allocUnsafe(Math.min(65536, config.maxBytes))
              const count = Math.min(tail.length - used, chunk.length - offset)
              chunk.copy(tail, used, offset, offset + count)
              used += count; offset += count
              if (used === tail.length) { chunks.push(tail); tail = undefined; used = 0 }
            }
          })
          incoming.on('end', () => {
            if (settled) return
            if (!incoming.complete || (config.method !== 'HEAD' && length !== null && received !== Number(length))) { finish(error('invalid_response')); return }
            if (tail && used) chunks.push(tail.subarray(0, used))
            finish(undefined, responseValue(url, status, headers, Buffer.concat(chunks, received)))
          })
        } catch { finish(error('invalid_response')) }
      })
      req.on('error', () => finish(signal.aborted ? aborted(signal) : error('network_error')))
      req.on('upgrade', (incoming: http.IncomingMessage, socket: import('node:stream').Duplex) => {
        incoming.on('error', () => finish(error('network_error')))
        socket.on('error', () => finish(error('network_error')))
        socket.destroy(); incoming.destroy()
        finish(error('http_error', incoming.statusCode || 101))
      })
      req.on('close', () => { if (!settled && !res) finish(error('network_error')) })
      if (settled || signal.aborted) { req.destroy(); agent.destroy(); if (!settled) cancel(); return }
      req.end(config.body)
    } catch { finish(error('network_error')) }
  })
}
async function request(url: URL, options: ProviderHttpOptions, internal: boolean): Promise<ProviderResponse> {
  const config = prepare(url, options, internal)
  const control = new AbortController()
  const cancel = () => control.abort(error('aborted'))
  const timer = setTimeout(() => control.abort(error('timeout')), config.timeoutMs)
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  try {
    if (control.signal.aborted) throw aborted(control.signal)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const address = internal ? await resolveSidecar(host, url.protocol === 'https:', control.signal)
      : await resolvePublicAddress(host, control.signal)
    if (control.signal.aborted) throw aborted(control.signal)
    return await dispatch(url, address, config, control.signal)
  } catch (failure) {
    if (control.signal.aborted) throw aborted(control.signal)
    if (failure instanceof ProviderHttpError) throw failure
    // PublicHttpError details must never escape this API.
    throw error((failure as { code?: string })?.code === 'blocked_destination' ? 'blocked_destination' : 'network_error')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
  }
}
export async function providerRequest(url: string, options: ProviderHttpOptions = {}): Promise<ProviderResponse> {
  return request(publicUrl(url), options, false)
}
export async function providerJson<T = any>(url: string, body: unknown, options: ProviderHttpOptions = {}): Promise<T> {
  let serialized: string | undefined
  try { serialized = JSON.stringify(body) } catch { throw error('invalid_request') }
  if (serialized === undefined) throw error('invalid_request')
  return (await providerRequest(url, { ...options, method: 'POST', body: serialized })).json()
}
export async function providerGetJson<T = any>(url: string, options: ProviderHttpOptions = {}): Promise<T> {
  return (await providerRequest(url, { ...options, method: 'GET' })).json()
}
export async function sidecarRequest(path: SidecarPath, options: SidecarHttpOptions = {}): Promise<ProviderResponse> {
  return request(sidecarUrl(path), options, true)
}
