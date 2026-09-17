import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const remote = vi.hoisted(() => ({ complete: vi.fn(), client: vi.fn(), request: vi.fn(), artifact: vi.fn() }))
vi.mock('../../agent/llmClient', () => ({ createClient: remote.client }))
vi.mock('../providerHttp', () => ({ providerRequest: remote.request }))
vi.mock('../../agent/artifacts', () => ({ saveArtifact: remote.artifact }))
vi.mock('../aiProviders', () => ({ getHFModel: () => 'fixture-chat' }))
vi.mock('../chatModels', () => ({
  chatModelCatalog: () => [],
  resolveChatTarget: () => ({ model: 'fixture-chat', tier: 'standard', baseUrl: 'https://fixture.example.test/v1', contextTokens: 32_768 }),
}))

import router from '../../routes/v1'
import { prisma } from '../prisma'
import { captureApiSettlement } from '../apiReservations'

const db = prisma!
const chatBody = { messages: [{ role: 'user', content: 'hello' }] }
const completed = () => ({ choices: [{ message: { content: 'answer', reasoning_content: 'reason', tool_calls: [] }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })
const image = () => ({ headers: new Headers({ 'content-type': 'image/png' }), body: Buffer.from('fixture-image') })
async function fixture(balance = 1_000_000n) {
  const user = await db.user.create({ data: { email: `paid-v1-${randomUUID()}@example.test`, name: 'Fixture', password: 'fixture', apiBalanceMicros: balance } })
  const key = await db.apiKey.create({ data: { userId: user.id, keyHash: randomUUID(), prefix: 'fixture' } })
  return { userId: user.id, apiKeyId: key.id, plan: null, balanceMicros: balance, unlimited: false }
}
function start(path: string, body: unknown, api: Awaited<ReturnType<typeof fixture>>) {
  const route = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post).route
  const req: any = Object.assign(new EventEmitter(), { body, api, aborted: false, headers: { 'idempotency-key': 'caller-cannot-own-the-reservation' } })
  const res: any = Object.assign(new EventEmitter(), { statusCode: 200, destroyed: false, headersSent: false, headers: {}, chunks: [] })
  res.status = (code: number) => { res.statusCode = code; return res }
  res.json = (value: unknown) => { res.body = value; res.headersSent = true; return res }
  res.setHeader = (name: string, value: string) => { res.headers[name] = value }
  res.flushHeaders = () => { res.headersSent = true }
  res.write = (value: string) => { res.chunks.push(value); return true }
  res.end = () => { res.ended = true; return res }
  const done = route.stack.at(-1).handle(req, res)
  return { req, res, done }
}
async function records(userId: string) {
  const [user, holds, usage] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId } }),
    db.apiReservation.findMany({ where: { userId } }),
    db.apiUsage.findMany({ where: { userId } }),
  ])
  return { balance: user.apiBalanceMicros, holds, usage }
}
beforeEach(() => {
  remote.complete.mockReset().mockResolvedValue(completed())
  remote.client.mockReset().mockReturnValue({ chat: { completions: { create: remote.complete } } })
  remote.request.mockReset()
  remote.artifact.mockReset().mockResolvedValue({ url: '/api/files/fixture' })
  vi.stubEnv('HF_MAX_TOKENS', '4096')
  vi.stubEnv('HF_IMAGE_ENDPOINT_URL', 'https://fixture.example.test/image')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
afterAll(async () => { await db.$disconnect() })

describe('paid v1 with real accounting and mocked upstreams', () => {
  it('commits the upper-bound hold BEFORE chat dispatch, then captures actual usage', async () => {
    const api = await fixture()
    remote.complete.mockImplementation(async (body, options) => {
      const state = await records(api.userId)
      expect(state.balance).toBe(1_000_000n - 65_536n)
      expect(state.holds).toMatchObject([{ state: 'dispatched', amountMicros: 65_536n }])
      expect(state.usage).toHaveLength(0)
      expect(body.max_tokens).toBe(4096)
      expect(options.maxRetries).toBe(0)
      return completed()
    })
    const { res, req, done } = start('/chat/completions', chatBody, api)
    await done
    expect(res.statusCode).toBe(200)
    expect(res.headers['X-Loop-Cost-USD']).toBe('0.000220')
    const state = await records(api.userId)
    expect(state.balance).toBe(999_780n)
    expect(state.holds).toMatchObject([{ state: 'captured', capturedMicros: 220n }])
    expect(state.usage).toMatchObject([{ costMicros: 220n, tokensIn: 100, tokensOut: 10 }])
    expect(req.listenerCount('aborted')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })

  it.each(['/chat/completions', '/embeddings', '/images/generations'])('rejects insufficient funds before dispatch for %s', async path => {
    const api = await fixture(1n)
    const { res, done } = start(path, { ...chatBody, input: 'hello', prompt: 'hello' }, api)
    await done
    expect(res.statusCode).toBe(402)
    expect(remote.complete).not.toHaveBeenCalled()
    expect(remote.request).not.toHaveBeenCalled()
    expect(await records(api.userId)).toMatchObject({ balance: 1n, holds: [], usage: [] })
  })

  it('unlimited account metadata cannot bypass prepaid reservation', async () => {
    const api = { ...await fixture(0n), unlimited: true }
    const { res, done } = start('/chat/completions', chatBody, api)
    await done
    expect(res.statusCode).toBe(402)
    expect(remote.complete).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, 32_001])('rejects invalid max output %s without paid work', async max_tokens => {
    const api = await fixture()
    const { res, done } = start('/chat/completions', { ...chatBody, max_tokens }, api)
    await done
    expect(res.statusCode).toBe(400)
    expect(remote.complete).not.toHaveBeenCalled()
    expect((await records(api.userId)).holds).toHaveLength(0)
  })

  it('rejects invalid environment defaults, conflicting caps, and oversized tools', async () => {
    const api = await fixture()
    vi.stubEnv('HF_MAX_TOKENS', 'Infinity')
    for (const body of [chatBody, { ...chatBody, max_tokens: 10, max_completion_tokens: 20 }, { ...chatBody, max_tokens: 10, tools: [{ large: 'x'.repeat(40_000) }] }]) {
      const { res, done } = start('/chat/completions', body, api)
      await done
      expect(res.statusCode).toBe(400)
    }
    expect(remote.complete).not.toHaveBeenCalled()
    expect((await records(api.userId)).holds).toHaveLength(0)
  })

  it('honors max_completion_tokens and generates fresh identities despite repeated client keys', async () => {
    const api = await fixture()
    const ids = []
    for (let i = 0; i < 2; i++) {
      const { res, done } = start('/chat/completions', { ...chatBody, max_completion_tokens: 10 }, api)
      await done
      expect(res.statusCode).toBe(200)
      ids.push(res.headers['X-Loop-Reservation-Id'])
    }
    expect(new Set(ids).size).toBe(2)
    expect(remote.complete.mock.calls.every(([body]) => body.max_tokens === 10)).toBe(true)
  })

  it('releases configuration failures before upstream invocation', async () => {
    const api = await fixture()
    remote.client.mockImplementation(() => { throw new Error('fixture-private-configuration') })
    const { res, done } = start('/chat/completions', chatBody, api)
    await done
    expect(res.statusCode).toBe(502)
    const state = await records(api.userId)
    expect(state.balance).toBe(1_000_000n)
    expect(state.holds).toMatchObject([{ state: 'released' }])
    expect(state.usage).toMatchObject([{ costMicros: 0n }])
    expect(JSON.stringify(res.body)).not.toContain('fixture-private')
  })

  it.each(['missing', 'negative', 'fractional', 'over-output', 'over-input'])('retains unknown chat hold for %s usage', async scenario => {
    const api = await fixture()
    const response: any = completed()
    if (scenario === 'missing') delete response.usage
    if (scenario === 'negative') response.usage.prompt_tokens = -1
    if (scenario === 'fractional') response.usage.completion_tokens = 1.5
    if (scenario === 'over-output') response.usage.completion_tokens = 4097
    if (scenario === 'over-input') response.usage.prompt_tokens = 32_768
    remote.complete.mockResolvedValue(response)
    const { res, done } = start('/chat/completions', chatBody, api)
    await done
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    const state = await records(api.userId)
    expect(state.balance).toBe(934_464n)
    expect(state.holds).toMatchObject([{ state: 'unknown' }])
    expect(state.usage).toHaveLength(0)
  })

  it('settles stream usage before DONE and counts non-content output via provider usage', async () => {
    const api = await fixture()
    remote.complete.mockImplementation(async body => {
      expect(body.stream_options).toEqual({ include_usage: true })
      return (async function* () {
        yield { choices: [{ delta: { tool_calls: [{ function: { arguments: '{}' } }], reasoning_content: 'thought' }, finish_reason: null }] }
        yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
        yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }
      })()
    })
    const { res, done } = start('/chat/completions', { ...chatBody, stream: true }, api)
    await done
    expect(res.chunks.join('')).toContain('[DONE]')
    expect((await records(api.userId)).usage).toMatchObject([{ costMicros: 220n, tokensOut: 10 }])
  })

  it('does not emit DONE on a truncated stream; partial work stays held and errors are observable', async () => {
    const api = await fixture()
    remote.complete.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'partial' } }] }
      throw new Error('fixture-secret-provider-error')
    })())
    const { res, done } = start('/chat/completions', { ...chatBody, stream: true }, api)
    await done
    expect(res.chunks.join('')).not.toContain('[DONE]')
    expect(res.chunks.join('')).toContain('upstream_error')
    expect(res.chunks.join('')).not.toContain('fixture-secret')
    expect((await records(api.userId)).holds).toMatchObject([{ state: 'unknown' }])
    expect(console.error).toHaveBeenCalledWith('api_paid_request_failed', expect.objectContaining({ code: 'upstream_error' }))
  })

  it('withholds stream success markers when final accounting fails', async () => {
    const api = await fixture()
    remote.complete.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }
      yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }
      vi.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('fixture-settlement-failed'))
    })())
    const { res, done } = start('/chat/completions', { ...chatBody, stream: true }, api)
    await done
    const stream = res.chunks.join('')
    expect(stream).not.toContain('[DONE]')
    expect(stream).not.toContain('"finish_reason":"stop"')
    expect(stream).toContain('"code":"unavailable"')
    expect(await records(api.userId)).toMatchObject({ balance: 934_464n, holds: [{ state: 'unknown' }], usage: [] })
  })

  it('disconnect during chat aborts upstream and retains the durable hold', async () => {
    const api = await fixture()
    let started!: () => void
    const invoked = new Promise<void>(resolve => { started = resolve })
    remote.complete.mockImplementation((_body, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('fixture-abort')), { once: true })
      started()
    }))
    const { req, res, done } = start('/chat/completions', chatBody, api)
    await invoked
    res.destroyed = true
    res.emit('close')
    await done
    expect(res.body).toBeUndefined()
    expect((await records(api.userId)).holds).toMatchObject([{ state: 'unknown' }])
    expect(req.listenerCount('aborted')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('captures deterministic UTF-8 embeddings metering after validating vectors', async () => {
    const api = await fixture()
    remote.request.mockImplementation(async () => {
      expect((await records(api.userId)).holds).toMatchObject([{ state: 'dispatched', amountMicros: 16n }])
      return { json: async () => [[1, 2], [3, 4]] }
    })
    const { res, done } = start('/embeddings', { input: ['é', 'hi'] }, api)
    await done
    expect(res.statusCode).toBe(200)
    expect(res.body.usage.prompt_tokens).toBe(8)
    expect(res.headers['X-Loop-Usage-Estimated']).toBe('utf8-bytes-plus-special-tokens')
    expect((await records(api.userId)).usage).toMatchObject([{ kind: 'embedding', tokensIn: 8, costMicros: 16n }])
  })

  it('partial image batches retain the full hold and record completed units', async () => {
    const api = await fixture()
    remote.request.mockResolvedValueOnce(image()).mockRejectedValueOnce(new Error('fixture-private-upstream'))
    const { res, done } = start('/images/generations', { prompt: 'hello', n: 3 }, api)
    await done
    expect(res.statusCode).toBe(502)
    expect(remote.request).toHaveBeenCalledTimes(2)
    expect(await records(api.userId)).toMatchObject({ balance: 850_000n, holds: [{ state: 'unknown', amountMicros: 150_000n, evidence: { completedUnits: 1 } }], usage: [] })
  })

  it('artifact failures after known completed generation do not refund consumed work', async () => {
    const api = await fixture()
    remote.request.mockResolvedValue(image())
    remote.artifact.mockRejectedValue(new Error('fixture-storage-error'))
    const { res, done } = start('/images/generations', { prompt: 'hello', n: 2 }, api)
    await done
    expect(res.statusCode).toBe(502)
    expect(await records(api.userId)).toMatchObject({ balance: 900_000n, holds: [{ state: 'captured' }], usage: [{ costMicros: 100_000n, units: 2 }] })
  })

  it('accounting failure after provider success is not swallowed or refunded', async () => {
    const api = await fixture()
    remote.complete.mockImplementation(async () => {
      vi.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('fixture-db-failure'))
      return completed()
    })
    const { res, done } = start('/chat/completions', chatBody, api)
    await done
    expect(res.statusCode).toBeGreaterThanOrEqual(500)
    expect(res.body.choices).toBeUndefined()
    expect(await records(api.userId)).toMatchObject({ balance: 934_464n, holds: [{ state: 'unknown' }], usage: [] })
    expect(console.error).toHaveBeenCalled()
  })

  it('video dispatch explicitly remains unavailable until job-linked worker accounting exists', async () => {
    const api = await fixture()
    const { res, done } = start('/videos/generations', { prompt: 'hello' }, api)
    await done
    expect(res.statusCode).toBe(503)
    expect(res.body.error.code).toBe('video_accounting_unavailable')
    expect(await db.mediaJob.count({ where: { userId: api.userId } })).toBe(0)
    expect((await records(api.userId)).holds).toHaveLength(0)
  })

  it('disconnect before upstream invocation releases the hold', async () => {
    const api = await fixture()
    const { res, req, done } = start('/chat/completions', chatBody, api)
    req.aborted = true
    req.emit('aborted')
    await done
    expect(remote.complete).not.toHaveBeenCalled()
    expect(res.body).toBeUndefined()
    expect(await records(api.userId)).toMatchObject({ balance: 1_000_000n, holds: [{ state: 'released' }], usage: [{ costMicros: 0n }] })
  })

  it('failed unknown-state persistence leaves a discoverable dispatched hold and reports 503', async () => {
    const api = await fixture()
    remote.complete.mockImplementation(async () => {
      vi.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('fixture-db-capture')).mockRejectedValueOnce(new Error('fixture-db-cleanup'))
      return completed()
    })
    const { res, done } = start('/chat/completions', chatBody, api)
    await done
    expect(res.statusCode).toBe(503)
    expect(res.body.error.code).toBe('accounting_unavailable')
    expect(await records(api.userId)).toMatchObject({ balance: 934_464n, holds: [{ state: 'dispatched' }], usage: [] })
  })

  it.each(['intent', 'capture'])('ambiguous successful %s commit never causes a second debit or a refund', async phase => {
    const api = await fixture()
    remote.complete.mockImplementation(async () => {
      const realTransaction = db.$transaction.bind(db)
      const spy = vi.spyOn(db, '$transaction')
      // Capture now follows an independent, durable intent transaction.
      if (phase === 'capture') spy.mockImplementationOnce(realTransaction as any)
      spy.mockImplementationOnce(async (...args: any[]) => {
        await (realTransaction as any)(...args)
        throw new Error('fixture-connection-lost-after-commit')
      })
      return completed()
    })
    const { res, done } = start('/chat/completions', chatBody, api)
    await done
    expect(res.statusCode).toBe(503)
    const id = res.headers['X-Loop-Reservation-Id']
    if (phase === 'intent') {
      expect(await records(api.userId)).toMatchObject({ balance: 934_464n, holds: [{ state: 'unknown' }], usage: [] })
      expect(await db.apiSettlementIntent.findUnique({ where: { reservationId: id } })).toMatchObject({ status: 'pending', costMicros: 220n })
    }
    await captureApiSettlement(id)
    expect(await records(api.userId)).toMatchObject({ balance: 999_780n, holds: [{ state: 'captured', capturedMicros: 220n }], usage: [{ costMicros: 220n }] })
    expect((await records(api.userId)).usage).toHaveLength(1)
    expect(remote.complete).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('awaits actual capture after intent commit before successful response, stream=%s', async stream => {
    const api = await fixture()
    let reached!: () => void, release!: () => void
    const capturing = new Promise<void>(r => { reached = r }), proceed = new Promise<void>(r => { release = r })
    const installCapturePause = () => {
      const realTransaction = db.$transaction.bind(db)
      vi.spyOn(db, '$transaction').mockImplementationOnce(realTransaction as any).mockImplementationOnce(async (...args: any[]) => {
        reached(); await proceed
        return (realTransaction as any)(...args)
      })
    }
    remote.complete.mockImplementation(async () => {
      if (!stream) { installCapturePause(); return completed() }
      return (async function* () {
        yield { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }
        yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }
        installCapturePause()
      })()
    })
    const { res, done } = start('/chat/completions', { ...chatBody, stream }, api)
    try {
      await capturing
      expect(await db.apiSettlementIntent.findUnique({ where: { reservationId: res.headers['X-Loop-Reservation-Id'] } })).toMatchObject({ status: 'pending', costMicros: 220n })
      expect((await records(api.userId)).usage).toHaveLength(0)
      expect(res.body).toBeUndefined()
      expect(res.chunks.join('')).not.toContain('[DONE]')
      expect(res.chunks.join('')).not.toContain('"finish_reason":"stop"')
    } finally { release(); await done }
    expect((await records(api.userId)).usage).toHaveLength(1)
    if (stream) expect(res.chunks.join('')).toContain('[DONE]')
    else expect(res.body.choices).toBeDefined()
  })

  it.each([false, true])('fails foreground capture with durable intent and recovers without upstream replay, stream=%s', async stream => {
    const api = await fixture()
    const installCaptureFailure = () => {
      const realTransaction = db.$transaction.bind(db)
      vi.spyOn(db, '$transaction').mockImplementationOnce(realTransaction as any).mockRejectedValueOnce(new Error('fixture-capture-unavailable'))
    }
    remote.complete.mockImplementation(async () => {
      if (!stream) { installCaptureFailure(); return completed() }
      return (async function* () {
        yield { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }
        yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }
        installCaptureFailure()
      })()
    })
    const { res, done } = start('/chat/completions', { ...chatBody, stream }, api)
    await done
    const id = res.headers['X-Loop-Reservation-Id']
    expect(await db.apiSettlementIntent.findUnique({ where: { reservationId: id } })).toMatchObject({ status: 'pending', costMicros: 220n })
    expect(await records(api.userId)).toMatchObject({ balance: 934_464n, holds: [{ state: 'unknown' }], usage: [] })
    if (stream) {
      expect(res.chunks.join('')).not.toContain('[DONE]')
      expect(res.chunks.join('')).toContain('"code":"unavailable"')
    } else { expect(res.statusCode).toBe(503); expect(res.body.choices).toBeUndefined() }
    await captureApiSettlement(id)
    expect(await records(api.userId)).toMatchObject({ balance: 999_780n, holds: [{ state: 'captured' }], usage: [{ costMicros: 220n }] })
    expect(remote.complete).toHaveBeenCalledTimes(1)
  })
})
