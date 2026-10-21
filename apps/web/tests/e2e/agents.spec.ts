import { test, expect, type Locator, type Page, type Route } from '@playwright/test'

/**
 * Loop Bot computer + teach states. Auth is the same localStorage `user`
 * object getStoredUser() reads (no live login). /api/bots and /api/bot/* are
 * fulfilled in the browser. No E2B desktop is booted, and the noVNC canvas
 * is not clicked — the stream URL only has to be present for Watching /
 * Take control.
 */
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'agents computer flow is layout-independent')
})

const BOT_NAME = 'Helm'

const USER = {
  id: 'user-e2e',
  email: 'ada@example.com',
  name: 'Ada',
  role: 'owner',
  plan: 'pro',
}

const BOT = {
  id: 'bot-helm',
  name: BOT_NAME,
  label: 'Autonomous operator',
  avatarColor: '#c96442',
  persona: '',
  defaultTools: [] as string[],
  cloudComputer: true,
  isPrimary: true,
  createdAt: '2026-10-20T12:00:00.000Z',
  conversationId: null,
  preview: '',
  updatedAt: null,
  working: false,
}

/** View URL with a websocket path so the screen mounts. Nothing listens on it. */
const VIEW_URL = '/novnc/vnc.html?path=/websockify&view_only=true'
const INTERACTIVE_URL = '/novnc/vnc.html?path=/websockify&view_only=false'

const BOX = {
  alive: true,
  sandboxId: 'sbx-e2e',
  viewUrl: VIEW_URL,
  interactiveUrl: INTERACTIVE_URL,
  resumed: false,
  ageMinutes: 1,
  taskType: 'default',
  workspaceDir: '/workspace',
}

const TASK = {
  id: 'task-teach',
  kind: 'teach',
  goal: 'Watch the operator demonstrate a workflow on this computer and learn it as a reusable skill.',
  status: 'processing',
  schedule: null,
  model: null,
  priority: 0,
  attempts: 1,
  failures: 0,
  nextAttemptAt: '2026-10-20T12:00:00.000Z',
  cancelRequested: false,
  lastErrorCode: null,
  createdAt: '2026-10-20T12:00:00.000Z',
  updatedAt: '2026-10-20T12:00:00.000Z',
  runs: [{
    id: 'run-teach',
    status: 'running',
    error: null,
    startedAt: '2026-10-20T12:00:01.000Z',
    completedAt: null,
  }],
}

type SseEvent = Record<string, unknown>

/** Holds the run stream open so a skill_saved before Stop and the post-Stop event are separate reads. */
class StreamGate {
  private first = true
  private queued: SseEvent[] | null = null
  private waiters: Array<(events: SseEvent[]) => void> = []

  async handle(route: Route) {
    if (this.first) {
      this.first = false
      await route.fulfill(sse([{ type: 'skill_saved', skillId: 'too-soon', name: 'Premature', seq: 1 }]))
      return
    }
    const events = this.queued ?? await new Promise<SseEvent[]>((resolve) => { this.waiters.push(resolve) })
    await route.fulfill(sse(events))
  }

  /** Next events read (and any read already waiting) receives these frames. */
  release(events: SseEvent[]) {
    this.queued = events
    const pending = this.waiters.splice(0)
    for (const resolve of pending) resolve(events)
  }
}

function sse(events: SseEvent[]) {
  return {
    status: 200,
    contentType: 'text/event-stream',
    body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  }
}

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

async function seedSignedInUser(page: Page) {
  await page.addInitScript((user) => {
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('loopSignedIn', '1')
  }, USER)
}

async function stubAgentsApi(page: Page, gate: StreamGate | null) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()

    if (path === '/api/bots' && method === 'GET') {
      await route.fulfill(json({ bots: [BOT], groups: [] }))
      return
    }
    if (path === '/api/bot/tasks' && method === 'GET') {
      await route.fulfill(json({ tasks: [] }))
      return
    }
    if (path === '/api/bot/tasks' && method === 'POST') {
      await route.fulfill(json({
        ok: true,
        task: { id: TASK.id, kind: 'teach', status: 'queued', nextAttemptAt: TASK.nextAttemptAt },
        suggestedSkills: [],
      }))
      return
    }
    if (path.startsWith('/api/bot/tasks/') && method === 'GET') {
      await route.fulfill(json(TASK))
      return
    }
    if (path === '/api/bot/quota' && method === 'GET') {
      await route.fulfill(json({
        plan: 'pro',
        unlimited: false,
        computerAllowed: true,
        computerConfigured: true,
        cap: 100,
        used: 0,
        remaining: 100,
        resetsAt: '2026-10-21T00:00:00.000Z',
      }))
      return
    }
    if (path === '/api/bot/skills' && method === 'GET') {
      await route.fulfill(json({ skills: [] }))
      return
    }
    if (path === '/api/bot/routines' && method === 'GET') {
      await route.fulfill(json({ routines: [] }))
      return
    }
    if (path === '/api/bot/memory' && method === 'GET') {
      await route.fulfill(json({ memory: '' }))
      return
    }
    if ((path === '/api/bot/computer' && method === 'GET') || (path === '/api/bot/computer/wake' && method === 'POST')) {
      await route.fulfill(json({ ...BOX, taskType: url.searchParams.get('taskType') || 'default' }))
      return
    }
    if (path.startsWith('/api/bot/runs/') && path.endsWith('/computer') && method === 'GET') {
      await route.fulfill(json({
        active: true,
        sandboxId: BOX.sandboxId,
        viewUrl: VIEW_URL,
        interactiveUrl: INTERACTIVE_URL,
        takeoverRequested: false,
        minutes: 1,
        startedAt: TASK.createdAt,
        endedAt: null,
      }))
      return
    }
    if (path.endsWith('/takeover') && method === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}') as { takeover?: boolean }
      await route.fulfill(json({ takeoverRequested: !!body.takeover, interactiveUrl: INTERACTIVE_URL }))
      return
    }
    if (path.endsWith('/events') && method === 'GET') {
      if (gate) {
        await gate.handle(route)
        return
      }
      await route.fulfill(sse([{ type: 'done', seq: 1 }]))
      return
    }
    await route.fulfill(json({}))
  })
}

async function openComputer(page: Page) {
  await page.goto('/agents/')
  await expect(page.getByRole('button', { name: 'Computer' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('working')).toHaveCount(0)
  await page.getByRole('button', { name: 'Computer' }).click()
  await expect(page.getByText(`${BOT_NAME}'s screen`)).toBeVisible()
  const frame = page.locator('.aspect-video')
  await expect(frame).toBeVisible()
  const frameBox = await frame.boundingBox()
  const captionBox = await page.getByText(`${BOT_NAME}'s screen`).boundingBox()
  expect(frameBox).toBeTruthy()
  expect(captionBox).toBeTruthy()
  expect(frameBox!.width).toBeGreaterThan(80)
  expect(frameBox!.height).toBeGreaterThan(40)
  expect(frameBox!.width / frameBox!.height).toBeCloseTo(16 / 9, 1)
  expect(captionBox!.y).toBeGreaterThanOrEqual(frameBox!.y)
  await expect(page.getByText('Watching')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Take control' })).toBeEnabled()
}

async function enlarge(page: Page) {
  await page.getByRole('button', { name: 'Enlarge the computer view' }).click()
  const dialog = page.getByRole('dialog', { name: `${BOT_NAME}'s computer` })
  await expect(dialog.getByText('Record yourself doing a task')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Start recording' })).toBeVisible()
  return dialog
}

/** Start recording and wait until the early skill_saved has had a chance to land. */
async function startRecording(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Start recording' }).click()
  await expect(dialog.getByText(/Skill saved/)).toHaveCount(0)
  await expect(dialog.getByText('0 frames')).toBeVisible({ timeout: 15_000 })
  await expect(dialog.getByText('Premature')).toHaveCount(0)
  await expect(dialog.getByText(/Skill saved/)).toHaveCount(0)
  return dialog.getByRole('button', { name: 'Stop' }).first()
}

test.describe('Loop Bot computer and teach', () => {
  let gate: StreamGate | null = null

  test.afterEach(() => {
    gate?.release([{ type: 'done', seq: 99 }])
    gate = null
  })

  test('Computer tab shows the 16:9 screen with Watching and Take control', async ({ page }) => {
    await seedSignedInUser(page)
    await stubAgentsApi(page, null)
    await openComputer(page)
  })

  test('enlarged Start recording ignores a skill_saved that arrives before Stop', async ({ page }) => {
    gate = new StreamGate()
    await seedSignedInUser(page)
    await stubAgentsApi(page, gate)
    await openComputer(page)
    const dialog = await enlarge(page)
    await startRecording(dialog)
  })

  test('Stop with no demo shows the nothing-recorded error', async ({ page }) => {
    gate = new StreamGate()
    await seedSignedInUser(page)
    await stubAgentsApi(page, gate)
    await openComputer(page)
    const dialog = await enlarge(page)
    const stop = await startRecording(dialog)
    await stop.click()
    await expect(dialog.getByText('Saving skill…')).toBeVisible()
    gate.release([
      { type: 'error', message: 'Nothing was recorded', seq: 2 },
      { type: 'done', seq: 3 },
    ])
    await expect(dialog.getByText('Nothing was recorded')).toBeVisible({ timeout: 10_000 })
    await expect(dialog.getByText(/Skill saved/)).toHaveCount(0)
  })

  test('Stop after a real skill_saved shows the skill name', async ({ page }) => {
    gate = new StreamGate()
    await seedSignedInUser(page)
    await stubAgentsApi(page, gate)
    await openComputer(page)
    const dialog = await enlarge(page)
    const stop = await startRecording(dialog)
    await stop.click()
    await expect(dialog.getByText('Saving skill…')).toBeVisible()
    gate.release([
      { type: 'skill_saved', skillId: 'skill-login', name: 'Login', seq: 2 },
      { type: 'done', seq: 3 },
    ])
    await expect(dialog.getByText('Skill saved · Login')).toBeVisible({ timeout: 10_000 })
    await expect(dialog.getByText('Premature')).toHaveCount(0)
  })
})
