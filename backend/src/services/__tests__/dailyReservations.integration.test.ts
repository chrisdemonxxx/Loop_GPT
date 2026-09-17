import { randomUUID } from 'crypto'
import type { Server } from 'http'
import express from 'express'
import jwt from 'jsonwebtoken'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Real PostgreSQL, JWT, routes, runtime and daily ledger. Only provider/artifact
// boundaries are replaced: these tests cannot call live inference or media APIs.
const remote = vi.hoisted(() => ({ client: vi.fn(), complete: vi.fn(), turn: vi.fn(), plan: vi.fn(), media: vi.fn(), image: vi.fn(), artifact: vi.fn() }))
vi.mock('../../agent/llmClient', () => ({ createClient: remote.client, resolveModel: () => 'fixture-model',
  isOpenAICompatible: () => true, streamTurn: remote.turn, completeOnce: remote.plan }))
vi.mock('../providerHttp', async original => ({ ...await original<typeof import('../providerHttp')>(), providerRequest: remote.media }))
vi.mock('../imageApi', () => ({ imageApiService: { generateImage: remote.image } }))
vi.mock('../../agent/artifacts', () => ({ saveArtifact: remote.artifact }))
vi.mock('../../agent/tools/webSearch', async original => ({ ...await original<typeof import('../../agent/tools/webSearch')>(), searchWeb: vi.fn(async () => []) }))
vi.mock('../../agent/tools/webFetch', async original => ({ ...await original<typeof import('../../agent/tools/webFetch')>(), fetchReadable: vi.fn(async () => ({ title: '', text: '' })) }))
import { prisma } from '../prisma'
import { getAccount, recordUsage } from '../billing'
import { prepareRunConversation } from '../runWorkspace'
import { reserveDailyCredits, markDailyDispatched, captureDailyReservation, finishDailyFailure, dailyDispatch } from '../dailyReservations'
import agentRouter from '../../routes/agent'
import messagesRouter from '../../routes/messages'
import mediaRouter from '../../routes/media'
import { registerBuiltinTools } from '../../agent'
import { generateImageTool } from '../../agent/tools/generateImage'
import { generateVideoTool } from '../../agent/tools/generateVideo'

const db = prisma!
const prefix = `daily-${randomUUID()}`
let userId: string, server: Server, base: string
let serial = 0
const user = () => db.user.findUniqueOrThrow({ where: { id: userId } })
const holds = () => db.dailyReservation.findMany({ where: { userId } })
const ctx = () => ({ userId, conversationId: '', scratch: {}, emit: vi.fn() })
const completion = { choices: [{ message: { content: 'fixture answer' } }], usage: { prompt_tokens: 4, completion_tokens: 3 } }
async function request(path: string, body: unknown, identity = userId) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt.sign({ userId: identity }, process.env.JWT_SECRET!)}` }, body: JSON.stringify(body) })
  return { status: res.status, text: await res.text() }
}
const chatBody = { messages: [{ role: 'user', content: 'hello' }], stream: false }
const agentPaths = ['/api/agent', '/api/conversations']
const paths = [
  ...agentPaths.map(mount => ({ path: `${mount}/completions`, body: chatBody })),
  ...agentPaths.map(mount => ({ path: `${mount}/new/stream`, body: { content: 'hello', mode: 'chat' } })),
  { path: '/api/conversations/new/messages', body: { content: 'hello', tool: 'chat' } },
]

beforeAll(async () => {
  registerBuiltinTools()
  const app = express(); app.use(express.json())
  app.use('/api/agent', agentRouter); app.use('/api/conversations', agentRouter)
  app.use('/api/conversations', messagesRouter); app.use('/api/media', mediaRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  userId = `${prefix}-${serial++}`
  await db.user.create({ data: { id: userId, email: `${userId}@example.test`, name: 'Daily fixture', password: 'fixture-only' } })
  vi.stubEnv('HF_ENDPOINT_URL', 'https://fixture.example.test/model')
  vi.stubEnv('HF_IMAGE_ENDPOINT_URL', 'https://fixture.example.test/image')
  vi.stubEnv('VIDEO_API_URL', 'https://fixture.example.test/video')
  vi.stubEnv('IMAGE_API_URL', 'http://127.0.0.1:8081')
  vi.stubEnv('HF_TOKEN', '')
  for (const mock of Object.values(remote)) mock.mockReset()
  remote.complete.mockImplementation(async (params: any) => params.stream
    ? (async function* () { yield { choices: [{ delta: { content: 'fixture answer' } }] } })() : completion)
  remote.client.mockImplementation(() => ({ chat: { completions: { create: remote.complete } } }))
  remote.turn.mockResolvedValue({ content: 'fixture answer', toolCalls: [] })
  remote.plan.mockResolvedValue('["fixture"]')
  remote.media.mockResolvedValue({ headers: new Headers({ 'content-type': 'image/png' }), body: Buffer.from('fixture media') })
  remote.image.mockResolvedValue({ image_base64: Buffer.from('fixture image').toString('base64'), model: 'flux-schnell' })
  remote.artifact.mockResolvedValue({ id: randomUUID(), kind: 'image', url: '/fixture.png' })
})
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  // HTTP failure responses can precede asynchronous reservation cleanup.
  await vi.waitFor(async () => expect((await holds()).filter(row => row.state === 'reserved' || row.state === 'dispatched')).toHaveLength(0), { timeout: 3000 })
})
afterAll(async () => {
  if (server) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } })
  await db.$disconnect()
})

describe('atomic daily reservations on PostgreSQL', () => {
  it('does not commit a dispatch marker for a cancelled reservation', async () => {
    const hold = await reserveDailyCredits(userId, 'chat')
    const controller = new AbortController(); controller.abort()
    await expect(markDailyDispatched(hold.id, controller.signal)).rejects.toMatchObject({ code: 'DAILY_CANCELLED' })
    expect((await holds())[0].state).toBe('reserved')
    await finishDailyFailure(hold.id)
    expect((await user()).credits).toBe(30)
  })
  it.each([['chat', 1, 7], ['research', 3, 2], ['video', 10, 0], ['image', 0, 3]] as const)(
    'never overspends concurrent %s reservations', async (kind, cost, admitted) => {
      await db.user.update({ where: { id: userId }, data: { credits: 7, imageCredits: 3 } })
      const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => reserveDailyCredits(userId, kind)))
      const accepted = outcomes.filter(r => r.status === 'fulfilled')
      expect(accepted).toHaveLength(admitted)
      for (const result of outcomes) if (result.status === 'rejected') expect(result.reason.status).toBe(402)
      expect((await user()).credits).toBe(7 - cost * admitted)
      expect((await user()).imageCredits).toBe(kind === 'image' ? 0 : 3)
      await Promise.all((await holds()).map(row => finishDailyFailure(row.id)))
      expect((await user()).credits).toBe(7); expect((await user()).imageCredits).toBe(3)
    })

  it('captures metrics once under concurrent retries and rejects mismatched identity/metrics', async () => {
    const hold = await reserveDailyCredits(userId, 'chat', 'fixture')
    await markDailyDispatched(hold.id)
    const usage = { reservationId: hold.id, model: 'fixture', tokensIn: 10, tokensOut: 12 }
    await Promise.all(Array.from({ length: 12 }, () => recordUsage(userId, 'chat', usage)))
    expect(await db.usageEvent.count({ where: { reservationId: hold.id } })).toBe(1)
    expect(await user()).toMatchObject({ credits: 29, messagesTotal: 1, tokensInTotal: 10n, tokensOutTotal: 12n })
    await expect(recordUsage(userId, 'chat', { ...usage, tokensOut: 13 })).rejects.toMatchObject({ status: 409 })
    await expect(recordUsage('foreign', 'chat', usage)).rejects.toMatchObject({ status: 409 })
    await expect(recordUsage(userId, 'video', usage)).rejects.toMatchObject({ status: 409 })
    await expect(recordUsage(userId, 'chat')).rejects.toMatchObject({ code: 'DAILY_RESERVATION_REQUIRED' })
    await finishDailyFailure(hold.id)
    expect((await user()).credits).toBe(29)
  })

  it('serializes daily reset with concurrent account reads and deductions', async () => {
    await db.user.update({ where: { id: userId }, data: { credits: 0, imageCredits: 0, creditsResetAt: new Date(Date.now() - 86_400_001) } })
    await Promise.all(Array.from({ length: 20 }, (_, i) => i % 2 ? getAccount(userId) : reserveDailyCredits(userId, 'chat')))
    expect(await user()).toMatchObject({ credits: 20, imageCredits: 5 })
    expect(new Set((await holds()).map(row => row.windowStart.toISOString())).size).toBe(1)
    await Promise.all((await holds()).map(row => finishDailyFailure(row.id)))
    expect((await user()).credits).toBe(30)
  })

  it('does not add old-window refunds to refreshed allowance even when reset and refund race', async () => {
    const oldWindow = new Date(Date.now() - 86_400_001)
    // Build consistent historical fixture data at INSERT; debit/window identity
    // is immutable and must not be rewritten after an actual reservation.
    const old = await db.$transaction(async tx => {
      await tx.user.update({ where: { id: userId }, data: { creditsResetAt: oldWindow, imageCredits: { decrement: 1 } } })
      return tx.dailyReservation.create({ data: { id: randomUUID(), userId, kind: 'image', model: '', credits: 0,
        imageCredits: 1, bypass: false, windowStart: oldWindow } })
    })
    await Promise.all([getAccount(userId), finishDailyFailure(old.id), finishDailyFailure(old.id)])
    expect(await user()).toMatchObject({ credits: 30, imageCredits: 5 })
    const current = await reserveDailyCredits(userId, 'image')
    await finishDailyFailure(old.id)
    expect((await user()).imageCredits).toBe(4)
    await finishDailyFailure(current.id)
  })

  it('refunds undispatched failures once, prevents replay, and retains uncertain dispatched work', async () => {
    const pre = await reserveDailyCredits(userId, 'video')
    await Promise.all(Array.from({ length: 10 }, () => finishDailyFailure(pre.id)))
    expect((await user()).credits).toBe(30)
    await expect(markDailyDispatched(pre.id)).rejects.toMatchObject({ status: 409 })
    const post = await reserveDailyCredits(userId, 'video')
    const dispatch = dailyDispatch(post.id)
    await Promise.all([dispatch(), dispatch()])
    await expect(markDailyDispatched(post.id)).rejects.toMatchObject({ status: 409 })
    await Promise.all(Array.from({ length: 10 }, () => finishDailyFailure(post.id)))
    expect((await user()).credits).toBe(20)
    expect((await holds()).find(row => row.id === post.id)?.state).toBe('unknown')
    await captureDailyReservation(post.id, userId, 'video')
    expect((await user()).credits).toBe(20)
  })

  it('serializes capture racing with failure cleanup without refunding dispatched work', async () => {
    const hold = await reserveDailyCredits(userId, 'chat')
    await markDailyDispatched(hold.id)
    await Promise.all([finishDailyFailure(hold.id), recordUsage(userId, 'chat', { reservationId: hold.id })])
    expect((await holds())[0].state).toBe('captured')
    expect(await user()).toMatchObject({ credits: 29, messagesTotal: 1 })
  })

  it.each([{ role: 'admin', unlimited: false }, { role: 'user', unlimited: true }])('audits explicit bypass %j', async flags => {
    await db.user.update({ where: { id: userId }, data: { ...flags, credits: 0, imageCredits: 0 } })
    const hold = await reserveDailyCredits(userId, 'video')
    expect(hold).toMatchObject({ bypass: true, credits: 0, imageCredits: 0 })
    await markDailyDispatched(hold.id); await recordUsage(userId, 'video', { reservationId: hold.id })
    expect((await user()).credits).toBe(0)
    expect(await db.usageEvent.findUnique({ where: { reservationId: hold.id } })).toMatchObject({ credits: 0 })
  })

  it('rolls back deductions if reservation persistence fails and rolls back counters if usage persistence fails', async () => {
    await db.$executeRawUnsafe(`CREATE FUNCTION daily_test_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture write failure'; END $$`)
    try {
      await db.$executeRawUnsafe(`CREATE TRIGGER daily_test_reserve_failure BEFORE INSERT ON "DailyReservation" FOR EACH ROW EXECUTE FUNCTION daily_test_fail_insert()`)
      await expect(reserveDailyCredits(userId, 'chat')).rejects.toThrow()
      expect((await user()).credits).toBe(30)
      expect(await holds()).toHaveLength(0)
      await db.$executeRawUnsafe(`DROP TRIGGER daily_test_reserve_failure ON "DailyReservation"`)
      const hold = await reserveDailyCredits(userId, 'chat'); await markDailyDispatched(hold.id)
      await db.$executeRawUnsafe(`CREATE TRIGGER daily_test_usage_failure BEFORE INSERT ON "UsageEvent" FOR EACH ROW EXECUTE FUNCTION daily_test_fail_insert()`)
      await expect(recordUsage(userId, 'chat', { reservationId: hold.id, tokensIn: 7 })).rejects.toThrow()
      expect(await user()).toMatchObject({ credits: 29, tokensInTotal: 0n, messagesTotal: 0 })
      expect((await holds())[0].state).toBe('dispatched')
      await finishDailyFailure(hold.id)
      await db.$executeRawUnsafe(`DROP TRIGGER daily_test_usage_failure ON "UsageEvent"`)
      await recordUsage(userId, 'chat', { reservationId: hold.id, tokensIn: 7 })
      expect((await user()).messagesTotal).toBe(1)
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS daily_test_reserve_failure ON "DailyReservation"`)
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS daily_test_usage_failure ON "UsageEvent"`)
      await db.$executeRawUnsafe(`DROP FUNCTION daily_test_fail_insert()`)
    }
  })
})

describe('JWT daily dispatch enforcement', () => {
  it.each([generateImageTool, generateVideoTool])('releases $name cancelled during reservation before marking dispatch', async tool => {
    const controller = new AbortController()
    const transaction = db.$transaction.bind(db)
    vi.spyOn(db, '$transaction').mockImplementationOnce(async (...args: any[]) => {
      const result = await (transaction as any)(...args)
      controller.abort()
      return result
    })
    expect((await tool.handler({ prompt: 'fixture' }, { ...ctx(), signal: controller.signal })).isError).toBe(true)
    expect((await holds())[0].state).toBe('released')
    expect(await user()).toMatchObject({ credits: 30, imageCredits: 5 })
    expect(remote.media).not.toHaveBeenCalled(); expect(remote.image).not.toHaveBeenCalled()
  })
  it('captures successful legacy image work even when artifact storage fails', async () => {
    remote.artifact.mockRejectedValue(new Error('fixture artifact unavailable'))
    expect((await request('/api/conversations/new/messages', { content: 'fixture', tool: 'generate-image' })).status).toBe(500)
    expect((await holds())[0].state).toBe('captured')
    expect(await user()).toMatchObject({ imageCredits: 4, imagesTotal: 1 })
    expect(await db.usageEvent.count({ where: { userId } })).toBe(1)
  })
  it.each(paths)('rejects missing users before dispatch at $path', async ({ path, body }) => {
    const result = await request(path, body, 'missing-daily-user')
    expect(result.status).toBe(403)
    expect(remote.client).not.toHaveBeenCalled(); expect(remote.turn).not.toHaveBeenCalled()
    expect(remote.image).not.toHaveBeenCalled()
  })

  it.each(paths)('rejects database errors before dispatch at $path', async ({ path, body }) => {
    vi.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('private fixture database error'))
    const result = await request(path, body)
    expect(result.status).toBe(503); expect(result.text).not.toContain('private fixture')
    expect(remote.client).not.toHaveBeenCalled(); expect(remote.turn).not.toHaveBeenCalled()
  })

  it('shares the same atomic allowance across CLI aliases, SSE and legacy requests', async () => {
    // Pin workspace ownership before this accounting race; workspace creation
    // intentionally reports its own serializable conflicts under concurrent writes.
    const conversation = await prepareRunConversation(userId, 'new', 'Daily concurrency fixture')
    await db.user.update({ where: { id: userId }, data: { credits: 3 } })
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => {
      const target = paths[i % paths.length]; return request(target.path.replace('/new/', `/${conversation.id}/`), target.body)
    }))
    expect(results.filter(r => r.status === 200), JSON.stringify(results.filter(r => r.status !== 200 && r.status !== 402))).toHaveLength(3)
    expect(results.filter(r => r.status === 402)).toHaveLength(17)
    expect((await user()).credits).toBe(0)
    expect((await holds()).map(row => row.state)).toEqual(['captured', 'captured', 'captured'])
    expect(remote.complete.mock.calls.length + remote.turn.mock.calls.length).toBe(3)
  })

  it.each(agentPaths)('accounts for successful streaming CLI completion at %s', async mount => {
    remote.complete.mockImplementation(async () => {
      expect((await holds())[0].state).toBe('dispatched'); expect((await user()).credits).toBe(29)
      return (async function* () { yield { choices: [{ delta: { content: 'answer' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } } })()
    })
    const result = await request(`${mount}/completions`, { ...chatBody, stream: true })
    expect(result.status).toBe(200); expect(result.text).toContain('[DONE]')
    expect(await user()).toMatchObject({ credits: 29, messagesTotal: 1, tokensInTotal: 5n, tokensOutTotal: 2n })
  })

  it.each(['chat', 'agent', 'research'])('reserves base %s credits before runtime model dispatch', async mode => {
    const cost = mode === 'research' ? 3 : 1
    const assertDebit = async () => {
      expect((await user()).credits).toBe(30 - cost)
      expect((await holds())[0].state).toBe('dispatched')
    }
    remote.turn.mockImplementation(async () => { await assertDebit(); return { content: 'answer', toolCalls: [] } })
    remote.plan.mockImplementation(async () => { await assertDebit(); return '["fixture"]' })
    expect((await request('/api/agent/new/stream', { content: 'hello', mode })).status).toBe(200)
    expect((await holds())[0].state).toBe('captured')
    expect((await user()).credits).toBe(30 - cost)
  })

  it.each(paths)('releases client-construction failures at $path', async ({ path, body }) => {
    remote.client.mockImplementation(() => { throw new Error('fixture client failure') })
    const result = await request(path, body)
    expect(result.status).toBe(path.endsWith('/stream') ? 200 : 502)
    await vi.waitFor(async () => expect((await user()).credits).toBe(30))
    expect((await holds())[0].state).toBe('released')
    expect(remote.complete).not.toHaveBeenCalled(); expect(remote.turn).not.toHaveBeenCalled()
  })

  it.each(paths)('retains uncertain provider failures at $path', async ({ path, body }) => {
    remote.complete.mockRejectedValue(new Error('fixture transport failed'))
    remote.turn.mockRejectedValue(new Error('fixture transport failed'))
    await request(path, body)
    await vi.waitFor(async () => expect((await holds())[0].state).toBe('unknown'))
    expect((await user()).credits).toBe(29)
    expect(await db.usageEvent.count({ where: { userId } })).toBe(0)
  })

  it('releases an unauthorized conversation reservation before model construction', async () => {
    const result = await request('/api/agent/foreign-conversation/stream', { content: 'hello' })
    expect(result.status).toBe(404)
    expect((await user()).credits).toBe(30); expect((await holds())[0].state).toBe('released')
    expect(remote.client).not.toHaveBeenCalled()
  })

  it('settles legacy image credits before returning the response', async () => {
    remote.image.mockImplementation(async () => {
      expect((await user()).imageCredits).toBe(4); expect((await holds())[0].state).toBe('dispatched')
      return { image_base64: Buffer.from('fixture').toString('base64'), model: 'flux-schnell' }
    })
    expect((await request('/api/conversations/new/messages', { content: 'fixture', tool: 'generate-image' })).status).toBe(200)
    expect(await user()).toMatchObject({ credits: 30, imageCredits: 4, imagesTotal: 1 })
  })

  it('charges media tools once each, separately from one base agent charge', async () => {
    remote.turn.mockResolvedValueOnce({ content: '', toolCalls: [
      { id: 'image', name: 'generate_image', arguments: '{"prompt":"fixture"}' },
      { id: 'video', name: 'generate_video', arguments: '{"prompt":"fixture"}' },
    ] })
    const response = await request('/api/agent/new/stream', { content: 'media', mode: 'agent', toolNames: ['generate_image', 'generate_video'] })
    expect(response.text).not.toContain('"isError":true')
    expect(remote.media).toHaveBeenCalledTimes(2)
    expect(await user()).toMatchObject({ credits: 19, imageCredits: 4, imagesTotal: 1, messagesTotal: 2 })
    expect((await holds()).map(row => row.kind).sort()).toEqual(['agent', 'image', 'video'])
    expect((await holds()).every(row => row.state === 'captured')).toBe(true)
  })

  it.each([generateImageTool, generateVideoTool])('atomically limits concurrent $name tool calls', async tool => {
    await db.user.update({ where: { id: userId }, data: { credits: 10, imageCredits: 1 } })
    const results = await Promise.all(Array.from({ length: 8 }, () => tool.handler({ prompt: 'fixture' }, ctx())))
    expect(results.filter(r => !r.isError)).toHaveLength(1)
    expect(remote.media).toHaveBeenCalledTimes(1)
    expect((await holds())[0].state).toBe('captured')
  })

  it.each([generateImageTool, generateVideoTool])('releases unconfigured $name before provider dispatch', async tool => {
    vi.stubEnv('HF_IMAGE_ENDPOINT_URL', ''); vi.stubEnv('VIDEO_API_URL', '')
    vi.stubEnv('HF_VIDEO_ENDPOINT_URL', ''); vi.stubEnv('IMAGE_API_URL', '')
    expect((await tool.handler({ prompt: 'fixture' }, ctx())).isError).toBe(true)
    expect(await user()).toMatchObject({ credits: 30, imageCredits: 5 })
    expect((await holds())[0].state).toBe('released')
    expect(remote.media).not.toHaveBeenCalled()
  })

  it('disables JWT async video creation without queuing or charging', async () => {
    expect((await request('/api/media/video-jobs', { prompt: 'fixture video' })).status).toBe(503)
    expect(await db.mediaJob.count({ where: { userId } })).toBe(0)
    expect(await holds()).toHaveLength(0); expect(remote.media).not.toHaveBeenCalled()
  })
})
