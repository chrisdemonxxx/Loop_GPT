import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * Live-run recovery. The static shell talks to same-origin /api; these tests
 * stub that API so a real message streams, a mid-stream chat switch does not
 * paint the other thread, a dropped socket resumes, and a reload reattaches
 * from the stored run handle.
 */
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'stream recovery is layout-independent')
})

function sse(events: object[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return {
    status: 200,
    contentType: 'text/event-stream',
    body,
  }
}

function storedAnswer(text: string) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      messages: [{ id: 'm-assistant', role: 'assistant', content: text, createdAt: new Date().toISOString() }],
    }),
  }
}

/** Guest session, plus a handler for the one stream this test cares about. */
async function stubApi(page: Page, onRoute: (route: Route, url: string, method: string) => Promise<boolean>) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url()
    const method = route.request().method()
    if (await onRoute(route, url, method)) return
    if (url.includes('/api/auth/providers')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ guest: true }) })
      return
    }
    if (url.includes('/api/conversations') && method === 'GET' && !url.includes('/messages')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [] }) })
  })
}

test('sends a message and renders the streamed answer', async ({ page }) => {
  await stubApi(page, async (route, url, method) => {
    if (url.includes('/api/conversations') && method === 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'conv-e2e' }) })
      return true
    }
    if (url.includes('/stream')) {
      await route.fulfill(sse([
        { type: 'run', runId: 'run-e2e', seq: 0 },
        { type: 'delta', step: 0, text: 'Hello from the stream', seq: 1 },
        { type: 'final', content: 'Hello from the stream', seq: 2 },
        { type: 'done', seq: 3 },
      ]))
      return true
    }
    if (url.includes('/messages')) {
      await route.fulfill(storedAnswer('Hello from the stream'))
      return true
    }
    return false
  })

  await page.goto('/chat/')
  const box = page.locator('textarea')
  await box.waitFor()
  await box.fill('Say hello')
  await box.press('Enter')
  await expect(page.getByText('Hello from the stream').first()).toBeVisible({ timeout: 15_000 })
})

test('switching chats mid-stream does not leak the live answer', async ({ page }) => {
  let releaseStream: () => void = () => {}
  const streamHeld = new Promise<void>((resolve) => { releaseStream = resolve })
  await stubApi(page, async (route, url, method) => {
    if (url.includes('/api/conversations') && method === 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'conv-live' }) })
      return true
    }
    if (url.includes('/stream')) {
      await streamHeld
      try {
        await route.fulfill(sse([
          { type: 'run', runId: 'run-live', seq: 0 },
          { type: 'delta', step: 0, text: 'LEAKED-ANSWER', seq: 1 },
          { type: 'done', seq: 2 },
        ]))
      } catch { /* the chat switch aborts this request */ }
      return true
    }
    if (method === 'GET' && /\/api\/conversations\/?$/.test(url.split('?')[0])) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'conv-other', title: 'Other chat', updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() },
        ]),
      })
      return true
    }
    return false
  })

  await page.goto('/chat/')
  const box = page.locator('textarea')
  await box.waitFor()
  await box.fill('Start a long answer')
  await box.press('Enter')
  await expect(page.getByText('Start a long answer')).toBeVisible()
  await page.getByRole('button', { name: 'Other chat' }).click()
  releaseStream()
  await page.waitForTimeout(800)
  await expect(page.getByText('LEAKED-ANSWER')).toHaveCount(0)
  await expect(page.getByText('Start a long answer')).toHaveCount(0)
})

test('recovers the answer after the first socket drops', async ({ page }) => {
  let streamHits = 0
  await stubApi(page, async (route, url, method) => {
    if (url.includes('/api/conversations') && method === 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'conv-drop' }) })
      return true
    }
    if (url.includes('/stream')) {
      streamHits += 1
      await route.fulfill(sse([{ type: 'run', runId: 'run-drop', seq: 0 }]))
      return true
    }
    if (url.includes('/runs/')) {
      await route.fulfill(sse([
        { type: 'delta', step: 0, text: 'Back after the drop', seq: 1 },
        { type: 'final', content: 'Back after the drop', seq: 2 },
        { type: 'done', seq: 3 },
      ]))
      return true
    }
    if (url.includes('/messages')) {
      await route.fulfill(storedAnswer('Back after the drop'))
      return true
    }
    return false
  })

  await page.goto('/chat/')
  const box = page.locator('textarea')
  await box.waitFor()
  await box.fill('Please recover')
  await box.press('Enter')
  await expect(page.getByText('Back after the drop')).toBeVisible({ timeout: 20_000 })
  expect(streamHits).toBeGreaterThan(0)
})

test('reattaches to a stored run after reload', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('loop-active-run:conv-reload', JSON.stringify({ runId: 'run-reload', lastSeq: 1 }))
  })
  await stubApi(page, async (route, url) => {
    if (url.includes('/runs/run-reload/events')) {
      await route.fulfill(sse([
        { type: 'delta', step: 0, text: 'Still going after reload', seq: 2 },
        { type: 'final', content: 'Still going after reload', seq: 3 },
        { type: 'done', seq: 4 },
      ]))
      return true
    }
    if (url.includes('/messages')) {
      await route.fulfill(storedAnswer('Still going after reload'))
      return true
    }
    return false
  })

  await page.goto('/chat/?conversation=conv-reload')
  await expect(page.getByText('Still going after reload')).toBeVisible({ timeout: 15_000 })
})
