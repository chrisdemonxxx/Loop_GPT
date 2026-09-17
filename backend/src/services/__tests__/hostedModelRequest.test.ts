import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelSelectionError, resolveHostedModelRequest } from '../hostedModelRequest'

beforeEach(() => {
  vi.stubEnv('HF_ENDPOINT_URL', 'https://standard.example.test')
  vi.stubEnv('HF_MODEL', 'operator-standard')
  vi.stubEnv('HF_LARGE_ENDPOINT_URL', 'https://large.example.test/v1')
  vi.stubEnv('HF_LARGE_MODEL', 'operator-large')
  vi.stubEnv('DEFAULT_PROVIDER', 'local')
  vi.stubEnv('DEFAULT_MODEL', 'http://127.0.0.1:1234')
})
afterEach(() => vi.unstubAllEnvs())

describe('hosted HTTP model selection', () => {
  it('defaults only to the operator-configured standard model', () => {
    expect(resolveHostedModelRequest({ content: 'hello' })).toEqual({ provider: 'huggingface',
      model: 'operator-standard', baseUrl: 'https://standard.example.test/v1', apiKey: undefined })
  })
  it('maps public aliases to operator targets, never forwards raw client model strings', () => {
    expect(resolveHostedModelRequest({ provider: 'huggingface', model: ' loop-chat-large ' })).toMatchObject({ model: 'operator-large', baseUrl: 'https://large.example.test/v1' })
    expect(resolveHostedModelRequest({ model: 'http://169.254.169.254/latest/meta-data' })).toMatchObject({ model: 'operator-standard', baseUrl: 'https://standard.example.test/v1' })
  })
  it.each(['openai', 'local', 'ollama', 'nvidia', '__proto__'])('rejects %s provider selection', (provider) => {
    expect(() => resolveHostedModelRequest({ provider })).toThrow(ModelSelectionError)
  })
  it.each(['apiKey', 'api_key', 'baseUrl', 'baseURL', 'base_url', 'models', 'selectionMode'])('rejects presence of %s even if empty/null', (field) => {
    for (const value of [null, '', [], { apiKey: 'secret', baseUrl: 'http://127.0.0.1' }]) {
      expect(() => resolveHostedModelRequest({ [field]: value })).toThrow(ModelSelectionError)
    }
  })
  it('rejects malformed model/body values without reflecting them in errors', () => {
    for (const body of [null, [], 'secret', { model: {} }, { model: null }, { model: '' }, { model: 'a'.repeat(201) }]) {
      expect(() => resolveHostedModelRequest(body)).toThrow(ModelSelectionError)
    }
    try { resolveHostedModelRequest({ apiKey: 'fixture-private-token' }) }
    catch (error) { expect(String(error)).not.toContain('fixture-private-token') }
  })
})
