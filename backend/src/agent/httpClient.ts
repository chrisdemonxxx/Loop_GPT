import { providerRequest } from '../services/providerHttp'

/** Legacy compatibility helpers, restricted to the reviewed public transport.
 * Credentials require explicitly configured endpoint origins; never infer them.
 */
export interface HttpOptions {
  headers?: Record<string, string>
  allowedOrigins?: readonly string[]
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
}

export async function fetchText(url: string, opts: HttpOptions = {}): Promise<string> {
  return (await providerRequest(url, { timeoutMs: 20000, ...opts })).text()
}

export async function postForm(url: string, form: Record<string, string>, opts: HttpOptions = {}): Promise<string> {
  return (await providerRequest(url, { timeoutMs: 20000, ...opts, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...opts.headers },
    body: Buffer.from(new URLSearchParams(form).toString()) })).text()
}

export async function postJson<T = any>(url: string, body: any, opts: HttpOptions = {}): Promise<T> {
  return (await providerRequest(url, { timeoutMs: 20000, ...opts, method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.headers }, body: JSON.stringify(body) })).json()
}

export async function getJson<T = any>(url: string, opts: HttpOptions = {}): Promise<T> {
  return (await providerRequest(url, { timeoutMs: 20000, ...opts })).json()
}

export async function fetchBuffer(url: string, opts: HttpOptions & { method?: string; body?: any } = {}): Promise<Buffer> {
  const { method = 'GET', body, ...options } = opts
  if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') throw new Error('Unsupported HTTP method')
  return (await providerRequest(url, { timeoutMs: 120000, ...options, method,
    body: body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body) })).body
}

export const IMAGE_RESPONSE_BYTES = 16 * 1024 * 1024
export const VIDEO_RESPONSE_BYTES = 96 * 1024 * 1024
const ARTIFACT_BYTES = 50 * 1024 * 1024

export function checkedMedia(buffer: Buffer): Buffer {
  if (!buffer.length || buffer.length > ARTIFACT_BYTES) throw new Error('Invalid media size')
  return buffer
}

export function decodeMedia(value: string): Buffer {
  const encoded = value.replace(/^data:[^,]*;base64,/i, '').replace(/\s/g, '')
  if (!encoded || encoded.length > Math.ceil(ARTIFACT_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error('Invalid media encoding')
  return checkedMedia(Buffer.from(encoded, 'base64'))
}

/** Recheck URL syntax and credential scope on every use. The transport owns DNS
 * and public-address enforcement, including for anonymous result downloads.
 */
export function mediaUrl(value: string, endpoint?: string, sameOrigin = false): string {
  try {
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\s\u0000-\u001f\u007f-\u009f\\#]/.test(value)) throw new Error()
    const url = endpoint ? new URL(value, endpoint) : new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (sameOrigin && url.origin !== new URL(endpoint!).origin)) throw new Error()
    return url.href
  } catch { throw new Error('Invalid media URL') }
}

export function mediaAuth(endpoint: string): Pick<HttpOptions, 'headers' | 'allowedOrigins'> {
  const origin = new URL(mediaUrl(endpoint)).origin
  return process.env.HF_TOKEN
    ? { headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` }, allowedOrigins: [origin] }
    : {}
}

/** One wall-clock budget covers submission, fallback, polls and downloads. */
export function mediaOperation(timeoutMs: number, external?: AbortSignal) {
  const controller = new AbortController()
  const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 1_800_000))
  let timedOut = false
  const abort = () => controller.abort()
  const timer = setTimeout(() => { timedOut = true; abort() }, Math.max(0, deadline - Date.now()))
  if (external?.aborted) abort()
  else external?.addEventListener('abort', abort, { once: true })
  const check = () => {
    if (Date.now() >= deadline) { timedOut = true; abort() }
    if (controller.signal.aborted) throw new Error(timedOut ? 'Media operation timed out' : 'Media operation cancelled')
  }
  return {
    signal: controller.signal,
    abort,
    check,
    remaining(cap = 1_800_000) { check(); return Math.max(1, Math.min(cap, deadline - Date.now())) },
    async sleep(ms: number) {
      check()
      await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(wait); controller.signal.removeEventListener('abort', cancelled) }
        const cancelled = () => { done(); reject(new Error('Media operation interrupted')) }
        const wait = setTimeout(() => { done(); resolve() }, Math.min(ms, deadline - Date.now()))
        controller.signal.addEventListener('abort', cancelled, { once: true })
      })
      check()
    },
    dispose() { clearTimeout(timer); external?.removeEventListener('abort', abort) },
  }
}

export type MediaOperation = ReturnType<typeof mediaOperation>

export function mediaFailure(operation: MediaOperation, kind: string): string {
  try { operation.check() } catch (error) { return (error as Error).message }
  return `${kind} generation failed`
}
