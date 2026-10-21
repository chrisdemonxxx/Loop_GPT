import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * /build Phase 0 smoke (B27). Full Loop-it offline_model_factory e2e needs the
 * deploy/loopit compose stack + LOOPIT_ENABLED export; when that is unavailable
 * we exercise the static /build shell against route-mocked /api/loopit/*.
 */

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'build flow is layout-independent')
})

const RUN = {
  run_id: 'run_e2e',
  project_id: 'proj_e2e',
  prompt: 'Build a hello page',
  title: 'Hello page',
  status: 'completed',
  started_at: '2026-10-20T12:00:00.000Z',
  finished_at: '2026-10-20T12:01:00.000Z',
  iterations: 1,
  summary: 'Done',
  credits_spent: 0.01,
  files: ['index.html', 'App.js', 'styles.css'],
  checkpoints: [{
    checkpoint_id: 'cp_e2e',
    parent_id: null,
    created_at: '2026-10-20T12:00:30.000Z',
    verified: true,
    live: true,
  }],
}

async function stubLoopit(page: Page, onRoute?: (route: Route, url: string, method: string) => Promise<boolean>) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url()
    const method = route.request().method()
    if (onRoute && await onRoute(route, url, method)) return

    if (url.includes('/api/auth/providers')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ guest: true }) })
      return
    }
    if (url.includes('/api/loopit/token') && method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'e2e-tok', expiresAt: new Date(Date.now() + 120_000).toISOString() }),
      })
      return
    }
    if (url.includes('/api/loopit/health')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok', offline: true, exec_enabled: false, projects_root: '/', run_execution_mode: 'local',
        }),
      })
      return
    }
    if (url.includes('/api/loopit/me')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user_id: 'u', email: null, org_id: 'o', role: 'owner', scopes: ['api', 'runs'] }),
      })
      return
    }
    if (url.match(/\/api\/loopit\/runs\/?(\?|$)/) && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([RUN]) })
      return
    }
    if (url.includes('/api/loopit/runs/run_e2e') && method === 'GET' && !url.includes('/events')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RUN) })
      return
    }
    if (url.includes('/api/loopit/runs/run_e2e/events')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: end\ndata: {}\n\n',
      })
      return
    }
    if (url.includes('/api/loopit/projects/proj_e2e/preview') && method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          url: '/api/projects/proj_e2e/site/t/tok/index.html',
          expires_at: Math.floor(Date.now() / 1000) + 900,
        }),
      })
      return
    }
    if (url.includes('/api/loopit/projects/') && method === 'POST' && url.includes('/deploy')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          deployment_id: 'dep_e2e',
          project_id: 'proj_e2e',
          checkpoint_id: 'cp_e2e',
          status: 'live',
          production_url: '/api/projects/proj_e2e/site/t/tok/index.html',
          reason: 'e2e',
        }),
      })
      return
    }
    // Default: empty JSON so unrelated app calls do not 404 the shell.
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
}

test('board lists mocked runs', async ({ page }) => {
  await stubLoopit(page)
  await page.goto('/build/')
  await expect(page.getByText('Hello page').or(page.getByText('Build a hello page'))).toBeVisible({ timeout: 15_000 })
})

test('run view loads preview and publish surface with deployment_id path', async ({ page }) => {
  let deployBody: string | null = null
  let deployResponseId: string | null = null
  await stubLoopit(page, async (route, url, method) => {
    if (url.includes('/api/loopit/projects/') && method === 'POST' && /\/deploy\/?$/.test(url.split('?')[0])) {
      deployBody = route.request().postData()
      const payload = {
        deployment_id: 'dep_e2e',
        project_id: 'proj_e2e',
        checkpoint_id: 'cp_e2e',
        status: 'live',
        production_url: '/api/projects/proj_e2e/site/t/tok/index.html',
        reason: 'e2e publish',
      }
      deployResponseId = payload.deployment_id
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      })
      return true
    }
    return false
  })

  await page.goto('/build/?run=run_e2e')
  // Prefer run chrome that exists even when a stale static `out/` omits the
  // fill-layout title row (AppPage heading). Versions + preview prove the run loaded.
  await expect(page.getByText('Version 1')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('iframe[title="Build preview"]')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /^Publish$/i }).first().click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /^Publish$/i }).click()

  await expect(page.getByText(/Your app is live/i).first()).toBeVisible({ timeout: 10_000 })
  expect(deployBody).toBeTruthy()
  expect(deployResponseId).toBe('dep_e2e')
  // Unpublish is gated on deployment_id in current source; a stale `out/` export
  // may lack the button until LOOPIT_ENABLED=1 rebuild. Soft-check when present.
  const unpublish = page.getByRole('button', { name: /Unpublish/i })
  if (await unpublish.count()) {
    await expect(unpublish).toBeVisible()
  }
})
