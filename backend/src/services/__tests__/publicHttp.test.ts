import http from 'node:http'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const dns = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }))
import { isPublicAddress, validatePublicUrl, publicRequest, getPublicJson, postPublicJson } from '../publicHttp'

type Plan = { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; stall?: boolean; delay?: number; error?: string }
let plans: Plan[], requests: Array<{ url: URL; options: any; req: any }>
function transport(url: URL, options: any, callback: (response: any) => void) {
  const plan = plans.shift() || {}
  const req: any = new EventEmitter()
  let response: any, timer: ReturnType<typeof setTimeout> | undefined
  req.destroy = vi.fn(() => { req.destroyed = true; if (timer) clearTimeout(timer); response?.destroy(); return req })
  req.end = vi.fn(() => {
    const respond = () => {
      if (req.destroyed) return
      if (plan.error) { req.emit('error', new Error(plan.error)); return }
      response = new PassThrough()
      response.statusCode = plan.status || 200; response.headers = plan.headers || {}; response.complete = false
      callback(response)
      if (response.destroyed) return
      for (const chunk of plan.chunks || [Buffer.from('ok')]) { if (!response.destroyed) response.write(chunk) }
      if (!plan.stall && !response.destroyed) { response.complete = true; response.end() }
    }
    if (plan.delay) timer = setTimeout(respond, plan.delay)
    else queueMicrotask(respond)
    return req
  })
  requests.push({ url, options, req })
  return req
}
beforeEach(() => {
  plans = []; requests = []
  dns.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  vi.spyOn(http, 'request').mockImplementation(transport as any)
  vi.spyOn(https, 'request').mockImplementation(transport as any)
})
afterEach(() => { for (const item of requests) item.req.destroy(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('public destination classification', () => {
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'])('accepts public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })
  it.each(['0.0.0.0', '10.0.0.1', '100.100.100.200', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '255.255.255.255', '168.63.129.16', '147.75.207.207', '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
    '64:ff9b::a00:1', 'fc00::1', 'fe80::1', 'ff02::1', '2001::1', '2001:db8::1', '2002:7f00:1::1', '3fff::1'])('rejects reserved address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })
  it.each(['http://127.0.0.1', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1',
    'http://[::ffff:127.0.0.1]', 'http://localhost', 'http://api.localhost', 'http://metadata.google.internal',
    'http://printer.local', 'http://singlelabel', 'http://metadata.packet.net', 'https://example.com.', 'file:///etc/passwd',
    'https://user:secret@example.com', 'https://example.com:8443', 'https://example.com\\@127.0.0.1', ' https://example.com'])('rejects unsafe URL %s before transport', async (url) => {
    await expect(publicRequest(url)).rejects.toThrow()
    expect(requests).toHaveLength(0)
    expect(dns.lookup).not.toHaveBeenCalled()
  })
  it('normalizes standard explicit ports and removes fragments', () => {
    expect(validatePublicUrl('https://example.com:443/path#fragment').href).toBe('https://example.com/path')
  })
})

describe('pinned transport and bounded responses (mocked sockets/DNS)', () => {
  it('pins the checked DNS address while preserving Host/TLS hostname and disabling pooled agents', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:8888')
    expect((await publicRequest('https://public.example.com/path')).body.toString()).toBe('ok')
    expect(requests[0].url.hostname).toBe('public.example.com')
    expect(requests[0].options.agent.options.keepAlive).toBe(false)
    expect(requests[0].options.agent.options.proxyEnv).toEqual({})
    expect(requests[0].options.maxHeaderSize).toBe(16384)
    expect(requests[0].options.rejectUnauthorized).not.toBe(false)
    dns.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const callback = vi.fn()
    requests[0].options.lookup('public.example.com', {}, callback)
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    requests[0].options.lookup('public.example.com', { all: true }, callback)
    expect(callback).toHaveBeenLastCalledWith(null, [{ address: '93.184.216.34', family: 4 }])
    expect(dns.lookup).toHaveBeenCalledTimes(1)
  })
  it.each([
    [], [{ address: '10.0.0.1', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }],
    [{ address: '93.184.216.34', family: 6 }],
  ].map((records) => ({ records })))('rejects empty/private/mixed/invalid DNS records $records', async ({ records }) => {
    dns.lookup.mockResolvedValue(records)
    await expect(publicRequest('https://public.example.com')).rejects.toMatchObject({ code: 'blocked_destination' })
    expect(requests).toHaveLength(0)
  })
  it('does not return DNS or socket error details', async () => {
    dns.lookup.mockRejectedValueOnce(new Error('secret in DNS error'))
    await expect(publicRequest('https://public.example.com')).rejects.toMatchObject({ message: 'Outbound request failed' })
    plans.push({ error: 'secret in transport error' })
    await expect(publicRequest('https://public.example.com')).rejects.toMatchObject({ message: 'Outbound request failed' })
  })
  it('revalidates each anonymous redirect, including DNS on the same hostname', async () => {
    plans.push({ status: 302, headers: { location: '/next' } })
    dns.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    await expect(publicRequest('https://public.example.com', { redirects: 3 })).rejects.toMatchObject({ code: 'blocked_destination' })
    expect(requests).toHaveLength(1)
  })
  it('follows an allowed public redirect and reports the final URL', async () => {
    plans.push({ status: 302, headers: { location: 'https://other.example.com/article' } }, { chunks: [Buffer.from('article')] })
    const result = await publicRequest('https://public.example.com', { redirects: 3 })
    expect(result.url).toBe('https://other.example.com/article')
    expect(result.body.toString()).toBe('article')
    expect(dns.lookup).toHaveBeenCalledTimes(2)
  })
  it.each(['http://127.0.0.1/admin', 'http://other.example.com', 'file:///etc/passwd', 'https://user:secret@other.example.com'])('rejects redirect %s', async (location) => {
    plans.push({ status: 302, headers: { location } })
    await expect(publicRequest('https://public.example.com', { redirects: 3 })).rejects.toMatchObject({ code: 'blocked_destination' })
    expect(requests).toHaveLength(1)
  })
  it('bounds redirect loops and does not forward authenticated bodies', async () => {
    plans.push(...Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/next' } })))
    await expect(publicRequest('https://public.example.com', { redirects: 3 })).rejects.toMatchObject({ code: 'redirect_rejected' })
    expect(requests).toHaveLength(4)
    plans.push({ status: 307, headers: { location: 'https://other.example.com' } })
    await expect(postPublicJson('https://public.example.com', { token: 'fixture-secret' }, { headers: { Authorization: 'Bearer fixture' } })).rejects.toMatchObject({ code: 'redirect_rejected' })
    expect(requests).toHaveLength(5)
  })
  it('rejects explicit credential redirects, non-TLS credentials and origin mismatches before sending', async () => {
    await expect(publicRequest('https://public.example.com', { headers: { Authorization: 'Bearer fixture' }, redirects: 3 })).rejects.toMatchObject({ code: 'redirect_rejected' })
    await expect(publicRequest('http://public.example.com', { headers: { 'X-Key': 'fixture' } })).rejects.toMatchObject({ code: 'blocked_destination' })
    await expect(publicRequest('https://public.example.com', { allowedOrigins: ['https://other.example.com'] })).rejects.toMatchObject({ code: 'blocked_destination' })
    expect(requests).toHaveLength(0)
  })
  it.each(['Host', 'Content-Length', 'Transfer-Encoding', 'Proxy-Authorization', 'Accept-Encoding'])('rejects caller override of %s', async (header) => {
    await expect(publicRequest('https://public.example.com', { headers: { [header]: 'override' } })).rejects.toMatchObject({ code: 'invalid_request' })
    expect(requests).toHaveLength(0)
  })
  it('rejects header injection, oversized request bodies and invalid limits', async () => {
    await expect(publicRequest('https://public.example.com', { headers: { Authorization: 'key\r\nHost: internal' } })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(publicRequest('https://public.example.com', { body: 'x'.repeat(65537) })).rejects.toMatchObject({ code: 'invalid_request' })
    for (const opts of [{ maxBytes: Infinity }, { timeoutMs: 0 }, { redirects: 4 }]) await expect(publicRequest('https://public.example.com', opts)).rejects.toMatchObject({ code: 'invalid_request' })
  })
  it('rejects oversized content length before reading the body', async () => {
    plans.push({ headers: { 'content-length': '1000' }, stall: true })
    await expect(publicRequest('https://public.example.com', { maxBytes: 10 })).rejects.toMatchObject({ code: 'too_large' })
    expect(requests[0].req.destroy).toHaveBeenCalled()
  })
  it('counts streamed bytes even without content length', async () => {
    plans.push({ chunks: [Buffer.from('abc'), Buffer.from('def')] })
    await expect(publicRequest('https://public.example.com', { maxBytes: 5 })).rejects.toMatchObject({ code: 'too_large' })
  })
  it.each([['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync]] as const)('bounds decompressed %s output', async (encoding, compress) => {
    plans.push({ headers: { 'content-encoding': encoding }, chunks: [compress(Buffer.from('hello'))] })
    expect((await publicRequest('https://public.example.com')).body.toString()).toBe('hello')
    plans.push({ headers: { 'content-encoding': encoding }, chunks: [compress(Buffer.alloc(2000, 65))] })
    await expect(publicRequest('https://public.example.com', { maxBytes: 100 })).rejects.toMatchObject({ code: 'too_large' })
  })
  it('rejects unsupported encoding and HTTP errors without reflecting response bodies', async () => {
    plans.push({ headers: { 'content-encoding': 'unknown' } })
    await expect(publicRequest('https://public.example.com')).rejects.toMatchObject({ code: 'invalid_response' })
    plans.push({ status: 401, chunks: [Buffer.from('secret-reflected-by-provider')] })
    await expect(publicRequest('https://public.example.com')).rejects.toMatchObject({ message: 'Outbound service returned HTTP 401' })
  })
  it('includes stalled DNS in its deadline and never opens a late socket', async () => {
    let release!: (value: any) => void
    dns.lookup.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    await expect(publicRequest('https://public.example.com', { timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' })
    release([{ address: '93.184.216.34', family: 4 }]); await Promise.resolve()
    expect(requests).toHaveLength(0)
  })
  it('keeps the deadline running after headers and destroys a stalled body', async () => {
    plans.push({ stall: true })
    await expect(publicRequest('https://public.example.com', { timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' })
    expect(requests[0].req.destroy).toHaveBeenCalled()
  })
  it('honors cancellation before DNS and during response streaming', async () => {
    const early = new AbortController(); early.abort()
    await expect(publicRequest('https://public.example.com', { signal: early.signal })).rejects.toMatchObject({ code: 'aborted' })
    expect(dns.lookup).not.toHaveBeenCalled()
    const control = new AbortController(); plans.push({ stall: true })
    const result = publicRequest('https://public.example.com', { signal: control.signal })
    setTimeout(() => control.abort(), 10)
    await expect(result).rejects.toMatchObject({ code: 'aborted' })
    expect(requests[0].req.destroy).toHaveBeenCalled()
  })
  it('parses bounded JSON and hides malformed payload contents', async () => {
    plans.push({ chunks: [Buffer.from('{"ok":true}')] }, { chunks: [Buffer.from('secret malformed content')] })
    expect(await getPublicJson('https://public.example.com')).toEqual({ ok: true })
    await expect(getPublicJson('https://public.example.com')).rejects.toMatchObject({ message: 'Outbound service returned invalid JSON' })
  })

  it('checks the server preflight after DNS and opens no socket when denied', async () => {
    const beforeConnect = vi.fn(async () => { throw new Error('private authorization detail') })
    await expect(publicRequest('https://public.example.com', { beforeConnect })).rejects.toMatchObject({ code: 'network_error' })
    expect(dns.lookup).toHaveBeenCalledTimes(1)
    expect(beforeConnect).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(0)
  })

  it('includes stalled server preflight in the shared deadline', async () => {
    await expect(publicRequest('https://public.example.com', { timeoutMs: 30, beforeConnect: () => new Promise(() => {}) })).rejects.toMatchObject({ code: 'timeout' })
    expect(requests).toHaveLength(0)
  })
})
