import { chromium } from 'playwright'
import AxeBuilder from '@axe-core/playwright'

const b = await chromium.launch()
const ctx = await b.newContext({ colorScheme: 'dark', viewport: { width: 1280, height: 800 } })
await ctx.addInitScript(() => { try { localStorage.setItem('loop-theme', 'dark') } catch {} })
const page = await ctx.newPage()
page.on('dialog', d => d.accept())
await page.goto('http://127.0.0.1:4123/admin/', { waitUntil: 'domcontentloaded' })
const r = await new AxeBuilder({ page }).analyze()
for (const v of r.violations.filter(v => v.impact !== null)) {
  console.log('===', v.id, v.impact)
  for (const n of v.nodes) {
    console.log('target:', n.target.join(' '))
    console.log('html  :', n.html.slice(0, 300))
    console.log('result:', JSON.stringify(n.result))
    console.log('anyId :', JSON.stringify(n.any)[0])
  }
}
await b.close()
