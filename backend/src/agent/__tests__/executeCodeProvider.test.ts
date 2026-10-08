import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseProvider, SandboxUnavailableError } from '../tools/executeCode'

afterEach(() => { vi.unstubAllEnvs() })

describe('execute_code sandbox selection in production', () => {
  it.each(['subprocess', 'docker'])('refuses the host-sharing %s provider', async (provider) => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SANDBOX_PROVIDER', provider)
    await expect(chooseProvider()).rejects.toBeInstanceOf(SandboxUnavailableError)
  })
  it('refuses to run when no managed sandbox is configured', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SANDBOX_PROVIDER', '')
    vi.stubEnv('E2B_API_KEY', '')
    await expect(chooseProvider()).rejects.toBeInstanceOf(SandboxUnavailableError)
  })
  it('defaults to E2B when its key is present', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SANDBOX_PROVIDER', '')
    vi.stubEnv('E2B_API_KEY', 'e2b-fixture')
    await expect(chooseProvider()).resolves.toBe('e2b')
  })
  it.each(['e2b', 'hf'])('accepts the managed %s provider', async (provider) => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SANDBOX_PROVIDER', provider)
    await expect(chooseProvider()).resolves.toBe(provider)
  })
})
