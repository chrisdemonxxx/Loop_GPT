import { chromium } from 'playwright'
import AxeBuilder from '@axe-core/playwright'

const b = await chromium.launch()
const ctx = await b.newContext({ colorScheme: 'dark', viewport: { width: 1280, height: 800 } })
await ctx.addInitScript(() => { try { localStorage.setItem('loop-theme', 'dark') } catch {} })
const page = await ctx.newPage()
page.on('dialog', d => d.accept())
await page.goto('http://127.0.0.1:4123/admin/', { waitUntil: 'domcontentloaded' })
const r = await new AxeBuilder({ page }).analyze()
for (const v of r.violations.filter(x => x.id === 'color-contrast')) {
  for (const n of v.nodes) {
    const d = (n.any.find(a => a.id === 'color-contrast') || {}).data || {}
    console.log('==', (n.target[0] || '').slice(0, 60))
    console.log('  fg:', JSON.stringify(d.fgColor), 'bg:', JSON.stringify(d.bgColor))
    console.log('  fgActual:', d.fgColor && d.fgColor.actual ? `rgb(${d.fgColor.actual.slice(1, -1)})` : '', 'bgActual:', d.bgColor && d.bgColor.actual ? `rgba(${d.bgColor.actual.slice(1, -1)})` : '')
  }
}
await b.close()
