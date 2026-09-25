import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test.describe('public pages', () => {
  for (const path of ['/', '/login/', '/signup/']) {
    test(`${path} renders and has no critical a11y violations`, async ({ page }) => {
      await page.goto(path)
      await page.waitForLoadState('domcontentloaded')
      const results = await new AxeBuilder({ page }).analyze()
      // Gate on `critical` only; `serious` contrast issues are tracked in the
      // design pass (GAP-003) and surfaced via the report artifact.
      const critical = results.violations.filter((v) => v.impact === 'critical')
      expect(critical, JSON.stringify(critical.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`))).toHaveLength(0)
    })
  }

  test('landing has a working sign-up CTA', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/Loop GPT/i)
    const cta = page.getByRole('link', { name: /get started|start free|sign up/i }).first()
    await expect(cta).toBeVisible()
  })

  test('login page shows email/password and social sign-in', async ({ page }) => {
    await page.goto('/login/')
    await expect(page.getByPlaceholder('Email')).toBeVisible()
    await expect(page.getByPlaceholder('Password')).toBeVisible()
    await expect(page.getByRole('button', { name: /google/i })).toBeVisible()
  })

  test('chat shell has no critical a11y violations', async ({ page }) => {
    await page.goto('/chat/')
    await page.waitForLoadState('domcontentloaded')
    // The API is stubbed in this suite, so the page may show its auth/loading
    // state; the gate is accessibility on whatever renders.
    const results = await new AxeBuilder({ page }).analyze()
    const critical = results.violations.filter((v) => v.impact === 'critical')
    expect(critical, JSON.stringify(critical.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`))).toHaveLength(0)
  })
})
