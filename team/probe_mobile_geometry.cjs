/** Orchestrator measurement pass 2: resolve the TRUE control row (walk up from the + button),
 *  and find the real suggestion cards. Throwaway (boss-bot). */
const PW = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/frontend/node_modules/playwright'
const { chromium, devices } = require(PW)
const URL = process.env.M_URL || 'http://127.0.0.1:4123/chat/'
const VIEWPORTS = [{ w: 390, h: 844, label: '390x844' }, { w: 360, h: 800, label: '360x800' }]

const probe = () => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) } }
  const plus = document.querySelector('button[aria-label="Add attachments and actions"]')
  let row = plus
  const chain = []
  for (let i = 0; i < 6 && row; i++) { row = row.parentElement; if (row) chain.push({ i, cls: String(row.className).slice(0, 70), children: row.children.length, rect: r(row) }) }
  // the real row = the ancestor with the most element children that looks like the flex row
  let best = null
  let n = plus
  for (let i = 0; i < 6 && n; i++) { n = n.parentElement; if (n && String(n.className).includes('flex') && n.children.length >= 5) { best = n; break } }
  const controls = best ? [...best.children].map((c) => ({ tag: c.tagName, aria: c.getAttribute('aria-label'), title: c.getAttribute('title'), text: (c.textContent || '').trim().slice(0, 24), rect: r(c) })) : []
  const send = [...document.querySelectorAll('button')].filter((b) => /^send$/i.test(b.getAttribute('aria-label') || '') || /send/i.test(b.getAttribute('title') || '')).map((b) => ({ aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), rect: r(b), parentCls: String(b.parentElement.className).slice(0, 60), sameAsBest: b.parentElement === best, insideBest: best ? best.contains(b) : null }))
  // suggestion cards: the empty-state buttons
  const texts = ['Explain quantum computing', 'plot a sine wave', 'AI research trends', 'business plan']
  const cards = texts.map((t) => {
    const el = [...document.querySelectorAll('button, a, div')].filter((e) => e.children.length <= 3 && (e.textContent || '').includes(t)).pop()
    return { t, rect: r(el), cls: el ? String(el.className).slice(0, 50) : null }
  })
  return { innerWidth: window.innerWidth, chain, rowFound: !!best, rowCls: best ? String(best.className) : null, rowRect: r(best), rowScrollW: best ? best.scrollWidth : null, controls, send, cards }
}

;(async () => {
  const browser = await chromium.launch()
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ ...devices['Pixel 5'], viewport: { width: vp.w, height: vp.h } })
    const page = await ctx.newPage()
    await page.goto(URL, { waitUntil: 'load' })
    await page.waitForTimeout(3000)
    console.log('=== ' + vp.label + ' ===')
    console.log(JSON.stringify(await page.evaluate(probe), null, 1))
    const reason = page.locator('button.chip[aria-label^="Reasoning effort"]').first()
    if (await reason.count()) {
      await reason.click({ force: true }).catch(() => {})
      await page.waitForTimeout(400)
      const ov = await page.evaluate(() => {
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) } }
        const m = r(document.querySelector('[role="menu"][aria-label="Reasoning effort"]'))
        const texts = ['Explain quantum computing', 'plot a sine wave', 'AI research trends', 'business plan']
        const cards = texts.map((t) => { const el = [...document.querySelectorAll('button, a, div')].filter((e) => e.children.length <= 3 && (e.textContent || '').includes(t)).pop(); return { t, rect: r(el) } })
        const hits = (a, b) => !!a && !!b && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom
        return { menu: m, fitsRight: m ? m.right <= window.innerWidth : null, cards, overlapsCards: cards.filter((c) => hits(m, c.rect)).map((c) => c.t) }
      })
      console.log('MENU ' + JSON.stringify(ov))
    }
    await ctx.close()
  }
  await browser.close()
})()
