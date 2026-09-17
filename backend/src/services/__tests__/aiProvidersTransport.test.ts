import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const remote = vi.hoisted(() => ({ request: vi.fn(), client: vi.fn(), complete: vi.fn() }))
vi.mock('../providerHttp', () => ({ providerRequest: remote.request }))
vi.mock('../../agent/llmClient', () => ({ createClient: remote.client }))
import { AIProviderService, type AIProvider, getHFBaseUrl, getHFModel } from '../aiProviders'

let service: AIProviderService
const messages = [{ role: 'user', content: 'fixture question' }]
const json = (data: unknown) => ({ json: async () => data })
beforeEach(() => {
  service = new AIProviderService()
  remote.request.mockReset()
  remote.complete.mockReset().mockResolvedValue({ choices: [{ message: { content: 'fixture answer' } }] })
  remote.client.mockReset().mockReturnValue({ chat: { completions: { create: remote.complete } } })
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('provider discovery transport and credential segregation', () => {
  it.each([
    ['openai', 'https://api.openai.com/v1/models', 'gpt-4o', { data: [{ id: 'gpt-4o' }] }],
    ['groq', 'https://api.groq.com/openai/v1/models', 'llama-fixture', { data: [{ id: 'llama-fixture' }] }],
    ['together', 'https://api.together.xyz/v1/models', 'chat-fixture', [{ name: 'chat-fixture', type: 'chat' }]],
    ['xai', 'https://api.x.ai/v1/models', 'grok-fixture', { data: [{ id: 'grok-fixture' }] }],
    ['perplexity', 'https://api.perplexity.ai/models', 'sonar-fixture', { data: [{ id: 'sonar-fixture' }] }],
    ['nvidia', 'https://integrate.api.nvidia.com/v1/models', 'chat-fixture', { data: [{ id: 'chat-fixture' }] }],
  ])('uses a fixed bounded origin for %s', async (provider, url, model, payload) => {
    remote.request.mockResolvedValue(json(payload))
    expect(await service.getAvailableModels(provider as AIProvider, 'fixture-key')).toEqual([model])
    expect(remote.request).toHaveBeenCalledTimes(1)
    expect(remote.request).toHaveBeenCalledWith(url, {
      method: 'GET', headers: { Authorization: 'Bearer fixture-key' },
      allowedOrigins: [new URL(url as string).origin], timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024,
    })
  })

  it('keeps concurrent and successive credentials separate without a provider cache', async () => {
    remote.request.mockImplementation(async (_url, options) => {
      await Promise.resolve()
      return json({ data: [{ id: `gpt-4-${options.headers.Authorization}` }] })
    })
    const [a, b] = await Promise.all([
      service.getAvailableModels('openai', 'fixture-a'), service.getAvailableModels('openai', 'fixture-b'),
    ])
    expect(a).toEqual(['gpt-4-Bearer fixture-a'])
    expect(b).toEqual(['gpt-4-Bearer fixture-b'])
    service.setProviderConfig('openai', { name: 'openai', apiKey: 'fixture-config' })
    expect(await service.getAvailableModels('openai')).toEqual(['gpt-4-Bearer fixture-config'])
    service.clearModelCache('openai'); service.clearModelCache()
    expect(remote.request).toHaveBeenCalledTimes(3)
  })

  it('uses only the matching provider fallback and honors an explicit empty key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture-openai')
    vi.stubEnv('GROQ_API_KEY', 'fixture-groq')
    remote.request.mockResolvedValue(json({ data: [] }))
    await service.getAvailableModels('openai')
    await service.getAvailableModels('groq')
    await service.getAvailableModels('openai', '')
    expect(remote.request.mock.calls.map(call => call[1].headers)).toEqual([
      { Authorization: 'Bearer fixture-openai' }, { Authorization: 'Bearer fixture-groq' }, {},
    ])
  })

  it.each([
    'https://custom.example.test/v1', 'http://127.0.0.1/v1',
    'https://integrate.api.nvidia.com.evil.test/v1',
    'https://integrate.api.nvidia.com/v1?token=fixture',
    'https://fixture@integrate.api.nvidia.com/v1',
  ])('never sends a server, request or configured NVIDIA key to %s', async base => {
    vi.stubEnv('NVIDIA_API_KEY', 'fixture-server-secret')
    expect(await service.getAvailableModels('nvidia', undefined, base)).toContain('meta/llama-3.1-8b-instruct')
    await service.getAvailableModels('nvidia', 'fixture-request-secret', base)
    service.setProviderConfig('nvidia', { name: 'nvidia', apiKey: 'fixture-config-secret', baseUrl: base })
    await service.getAvailableModels('nvidia')
    expect(remote.request).not.toHaveBeenCalled()
  })

  it.each(['local', 'ollama', 'huggingface', 'anthropic'] as AIProvider[])('%s discovery stays static', async provider => {
    expect((await service.getAvailableModels(provider)).length).toBeGreaterThan(0)
    await service.getAvailableModels(provider, 'fixture-key', 'http://localhost:1234')
    expect(remote.request).not.toHaveBeenCalled()
  })

  it('returns static fallback without reflecting or logging transport/parse exceptions', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    remote.request.mockRejectedValueOnce(new Error('fixture-secret upstream response'))
    expect(await service.getAvailableModels('openai')).toContain('gpt-4o')
    remote.request.mockResolvedValueOnce({ json: async () => { throw new Error('fixture-secret parse') } })
    expect(JSON.stringify(await service.getAvailableModels('openai'))).not.toContain('fixture-secret')
    expect(log).not.toHaveBeenCalled()
  })
})

describe('legacy chat dispatch', () => {
  it.each(['openai', 'groq', 'together', 'xai', 'perplexity', 'nvidia', 'huggingface'] as AIProvider[])(
    'routes %s through the guarded client', async provider => {
      expect(await service.getChatCompletion(provider, messages, 'fixture-model', 'fixture-key')).toBe('fixture answer')
      expect(remote.client).toHaveBeenCalledWith(provider, 'fixture-key', provider === 'nvidia' ? 'https://integrate.api.nvidia.com/v1' : undefined)
      expect(remote.complete).toHaveBeenCalledTimes(1)
      expect(remote.request).not.toHaveBeenCalled()
    },
  )

  it('passes HF configuration to guarded resolution and retains helper APIs', async () => {
    vi.stubEnv('HF_ENDPOINT_URL', 'https://operator.example.test/')
    vi.stubEnv('HF_MODEL', 'fixture-hf')
    expect(getHFBaseUrl()).toBe('https://operator.example.test/v1')
    expect(getHFBaseUrl('https://operator.example.test/v1/')).toBe('https://operator.example.test/v1')
    expect(getHFModel()).toBe('fixture-hf')
    await service.getHFEndpointChatCompletion(messages, undefined, undefined, 'https://operator.example.test')
    expect(remote.client).toHaveBeenCalledWith('huggingface', undefined, 'https://operator.example.test')
    expect(remote.complete.mock.calls[0][0].model).toBe('fixture-hf')
  })

  it.each(['local', 'ollama'] as AIProvider[])('explicitly retires %s chat', async provider => {
    await expect(service.getChatCompletion(provider, messages)).rejects.toThrow('Local provider chat is disabled.')
    expect(remote.client).not.toHaveBeenCalled(); expect(remote.request).not.toHaveBeenCalled()
  })

  it('sends Anthropic credentials only to its fixed bounded native endpoint', async () => {
    remote.request.mockResolvedValue(json({ content: [{ text: 'native answer' }] }))
    expect(await service.getAnthropicChatCompletion(messages, 'fixture-model', 'fixture-anthropic')).toBe('native answer')
    expect(remote.request).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.objectContaining({
      method: 'POST', allowedOrigins: ['https://api.anthropic.com'], timeoutMs: 120_000,
      maxBytes: 8 * 1024 * 1024,
      headers: { 'x-api-key': 'fixture-anthropic', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    }))
  })

  it.each(['constructor', 'completion', 'anthropic'])('sanitizes %s failures without retrying raw exceptions', async stage => {
    const secret = new Error('fixture-secret provider body')
    if (stage === 'constructor') remote.client.mockImplementationOnce(() => { throw secret })
    if (stage === 'completion') remote.complete.mockRejectedValueOnce(secret)
    if (stage === 'anthropic') remote.request.mockRejectedValueOnce(secret)
    await expect(service.getChatCompletion(stage === 'anthropic' ? 'anthropic' : 'huggingface', messages))
      .rejects.toThrow(/^Upstream model request failed\.$/)
    expect(remote.complete.mock.calls.length).toBeLessThanOrEqual(1)
    expect(remote.request.mock.calls.length).toBeLessThanOrEqual(1)
  })
})
