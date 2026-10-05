import { chromium } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import fs from 'fs'

const BASE = 'http://127.0.0.1:4123'
const ROUTES = ['/', '/login/', '/signup/', '/chat/', '/account/', '/admin/', '/onboarding/', '/share/', '/verify/', '/forgot/', '/reset/',
  // S2 settings overlays: the chat page's hash listener opens the dialog on
  // these deep links, so the new panels get scanned like any route.
  '/chat/#settings/general', '/chat/#settings/account', '/chat/#settings/privacy/uploaded-files',
  '/chat/#settings/billing', '/chat/#settings/time', '/chat/#settings/code', '/chat/#settings/reflect']

const out = fs.openSync('axe-results.json', 'w')
const w = o => fs.writeSync(out, JSON.stringify(o) + '\n')

const pickN = n => ({
  target: n.target,
  html: n.html,
  any: n.any,
  all: n.all,
  none: n.none,
  impact: n.impact,
  impactValue: n.impactValue,
  failureSummary: n.failureSummary,
})

const browser = await chromium.launch()

for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({
    colorScheme: theme,
    viewport: { width: 1280, height: 800 },
  })
  await ctx.addInitScript(t => {
    try { localStorage.setItem('loop-theme', t) } catch {}
  }, theme)

  for (const route of ROUTES) {
    const page = await ctx.newPage()
    page.on('dialog', d => d.accept())
    page.on('pageerror', () => {})
    page.on('console', () => {})

    const t0 = Date.now()
    let status = 0
    let gotoErr = null
    try {
      const resp = await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 15000 })
      status = resp ? resp.status() : 0
    } catch (e) {
      gotoErr = e.message
    }

    // Settle before scanning: hydration swaps the theme attribute and node
    // text a beat after domcontentloaded — scanning earlier reports the
    // pre-hydration flash (GAP-003 2026-10-05: light runs showed dark-theme
    // colors on a few nodes while every settled node read light).
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve())).catch(() => {})
    await page.waitForTimeout(500)

    let axeErr = null
    let r
    try {
      r = await new AxeBuilder({ page }).analyze()
    } catch (e) {
      axeErr = e.message
    }

    const vs = (r ? r.violations : []).filter(v => v.impact !== null)
    const rec = {
      event: 'route',
      route,
      theme,
      status,
      ms: Date.now() - t0,
      counts: {
        critical: vs.filter(v => v.impact === 'critical').length,
        serious: vs.filter(v => v.impact === 'serious').length,
        moderate: vs.filter(v => v.impact === 'moderate').length,
        minor: vs.filter(v => v.impact === 'minor').length,
      },
      nodes: vs.flatMap(v => v.nodes.map(n => ({ id: [0] && { id: undefined }[0], id: [0] && { id: undefined }[0], ...pickN(n) }))),
      gotoErr,
      axeErr,
    }
    w(rec)
    await page.close()
  }
  await ctx.close()
}

await browser.close()
fs.closeSync(out)
