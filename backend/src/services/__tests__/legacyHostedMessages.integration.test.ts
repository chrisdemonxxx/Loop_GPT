import { randomUUID } from 'crypto'
import type { Server } from 'http'
import express from 'express'
import jwt from 'jsonwebtoken'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const remote = vi.hoisted(() => ({ client: vi.fn(), complete: vi.fn(), image: vi.fn(), shared: vi.fn(), fallback: vi.fn(), modes: vi.fn() }))
vi.mock('../../agent/llmClient', () => ({ createClient: remote.client }))
vi.mock('../imageApi', () => ({ imageApiService: { generateImage: remote.image } }))
vi.mock('../multiModelRouter', () => ({ multiModelRouter: { setModels: remote.shared, getAllModels: remote.shared, getMultiModelCompletion: remote.shared } }))
vi.mock('../aiProviders', () => ({ aiProviderService: { getChatCompletion: remote.fallback } }))
vi.mock('../interactionModes', () => ({ interactionModesService: { planMode: remote.modes, agenticMode: remote.modes, automationMode: remote.modes } }))
import { prisma } from '../prisma'
import messagesRouter from '../../routes/messages'
import modelsRouter from '../../routes/models'

const db = prisma!
const prefix = `legacy-hosted-${randomUUID()}`
let alice: string, bob: string, server: Server, base: string
const answer = (content = 'Hosted answer') => ({ choices: [{ message: { content } }] })
const headers = (userId: string) => ({ Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET!)}`, 'Content-Type': 'application/json' })
const conversation = (userId = alice) => db.conversation.create({ data: { userId, title: 'Hosted fixture' } })
const request = (id: string, body: unknown, userId = alice) => fetch(`${base}/api/conversations/${id}/messages`, {
  method: 'POST', headers: headers(userId), body: JSON.stringify(body),
})

beforeAll(async () => {
  alice = `${prefix}-alice`; bob = `${prefix}-bob`
  await db.user.createMany({ data: [alice, bob].map(id => ({ id, email: `${id}@example.test`, password: 'fixture-only', name: 'Fixture' })) })
  const app = express(); app.use(express.json({ limit: '1mb' }))
  app.use('/api/conversations', messagesRouter); app.use('/api/models', modelsRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(() => {
  vi.stubEnv('HF_ENDPOINT_URL', 'https://standard.example.test')
  vi.stubEnv('HF_MODEL', 'operator-standard')
  vi.stubEnv('HF_LARGE_ENDPOINT_URL', 'https://large.example.test')
  vi.stubEnv('HF_LARGE_MODEL', 'operator-large')
  vi.stubEnv('DEFAULT_PROVIDER', 'nvidia')
  remote.complete.mockReset().mockResolvedValue(answer())
  remote.client.mockReset().mockImplementation((provider, apiKey, baseUrl) => ({ chat: { completions: {
    create: (params: unknown, options: unknown) => remote.complete({ provider, apiKey, baseUrl }, params, options),
  } } }))
  remote.image.mockReset(); remote.shared.mockReset(); remote.fallback.mockReset(); remote.modes.mockReset()
})
afterEach(() => {
  expect(remote.shared).not.toHaveBeenCalled()
  expect(remote.fallback).not.toHaveBeenCalled()
  expect(remote.modes).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
})
afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) })
    await db.conversation.deleteMany({ where: { userId: { in: [alice, bob] } } })
    await db.user.deleteMany({ where: { id: { in: [alice, bob] } } })
  } finally { await db.$disconnect() }
})

describe('legacy message hosted-only migration', () => {
  it.each(['apiKey', 'api_key', 'baseUrl', 'baseURL', 'base_url', 'models', 'selectionMode'])('rejects raw %s before schema stripping or writes', async field => {
    const before = await db.conversation.count({ where: { userId: alice } })
    for (const value of [null, '', 'fixture-secret', [{ provider: 'local', baseUrl: 'http://127.0.0.1' }]]) {
      const res = await request('new', { content: 'q', [field]: value })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('HOSTED_MODEL_REQUIRED')
      expect(JSON.stringify(body)).not.toContain('fixture-secret')
    }
    expect(await db.conversation.count({ where: { userId: alice } })).toBe(before)
    expect(remote.client).not.toHaveBeenCalled()
    expect(remote.image).not.toHaveBeenCalled()
  })

  it('rejects provider switches for chat, vision and image-generation requests', async () => {
    for (const provider of ['openai', 'nvidia', 'local', 'ollama']) for (const tool of ['chat', 'vision-chat', 'generate-image']) {
      expect((await request('new', { content: 'q', provider, tool })).status).toBe(400)
    }
    expect(remote.client).not.toHaveBeenCalled(); expect(remote.image).not.toHaveBeenCalled()
  })

  it('rejects retired modes, schedules and placeholder tools before creating records', async () => {
    const before = await db.conversation.count({ where: { userId: alice } })
    for (const body of [{ interactionMode: 'plan' }, { interactionMode: 'agentic' }, { interactionMode: 'automation' },
      { schedule: null }, { tool: 'mcp' }, { tool: 'gpt-creation' }, { content: '/mcp list' }, { content: '/create helper' },
      { content: 'a'.repeat(100_001) }]) {
      expect((await request('new', { content: 'q', ...body })).status).toBe(400)
    }
    expect(await db.conversation.count({ where: { userId: alice } })).toBe(before)
    expect(remote.client).not.toHaveBeenCalled()
  })

  it('preserves conversation ownership and rejects missing vision attachments', async () => {
    const owned = await conversation()
    expect((await request(owned.id, { content: 'q' }, bob)).status).toBe(404)
    expect((await request(randomUUID(), { content: 'q' })).status).toBe(404)
    expect((await request('new', { content: 'q', tool: 'vision-chat' })).status).toBe(400)
    expect(remote.client).not.toHaveBeenCalled()
  })

  it('retains the response envelope, bounded owned history, and hosted target selection', async () => {
    const owned = await conversation()
    await db.message.create({ data: { conversationId: owned.id, role: 'assistant', content: 'Earlier owned answer' } })
    const res = await request(owned.id, { content: 'Current question', interactionMode: 'ask', model: 'loop-chat-large', provider: 'huggingface' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ conversationId: owned.id, toolUsed: 'chat',
      userMessage: { content: 'Current question', imagePath: null }, assistantMessage: { content: 'Hosted answer', imagePath: null } })
    expect(remote.client).toHaveBeenCalledWith('huggingface', undefined, 'https://large.example.test/v1')
    const [, params, options] = remote.complete.mock.calls[0]
    expect(params.model).toBe('operator-large')
    expect(params.messages).toEqual([{ role: 'assistant', content: 'Earlier owned answer' }, { role: 'user', content: 'Current question' }])
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(body)).not.toContain('operator-large')
    expect(await db.message.count({ where: { conversationId: owned.id } })).toBe(3)
  })

  it('keeps concurrent callers, models, histories and answers separate', async () => {
    const a = await conversation(); const b = await conversation(bob)
    let arrived = 0, release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    remote.complete.mockImplementation(async (target, params) => {
      arrived += 1; if (arrived === 2) release()
      await barrier
      return answer(`${target.baseUrl}|${params.messages.at(-1).content}`)
    })
    const [ra, rb] = await Promise.all([
      request(a.id, { content: 'alice-only', model: 'loop-chat' }),
      request(b.id, { content: 'bob-only', model: 'loop-chat-large' }, bob),
    ])
    expect(ra.status).toBe(200); expect(rb.status).toBe(200)
    const aa = await ra.json(), bb = await rb.json()
    expect(aa.assistantMessage.content).toBe('https://standard.example.test/v1|alice-only')
    expect(bb.assistantMessage.content).toBe('https://large.example.test/v1|bob-only')
    expect(JSON.stringify(await db.message.findMany({ where: { conversationId: a.id } }))).not.toContain('bob-only')
    expect(JSON.stringify(await db.message.findMany({ where: { conversationId: b.id } }))).not.toContain('alice-only')
  })

  it.each(['constructor', 'provider', 'empty-response'])('returns a generic failure without fallback for %s errors', async kind => {
    const owned = await conversation()
    if (kind === 'constructor') remote.client.mockImplementationOnce(() => { throw new Error('fixture-secret upstream endpoint') })
    else if (kind === 'provider') remote.complete.mockRejectedValueOnce(new Error('fixture-secret upstream body'))
    else remote.complete.mockResolvedValueOnce(answer(''))
    const res = await request(owned.id, { content: 'Question' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Model request failed' })
    const records = await db.message.findMany({ where: { conversationId: owned.id } })
    expect(records).toHaveLength(1)
    expect(JSON.stringify(records)).not.toContain('fixture-secret')
  })

  it('cancels a disconnected caller without writing a late assistant answer', async () => {
    const owned = await conversation()
    let started!: () => void, cancelled!: () => void
    const start = new Promise<void>(resolve => { started = resolve })
    const done = new Promise<void>(resolve => { cancelled = resolve })
    remote.complete.mockImplementation(async (_target, _params, { signal }) => {
      started()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled(); resolve() }, { once: true }))
      throw new Error('aborted fixture')
    })
    const abort = new AbortController()
    try {
      const result = fetch(`${base}/api/conversations/${owned.id}/messages`, { method: 'POST', signal: abort.signal,
        headers: headers(alice), body: JSON.stringify({ content: 'Cancel me' }) }).catch(() => undefined)
      await start; abort.abort(); await done; await result
      expect(remote.complete.mock.calls[0][2].signal.aborted).toBe(true)
      expect(await db.message.count({ where: { conversationId: owned.id, role: 'assistant' } })).toBe(0)
    } finally { abort.abort() }
  })
})

describe('global model selection retirement', () => {
  it('requires authentication even in development without an explicit guest opt-in', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('ENABLE_DEV_MODE', 'false')
    expect((await fetch(`${base}/api/models/selection`)).status).toBe(401)
  })
  it('returns authenticated 410 on every selection verb/subpath without reading shared state', async () => {
    for (const path of ['/selection', '/selection/child']) for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await fetch(`${base}/api/models${path}`, { method, headers: headers(alice),
        body: ['GET', 'OPTIONS'].includes(method) ? undefined : JSON.stringify({ models: [{ apiKey: 'fixture-secret' }] }) })
      expect(res.status).toBe(410)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toMatchObject({ code: 'GLOBAL_MODEL_SELECTION_RETIRED' })
    }
  })
  it('keeps the public catalog available without exposing operator configuration', async () => {
    const res = await fetch(`${base}/api/models/catalog`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('loop-large')
    expect(text).not.toContain('operator-large')
    expect(text).not.toContain('large.example.test')
  })
})
