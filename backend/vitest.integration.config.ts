import { defineConfig } from 'vitest/config'

// Never inherit DATABASE_URL or load .env for integration tests. Only a dedicated
// local database with this exact name is accepted by this harness.
const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a local loop_foundation_test PostgreSQL database')
const url = new URL(databaseUrl)
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/loop_foundation_test' ||
    [...url.searchParams.keys()].some((key) => key !== 'schema') ||
    (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')) {
  throw new Error('Integration tests require a local loop_foundation_test database with the public schema')
}

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test', DATABASE_URL: databaseUrl, ADMIN_INVITE_CODE: '',
      JWT_SECRET: 'integration-test-only-identity-secret-32-characters', ENABLE_DEV_MODE: 'false' },
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
})
