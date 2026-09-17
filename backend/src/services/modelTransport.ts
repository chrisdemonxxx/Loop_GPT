import https from 'node:https'
import { Readable, Transform } from 'node:stream'
import { Response as SDKResponse, type RequestInfo, type RequestInit } from 'node-fetch'
import { resolvePublicAddress, validatePublicUrl } from './publicHttp'

type Fetch = (input: RequestInfo, init?: RequestInit) => Promise<SDKResponse>

export class ModelTransportError extends Error {
  constructor() { super('Model transport configuration or request is not permitted') }
}

/** Client-construction checks; fresh DNS validation also runs for every request. */
export function modelBaseUrl(raw: unknown): string {
  try {
    if (typeof raw !== 'string' || /[?#%]/.test(raw) || /\/(?:\.|\.\.)(?:\/|$)/.test(raw)) throw new ModelTransportError()
    const url = validatePublicUrl(raw)
    if (url.protocol !== 'https:') throw new ModelTransportError()
    return url.href.replace(/\/+$/, '')
  } catch { throw new ModelTransportError() }
}

export function modelCredential(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,8000}$/.test(value)) throw new ModelTransportError()
  return value
}

export interface ModelTransportLimits {
  timeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  maxHeaderBytes?: number
}

function limit(value: number | undefined, fallback: number, ceiling: number): number {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < 1 || result > ceiling) throw new ModelTransportError()
  return result
}

/** Abort waiting even if a delegate ignores cancellation; dispose late responses. */
function waitForResponse(promise: ReturnType<Fetch>, signal: AbortSignal): ReturnType<Fetch> {
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', abort); reject(new ModelTransportError())
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(response => {
      if (settled) { (response.body as any)?.destroy?.(); return }
      settled = true; signal.removeEventListener('abort', abort); resolve(response)
    }, () => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', abort); reject(new ModelTransportError())
    })
  })
}

/** Chat-only fetch with per-request pinned DNS and a deadline through body consumption. */
export function guardedModelFetch(baseUrl: string, apiKey: string, delegate: Fetch, limits: ModelTransportLimits = {}): Fetch {
  const endpoint = `${modelBaseUrl(baseUrl)}/chat/completions`
  const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '')
  const authorization = `Bearer ${modelCredential(apiKey)}`
  const timeoutMs = limit(limits.timeoutMs, 300_000, 600_000)
  const maxRequestBytes = limit(limits.maxRequestBytes, 32 * 1024 * 1024, 32 * 1024 * 1024)
  const maxResponseBytes = limit(limits.maxResponseBytes, 8 * 1024 * 1024, 8 * 1024 * 1024)
  const maxHeaderBytes = limit(limits.maxHeaderBytes, 16_384, 16_384)
  return async (input, init) => {
    let agent: https.Agent | undefined
    let source: Readable | undefined, bounded: Transform | undefined
    let finished = false
    const control = new AbortController()
    const finish = (error?: ModelTransportError) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      init?.signal?.removeEventListener('abort', cancel)
      control.abort()
      source?.unpipe(bounded)
      source?.destroy()
      if (error) bounded?.destroy(error)
      agent?.destroy()
    }
    const cancel = () => finish(new ModelTransportError())
    const timer = setTimeout(cancel, timeoutMs)
    init?.signal?.addEventListener('abort', cancel, { once: true })
    if (init?.signal?.aborted) cancel()
    try {
      if (typeof input !== 'string' || input !== endpoint || init?.method !== 'POST' || control.signal.aborted) throw new ModelTransportError()
      const headers = new Headers(init.headers as HeadersInit)
      if (headers.get('authorization') !== authorization || headers.get('content-type') !== 'application/json') throw new ModelTransportError()
      if (typeof init.body !== 'string' || Buffer.byteLength(init.body) > maxRequestBytes || (headers.has('content-length') &&
          headers.get('content-length') !== String(Buffer.byteLength(init.body)))) throw new ModelTransportError()
      let requestHeaderBytes = 0
      for (const name of headers.keys()) {
        if (!['authorization', 'content-type', 'content-length', 'accept', 'user-agent'].includes(name) && !name.startsWith('x-stainless-')) throw new ModelTransportError()
        requestHeaderBytes += Buffer.byteLength(name) + Buffer.byteLength(headers.get(name)!) + 4
      }
      if (requestHeaderBytes + 27 > maxHeaderBytes) throw new ModelTransportError() // Includes forced Accept-Encoding: identity.
      const address = await resolvePublicAddress(host, control.signal)
      if (control.signal.aborted) throw new ModelTransportError()
      // Only socket lookup changes: original Host/SNI/certificate hostname stays.
      agent = new https.Agent({ keepAlive: false, rejectUnauthorized: true, proxyEnv: {}, family: address.family,
        lookup: ((hostname: string, options: any, callback: any) => {
          if (hostname !== host) { callback(new ModelTransportError()); return }
          if (options?.all) callback(null, [{ address: address.address, family: address.family }])
          else callback(null, address.address, address.family)
        }) as any,
      } as https.AgentOptions)
      // Identity-only responses make encoded/decoded payload budgets identical;
      // do not allow node-fetch to auto-decompress before our counter sees bytes.
      headers.set('accept-encoding', 'identity')
      const response = await waitForResponse(delegate(endpoint, { ...init, headers: Object.fromEntries(headers),
        signal: control.signal, agent, redirect: 'manual', follow: 0, compress: false,
      } as Parameters<Fetch>[1]), control.signal)
      if (!(response.body instanceof Readable)) { (response.body as any)?.destroy?.(); throw new ModelTransportError() }
      source = response.body
      source.on('error', cancel)
      source.once('close', () => { if (!source!.readableEnded) cancel() })
      if (finished) { source.destroy(); throw new ModelTransportError() }
      if (response.status < 200 || response.status >= 300 || response.redirected || response.url !== endpoint) {
        throw new ModelTransportError()
      }
      let responseHeaderBytes = 0
      response.headers.forEach((value, name) => { responseHeaderBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4 })
      if (responseHeaderBytes > maxHeaderBytes || (response.headers.get('content-encoding') || 'identity').trim().toLowerCase() !== 'identity') throw new ModelTransportError()
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)) throw new ModelTransportError()
      let received = 0
      bounded = new Transform({
        transform(chunk, _encoding, callback) {
          received += Buffer.byteLength(chunk)
          callback(received > maxResponseBytes ? new ModelTransportError() : null, received > maxResponseBytes ? undefined : chunk)
        },
        flush(callback) { callback(length !== null && received !== Number(length) ? new ModelTransportError() : null) },
      })
      bounded.on('error', cancel)
      bounded.once('end', () => finish())
      bounded.once('close', () => finish())
      const result = new SDKResponse(bounded, { status: response.status, headers: response.headers, url: endpoint, size: maxResponseBytes })
      source.pipe(bounded)
      return result
    } catch {
      finish(new ModelTransportError())
      throw new ModelTransportError()
    }
  }
}
