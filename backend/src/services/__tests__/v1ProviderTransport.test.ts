import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const remote = vi.hoisted(() => {
  class Failure extends Error {
    readonly code = 'PROVIDER_ERROR'
    constructor(readonly status?: number) { super('fixture-secret upstream failure') }
  }
  return { request: vi.fn(), client: vi.fn(), complete: vi.fn(), charge: vi.fn(), reserve: vi.fn(), dispatch: vi.fn(), abandon: vi.fn(), artifact: vi.fn(), video: vi.fn(), Failure }
})
vi.mock('../providerHttp', () => ({ providerRequest: remote.request, ProviderHttpError: remote.Failure }))
vi.mock('../../agent/llmClient', () => ({ createClient: remote.client }))
// Isolate persistence/auth infrastructure so these handler integration tests
// exercise the real route + provider adapter without a database or sockets.
vi.mock('../prisma', () => ({ prisma: null, hasDb: false }))
vi.mock('../apiReservations', async importOriginal => ({
  ...await importOriginal<typeof import('../apiReservations')>(),
  reserveApiBalance: remote.reserve, dispatchApiReservation: remote.dispatch,
  settleApiReservation: remote.charge, captureApiReservation: remote.charge, abandonApiReservation: remote.abandon,
}))
vi.mock('../../agent/artifacts', () => ({ saveArtifact: remote.artifact }))
vi.mock('../mediaJobs', () => ({ createVideoJob: remote.video }))
vi.mock('../../middleware/apiAuth', () => ({
  authenticateApiKey: vi.fn(), requireBalance: vi.fn(),
  apiError: (res: any, status: number, message: string, type: string, code: string) => res.status(status).json({ error: { message, type, code } }),
}))
vi.mock('../chatModels', () => ({
  chatModelCatalog: () => [],
  resolveChatTarget: () => ({ model: 'fixture-chat', baseUrl: 'https://operator.example.test/v1', tier: 'standard', contextTokens: 32_768 }),
}))
import router from '../../routes/v1'

const binary = Buffer.from([137, 80, 78, 71, 0, 255, 128, 1])
const b64 = binary.toString('base64')
function response(data: unknown, type = 'application/json') {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data))
  return { status: 200, ok: true, url: 'https://operator.example.test', headers: new Headers({ 'content-type': type }), body,
    json: async () => data, text: async () => body.toString(), arrayBuffer: async () => Uint8Array.from(body).buffer }
}
function start(path: string, body: unknown) {
  const route = (router as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods.post).route
  const req: any = Object.assign(new EventEmitter(), { body, aborted: false, api: { userId: 'fixture-user', apiKeyId: 'fixture-id', plan: 'fixture-plan' } })
  const res: any = Object.assign(new EventEmitter(), { statusCode: 200, destroyed: false, headers: {}, body: undefined })
  res.status = (status: number) => { res.statusCode = status; return res }
  res.json = (value: unknown) => { res.body = value; return res }
  res.setHeader = (key: string, value: string) => { res.headers[key] = value }
  const done = route.stack.at(-1).handle(req, res)
  return { req, res, done }
}
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  remote.request.mockReset()
  remote.charge.mockReset().mockResolvedValue(100)
  remote.reserve.mockReset().mockResolvedValue({})
  remote.dispatch.mockReset().mockResolvedValue(undefined)
  remote.abandon.mockReset().mockResolvedValue(undefined)
  remote.artifact.mockReset().mockResolvedValue({ url: '/api/files/fixture-image' })
  remote.video.mockReset()
  remote.complete.mockReset().mockResolvedValue({ choices: [{ message: { content: 'fixture answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })
  remote.client.mockReset().mockReturnValue({ chat: { completions: { create: remote.complete } } })
  vi.stubEnv('HF_TOKEN', 'fixture-hf-token')
  vi.stubEnv('HF_IMAGE_ENDPOINT_URL', 'https://operator.example.test/image/')
  vi.stubEnv('PUBLIC_API_URL', 'https://app.example.test')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('v1 embeddings reviewed transport', () => {
  it.each([
    { input: 'single', upstream: [1, 2], expected: [[1, 2]] },
    { input: ['a', 'b'], upstream: [[1, 2], [3, 4]], expected: [[1, 2], [3, 4]] },
    { input: ['a', 'b'], upstream: [[[1, 3], [3, 5]], [[2, 4], [4, 8]]], expected: [[2, 4], [3, 6]] },
  ])('preserves single/batch vectors and token mean pooling: $input', async ({ input, upstream, expected }) => {
    remote.request.mockResolvedValue(response(upstream))
    const { res, done, req } = start('/embeddings', { input, model: 'caller-model', baseUrl: 'https://untrusted.example.test' })
    await done
    expect(res.statusCode).toBe(200)
    expect(res.body.model).toBe('caller-model')
    expect(res.body.data.map((row: any) => row.embedding)).toEqual(expected)
    const [url, options] = remote.request.mock.calls[0]
    expect(new URL(url).origin).toBe('https://router.huggingface.co')
    expect(url).not.toContain('caller-model')
    expect(options).toMatchObject({ method: 'POST', allowedOrigins: ['https://router.huggingface.co'],
      headers: { Authorization: 'Bearer fixture-hf-token' }, maxBytes: 8 * 1024 * 1024 })
    expect(options.timeoutMs).toBeGreaterThan(0); expect(options.timeoutMs).toBeLessThanOrEqual(60_000)
    expect(JSON.parse(options.body)).toEqual({ inputs: Array.isArray(input) ? input : [input], options: { wait_for_model: true } })
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(req.listenerCount('aborted')).toBe(0); expect(res.listenerCount('close')).toBe(0)
    expect(remote.charge).toHaveBeenCalledTimes(1)
  })

  it.each([[], { error: 'fixture-secret' }, [[1, 2], [3, 4]], [1, Infinity], [[[1, 2], [3]]], [[[1, 2], ['bad', 3]]]].map(payload => ({ payload })))('rejects malformed or mismatched vectors without capture', async ({ payload }) => {
    remote.request.mockResolvedValue(response(payload))
    const { res, done } = start('/embeddings', { input: 'one' })
    await done
    expect(res.statusCode).toBe(502)
    expect(res.body.error.message).toBe('Upstream embeddings request failed.')
    expect(remote.charge).not.toHaveBeenCalled()
  })
})

describe('v1 images reviewed transport', () => {
  it('preserves binary bytes as base64 and binds credentials to the operator endpoint', async () => {
    remote.request.mockResolvedValue(response(binary, 'image/png'))
    const { res, done } = start('/images/generations', { prompt: 'fixture', response_format: 'b64_json', baseUrl: 'https://untrusted.example.test' })
    await done
    expect(res.body.data).toEqual([{ b64_json: b64 }])
    expect(remote.request).toHaveBeenCalledWith('https://operator.example.test/image', expect.objectContaining({
      allowedOrigins: ['https://operator.example.test'], maxBytes: 16 * 1024 * 1024,
      headers: { Authorization: 'Bearer fixture-hf-token', 'Content-Type': 'application/json', Accept: 'image/png' },
    }))
    expect(remote.artifact).not.toHaveBeenCalled()
  })

  it.each([{ image: b64 }, [{ image: b64 }], { images: [{ b64_json: b64 }] }, { data: [{ b64_json: b64 }] }].map(payload => ({ payload })))(
    'preserves supported JSON base64 image envelopes', async ({ payload }) => {
      remote.request.mockResolvedValue(response(payload))
      const { res, done } = start('/images/generations', { prompt: 'fixture', response_format: 'b64_json' })
      await done
      expect(res.body.data).toEqual([{ b64_json: b64 }])
    },
  )

  it('decodes image bytes exactly for owned URL artifacts and retains multi-image billing', async () => {
    remote.request.mockResolvedValue(response({ image: b64 }))
    const { res, done } = start('/images/generations', { prompt: 'fixture', n: 2 })
    await done
    expect(res.body.data).toEqual([{ url: 'https://app.example.test/api/files/fixture-image' }, { url: 'https://app.example.test/api/files/fixture-image' }])
    expect(remote.artifact).toHaveBeenCalledTimes(2)
    for (const call of remote.artifact.mock.calls) {
      expect(call[1]).toEqual(binary); expect(call[2]).toEqual({ userId: 'fixture-user' })
    }
    expect(remote.reserve).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image', amountMicros: 100_000 }))
    expect(remote.charge).toHaveBeenCalledWith(expect.objectContaining({ expectedKind: 'image', units: 2 }))
  })

  it.each([502, 503, 504])('retains uncertain HTTP %s work without a duplicate paid POST', async status => {
    vi.useFakeTimers()
    remote.request.mockRejectedValueOnce(new remote.Failure(status)).mockResolvedValue(response(binary, 'image/png'))
    const { res, done } = start('/images/generations', { prompt: 'fixture', response_format: 'b64_json' })
    await vi.advanceTimersByTimeAsync(8_000); await done
    expect(res.statusCode).toBe(502)
    expect(remote.request).toHaveBeenCalledTimes(1)
    expect(remote.abandon).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops the batch on the first uncertain image attempt', async () => {
    vi.useFakeTimers()
    remote.request.mockRejectedValue(new remote.Failure(503))
    const { res, done } = start('/images/generations', { prompt: 'fixture', n: 2 })
    await vi.runAllTimersAsync(); await done
    expect(remote.request).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(502)
    expect(remote.charge).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('enforces one 240-second deadline across sequential images and body waits', async () => {
    vi.useFakeTimers()
    remote.request.mockImplementation((_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(response(binary, 'image/png')) }, 130_000)
      const cancel = () => { clearTimeout(timer); reject(new Error('fixture-secret aborted')) }
      signal.addEventListener('abort', cancel, { once: true })
    }))
    const { res, done } = start('/images/generations', { prompt: 'fixture', n: 2 })
    await vi.advanceTimersByTimeAsync(240_000); await done
    expect(res.statusCode).toBe(502)
    expect(remote.request.mock.calls.map(call => call[1].timeoutMs)).toEqual([240_000, 110_000])
    expect(remote.charge).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })

  it.each([400, 401, 403, 429, undefined])('does not retry non-cold-start status %s', async status => {
    remote.request.mockRejectedValue(new remote.Failure(status))
    const { res, done } = start('/images/generations', { prompt: 'fixture' })
    await done
    expect(res.statusCode).toBe(502); expect(res.body.error.message).toBe('Image generation failed.')
    expect(remote.request).toHaveBeenCalledTimes(1)
  })

  it.each([{ image: 123 }, { error: 'fixture-secret' }, { image: 'not base64!' }])('rejects invalid image JSON generically', async payload => {
    remote.request.mockResolvedValue(response(payload))
    const { res, done } = start('/images/generations', { prompt: 'fixture' })
    await done
    expect(res.statusCode).toBe(502); expect(remote.charge).not.toHaveBeenCalled()
    expect(res.body.error.message).toBe('Image generation failed.')
  })
})

describe('media and embeddings cancellation/error isolation', () => {
  it.each(['/embeddings', '/images/generations'])('propagates HTTP disconnect for %s without a late bill/response', async path => {
    remote.request.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('fixture-secret disconnected')), { once: true })
    }))
    const { req, res, done } = start(path, { input: 'fixture', prompt: 'fixture' })
    res.destroyed = true; res.emit('close')
    await done
    expect(remote.request).not.toHaveBeenCalled()
    expect(remote.abandon).toHaveBeenCalledTimes(1)
    expect(res.body).toBeUndefined(); expect(remote.charge).not.toHaveBeenCalled()
    expect(remote.artifact).not.toHaveBeenCalled()
    expect(req.listenerCount('aborted')).toBe(0); expect(res.listenerCount('close')).toBe(0)
  })

  it('cleans up when a connection closes during image dispatch', async () => {
    vi.useFakeTimers()
    remote.request.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('fixture-secret disconnected')), { once: true })
    }))
    const { req, res, done } = start('/images/generations', { prompt: 'fixture' })
    await vi.advanceTimersByTimeAsync(0)
    req.aborted = true; req.emit('aborted')
    await done
    expect(remote.request).toHaveBeenCalledTimes(1)
    expect(res.body).toBeUndefined(); expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['/embeddings', '/images/generations'])('never reflects/logs raw provider or parse errors for %s', async path => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const parse of [false, true]) {
      if (parse) remote.request.mockResolvedValue({ ...response({}), json: async () => { throw new Error('fixture-secret parse') } })
      else remote.request.mockRejectedValue(new Error('fixture-secret body and credential'))
      const { res, done } = start(path, { input: 'fixture', prompt: 'fixture' })
      await done
      expect(res.statusCode).toBe(502)
      expect(JSON.stringify(res.body)).not.toContain('fixture-secret')
    }
    expect(log).toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain('fixture-secret')
  })

  it('retains guarded v1 chat dispatch, signal and generic failure behavior', async () => {
    remote.complete.mockRejectedValue(new Error('fixture-secret chat'))
    const { res, done } = start('/chat/completions', { messages: [{ role: 'user', content: 'fixture' }] })
    await done
    expect(remote.client).toHaveBeenCalledWith('huggingface', undefined, 'https://operator.example.test/v1')
    expect(remote.complete.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(res.statusCode).toBe(502); expect(res.body.error.message).toBe('Upstream model request failed.')
    expect(remote.request).not.toHaveBeenCalled()
  })
})
