import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const remote = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../providerHttp', () => ({ providerRequest: remote.request }))
// Route-handler tests isolate authentication infrastructure; the router's
// existing admin middleware is retained and checked below.
vi.mock('../../routes/auth', () => ({ authenticateToken: vi.fn(), requireAdmin: vi.fn() }))
import router from '../../routes/settings'
import { authenticateToken, requireAdmin } from '../../routes/auth'
import { aiProviderService, type AIProvider } from '../aiProviders'

const providers: AIProvider[] = ['openai', 'anthropic', 'groq', 'together', 'ollama', 'local', 'xai', 'perplexity', 'nvidia', 'huggingface']
async function invoke(path: string, method: string, overrides: Record<string, unknown> = {}) {
  const route = (router as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route
  const req = { body: {}, query: {}, params: {}, ...overrides }
  const res: any = { statusCode: 200, headers: {}, body: undefined }
  res.status = (code: number) => { res.statusCode = code; return res }
  res.json = (body: unknown) => { res.body = body; return res }
  res.setHeader = (key: string, value: string) => { res.headers[key] = value }
  await route.stack.at(-1).handle(req, res)
  return res
}
beforeEach(() => {
  remote.request.mockReset().mockImplementation(async (url: string) => ({ json: async () =>
    url.includes('together') ? [{ name: 'chat-fixture', type: 'chat' }] : { data: [{ id: 'gpt-4-llama-grok-chat' }] },
  }))
  for (const provider of providers) aiProviderService.setProviderConfig(provider, { name: provider })
  for (const name of ['OPENAI', 'GROQ', 'TOGETHER', 'XAI', 'PERPLEXITY', 'NVIDIA', 'ANTHROPIC']) {
    vi.stubEnv(`${name}_API_KEY`, `fixture-${name}`)
  }
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('admin provider discovery', () => {
  it('keeps authentication and admin gates on all routes', () => {
    expect((router as any).stack.slice(0, 2).map((layer: any) => layer.handle)).toEqual([authenticateToken, requireAdmin])
  })

  it.each(['apiKey', 'api_key', 'baseUrl', 'baseURL', 'base_url'])('rejects GET %s before any discovery', async field => {
    for (const value of ['', 'fixture-secret', ['fixture-secret'], { nested: 'fixture-secret' }]) {
      const res = await invoke('/providers', 'get', { query: { [field]: value } })
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'Invalid discovery request.' })
    }
    expect(remote.request).not.toHaveBeenCalled()
  })

  it('GET uses separate fixed cloud origins and their own keys', async () => {
    const res = await invoke('/providers', 'get')
    expect(res.statusCode).toBe(200)
    expect(res.body).toHaveLength(9)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(remote.request.mock.calls.map(([url, options]) => [url, options.headers.Authorization])).toEqual([
      ['https://api.openai.com/v1/models', 'Bearer fixture-OPENAI'],
      ['https://api.groq.com/openai/v1/models', 'Bearer fixture-GROQ'],
      ['https://api.together.xyz/v1/models', 'Bearer fixture-TOGETHER'],
      ['https://api.x.ai/v1/models', 'Bearer fixture-XAI'],
      ['https://api.perplexity.ai/models', 'Bearer fixture-PERPLEXITY'],
      ['https://integrate.api.nvidia.com/v1/models', 'Bearer fixture-NVIDIA'],
    ])
    expect(JSON.stringify(res.body)).not.toContain('Bearer')
  })

  it('POST scopes the supplied key to exactly the named provider', async () => {
    const res = await invoke('/providers/:providerId/models', 'post', {
      params: { providerId: 'nvidia' }, body: { apiKey: 'fixture-private-nvidia' },
    })
    expect(res.statusCode).toBe(200)
    expect(remote.request).toHaveBeenCalledTimes(1)
    expect(remote.request).toHaveBeenCalledWith('https://integrate.api.nvidia.com/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer fixture-private-nvidia' }, allowedOrigins: ['https://integrate.api.nvidia.com'],
    }))
    expect(JSON.stringify(res.body)).not.toContain('fixture-private-nvidia')
  })

  it.each([
    { apiKey: ['fixture-secret'] }, { apiKey: 'fixture-secret\r\nInjected: value' },
    { apiKey: 'fixture-secret', baseUrl: 'https://custom.example.test' }, { apiKey: null },
  ])('rejects invalid provider-specific discovery input', async body => {
    const res = await invoke('/providers/:providerId/models', 'post', { params: { providerId: 'nvidia' }, body })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'Invalid discovery request.' })
    expect(remote.request).not.toHaveBeenCalled()
  })

  it('rejects unknown providers and query overrides on POST', async () => {
    for (const params of [{ providerId: 'constructor' }, { providerId: 'fixture-secret' }]) {
      expect((await invoke('/providers/:providerId/models', 'post', { params })).statusCode).toBe(400)
    }
    expect((await invoke('/providers/:providerId/models', 'post', {
      params: { providerId: 'openai' }, query: { apiKey: 'fixture-secret' },
    })).statusCode).toBe(400)
    expect(remote.request).not.toHaveBeenCalled()
  })

  it('configuration refresh cannot send fallback credentials to a custom NVIDIA URL', async () => {
    const res = await invoke('/provider', 'post', { body: {
      provider: 'nvidia', apiKey: 'fixture-secret', baseUrl: 'https://custom.example.test/v1',
    } })
    expect(res.statusCode).toBe(200)
    expect(remote.request).not.toHaveBeenCalled()
    const config = await invoke('/provider/:providerId', 'get', { params: { providerId: 'nvidia' } })
    expect(config.body.apiKey).toBe('***')
    expect(JSON.stringify(config.body)).not.toContain('fixture-secret')
  })

  it('does not reflect provider exceptions through discovery', async () => {
    remote.request.mockRejectedValue(new Error('fixture-secret provider error body'))
    const res = await invoke('/providers/:providerId/models', 'post', { params: { providerId: 'openai' } })
    expect(res.statusCode).toBe(200)
    expect(res.body.models).toContain('gpt-4o')
    expect(JSON.stringify(res.body)).not.toContain('fixture-secret')
  })

  it('uses a generic route error even if discovery itself fails unexpectedly', async () => {
    vi.spyOn(aiProviderService, 'getAvailableModels').mockRejectedValueOnce(new Error('fixture-secret unexpected'))
    const res = await invoke('/providers/:providerId/models', 'post', { params: { providerId: 'openai' } })
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'Failed to fetch models.' })
  })
})
