import { PassThrough, Readable } from 'node:stream'
import { getEventListeners } from 'node:events'
import https from 'node:https'
import { Response } from 'node-fetch'
import OpenAI from 'openai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({ fetch: vi.fn(), options: vi.fn(), dns: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: wire.dns }))
vi.mock('node-fetch', async original => ({ ...await original<typeof import('node-fetch')>(), default: wire.fetch }))
// Preserve the real installed SDK URL/header construction and SSE parser. Only
// its network fetch is replaced; createClient still installs the production guard.
vi.mock('openai', async original => {
  const actual = await original<typeof import('openai')>()
  return { ...actual, default: class extends actual.default {
    constructor(options: any) { super(options); wire.options(options) }
  } }
})
import { completeOnce, createClient, resolveOpenAIConfig, streamTurn } from '../llmClient'
import { guardedModelFetch, modelBaseUrl, ModelTransportError, type ModelTransportLimits } from '../../services/modelTransport'

const endpoint = 'https://hosted.example.com/v1/chat/completions'
const params = { model: 'fixture-model', messages: [{ role: 'user' as const, content: 'q' }] }
const response = (body: string, status = 200, url = endpoint, headers = {}) => new Response(Readable.from([Buffer.from(body)]), {
  status, url, headers: { 'content-type': 'application/json', ...headers },
})

describe('model DNS pinning and bounded response lifecycle', () => {
  const options = () => ({ method: 'POST', body: '{}', headers: { authorization: 'Bearer fixture-hf-secret', 'content-type': 'application/json' } })
  const run = (limits: ModelTransportLimits = {}, extra = {}) =>
    guardedModelFetch('https://hosted.example.com/v1', 'fixture-hf-secret', wire.fetch, limits)(endpoint, { ...options(), ...extra })
  const streamingResponse = (source: Readable) => new Response(source, { status: 200, url: endpoint, headers: { 'content-type': 'text/event-stream' } })

  it.each([
    [], [{ address: '127.0.0.1', family: 4 }], [{ address: '169.254.169.254', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '::1', family: 6 }], [{ address: '93.184.216.34', family: 6 }], [null],
  ].map(answers => ({ answers })))('rejects empty/private/mixed/invalid DNS answers %# before fetch', async ({ answers }) => {
    wire.dns.mockResolvedValueOnce(answers)
    await expect(run()).rejects.toThrow(ModelTransportError)
    expect(wire.fetch).not.toHaveBeenCalled()
  })
  it('pins the checked address in both Node lookup callback forms without changing Host/SNI URL', async () => {
    const reply = await run()
    const [url, init] = wire.fetch.mock.calls[0]
    expect(url).toBe(endpoint)
    const lookup = init.agent.options.lookup
    const single = vi.fn(), all = vi.fn(), wrongHost = vi.fn()
    lookup('hosted.example.com', {}, single)
    lookup('hosted.example.com', { all: true }, all)
    lookup('other.example.com', {}, wrongHost)
    expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }])
    expect(wrongHost.mock.calls[0][0]).toBeInstanceOf(ModelTransportError)
    expect(wire.dns).toHaveBeenCalledTimes(1)
    expect(init.agent.options.family).toBe(4)
    await reply.text()
  })
  it('re-resolves every request and rejects a subsequent private DNS answer', async () => {
    await (await run()).text()
    wire.dns.mockResolvedValueOnce([{ address: '10.1.2.3', family: 4 }])
    await expect(run()).rejects.toThrow(ModelTransportError)
    expect(wire.dns).toHaveBeenCalledTimes(2)
    expect(wire.fetch).toHaveBeenCalledTimes(1)
  })
  it('supports checked IPv6-only answers', async () => {
    wire.dns.mockResolvedValueOnce([{ address: '2606:4700:4700::1111', family: 6 }])
    const reply = await run()
    expect(wire.fetch.mock.calls[0][1].agent.options.family).toBe(6)
    await reply.text()
  })
  it('times out stalled DNS and never dispatches a late result', async () => {
    let resolve!: (value: unknown) => void
    wire.dns.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await expect(run({ timeoutMs: 30 })).rejects.toThrow(ModelTransportError)
    resolve([{ address: '93.184.216.34', family: 4 }])
    await Promise.resolve()
    expect(wire.fetch).not.toHaveBeenCalled()
  })
  it('times out ignored fetch cancellation and destroys a late response', async () => {
    let resolve!: (value: Response) => void
    wire.fetch.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await expect(run({ timeoutMs: 30 })).rejects.toThrow(ModelTransportError)
    const late = response('{}')
    resolve(late); await Promise.resolve()
    expect(late.body.destroyed).toBe(true)
    expect(wire.fetch.mock.calls[0][1].signal.aborted).toBe(true)
  })
  it('keeps one deadline across DNS and body reading instead of restarting at headers', async () => {
    vi.useFakeTimers()
    try {
      wire.dns.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve([{ address: '93.184.216.34', family: 4 }]), 20)))
      const source = new PassThrough()
      wire.fetch.mockResolvedValueOnce(streamingResponse(source))
      const pending = run({ timeoutMs: 50 })
      await vi.advanceTimersByTimeAsync(30)
      const reply = await pending
      const failed = expect(reply.text()).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(21)
      await failed
      expect(source.destroyed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('times out an unconsumed response and releases the source', async () => {
    const source = new PassThrough()
    wire.fetch.mockResolvedValueOnce(streamingResponse(source))
    const reply = await run({ timeoutMs: 30 })
    await new Promise(resolve => reply.body.once('close', resolve))
    expect(source.destroyed).toBe(true)
    expect(wire.fetch.mock.calls[0][1].signal.aborted).toBe(true)
  })
  it('cancels during body consumption and removes the caller abort listener', async () => {
    const source = new PassThrough(), controller = new AbortController()
    wire.fetch.mockResolvedValueOnce(streamingResponse(source))
    const reply = await run({}, { signal: controller.signal })
    const failed = expect(reply.text()).rejects.toThrow()
    controller.abort()
    await failed
    expect(source.destroyed).toBe(true)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
  it('releases deadline/listeners on success', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const reply = await run({}, { signal: controller.signal })
      await reply.text()
      expect(vi.getTimerCount()).toBe(0)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(controller.signal.aborted).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('enforces request/header caps before resolving DNS', async () => {
    await expect(run({ maxRequestBytes: 1 })).rejects.toThrow(ModelTransportError)
    await expect(run({ maxHeaderBytes: 32 })).rejects.toThrow(ModelTransportError)
    expect(wire.dns).not.toHaveBeenCalled()
    expect(wire.fetch).not.toHaveBeenCalled()
  })
  it.each(['gzip', 'deflate', 'br'])('rejects %s responses rather than decompressing outside the byte counter', async encoding => {
    const reply = response('compressed-payload', 200, endpoint, { 'content-encoding': encoding })
    wire.fetch.mockResolvedValueOnce(reply)
    await expect(run()).rejects.toThrow(ModelTransportError)
    expect(reply.body.destroyed).toBe(true)
    expect(wire.fetch.mock.calls[0][1]).toMatchObject({ compress: false, headers: { 'accept-encoding': 'identity' } })
  })
  it.each(['-1', '1e3', '99999999'])('rejects invalid/oversized Content-Length %s', async length => {
    wire.fetch.mockResolvedValueOnce(response('{}', 200, endpoint, { 'content-length': length }))
    await expect(run()).rejects.toThrow(ModelTransportError)
  })
  it('rejects oversized response headers', async () => {
    wire.fetch.mockResolvedValueOnce(response('{}', 200, endpoint, { 'x-large': 'a'.repeat(1024) }))
    await expect(run({ maxHeaderBytes: 512 })).rejects.toThrow(ModelTransportError)
  })
  it('enforces streaming byte limits without buffering an unbounded body', async () => {
    const source = new PassThrough()
    wire.fetch.mockResolvedValueOnce(streamingResponse(source))
    const reply = await run({ maxResponseBytes: 5 })
    const failed = expect(reply.text()).rejects.toThrow()
    source.write(Buffer.from('1234')); source.write(Buffer.from('5678'))
    await failed
    expect(source.destroyed).toBe(true)
  })
  it('rejects a declared length mismatch at EOF', async () => {
    wire.fetch.mockResolvedValueOnce(response('123', 200, endpoint, { 'content-length': '5' }))
    const reply = await run()
    await expect(reply.text()).rejects.toThrow()
  })
  it.each(['error', 'close'])('handles premature source %s without leaking its error payload', async event => {
    const source = new PassThrough()
    wire.fetch.mockResolvedValueOnce(streamingResponse(source))
    const reply = await run()
    const failed = expect(reply.text()).rejects.not.toThrow('fixture-private-error')
    if (event === 'error') source.destroy(new Error('fixture-private-error'))
    else source.destroy()
    await failed
    expect(wire.fetch.mock.calls[0][1].signal.aborted).toBe(true)
  })
  it('rejects invalid or excessive trusted limit settings', () => {
    for (const limits of [{ timeoutMs: 0 }, { timeoutMs: 600_001 }, { maxResponseBytes: 8 * 1024 * 1024 + 1 },
      { maxRequestBytes: Infinity }, { maxHeaderBytes: NaN }]) {
      expect(() => guardedModelFetch('https://hosted.example.com/v1', 'fixture-hf-secret', wire.fetch, limits)).toThrow(ModelTransportError)
    }
  })
  it.each(['deadline', 'size'])('rejects an incomplete real SDK SSE turn on %s failure', async kind => {
    const source = new PassThrough()
    source.write(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`))
    wire.fetch.mockResolvedValueOnce(streamingResponse(source))
    const client = new OpenAI({ apiKey: 'fixture-hf-secret', baseURL: 'https://hosted.example.com/v1',
      maxRetries: 0, organization: null, project: null,
      fetch: guardedModelFetch('https://hosted.example.com/v1', 'fixture-hf-secret', wire.fetch,
        { timeoutMs: 100, maxResponseBytes: 256 }) as any })
    const onDelta = vi.fn()
    const overflow = kind === 'size' ? setTimeout(() => source.write(Buffer.alloc(512)), 15) : undefined
    try {
      await expect(streamTurn({ client, model: 'fixture', messages: params.messages, onDelta })).rejects.toThrow()
      expect(onDelta).toHaveBeenCalledWith('partial')
      expect(source.destroyed).toBe(true)
    } finally { clearTimeout(overflow) }
  })
})
beforeEach(() => {
  vi.stubEnv('HF_ENDPOINT_URL', 'https://hosted.example.com')
  vi.stubEnv('HF_LARGE_ENDPOINT_URL', 'https://large.example.com')
  vi.stubEnv('HF_TOKEN', 'fixture-hf-secret')
  vi.stubEnv('OPENAI_API_KEY', 'fixture-openai-secret')
  vi.stubEnv('OPENAI_BASE_URL', 'https://ambient.example.com')
  vi.stubEnv('OPENAI_ORG_ID', 'ambient-org')
  vi.stubEnv('OPENAI_PROJECT_ID', 'ambient-project')
  wire.options.mockReset()
  wire.dns.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  wire.fetch.mockReset().mockImplementation(async () => response(JSON.stringify({ choices: [{ message: { content: 'Guarded answer' } }] })))
})
afterEach(() => vi.unstubAllEnvs())

describe('model endpoint configuration', () => {
  it.each(['http://hosted.example.com', 'https://localhost', 'https://127.0.0.1', 'https://169.254.169.254',
    'https://user:secret@hosted.example.com', 'https://hosted.example.com:8443', 'https://hosted.example.com?key=secret',
    'https://hosted.example.com/#fragment', 'https://hosted.example.com/%2e%2e/v1', 'https://hosted.example.com/a/../v1',
    ' https://hosted.example.com', 'https://private.internal'])('rejects operator URL %s', url => {
    expect(() => modelBaseUrl(url)).toThrow(ModelTransportError)
  })
  it('binds HF credentials only to configured standard/large roots', () => {
    expect(resolveOpenAIConfig('huggingface')).toEqual({ baseURL: 'https://hosted.example.com/v1', apiKey: 'fixture-hf-secret' })
    expect(resolveOpenAIConfig('huggingface', undefined, 'https://large.example.com/v1')).toMatchObject({ baseURL: 'https://large.example.com/v1' })
    expect(() => createClient('huggingface', undefined, 'https://other.example.com')).toThrow(ModelTransportError)
    expect(() => createClient('huggingface', 'caller-key', 'https://other.example.com')).toThrow(ModelTransportError)
    expect(wire.fetch).not.toHaveBeenCalled()
  })
  it('does not silently fall back to a server key when an explicit key is empty or malformed', () => {
    for (const key of ['', 'bad\r\nheader', 'contains space', 'a'.repeat(8001)]) expect(() => createClient('huggingface', key)).toThrow(ModelTransportError)
    vi.stubEnv('HF_TOKEN', '')
    expect(() => createClient('huggingface')).toThrow(ModelTransportError)
  })
  it('rejects missing HF configuration instead of constructing a relative SDK URL', () => {
    vi.stubEnv('HF_ENDPOINT_URL', '')
    expect(() => createClient('huggingface')).toThrow(ModelTransportError)
  })
  it.each(['openai', 'groq', 'together', 'nvidia', 'xai', 'perplexity'] as const)('prevents custom destinations on the %s client', provider => {
    expect(() => createClient(provider, 'explicit-fixture-key', 'https://other.example.com/v1')).toThrow(ModelTransportError)
  })
  it.each(['local', 'ollama'] as const)('does not expose a private-service fallback for %s', provider => {
    expect(() => createClient(provider)).toThrow(ModelTransportError)
  })
  it('ignores ambient OpenAI base URL and disables ambient organization/project headers', () => {
    const client = createClient('openai')
    expect(client.baseURL).toBe('https://api.openai.com/v1')
    expect(wire.options).toHaveBeenCalledWith(expect.objectContaining({ organization: null, project: null, maxRetries: 0 }))
  })
})

describe('real SDK with guarded mocked transport', () => {
  it('forwards cancellation from nonstreaming internal model calls', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(completeOnce(createClient('huggingface'), 'fixture', params.messages, 0.5, 100, controller.signal)).rejects.toThrow()
    expect(wire.fetch).not.toHaveBeenCalled()
  })
  it('preserves JSON completions and sends exact credentials with a dedicated direct agent', async () => {
    const result = await createClient('huggingface').chat.completions.create(params)
    expect(result.choices[0].message.content).toBe('Guarded answer')
    const [url, options] = wire.fetch.mock.calls[0]
    expect(url).toBe(endpoint)
    expect(options).toMatchObject({ method: 'POST', redirect: 'manual', follow: 0 })
    expect(options.headers.authorization).toBe('Bearer fixture-hf-secret')
    expect(options.headers['openai-organization']).toBeUndefined()
    expect(options.headers['openai-project']).toBeUndefined()
    expect(options.agent).toBeInstanceOf(https.Agent)
    expect(options.agent.options.keepAlive).toBe(false)
    expect(options.agent.options.rejectUnauthorized).toBe(true)
    expect(options.agent.options.proxyEnv).toEqual({})
    expect(wire.fetch).toHaveBeenCalledTimes(1)
  })
  it('preserves SSE deltas and native tool calls using the installed SDK parser', async () => {
    const chunk = { choices: [{ delta: { content: 'Hello', tool_calls: [{ index: 0, id: 'call1', function: { name: 'calculator', arguments: '{"expression":"6*7"}' } }] }, finish_reason: 'tool_calls' }] }
    wire.fetch.mockResolvedValueOnce(response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, 200, endpoint, { 'content-type': 'text/event-stream' }))
    const onDelta = vi.fn()
    const result = await streamTurn({ client: createClient('huggingface'), model: 'fixture', messages: params.messages, onDelta })
    expect(result).toMatchObject({ content: 'Hello', finishReason: 'tool_calls', toolCalls: [{ id: 'call1', name: 'calculator', arguments: '{"expression":"6*7"}' }] })
    expect(onDelta).toHaveBeenCalledWith('Hello')
  })
  it('uses separate agents per request and releases them after response consumption', async () => {
    const destroyed: ReturnType<typeof vi.spyOn>[] = []
    wire.fetch.mockImplementation(async (_url, init) => {
      destroyed.push(vi.spyOn(init.agent, 'destroy'))
      return response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
    const client = createClient('huggingface')
    await client.chat.completions.create(params)
    await client.chat.completions.create(params)
    expect(wire.fetch.mock.calls[0][1].agent).not.toBe(wire.fetch.mock.calls[1][1].agent)
    for (const destroy of destroyed) expect(destroy).toHaveBeenCalled()
  })
  it.each([301, 302, 303, 307, 308, 401, 429, 500])('discards status %s without forwarding credentials or retrying', async status => {
    const reply = response('fixture-secret provider body', status, endpoint, { location: 'https://other.example.com', 'x-should-retry': 'true' })
    wire.fetch.mockResolvedValueOnce(reply)
    const error = await createClient('huggingface').chat.completions.create(params).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error) + String(error.cause)).not.toContain('fixture-secret')
    expect(reply.body.destroyed).toBe(true)
    expect(wire.fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects same-origin redirects as well as cross-origin ones', async () => {
    wire.fetch.mockResolvedValueOnce(response('', 307, endpoint, { location: '/v2/chat/completions' }))
    await expect(createClient('huggingface').chat.completions.create(params)).rejects.toThrow()
    expect(wire.fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects SDK base URL mutation and absolute URL requests before network dispatch', async () => {
    const client = createClient('huggingface')
    client.baseURL = 'https://other.example.com/v1'
    await expect(client.chat.completions.create(params)).rejects.toThrow()
    await expect(client.post('https://other.example.com/v1/chat/completions', { body: params })).rejects.toThrow()
    expect(wire.fetch).not.toHaveBeenCalled()
  })
  it('rejects query, authorization and routing-header overrides before dispatch', async () => {
    const client = createClient('huggingface')
    for (const options of [{ query: { token: 'secret' } }, { headers: { Authorization: 'Bearer replacement' } },
      { headers: { Host: 'other.example.com' } }, { headers: { Cookie: 'secret' } }, { headers: { 'OpenAI-Project': 'other' } },
      { headers: { 'Content-Length': '1' } }]) {
      await expect(client.chat.completions.create(params, options)).rejects.toThrow()
    }
    expect(wire.fetch).not.toHaveBeenCalled()
  })
  it('overrides supplied agents and rejects unexpected response destinations', async () => {
    const supplied = new https.Agent()
    try {
      wire.fetch.mockResolvedValueOnce(response('{}', 200, 'https://other.example.com/v1/chat/completions'))
      await expect(createClient('huggingface').chat.completions.create(params, { httpAgent: supplied })).rejects.toThrow()
      expect(wire.fetch.mock.calls[0][1].agent).not.toBe(supplied)
    } finally { supplied.destroy() }
  })
  it('sanitizes transport exceptions and passes SDK cancellation to fetch', async () => {
    wire.fetch.mockRejectedValueOnce(new Error('fixture-secret request failed'))
    const signal = new AbortController().signal
    const error = await createClient('huggingface').chat.completions.create(params, { signal }).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error.cause)).not.toContain('fixture-secret')
    expect(wire.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    const cancelled = new AbortController(); cancelled.abort()
    wire.fetch.mockClear()
    await expect(createClient('huggingface').chat.completions.create(params, { signal: cancelled.signal })).rejects.toThrow()
    expect(wire.fetch).not.toHaveBeenCalled()
  })
})
