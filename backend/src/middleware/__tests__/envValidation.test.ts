import { describe, expect, it } from 'vitest'
import { validateEnv } from '../envValidation'
import path from 'path'

const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://loop:test-password@localhost:5432/loop_test',
  JWT_SECRET: 'test-only-random-secret-with-at-least-32-characters',
  FRONTEND_URL: 'https://app.example.test, https://direct.example.test',
  PRIVATE_FILES_STORAGE_MODE: 'shared-filesystem',
  PRIVATE_FILES_DIR: path.resolve('format-only-nonexistent-private-store'),
  PRIVATE_FILES_STORE_ID: '00000000-0000-4000-8000-000000000001',
}

describe('startup environment validation', () => {
  it('allows development without external services', () => {
    expect(validateEnv({ NODE_ENV: 'development' }).NODE_ENV).toBe('development')
  })

  it('accepts an explicit HTTPS origin allowlist', () => {
    expect(validateEnv(production).FRONTEND_URL).toBe(production.FRONTEND_URL)
  })

  it.each([
    ['DATABASE_URL', ''],
    ['DATABASE_URL', 'postgresql://user:password@localhost/db'],
    ['DATABASE_URL', 'https://database.example.test/db'],
    ['JWT_SECRET', 'short'],
    ['JWT_SECRET', 'your-secret-key-change-in-production'],
    ['FRONTEND_URL', ''],
    ['FRONTEND_URL', 'http://app.example.test'],
    ['FRONTEND_URL', 'https://app.example.test/path'],
    ['FRONTEND_URL', 'https://user:secret@app.example.test'],
    ['FRONTEND_URL', 'https://app.example.test,invalid'],
    ['ENABLE_DEV_MODE', 'true'],
    ['ENABLE_DEV_MODE', 'TRUE'],
    ['PRIVATE_FILES_STORAGE_MODE', ''],
    ['PRIVATE_FILES_STORAGE_MODE', 'local'],
    ['PRIVATE_FILES_DIR', 'relative/path'],
    ['PRIVATE_FILES_DIR', ''],
    ['PRIVATE_FILES_STORE_ID', 'invalid-private-store-id'],
    ['PRIVATE_FILES_STORE_ID', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'],
    ['PRIVATE_FILES_MIN_FREE_BYTES', '-1'],
    ['PRIVATE_FILES_MIN_FREE_BYTES', '1.5'],
    ['PRIVATE_FILES_MIN_FREE_BYTES', '9007199254740992'],
  ])('rejects invalid production %s configuration (%s)', (key, value) => {
    expect(() => validateEnv({ ...production, [key]: value })).toThrow(key)
  })

  it('accepts an explicitly disabled development bypass', () => {
    expect(() => validateEnv({ ...production, ENABLE_DEV_MODE: 'false' })).not.toThrow()
  })

  it('requires production storage fields individually, without doing filesystem I/O', () => {
    expect(() => validateEnv(production)).not.toThrow()
    for (const key of ['PRIVATE_FILES_STORAGE_MODE', 'PRIVATE_FILES_DIR', 'PRIVATE_FILES_STORE_ID']) {
      expect(() => validateEnv({ ...production, [key]: undefined })).toThrow(key)
    }
    expect(() => validateEnv({ NODE_ENV: 'test', PRIVATE_FILES_STORAGE_MODE: 'shared-filesystem' })).toThrow('PRIVATE_FILES_DIR')
  })

  it('never includes rejected secrets in the error', () => {
    try {
      validateEnv({ ...production, DATABASE_URL: 'invalid-private-credential' })
      throw new Error('Expected validation to fail')
    } catch (error) {
      expect(String(error)).toContain('DATABASE_URL')
      expect(String(error)).not.toContain('invalid-private-credential')
    }
  })
})
