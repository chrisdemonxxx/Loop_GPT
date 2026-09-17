import { expect, test, type Page } from '@playwright/test'

const fileId = '12345678-1234-1234-1234-123456789abc'
async function mockBackend(page: Page) {
  const calls: { path: string; auth?: string; body?: unknown }[] = []
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== 'http://127.0.0.1:4179') return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const body = request.postData() ? request.postDataJSON() : undefined
    calls.push({ path: url.pathname, auth: request.headers().authorization, body })
    switch (url.pathname) {
      case '/api/auth/login': return route.fulfill({ json: { token: 'browser-fixture-jwt', user: { name: 'Fixture user' } } })
      case '/api/workspaces': return route.fulfill({ json: { workspaces: [
        { id: 'personal', name: 'Personal', role: 'owner', personalOwnerId: 'fixture' },
        { id: 'team', name: 'Team', role: 'editor', personalOwnerId: null },
      ], nextCursor: null } })
      case '/api/agent/new/stream': return route.fulfill({ contentType: 'text/event-stream', body: [
        { type: 'status', message: 'conversation:fixture-conversation' },
        { type: 'delta', step: 0, text: 'Hello' },
        { type: 'artifact', artifact: { id: fileId, kind: 'file', name: 'answer.html', url: 'https://untrusted.invalid/never-fetch' } },
        { type: 'final', content: 'Bonjour 🌿 <script>window.compromised = true</script>' },
        { type: 'done' },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') })
      case `/api/files/${fileId}/content`: return route.fulfill({ contentType: 'text/html', body: '<h1>Download only</h1>' })
      case '/api/developer/overview': return route.fulfill({ json: { balanceUsd: 12.5, usage: { requests: 2, tokensIn: 10, tokensOut: 20, spendUsd: .1 } } })
      default: return route.abort()
    }
  })
  return calls
}
async function signIn(page: Page) {
  await page.getByLabel('Email', { exact: true }).fill('fixture@example.com')
  await page.getByLabel('Password', { exact: true }).fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveValue('personal')
}

test('login, hosted stream, inert authenticated download, developer usage, locale and logout', async ({ page }, testInfo) => {
  const calls = await mockBackend(page)
  await page.goto('/')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main')).toBeFocused()
  await signIn(page)
  await page.getByLabel('Message', { exact: true }).fill('A fixture conversation')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.assistant .message-text')).toHaveText('Bonjour 🌿 <script>window.compromised = true</script>')
  await expect(page.locator('.assistant script')).toHaveCount(0)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download: answer.html', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('answer.html')
  await page.getByText('Developer usage', { exact: true }).click()
  await page.getByRole('button', { name: 'Load developer overview' }).click()
  await expect(page.locator('dd').first()).toHaveText('$12.50')
  expect(calls.find((call) => call.path === '/api/agent/new/stream')?.body).toEqual({ content: 'A fixture conversation', workspaceId: 'personal', mode: 'chat', connectionIds: [], toolNames: [] })
  expect(calls.filter((call) => call.path !== '/api/auth/login').every((call) => call.auth === 'Bearer browser-fixture-jwt')).toBe(true)
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: { 'loop.web.locale': 'en-US' }, session: {} })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const targets = await page.locator('button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))
  expect(targets.every((height) => height >= 44)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('client.png'), fullPage: true })
  await page.getByLabel('Language and region').selectOption('fr-CA')
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr-CA')
  await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toBeVisible()
  await expect(page.locator('.message')).toHaveCount(0)
})

test('installed PWA caches only shell and reloads offline without auth or messages', async ({ page, context }) => {
  await mockBackend(page)
  await page.goto('/')
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await signIn(page)
  const cached = await page.evaluate(async () => {
    const result: string[] = []
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) result.push(new URL(request.url).pathname)
    }
    return result
  })
  expect(cached).toContain('/index.html')
  expect(cached.some((path) => path.startsWith('/assets/'))).toBe(true)
  expect(cached.every((path) => /^\/(index\.html|manifest\.webmanifest|icon\.svg|apple-touch-icon\.png|icon-(192|512)\.png|assets\/[\w.-]+\.(js|css))$/.test(path))).toBe(true)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeDisabled()
  await expect(page.getByText(/You are offline/)).toBeVisible()
  await expect(page.getByText('Fixture user', { exact: true })).toHaveCount(0)
  await expect(page.locator('.message')).toHaveCount(0)
  await context.setOffline(false)
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled()
})
