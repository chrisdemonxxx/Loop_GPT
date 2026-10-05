import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

/** Settle after domcontentloaded: hydration swaps theme/text a beat later, and
 *  scanning the pre-hydration flash reports the wrong theme's colors
 *  (proven in the GAP-003 sweep, 2026-10-05). */
async function settle(page: import('@playwright/test').Page) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(300)
}

/** GAP-003 gate: zero `critical` AND `serious` violations (the sweep artifact
 *  is tests/axe-sweep.mjs, 11 routes × 2 themes — both went to zero 2026-10-05). */
function serious(v: { impact?: string | null }) {
  return v.impact === 'critical' || v.impact === 'serious'
}

test.describe('public pages', () => {
  for (const path of ['/', '/login/', '/signup/']) {
    test(`${path} renders and has no serious+ a11y violations`, async ({ page }) => {
      await page.goto(path)
      await page.waitForLoadState('domcontentloaded')
      await settle(page)
      const results = await new AxeBuilder({ page }).analyze()
      const blocking = results.violations.filter((v) => v.impact && serious(v))
      expect(blocking, JSON.stringify(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`))).toHaveLength(0)
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

  test('chat shell has no serious+ a11y violations', async ({ page }) => {
    await page.goto('/chat/')
    await page.waitForLoadState('domcontentloaded')
    await settle(page)
    // The API is stubbed in this suite, so the page may show its auth/loading
    // state; the gate is accessibility on whatever renders.
    const results = await new AxeBuilder({ page }).analyze()
    const blocking = results.violations.filter((v) => v.impact && serious(v))
    expect(blocking, JSON.stringify(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`))).toHaveLength(0)
  })
})

test.describe('theme switcher (§8-35)', () => {
  test('boot script applies the stored light theme before paint', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('loop-theme', 'light'))
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    // The light override layer is active: the body surface flips.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(bg).toBe('rgb(250, 250, 250)')
  })

  test('light theme has no serious+ a11y violations', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('loop-theme', 'light'))
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await settle(page)
    const results = await new AxeBuilder({ page }).analyze()
    const blocking = results.violations.filter((v) => v.impact && serious(v))
    expect(blocking, JSON.stringify(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`))).toHaveLength(0)
  })

  test('dark remains the default with no stored choice', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    const attr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    expect(attr).toBeNull()
  })

  test('system choice follows the OS preference live', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('loop-theme', 'system'))
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    // System + dark OS = dark = no attribute.
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull()
    // The OS flips to light: the provider's live listener re-applies.
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  })
})
