import { EventEmitter } from 'events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const upstream = vi.hoisted(() => ({ client: vi.fn(), request: vi.fn() }))
vi.mock('../../agent/llmClient', () => ({ createClient: upstream.client }))
vi.mock('../providerHttp', () => ({ providerRequest: upstream.request }))
vi.mock('../../agent/artifacts', () => ({ saveArtifact: vi.fn() }))
vi.mock('../aiProviders', () => ({ getHFModel: () => 'fixture-chat' }))
vi.mock('../chatModels', () => ({ chatModelCatalog: () => [], resolveChatTarget: () => ({ model: 'fixture', tier: 'standard', contextTokens: 32_768 }) }))
import router from '../../routes/v1'

beforeEach(() => {
  vi.stubEnv('HF_IMAGE_ENDPOINT_URL', 'https://fixture.example.test/image')
  vi.stubEnv('HF_MAX_TOKENS', '4096')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it.each(['/chat/completions', '/embeddings', '/images/generations'])('fails closed without a database at %s', async path => {
  const req: any = Object.assign(new EventEmitter(), {
    body: { messages: [{ role: 'user', content: 'hello' }], input: 'hello', prompt: 'hello' },
    api: { userId: 'fixture', apiKeyId: 'fixture', plan: null }, aborted: false,
  })
  const res: any = Object.assign(new EventEmitter(), { destroyed: false })
  res.status = (code: number) => { res.statusCode = code; return res }
  res.json = (body: unknown) => { res.body = body; return res }
  res.setHeader = vi.fn()
  const route = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post).route
  await route.stack.at(-1).handle(req, res)
  expect(res.statusCode).toBe(503)
  expect(upstream.client).not.toHaveBeenCalled()
  expect(upstream.request).not.toHaveBeenCalled()
  expect(req.listenerCount('aborted')).toBe(0)
  expect(res.listenerCount('close')).toBe(0)
})
