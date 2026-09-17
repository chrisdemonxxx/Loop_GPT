import http from 'node:http'
import https from 'node:https'
import { EventEmitter, getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const dns = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }))
import { ProviderHttpError, providerRequest, providerJson, providerGetJson, sidecarRequest } from '../providerHttp'

const endpoint = 'https://provider.example.com/api'
const publicRecords = [{ address: '93.184.216.34', family: 4 }]
type ResponseStream = PassThrough & { statusCode: number; headers: http.IncomingHttpHeaders; rawHeaders: string[]; complete: boolean }
type Plan = {
  status?: number; headers?: http.IncomingHttpHeaders; rawHeaders?: string[]; chunks?: Buffer[]
  stall?: boolean; noResponse?: boolean; incomplete?: boolean; prematureClose?: boolean
  socketError?: boolean; responseError?: boolean; synchronous?: boolean; inspect?: (options: any) => void
}
type RequestRecord = { url: URL; options: any; req: any; respond: () => void; response?: ResponseStream }
let plans: Plan[], requests: RequestRecord[], agents: Array<{ options: any; destroy: ReturnType<typeof vi.fn> }>
function transport(url: URL, options: any, callback: (response: any) => void) {
  const plan = plans.shift() || {}
  const req: any = new EventEmitter()
  req.destroy = vi.fn(() => { req.destroyed = true; return req })
  const record: RequestRecord = { url, options, req, respond: () => {} }
  record.respond = () => {
    const response = new PassThrough() as ResponseStream
    record.response = response
    response.statusCode = plan.status ?? 200
    response.headers = plan.headers || {}
    response.rawHeaders = plan.rawHeaders || []
    response.complete = false
    callback(response)
    if (response.destroyed) return
    if (plan.responseError) { response.destroy(new Error('secret response detail')); return }
    for (const chunk of plan.chunks || [Buffer.from('{"ok":true}')]) {
      if (!response.destroyed) response.write(chunk)
    }
    if (plan.prematureClose) { response.destroy(); return }
    if (!plan.stall && !response.destroyed) { response.complete = !plan.incomplete; response.end() }
  }
  req.end = vi.fn(() => {
    plan.inspect?.(options)
    if (plan.socketError) queueMicrotask(() => req.emit('error', new Error('secret socket detail')))
    else if (!plan.noResponse && !plan.synchronous) queueMicrotask(record.respond)
    return req
  })
  requests.push(record)
  if (plan.synchronous) record.respond()
  return req
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve() }
function clean(record: RequestRecord) {
  expect(record.req.destroy).toHaveBeenCalled()
  expect(record.options.agent.destroy).toHaveBeenCalled()
  if (record.response) expect(record.response.destroyed).toBe(true)
}
beforeEach(() => {
  plans = []; requests = []; agents = []
  dns.lookup.mockReset().mockResolvedValue(publicRecords)
  vi.stubEnv('IMAGE_API_URL', '')
  // Both constructors and both request functions are intercepted; no socket can be opened.
  const agent = function(options: any) { const value = { options, destroy: vi.fn() }; agents.push(value); return value }
  vi.spyOn(http, 'Agent').mockImplementation(agent as any)
  vi.spyOn(https, 'Agent').mockImplementation(agent as any)
  vi.spyOn(http, 'request').mockImplementation(transport as any)
  vi.spyOn(https, 'request').mockImplementation(transport as any)
})
afterEach(() => {
  for (const record of requests) { record.response?.destroy(); record.req.destroy() }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers()
})

describe('public provider destination policy', () => {
  it('allows an at-sign in an anonymous signed query, not in the authority', async () => {
    const result = await providerRequest('https://provider.example.com?signer=user@example.com')
    expect(result.status).toBe(200)
    expect(requests[0].url.search).toBe('?signer=user@example.com')
  })
  it('coalesces tiny and multi-block response chunks without changing bytes', async () => {
    const chunks = [...Array.from({ length: 1000 }, () => Buffer.from('a')), Buffer.alloc(150000, 0x62), Buffer.from('tail')]
    plans.push({ chunks })
    const result = await providerRequest(endpoint)
    expect(result.body).toEqual(Buffer.concat(chunks))
    clean(requests[0])
  })
  it.each([
    'http://provider.example.com', 'https://localhost', 'https://host.internal', 'https://metadata.packet.net',
    'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001', 'https://10.1.2.3',
    'https://[::1]', 'https://[::ffff:8.8.8.8]', 'https://[fd00::1]', 'https://169.254.169.254',
    'https://user:secret@provider.example.com', 'https://@provider.example.com', 'https://provider.example.com:8443',
    'https://provider.example.com/#', 'https://provider.example.com/#secret',
    ' https://provider.example.com', 'https://provider.example.com/has space',
    'https://provider.example.com/\nsecret', 'https://provider.example.com/\u0085secret',
    'https://provider.example.com/\u00a0secret', 'https://provider.example.com\\@127.0.0.1',
    'file:///secret', 'not a URL',
  ])('denies URL before DNS: %s', async url => {
    await expect(providerRequest(url)).rejects.toBeInstanceOf(ProviderHttpError)
    expect(dns.lookup).not.toHaveBeenCalled(); expect(requests).toHaveLength(0); expect(agents).toHaveLength(0)
  })
  it.each([
    [], [{ address: '10.0.0.1', family: 4 }],
    [...publicRecords, { address: '::1', family: 6 }],
    [...publicRecords, { address: '169.254.169.254', family: 4 }],
    [{ address: '93.184.216.34', family: 6 }], [{ address: 'not-ip', family: 4 }], [null],
  ].map(records => ({ records })))('denies every unsafe DNS answer set: $records', async ({ records }) => {
    dns.lookup.mockResolvedValue(records)
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'blocked_destination' })
    expect(requests).toHaveLength(0); expect(agents).toHaveLength(0)
  })
  it('retains signed anonymous query bytes and exposes the expected response API', async () => {
    const url = `${endpoint}?sig=a%2Fb%2Bc%3D&expires=123&key=one&key=two`
    plans.push({ headers: { 'content-type': 'application/json', 'content-length': '11' } })
    const result = await providerRequest(url)
    expect(result).toMatchObject({ status: 200, ok: true, url })
    expect(requests[0].url.href).toBe(url)
    expect(result.headers).toBeInstanceOf(Headers)
    expect(result.headers.get('content-type')).toBe('application/json')
    expect(Buffer.isBuffer(result.body)).toBe(true)
    expect(await result.json()).toEqual({ ok: true })
    expect(await result.text()).toBe('{"ok":true}')
    const array = await result.arrayBuffer()
    expect(array).toBeInstanceOf(ArrayBuffer); expect(array.byteLength).toBe(11)
    new Uint8Array(array)[0] = 0
    expect(result.body[0]).toBe(123)
    clean(requests[0])
  })
  it('pins all lookup forms, checks the hostname, disables proxies and uses fresh dedicated agents', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:9000')
    vi.stubEnv('NODE_USE_ENV_PROXY', '1')
    plans.push({ inspect(options) {
      expect(options).toMatchObject({ family: 4, rejectUnauthorized: true, maxHeaderSize: 16384 })
      expect(options.agent.options).toMatchObject({ keepAlive: false, rejectUnauthorized: true, proxyEnv: {} })
      expect(options.agent.options.lookup).toBe(options.lookup)
      expect(options.headers['accept-encoding']).toBe('identity')
      const callback = vi.fn()
      options.lookup('provider.example.com', {}, callback)
      expect(callback).toHaveBeenLastCalledWith(null, '93.184.216.34', 4)
      options.lookup('provider.example.com', { all: true }, callback)
      expect(callback).toHaveBeenLastCalledWith(null, publicRecords)
      options.lookup('other.example.com', {}, callback)
      expect(callback.mock.lastCall?.[0]).toBeInstanceOf(ProviderHttpError)
    } })
    await providerRequest(endpoint); await providerRequest(endpoint)
    expect(dns.lookup).toHaveBeenCalledTimes(2)
    expect(dns.lookup).toHaveBeenCalledWith('provider.example.com', { all: true, verbatim: true })
    expect(agents).toHaveLength(2); expect(agents[0]).not.toBe(agents[1])
    dns.lookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }])
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'blocked_destination' })
    expect(requests).toHaveLength(2)
  })
  it.each(['https://8.8.8.8/api', 'https://[2606:4700:4700::1111]/api'])('skips DNS for validated literal %s', async url => {
    await providerRequest(url)
    expect(dns.lookup).not.toHaveBeenCalled(); expect(requests).toHaveLength(1)
  })
})

describe('origin-bound credentials and request validation', () => {
  it.each(['Authorization', 'x-api-key'])('requires a canonical exact origin for %s', async name => {
    const headers = { [name]: name === 'Authorization' ? 'Bearer fixture-secret' : 'fixture-secret' }
    for (const allowedOrigins of [undefined, [], ['https://other.example.com'], ['https://provider.example.com/'],
      ['https://provider.example.com/path'], ['https://provider.example.com', 'http://other.example.com']]) {
      await expect(providerRequest(endpoint, { headers, allowedOrigins })).rejects.toBeInstanceOf(ProviderHttpError)
    }
    expect(dns.lookup).not.toHaveBeenCalled(); expect(requests).toHaveLength(0)
    await providerRequest(endpoint, { headers, allowedOrigins: ['https://provider.example.com'] })
    expect(requests[0].options.headers[name.toLowerCase()]).toBe(headers[name])
  })
  it('enforces supplied origins on anonymous requests', async () => {
    await expect(providerRequest(endpoint, { allowedOrigins: ['https://other.example.com'] })).rejects.toMatchObject({ code: 'blocked_destination' })
    await expect(providerRequest(endpoint, { allowedOrigins: 'https://provider.example.com' as any })).rejects.toBeInstanceOf(ProviderHttpError)
    expect(dns.lookup).not.toHaveBeenCalled()
  })
  it.each(['Basic abc', 'bearer abc', 'Bearer ', 'Bearer a b', 'Bearer a\tb', 'Bearer a\r\nb', 'Bearer café', `Bearer ${'a'.repeat(8001)}`])('denies invalid Authorization syntax', async value => {
    await expect(providerRequest(endpoint, { headers: { Authorization: value }, allowedOrigins: ['https://provider.example.com'] })).rejects.toMatchObject({ code: 'invalid_request' })
    expect(dns.lookup).not.toHaveBeenCalled()
  })
  it.each(['', 'a b', 'a\tb', 'café', 'a'.repeat(8001)])('denies invalid API-key syntax', async value => {
    await expect(providerRequest(endpoint, { headers: { 'x-api-key': value }, allowedOrigins: ['https://provider.example.com'] })).rejects.toMatchObject({ code: 'invalid_request' })
  })
  it('accepts maximal tokens and all permitted noncredential headers', async () => {
    await providerRequest(endpoint, { allowedOrigins: ['https://provider.example.com'], headers: {
      Authorization: `Bearer ${'a'.repeat(8000)}`, 'x-api-key': 'b'.repeat(8000), Accept: 'application/json',
      'User-Agent': 'fixture', 'Anthropic-Version': '2023-06-01', 'Content-Type': 'application/json',
    } })
    expect(requests).toHaveLength(1)
  })
  it.each(['Host', 'Content-Length', 'Transfer-Encoding', 'Cookie', 'Cookie2', 'Proxy-Authorization',
    'Proxy-Connection', 'Accept-Encoding', 'Connection', 'Upgrade', 'Expect', 'TE', 'Trailer', 'X-Unknown'])('denies caller header %s', async name => {
    await expect(providerRequest(endpoint, { headers: { [name]: 'value' } })).rejects.toMatchObject({ code: 'invalid_request' })
    expect(dns.lookup).not.toHaveBeenCalled()
  })
  it('denies duplicate case-insensitive headers, injection and oversized headers', async () => {
    for (const headers of [{ Accept: 'a', accept: 'b' }, { Accept: 'a\r\nb' }, { Accept: 42 }, { Accept: 'a'.repeat(16384) }]) {
      await expect(providerRequest(endpoint, { headers: headers as any })).rejects.toMatchObject({ code: 'invalid_request' })
    }
    expect(dns.lookup).not.toHaveBeenCalled()
  })
  it.each(['timeoutMs', 'maxBytes'] as const)('requires strictly positive integral %s', async key => {
    for (const value of [0, -1, 0.5, Infinity, NaN, null, '100', key === 'timeoutMs' ? 1_800_001 : 96 * 1024 * 1024 + 1]) {
      await expect(providerRequest(endpoint, { [key]: value } as any)).rejects.toMatchObject({ code: 'invalid_request' })
    }
    expect(dns.lookup).not.toHaveBeenCalled()
  })
  it('supports ceiling limits and denies invalid methods, bodies and request oversize before DNS', async () => {
    for (const options of [{ method: 'PUT' }, { method: '' }, { method: 'GET', body: '{}' }, { method: 'HEAD', body: Buffer.alloc(0) },
      { method: 'POST', body: {} }, { method: 'POST', body: 'not json' }]) {
      await expect(providerRequest(endpoint, options as any)).rejects.toMatchObject({ code: 'invalid_request' })
    }
    await expect(providerRequest(endpoint, { method: 'POST', body: Buffer.alloc(32 * 1024 * 1024 + 1) })).rejects.toMatchObject({ code: 'too_large' })
    expect(dns.lookup).not.toHaveBeenCalled()
    await providerRequest(endpoint, { timeoutMs: 1_800_000, maxBytes: 96 * 1024 * 1024 })
  })
  it('sends bounded POST strings/Buffers and exposes JSON convenience helpers', async () => {
    expect(await providerJson(endpoint, { prompt: 'hello' })).toEqual({ ok: true })
    expect(requests[0].options).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '18' } })
    expect(requests[0].req.end).toHaveBeenCalledWith(Buffer.from('{"prompt":"hello"}'))
    expect(await providerGetJson(endpoint, { method: 'POST' })).toEqual({ ok: true })
    expect(requests[1].options.method).toBe('GET')
    const body = Buffer.from('{}')
    await providerRequest(endpoint, { method: 'POST', body })
    expect(requests[2].req.end.mock.calls[0][0]).toEqual(body)
    expect(requests[2].req.end.mock.calls[0][0]).not.toBe(body)
    const circular: any = {}; circular.self = circular
    await expect(providerJson(endpoint, circular)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(providerJson(endpoint, undefined)).rejects.toMatchObject({ code: 'invalid_request' })
  })
})

describe('identity-only bounded responses', () => {
  it.each([301, 302, 303, 304, 307, 308, 400, 401, 429, 500, 503])('preserves status %s without returning body or redirecting', async status => {
    plans.push({ status, headers: { location: 'https://other.example.com/?secret' }, chunks: [Buffer.from('secret provider payload')] })
    const failure = await providerRequest(endpoint).catch(value => value)
    expect(failure).toBeInstanceOf(ProviderHttpError)
    expect(failure.status).toBe(status)
    expect(failure.message).toBe('Provider transport request failed')
    expect(failure.body).toBeUndefined(); expect(failure.url).toBeUndefined()
    expect(requests).toHaveLength(1); clean(requests[0])
  })
  it.each(['gzip', 'br', 'deflate', 'identity, gzip', 'compress', ''])('rejects encoding %s', async encoding => {
    plans.push({ headers: { 'content-encoding': encoding } })
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'invalid_response' })
    clean(requests[0])
  })
  it.each(['-1', '1.5', '3x', '9007199254740992', '3, 3'])('rejects malformed Content-Length %s', async length => {
    plans.push({ headers: { 'content-length': length } })
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'invalid_response' })
    clean(requests[0])
  })
  it('bounds declared/actual bytes and enforces exact length at EOF', async () => {
    for (const plan of [
      { headers: { 'content-length': '6' }, stall: true },
      { chunks: [Buffer.from('abc'), Buffer.from('def')] },
    ]) {
      plans.push(plan)
      await expect(providerRequest(endpoint, { maxBytes: 5 })).rejects.toMatchObject({ code: 'too_large' })
    }
    for (const length of ['1', '5']) {
      plans.push({ headers: { 'content-length': length }, chunks: [Buffer.from('abc')] })
      await expect(providerRequest(endpoint, { maxBytes: 5 })).rejects.toMatchObject({ code: 'invalid_response' })
    }
    plans.push({ headers: { 'content-length': '5' }, chunks: [Buffer.from('ab'), Buffer.alloc(0), Buffer.from('cde')] })
    expect(await (await providerRequest(endpoint, { maxBytes: 5 })).text()).toBe('abcde')
    requests.forEach(clean)
  })
  it('enforces the default 8MiB budget', async () => {
    plans.push({ headers: { 'content-length': String(8 * 1024 * 1024 + 1) }, stall: true })
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'too_large' })
  })
  it('bounds response headers including raw duplicate overhead and rejects ambiguous framing', async () => {
    plans.push({ headers: { 'x-large': 'a'.repeat(16384) } })
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'too_large' })
    plans.push({ rawHeaders: Array.from({ length: 3000 }, () => ['x', 'abc']).flat() })
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'too_large' })
    plans.push({ headers: { 'content-length': '11', 'transfer-encoding': 'chunked' } })
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it.each(['gzip', 'gzip, chunked', 'deflate, chunked', 'identity', 'chunked, chunked'])('denies transfer encoding %s', async encoding => {
    plans.push({ headers: { 'transfer-encoding': encoding } })
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'invalid_response' })
    clean(requests[0])
  })
  it('accepts identity content with ordinary chunked framing', async () => {
    plans.push({ headers: { 'transfer-encoding': 'chunked', 'content-encoding': 'identity' } })
    expect(await providerGetJson(endpoint)).toEqual({ ok: true })
  })
  it('permits HEAD representation length with empty body and an empty 204', async () => {
    plans.push({ headers: { 'content-length': '100' }, chunks: [] }, { status: 204, chunks: [] })
    expect((await providerRequest(endpoint, { method: 'HEAD' })).body.length).toBe(0)
    expect((await providerRequest(endpoint)).status).toBe(204)
    plans.push({ chunks: [Buffer.from('x')] }, { status: 204, chunks: [Buffer.from('x')] })
    await expect(providerRequest(endpoint, { method: 'HEAD' })).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it.each([{ incomplete: true }, { prematureClose: true }, { responseError: true }, { socketError: true }])('rejects incomplete or failed streams: %s', async plan => {
    plans.push(plan)
    await expect(providerRequest(endpoint)).rejects.toBeInstanceOf(ProviderHttpError)
    clean(requests[0])
  })
  it('sanitizes DNS, socket, construction and JSON failures', async () => {
    dns.lookup.mockRejectedValueOnce(new Error('secret dns data'))
    await expect(providerRequest(`${endpoint}?token=secret`)).rejects.toMatchObject({ message: 'Provider transport request failed' })
    plans.push({ socketError: true }, { chunks: [Buffer.from('secret invalid JSON')] })
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ message: 'Provider transport request failed' })
    await expect(providerGetJson(endpoint)).rejects.toMatchObject({ code: 'invalid_response', message: 'Provider transport request failed' })
    vi.mocked(https.request).mockImplementationOnce(() => { throw new Error('secret construction data') })
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'network_error', message: 'Provider transport request failed' })
    expect(agents.at(-1)?.destroy).toHaveBeenCalled()
  })
})

describe('one deadline, cancellation, and lifecycle cleanup', () => {
  it.each([false, true])('cancels stalled DNS without late dispatch (sidecar=%s)', async internal => {
    let release!: (records: any) => void
    dns.lookup.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const control = new AbortController()
    const pending = internal ? sidecarRequest('/health', { signal: control.signal }) : providerRequest(endpoint, { signal: control.signal })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' })
    control.abort(new Error('secret abort reason'))
    await rejected
    release(internal ? [{ address: '127.0.0.1', family: 4 }] : publicRecords)
    await flush()
    expect(agents).toHaveLength(0); expect(requests).toHaveLength(0)
    expect(getEventListeners(control.signal, 'abort')).toHaveLength(0)
  })
  it.each([false, true])('times out DNS and ignores late rejection (sidecar=%s)', async internal => {
    vi.useFakeTimers()
    let fail!: (error: Error) => void
    dns.lookup.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const pending = internal ? sidecarRequest('/health', { timeoutMs: 20 }) : providerRequest(endpoint, { timeoutMs: 20 })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(20); await rejected
    fail(new Error('late secret error')); await flush()
    expect(requests).toHaveLength(0); expect(agents).toHaveLength(0); expect(vi.getTimerCount()).toBe(0)
  })
  it('uses the 120000ms default deadline', async () => {
    vi.useFakeTimers(); dns.lookup.mockImplementationOnce(() => new Promise(() => {}))
    const rejected = expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(119999)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1); await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps one deadline through DNS, headers and a stalled body', async () => {
    vi.useFakeTimers()
    dns.lookup.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(publicRecords), 70)))
    plans.push({ stall: true })
    const rejected = expect(providerRequest(endpoint, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(70)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30); await rejected
    clean(requests[0]); expect(vi.getTimerCount()).toBe(0)
  })
  it('pre-aborted signals perform no DNS or agent construction in either policy', async () => {
    const control = new AbortController(); control.abort()
    await expect(providerRequest(endpoint, { signal: control.signal })).rejects.toMatchObject({ code: 'aborted' })
    await expect(sidecarRequest('/health', { signal: control.signal })).rejects.toMatchObject({ code: 'aborted' })
    expect(dns.lookup).not.toHaveBeenCalled(); expect(agents).toHaveLength(0)
    expect(getEventListeners(control.signal, 'abort')).toHaveLength(0)
  })
  it.each([false, true])('cleans resources on cancellation before/after headers (body=%s)', async body => {
    vi.useFakeTimers()
    plans.push(body ? { stall: true } : { noResponse: true })
    const control = new AbortController()
    const rejected = expect(providerRequest(endpoint, { signal: control.signal })).rejects.toMatchObject({ code: 'aborted' })
    await flush(); control.abort(); await rejected
    clean(requests[0])
    const callback = vi.fn()
    requests[0].options.lookup('provider.example.com', {}, callback)
    expect(callback.mock.lastCall?.[0]).toBeInstanceOf(ProviderHttpError)
    if (!body) { requests[0].respond(); expect(requests[0].response?.destroyed).toBe(true) }
    // Late stream/request errors are handled and cannot settle the promise again.
    requests[0].response?.emit('error', new Error('late secret'))
    requests[0].req.emit('error', new Error('late secret'))
    expect(getEventListeners(control.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cleans successful requests, listeners and timers', async () => {
    vi.useFakeTimers()
    const control = new AbortController()
    await providerRequest(endpoint, { signal: control.signal })
    clean(requests[0]); expect(getEventListeners(control.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('handles synchronous rejection during construction without sending a body', async () => {
    plans.push({ synchronous: true, status: 401 })
    await expect(providerRequest(endpoint, { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 401 })
    expect(requests[0].req.end).not.toHaveBeenCalled(); clean(requests[0])
  })
  it('rejects upgrades and destroys the detached upgraded socket', async () => {
    plans.push({ noResponse: true })
    const rejected = expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'http_error', status: 101 })
    await flush()
    const socket = new PassThrough(), incoming = new PassThrough() as ResponseStream
    incoming.statusCode = 101
    requests[0].req.emit('upgrade', incoming, socket, Buffer.alloc(0))
    await rejected
    expect(socket.destroyed).toBe(true); expect(incoming.destroyed).toBe(true)
    socket.emit('error', new Error('late upgrade secret'))
    clean(requests[0])
  })
})

describe('isolated operator-owned sidecar policy', () => {
  it.each(['/health', '/api/generate', '/api/analyze', '/api/vision-chat'] as const)('appends whitelisted path %s to the configured base path', async path => {
    vi.stubEnv('IMAGE_API_URL', 'http://image-worker:9081/prefix/')
    dns.lookup.mockResolvedValue([{ address: '172.20.0.2', family: 4 }])
    await sidecarRequest(path, { method: 'POST', body: '{}' })
    expect(requests[0].url.href).toBe(`http://image-worker:9081/prefix${path}`)
    expect(dns.lookup).toHaveBeenCalledWith('image-worker', { all: true, verbatim: true })
    expect(http.request).toHaveBeenCalledTimes(1); expect(https.request).not.toHaveBeenCalled()
  })
  it('uses the default localhost base', async () => {
    dns.lookup.mockResolvedValue([{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }])
    await sidecarRequest('/health')
    expect(requests[0].url.href).toBe('http://localhost:8081/health')
  })
  it.each(['http://127.0.0.1:8081', 'http://10.1.2.3:9000', 'http://172.16.0.1', 'http://192.168.1.1',
    'http://[::1]:8081', 'http://[fd12::1]:8081', 'https://8.8.8.8:9443', 'https://[2606:4700:4700::1111]:9443'])('accepts configured literal and skips DNS: %s', async base => {
    vi.stubEnv('IMAGE_API_URL', base)
    await sidecarRequest('/health')
    expect(dns.lookup).not.toHaveBeenCalled(); clean(requests[0])
  })
  it.each(['http://8.8.8.8', 'http://[2606:4700:4700::1111]', 'http://169.254.169.254', 'https://169.254.169.254',
    'http://100.100.100.200', 'https://168.63.129.16', 'https://147.75.207.207', 'https://[fd00:ec2::254]',
    'http://[::ffff:127.0.0.1]', 'http://[fe80::1]', 'https://[ff02::1]', 'http://0.0.0.0',
    'http://[::]', 'https://192.0.2.1', 'https://224.0.0.1', 'https://240.0.0.1'])('denies forbidden literal: %s', async base => {
    vi.stubEnv('IMAGE_API_URL', base)
    await expect(sidecarRequest('/health')).rejects.toMatchObject({ code: 'blocked_destination' })
    expect(dns.lookup).not.toHaveBeenCalled(); expect(requests).toHaveLength(0)
  })
  it.each(['http://worker?key=secret', 'http://worker/#', 'http://user:secret@worker', 'http://@worker', 'http://worker/../base',
    'http://worker/./base', 'http://worker/%2e%2e/base', 'http://worker/%61', 'http://worker\\base',
    'http://worker/has space', 'http://worker/\nbase', 'ftp://worker', 'http:worker', 'http://metadata.google.internal'])('denies unsafe operator base: %s', async base => {
    vi.stubEnv('IMAGE_API_URL', base)
    await expect(sidecarRequest('/health')).rejects.toBeInstanceOf(ProviderHttpError)
    expect(dns.lookup).not.toHaveBeenCalled(); expect(requests).toHaveLength(0)
  })
  it.each(['https://evil.example.com', '//evil.example.com', '/health?url=evil', '/health#fragment', '/api/../health', '/other', '/health/'])('rejects runtime path %s', async path => {
    await expect(sidecarRequest(path as any)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(dns.lookup).not.toHaveBeenCalled()
  })
  it('never accepts credentials even when an origin allowlist is smuggled into options', async () => {
    for (const headers of [{ Authorization: 'Bearer secret' }, { 'x-api-key': 'secret' }, { Cookie: 'secret' }]) {
      await expect(sidecarRequest('/health', { headers, allowedOrigins: ['http://localhost:8081'] } as any)).rejects.toMatchObject({ code: 'invalid_request' })
    }
    expect(dns.lookup).not.toHaveBeenCalled()
  })
  it('validates all internal DNS answers and keeps HTTP/public and HTTPS/private policy distinct', async () => {
    vi.stubEnv('IMAGE_API_URL', 'http://worker:8081')
    for (const records of [[], publicRecords, [{ address: '10.0.0.1', family: 4 }, ...publicRecords],
      [{ address: '10.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }],
      [{ address: '10.0.0.1', family: 6 }]]) {
      dns.lookup.mockResolvedValue(records)
      await expect(sidecarRequest('/health')).rejects.toMatchObject({ code: 'blocked_destination' })
    }
    expect(requests).toHaveLength(0)
    vi.stubEnv('IMAGE_API_URL', 'https://worker:9443')
    dns.lookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }, ...publicRecords])
    await sidecarRequest('/health')
    expect(requests[0].options.rejectUnauthorized).toBe(true)
    await expect(providerRequest(endpoint)).rejects.toMatchObject({ code: 'blocked_destination' })
    expect(requests).toHaveLength(1)
  })
  it('applies the shared engine limits, compression and redirect rules internally', async () => {
    dns.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    plans.push({ status: 302 }, { headers: { 'content-encoding': 'gzip' } }, { chunks: [Buffer.alloc(6)] })
    await expect(sidecarRequest('/health')).rejects.toMatchObject({ code: 'redirect_rejected', status: 302 })
    await expect(sidecarRequest('/health')).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(sidecarRequest('/health', { maxBytes: 5 })).rejects.toMatchObject({ code: 'too_large' })
    requests.forEach(clean)
  })
})
