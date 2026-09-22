import { defineConfig, devices } from '@playwright/test'

/**
 * E2E + accessibility for the static Next export. The webServer builds `out/`
 * (once, cached) and serves it on :4123; the API is stubbed so the UI renders
 * without a live backend.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: 'http://127.0.0.1:4123', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: 'node ./tests/serve-out.cjs',
    url: 'http://127.0.0.1:4123',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
