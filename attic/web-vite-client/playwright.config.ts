import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:4179', locale: 'en-US', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    { name: 'iphone-layout-chromium', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  ],
  webServer: {
    command: 'npm run preview -- --port 4179',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
    env: { WEB_DEV_API_ORIGIN: 'http://127.0.0.1:9', VITE_API_ORIGIN: '' },
  },
})
