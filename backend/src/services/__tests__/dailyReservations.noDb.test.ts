import { EventEmitter } from 'events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const remote = vi.hoisted(() => ({ model: vi.fn(), media: vi.fn(), image: vi.fn(), artifact: vi.fn() }))
vi.mock('../../agent/llmClient', () => ({ createClient: remote.model }))
vi.mock('../providerHttp', async original => ({ ...await original<typeof import('../providerHttp')>(), providerRequest: remote.media }))
vi.mock('../imageApi', () => ({ imageApiService: { generateImage: remote.image } }))
vi.mock('../../agent/artifacts', () => ({ saveArtifact: remote.artifact }))
import { reserveDailyCredits, markDailyDispatched, finishDailyFailure } from '../dailyReservations'
import { recordUsage, checkCredits } from '../billing'
import agentRouter from '../../routes/agent'
import messagesRouter from '../../routes/messages'
import mediaRouter from '../../routes/media'
import { resolveHostedModelRequest } from '../hostedModelRequest'
import { generateImageTool } from '../../agent/tools/generateImage'
import { generateVideoTool } from '../../agent/tools/generateVideo'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('HF_IMAGE_ENDPOINT_URL', 'https://fixture.example.test/image')
  vi.stubEnv('VIDEO_API_URL', 'https://fixture.example.test/video')
  vi.stubEnv('IMAGE_API_URL', 'http://localhost:8081')
})
afterEach(() => vi.unstubAllEnvs())

it('never grants no-DB exemptions or records free unreserved usage', async () => {
  await expect(checkCredits('fixture', 'chat')).rejects.toMatchObject({ status: 503 })
  await expect(reserveDailyCredits('fixture', 'chat')).rejects.toMatchObject({ status: 503 })
  await expect(markDailyDispatched('fixture')).rejects.toMatchObject({ status: 503 })
  await expect(finishDailyFailure('fixture')).rejects.toMatchObject({ status: 503 })
  await expect(recordUsage('fixture', 'chat', { reservationId: 'fixture' })).rejects.toMatchObject({ status: 503 })
  await expect(recordUsage('fixture', 'chat')).rejects.toMatchObject({ code: 'DAILY_RESERVATION_REQUIRED' })
})

it.each([
  [agentRouter, '/completions', { messages: [{ role: 'user', content: 'hello' }], stream: false }],
  [agentRouter, '/:conversationId/stream', { content: 'hello', mode: 'chat' }],
  [messagesRouter, '/:conversationId/messages', { content: 'hello', tool: 'chat' }],
  [messagesRouter, '/:conversationId/messages', { content: 'hello', tool: 'generate-image' }],
  [mediaRouter, '/video-jobs', { prompt: 'hello' }],
] as const)('blocks daily handler %# with no database', async (router, path, body) => {
  // Invoke only the final authenticated handler; JWT middleware is exercised by
  // the real-DB HTTP suite. No DB and no dev-account fallback can dispatch here.
  const req: any = { body, params: { conversationId: 'new' }, userId: 'fixture' }
  const res: any = Object.assign(new EventEmitter(), { destroyed: false, locals: { hostedTarget: resolveHostedModelRequest(body) } })
  res.status = (status: number) => { res.statusCode = status; return res }
  res.json = (value: unknown) => { res.body = value; return res }
  const route = (router as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods.post).route
  await route.stack.at(-1).handle(req, res)
  expect(res.statusCode).toBe(503)
  expect(remote.model).not.toHaveBeenCalled(); expect(remote.media).not.toHaveBeenCalled()
  expect(remote.image).not.toHaveBeenCalled(); expect(remote.artifact).not.toHaveBeenCalled()
  expect(res.listenerCount('close')).toBe(0)
})

it.each([generateImageTool, generateVideoTool])('blocks $name with no database even for missing identity', async tool => {
  for (const userId of ['fixture', '']) {
    expect((await tool.handler({ prompt: 'fixture' }, { userId, conversationId: '', scratch: {}, emit: vi.fn() })).isError).toBe(true)
  }
  expect(remote.media).not.toHaveBeenCalled(); expect(remote.image).not.toHaveBeenCalled()
})
