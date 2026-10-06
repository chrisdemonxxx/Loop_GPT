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
    {
      // P5 phone gate (audit P6): the two live phone viewports, Pixel-5-ish
      // UA, isMobile + Android 14. 390x844 is the user's phone, 360x800 the
      // small one.
      name: 'phone-390',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
      },
    },
    {
      name: 'phone-360',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 360, height: 800 },
        isMobile: true,
        hasTouch: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
      },
    },
  ],
  webServer: {
    command: 'node ./tests/serve-out.cjs',
    url: 'http://127.0.0.1:4123',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
