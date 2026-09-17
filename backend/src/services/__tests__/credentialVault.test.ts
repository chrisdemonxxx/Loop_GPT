import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptConnectionConfig, decryptConnectionConfig } from '../credentialVault'

const config = { token: 'fixture-secret-not-a-real-token' }
beforeEach(() => vi.stubEnv('CONNECTION_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64')))
afterEach(() => vi.unstubAllEnvs())

describe('authenticated connection encryption', () => {
  it('roundtrips credentials without plaintext in the envelope', () => {
    const envelope = encryptConnectionConfig('workspace', 'connection', config)
    expect(envelope).not.toContain(config.token)
    expect(decryptConnectionConfig('workspace', 'connection', envelope)).toEqual(config)
  })
  it('uses a fresh IV even for identical input', () => {
    expect(encryptConnectionConfig('w', 'c', config)).not.toBe(encryptConnectionConfig('w', 'c', config))
  })
  it.each([['other-workspace', 'connection'], ['workspace', 'other-connection']])('rejects transplant to %s/%s', (workspace, connection) => {
    const envelope = encryptConnectionConfig('workspace', 'connection', config)
    expect(() => decryptConnectionConfig(workspace, connection, envelope)).toThrow('could not be decrypted')
  })
  it.each(['iv', 'tag', 'data'])('rejects modified %s', (field) => {
    const envelope = JSON.parse(encryptConnectionConfig('w', 'c', config))
    const bytes = Buffer.from(envelope[field], 'base64'); bytes[0] ^= 1
    envelope[field] = bytes.toString('base64')
    expect(() => decryptConnectionConfig('w', 'c', JSON.stringify(envelope))).toThrow('could not be decrypted')
  })
  it.each(['', 'not-base64', Buffer.alloc(16).toString('base64'), `${Buffer.alloc(32).toString('base64')}\n`])('fails closed for malformed key %j', (key) => {
    vi.stubEnv('CONNECTION_ENCRYPTION_KEY', key)
    expect(() => encryptConnectionConfig('w', 'c', config)).toThrow('not configured')
  })
  it('does not silently decrypt after replacing the master key', () => {
    const envelope = encryptConnectionConfig('w', 'c', config)
    vi.stubEnv('CONNECTION_ENCRYPTION_KEY', Buffer.alloc(32, 8).toString('base64'))
    expect(() => decryptConnectionConfig('w', 'c', envelope)).toThrow('could not be decrypted')
  })
  it.each(['{bad', '{}', '{"v":2}'])('rejects invalid or unknown envelopes without leaking details', (envelope) => {
    expect(() => decryptConnectionConfig('w', 'c', envelope)).toThrow('Connection credentials could not be decrypted')
  })
})
