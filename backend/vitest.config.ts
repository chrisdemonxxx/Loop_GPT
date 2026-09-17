import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Unit tests never inherit a developer's real database connection.
    env: { NODE_ENV: 'test', DATABASE_URL: '', ADMIN_INVITE_CODE: '' },
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
    testTimeout: 20000,
  },
})
