import { randomUUID } from 'crypto'
import { request as httpRequest, type ClientRequest, type Server } from 'http'
import express from 'express'
import jwt from 'jsonwebtoken'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Real HTTP/JWT, ownership, runtime, persistence and PostgreSQL accounting. Only
// the provider boundary is mocked. DB locks/triggers force the lifecycle windows.
const remote = vi.hoisted(() => ({ client: vi.fn(), complete: vi.fn(), turn: vi.fn(), plan: vi.fn(), network: vi.fn() }))
vi.mock('../../agent/llmClient', () => ({ createClient: remote.client, resolveModel: () => 'fixture-model',
  isOpenAICompatible: () => true, streamTurn: remote.turn, completeOnce: remote.plan }))
vi.mock('../publicHttp', async original => ({ ...await original<typeof import('../publicHttp')>(),
  publicRequest: remote.network, postPublicForm: remote.network, postPublicJson: remote.network,
  getPublicJson: remote.network, fetchPublicText: remote.network }))
import { prisma } from '../prisma'
import { prepareRunConversation } from '../runWorkspace'
import { registerBuiltinTools } from '../../agent'
import agentRouter from '../../routes/agent'

const db = prisma!
const prefix = `daily-disconnect-${randomUUID()}`
const mounts = ['/api/agent', '/api/conversations']
const chatBody = { messages: [{ role: 'user', content: 'hello' }], stream: false }
const completion = { choices: [{ message: { content: 'fixture answer' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 3 } }
const paths = mounts.flatMap(mount => [
  ...[false, true].map(stream => ({ path: `${mount}/completions`, body: { ...chatBody, stream }, label: `completions stream=${stream}` })),
  ...['chat', 'agent', 'research'].map(mode => ({ path: `${mount}/new/stream`, body: { content: 'hello', mode }, label: mode })),
])
const successPaths = paths.filter(target => target.label !== 'agent' && target.label !== 'research')
let userId: string, server: Server, base: string, serial = 0

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture barrier timed out')), 8000)
    })])
  } finally { clearTimeout(timer) }
}

interface ObservedResponse {
  res: express.Response
  closed: ReturnType<typeof deferred<void>>
  frames: string[]
  baselineCloseListeners: number
}
interface EntryOptions { destroyAtEntry?: boolean; commitHeadersAtEntry?: boolean }
const observers = new Map<string, EntryOptions & { ready: ReturnType<typeof deferred<ObservedResponse>> }>()
const clients = new Set<ClientRequest>()
const activeResponses: ObservedResponse[] = []
const locks: Array<{ release: () => void; done: Promise<void> }> = []
const dropFixtures: Array<() => Promise<unknown>> = []
const holds = () => db.dailyReservation.findMany({ where: { userId } })
const user = () => db.user.findUniqueOrThrow({ where: { id: userId } })

function start(path: string, body: unknown, options: EntryOptions = {}) {
  const key = randomUUID()
  const ready = deferred<ObservedResponse>()
  observers.set(key, { ready, ...options })
  const result = deferred<{ status: number; text: string }>()
  const client = httpRequest(`${base}${path}`, { method: 'POST', agent: false, headers: {
    'Content-Type': 'application/json', 'X-Fixture-Request': key,
    Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET!)}`,
  } }, response => {
    let text = ''
    response.setEncoding('utf8')
    response.on('data', chunk => { text += chunk })
    response.on('error', () => {}) // Expected when a test destroys the socket.
    response.on('close', () => result.resolve({ status: response.statusCode || 0, text }))
  })
  clients.add(client)
  client.on('error', () => result.resolve({ status: 0, text: '' }))
  client.end(JSON.stringify(body))
  return { client, ready: ready.promise, result: result.promise }
}

// Query pg_blocking_pids, rather than sleeping and hoping the route reached SQL.
async function holdRow(table: 'User' | 'Conversation', id: string) {
  const acquired = deferred<number>(), release = deferred<void>()
  const done = db.$transaction(async tx => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
    if (table === 'User') await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${id} FOR UPDATE`
    else await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${id} FOR UPDATE`
    acquired.resolve(pid)
    await bounded(release.promise)
  }, { timeout: 12000, maxWait: 3000 })
  // The afterEach hook still awaits the original promise and reports failures.
  void done.catch(() => {})
  const lock = { release: () => release.resolve(), done }
  locks.push(lock)
  const pid = await bounded(acquired.promise)
  return { ...lock, waitForWaiter: () => vi.waitFor(async () => {
    const [{ waiting }] = await db.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS waiting`
    expect(waiting).toBe(true)
  }, { timeout: 3000, interval: 10 }) }
}

async function expectReleased() {
  await vi.waitFor(async () => {
    const rows = await holds()
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('released')
  }, { timeout: 3000, interval: 10 })
  expect(await user()).toMatchObject({ credits: 7, imageCredits: 3, messagesTotal: 0, tokensInTotal: 0n, tokensOutTotal: 0n })
  expect(await db.usageEvent.count({ where: { userId } })).toBe(0)
  for (const mock of Object.values(remote)) expect(mock).not.toHaveBeenCalled()
}
function expectNoSuccess(frames: string) {
  expect(frames).not.toContain('"type":"final"')
  expect(frames).not.toContain('"finish_reason":"stop"')
  expect(frames).not.toContain('[DONE]')
}

// Identifiers and conditions below contain only server-generated UUID fixtures.
async function rejectInsert(table: 'UsageEvent' | 'Message', condition: string) {
  const name = `disconnect_${randomUUID().replace(/-/g, '')}`
  await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF ${condition} THEN RAISE EXCEPTION 'fixture persistence failure'; END IF; RETURN NEW; END $$`)
  dropFixtures.push(async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "${table}"`)
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`)
  })
  await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${name}()`)
}

beforeAll(async () => {
  registerBuiltinTools()
  const app = express(); app.use(express.json())
  app.use((req, res, next) => {
    const key = req.header('X-Fixture-Request') || ''
    const observer = observers.get(key)
    if (observer) {
      observers.delete(key)
      const observed: ObservedResponse = { res, closed: deferred<void>(), frames: [], baselineCloseListeners: res.listenerCount('close') }
      activeResponses.push(observed)
      // Pass-through observation: the response is still written to a real socket.
      const write = res.write
      res.write = function (this: express.Response, ...args: any[]) {
        observed.frames.push(String(args[0]))
        return (write as any).apply(this, args)
      } as typeof res.write
      res.once('close', () => observed.closed.resolve())
      if (observer.destroyAtEntry) res.destroy()
      if (observer.commitHeadersAtEntry) res.flushHeaders()
      observer.ready.resolve(observed)
    }
    next()
  })
  for (const mount of mounts) app.use(mount, agentRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  userId = `${prefix}-${serial++}`
  await db.user.create({ data: { id: userId, email: `${userId}@example.test`, name: 'Disconnect fixture', password: 'fixture-only',
    credits: 7, imageCredits: 3, creditsResetAt: new Date() } })
  vi.stubEnv('HF_ENDPOINT_URL', 'https://fixture.example.test/model')
  vi.stubEnv('HF_TOKEN', '')
  for (const mock of Object.values(remote)) mock.mockReset()
  remote.client.mockImplementation(() => ({ chat: { completions: { create: remote.complete } } }))
  remote.complete.mockImplementation(async (params: any) => params.stream ? (async function* () {
    yield { choices: [{ delta: { content: 'fixture answer' }, finish_reason: null }] }
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
    yield { choices: [], usage: completion.usage }
  })() : completion)
  remote.turn.mockResolvedValue({ content: 'fixture answer', toolCalls: [] })
  // Research cancellation tests must stop before this boundary (and web work).
  remote.plan.mockRejectedValue(new Error('Unexpected research provider dispatch'))
  remote.network.mockRejectedValue(new Error('Unexpected external network dispatch'))
})
afterEach(async () => {
  try {
    for (const client of clients) client.destroy()
    for (const lock of locks) lock.release()
    await Promise.all(locks.map(lock => lock.done))
    await vi.waitFor(async () => {
      expect((await holds()).filter(row => ['reserved', 'dispatched'].includes(row.state))).toHaveLength(0)
      for (const observed of activeResponses) {
        expect(observed.res.listenerCount('close')).toBe(observed.baselineCloseListeners)
      }
    }, { timeout: 3000, interval: 10 })
  } finally {
    for (const drop of dropFixtures.reverse()) await drop()
    dropFixtures.length = 0; locks.length = 0; activeResponses.length = 0
    clients.clear(); observers.clear(); vi.unstubAllEnvs()
  }
})
afterAll(async () => {
  try {
    if (server) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
    await db.usageEvent.deleteMany({ where: { userId: { startsWith: prefix } } })
    await db.conversation.deleteMany({ where: { userId: { startsWith: prefix } } })
    await db.user.deleteMany({ where: { id: { startsWith: prefix } } })
  } finally { await db.$disconnect() }
})

describe('JWT disconnects before daily dispatch', () => {
  it.each(paths)('releases a reservation blocked on the user lock: $path $label', async ({ path, body }) => {
    const lock = await holdRow('User', userId)
    const pending = start(path, body)
    const observed = await bounded(pending.ready)
    try {
      await lock.waitForWaiter()
      expect(await holds()).toHaveLength(0)
      pending.client.destroy()
      await bounded(observed.closed.promise) // Server has observed close before SQL resumes.
    } finally { lock.release(); await lock.done }
    await expectReleased()
    expect(observed.frames).toEqual([])
    expect(await db.conversation.count({ where: { userId } })).toBe(0)
  })

  it.each(mounts.flatMap(mount => ['chat', 'agent', 'research'].flatMap(mode =>
    ['conversation', 'user-message'].map(stage => ({ mount, mode, stage })))))('releases a hold during $stage setup: $mount $mode', async ({ mount, mode, stage }) => {
    // Pre-create personal membership. An unbound legacy conversation blocks in
    // prepareRunConversation; a bound one blocks the user-message FK insert.
    const prepared = await prepareRunConversation(userId, 'new', 'Owned fixture')
    const conversation = stage === 'conversation'
      ? await db.conversation.create({ data: { userId, title: 'Legacy owned fixture' } }) : prepared
    const lock = await holdRow('Conversation', conversation.id)
    const pending = start(`${mount}/${conversation.id}/stream`, { content: 'hello', mode })
    const observed = await bounded(pending.ready)
    try {
      await lock.waitForWaiter()
      expect((await holds()).map(row => row.state)).toEqual(['reserved'])
      expect((await user()).credits).toBe(mode === 'research' ? 4 : 6)
      pending.client.destroy()
      await bounded(observed.closed.promise)
    } finally { lock.release(); await lock.done }
    await expectReleased()
    expect(observed.frames).toEqual([])
    expect(await db.message.count({ where: { conversationId: conversation.id, role: 'assistant' } })).toBe(0)
  })

  it.each(successPaths)('handles a response already destroyed at entry: $path $label', async ({ path, body }) => {
    const pending = start(path, body, { destroyAtEntry: true })
    const observed = await bounded(pending.ready)
    await bounded(observed.closed.promise)
    expect(await holds()).toHaveLength(0)
    for (const mock of Object.values(remote)) expect(mock).not.toHaveBeenCalled()
    expect((await user()).credits).toBe(7)
  })

  it.each(mounts)('releases the hold when real SSE header setup throws: %s', async mount => {
    // A middleware-committed response makes initSSE's setHeader throw the real
    // ERR_HTTP_HEADERS_SENT. No SSE, accounting or persistence mock is involved.
    const pending = start(`${mount}/new/stream`, { content: 'hello', mode: 'chat' }, { commitHeadersAtEntry: true })
    const result = await bounded(pending.result)
    expect(result.text).toContain('"type":"error"')
    expectNoSuccess(result.text)
    await expectReleased()
  })

  it.each(successPaths)('retains uncertain work on disconnect after dispatch: $path $label', async ({ path, body }) => {
    const started = deferred<void>()
    const waitForAbort = async (signal: AbortSignal) => {
      started.resolve()
      await new Promise<void>((_, reject) => {
        const cancel = () => reject(new Error('Fixture provider cancelled'))
        if (signal.aborted) cancel()
        else signal.addEventListener('abort', cancel, { once: true })
      })
    }
    remote.complete.mockImplementation(async (_params: unknown, options: { signal: AbortSignal }) => waitForAbort(options.signal))
    remote.turn.mockImplementation(async (options: { signal: AbortSignal }) => waitForAbort(options.signal))
    const pending = start(path, body)
    const observed = await bounded(pending.ready)
    await bounded(started.promise)
    expect((await holds()).map(row => row.state)).toEqual(['dispatched'])
    pending.client.destroy()
    await bounded(observed.closed.promise)
    await vi.waitFor(async () => expect((await holds()).map(row => row.state)).toEqual(['unknown']), { timeout: 3000 })
    expect(await user()).toMatchObject({ credits: 6, imageCredits: 3, messagesTotal: 0 })
    expect(await db.usageEvent.count({ where: { userId } })).toBe(0)
    expect(remote.complete.mock.calls.length + remote.turn.mock.calls.length).toBe(1)
    expect(remote.network).not.toHaveBeenCalled()
    expectNoSuccess(observed.frames.join(''))
  })
})

describe('daily capture precedes terminal success and assistant persistence', () => {
  it.each(successPaths)('withholds success while capture waits on SQL: $path $label', async ({ path, body }) => {
    const acquired = deferred<Awaited<ReturnType<typeof holdRow>>>()
    const takeLock = async () => { acquired.resolve(await holdRow('User', userId)) }
    const complete = remote.complete.getMockImplementation()!
    remote.complete.mockImplementation(async (...args: any[]) => { await takeLock(); return complete(...args) })
    remote.turn.mockImplementation(async () => { await takeLock(); return { content: 'fixture answer', toolCalls: [] } })
    const pending = start(path, body)
    const observed = await bounded(pending.ready)
    const lock = await bounded(acquired.promise)
    try {
      await lock.waitForWaiter()
      expect((await holds()).map(row => row.state)).toEqual(['dispatched'])
      expect(await db.usageEvent.count({ where: { userId } })).toBe(0)
      expect(await db.message.count({ where: { conversation: { userId }, role: 'assistant' } })).toBe(0)
      expectNoSuccess(observed.frames.join(''))
      if ('stream' in body && !body.stream) expect(observed.res.headersSent).toBe(false)
    } finally { lock.release(); await lock.done }
    const result = await bounded(pending.result)
    expect(result.status).toBe(200)
    expect(result.text).toContain(path.endsWith('/stream') ? '"type":"final"' : 'stream' in body && body.stream ? '[DONE]' : 'fixture answer')
    expect((await holds()).map(row => row.state)).toEqual(['captured'])
    expect(await db.usageEvent.count({ where: { userId } })).toBe(1)
    expect(await user()).toMatchObject({ credits: 6, imageCredits: 3, messagesTotal: 1 })
    if ('stream' in body && body.stream) {
      expect(result.text.indexOf('"finish_reason":"stop"')).toBeLessThan(result.text.indexOf('"usage"'))
      expect(result.text.indexOf('"usage"')).toBeLessThan(result.text.indexOf('[DONE]'))
    }
  })

  it.each(mounts)('captures successful work despite assistant INSERT failure: %s', async mount => {
    const conversation = await prepareRunConversation(userId, 'new', 'Persistence fixture')
    await rejectInsert('Message', `NEW."conversationId" = '${conversation.id}' AND NEW."role" = 'assistant'`)
    const pending = start(`${mount}/${conversation.id}/stream`, { content: 'hello', mode: 'chat' })
    const result = await bounded(pending.result)
    expect(result.text).toContain('"type":"error"')
    expectNoSuccess(result.text)
    expect((await holds()).map(row => row.state)).toEqual(['captured'])
    expect(await db.usageEvent.count({ where: { userId } })).toBe(1)
    expect(await user()).toMatchObject({ credits: 6, messagesTotal: 1, tokensInTotal: 2n, tokensOutTotal: 4n })
    expect(await db.message.count({ where: { conversationId: conversation.id, role: 'assistant' } })).toBe(0)
  })

  it.each(successPaths)('never sends terminal success if capture rolls back: $path $label', async ({ path, body }) => {
    await rejectInsert('UsageEvent', `NEW."userId" = '${userId}'`)
    const pending = start(path, body)
    const result = await bounded(pending.result)
    expect(result.text).toContain(path.endsWith('/stream') ? 'Agent run failed' : 'Model request failed')
    expectNoSuccess(result.text)
    await vi.waitFor(async () => expect((await holds()).map(row => row.state)).toEqual(['unknown']), { timeout: 3000 })
    expect(await user()).toMatchObject({ credits: 6, imageCredits: 3, messagesTotal: 0, tokensInTotal: 0n, tokensOutTotal: 0n })
    expect(await db.usageEvent.count({ where: { userId } })).toBe(0)
    expect(await db.message.count({ where: { conversation: { userId }, role: 'assistant', content: 'fixture answer' } })).toBe(0)
  })
})
