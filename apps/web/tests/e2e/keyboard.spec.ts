import { test, expect } from '@playwright/test'

/**
 * Keyboard walkthrough (blueprint §11, mapped to OUR registry — see
 * components/ShortcutSheet.tsx and lib/useHotkey.ts). The §11 behaviors
 * that exist in this app: ⌘K palette (filter + Enter + Esc), ⌘L new
 * conversation, ⌘B sidebar, Esc innermost-popover-first, composer
 * Enter/Shift+Enter, `/` command palette in the composer.
 *
 * Keyboard behavior is layout-independent — desktop-chromium only.
 */
test.beforeEach(async ({ }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'keyboard flow is layout-independent')
})

test('⌘K opens the palette; filter + Enter runs Settings; Esc closes surfaces innermost-first', async ({ page }) => {
  await page.goto('/chat/')
  await page.waitForSelector('textarea')
  // ⌘K opens the palette
  await page.keyboard.press('Meta+k')
  const paletteInput = page.locator('input[placeholder*="command" i]')
  await expect(paletteInput).toBeVisible()
  // Typing filters; Enter runs the first match (Settings) → dialog opens
  await paletteInput.fill('settings')
  await paletteInput.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Agent settings' })).toBeVisible()
  // Esc closes the settings dialog (via the hash history)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Agent settings' })).not.toBeVisible()
  // The palette was already gone — Esc on the shell closes nothing else
  await expect(page.locator('textarea')).toBeVisible()
})

test('⌘B toggles the sidebar both ways', async ({ page }) => {
  await page.goto('/chat/')
  await page.waitForSelector('textarea')
  const aside = page.locator('aside[aria-label="Sidebar"]')
  // First ⌘B hides it
  await page.keyboard.press('Meta+b')
  await expect(aside).toBeHidden()
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible()
  // Second ⌘B brings it back
  await page.keyboard.press('Meta+b')
  await expect(aside).toBeVisible()
})

test('⌘L starts a new conversation and closes the sidebar', async ({ page }) => {
  await page.goto('/chat/')
  await page.waitForSelector('textarea')
  await page.keyboard.press('Meta+l')
  // No conversation is selected and the sidebar is closed.
  await expect(page).toHaveURL(/\/chat\/?(\?.*)?$/)
  await expect(page.locator('aside[aria-label="Sidebar"]')).toBeHidden()
  await expect(page.locator('textarea')).toBeVisible()
})

test('composer: Shift+Enter inserts a newline; Enter does not', async ({ page }) => {
  await page.goto('/chat/')
  const box = page.locator('textarea')
  await box.waitFor()
  await box.focus()
  await box.fill('first line')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('second line')
  await expect(box).toHaveValue(/first line\r?\nsecond line/)
  // Enter sends — it must not add another newline whatever the stubbed
  // backend answers (send failure or success both keep the box single-line).
  const before = await box.inputValue()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  const after = await box.inputValue()
  expect(after.split(/\r?\n/).length).toBeLessThanOrEqual(before.split(/\r?\n/).length)
})

test('Esc closes the Run settings popover without closing anything behind it', async ({ page }) => {
  await page.goto('/chat/')
  await page.waitForSelector('textarea')
  // Option A: Mode/Web/Reason merged — the one Run-settings popover.
  const settings = page.getByRole('button', { name: /Run settings/i }).first()
  await settings.click()
  const menu = page.locator('[role="menu"][aria-label="Run settings"]')
  await expect(menu).toBeVisible()
  // Esc dismisses the popover; the composer (and page) stay
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  await expect(page.locator('textarea')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Agent settings' })).toBeHidden()
})