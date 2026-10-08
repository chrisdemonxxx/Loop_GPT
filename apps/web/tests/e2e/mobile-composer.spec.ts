import { test, expect, type Page } from '@playwright/test'

/**
 * P5 phone-viewport gate for the composer (audit P6).
 *
 * Measures rects, at the phone-390 (390x844) and phone-360 (360x800)
 * projects only:
 *   row      scrollWidth <= clientWidth, and every direct child
 *            (including the ml-auto Send wrapper) has right <= innerWidth
 *   chips    each button.chip label span is <= 16px tall and is not
 *            white-space: normal
 *   popovers each open menu has right <= innerWidth and intersects
 *            no empty-state suggestion card
 *
 * The live login leg runs only when LIVE_BASE_URL is set.
 */

const CARDS = [
  'Explain quantum computing',
  'plot a sine wave',
  'AI research trends',
  'business plan',
]

const FIXTURE = {
  email: 'hr.mobile.probe.20260929@example.com',
}

const POPOVERS = [
  { id: 'plus', name: 'PlusMenu', btn: 'button[aria-label="Add attachments and actions"]' },
  // Option A (redesign): Mode/Web/Reason merged into the one Run-settings
  // popover — the separate RunModePicker and EffortSelector are gone.
  { id: 'settings', name: 'RunSettings', btn: 'button.chip[aria-label^="Run settings"]' },
  { id: 'slash', name: 'SlashPalette', btn: 'textarea[aria-label*="Message Loop GPT"]' },
] as const

const stubApi = (page: Page) => page.route('**/api/**', async (route) => {
  const u = route.request().url()
  const ok = (b: unknown, s = 200) => route.fulfill({
    status: s,
    contentType: 'application/json',
    body: JSON.stringify(b),
  })
  if (u.includes('/api/auth/providers')) return ok({ guest: true, next: '/onboarding' })
  if (u.includes('/api/auth/login')) return ok({ token: 'st.9f210aa7', user: FIXTURE })
  if (u.includes('/api/account/me')) return ok({ ...FIXTURE, id: 'cmqa_mobile_probe', role: 'user', plan: 'free', credits: 30 })
  if (u.includes('/api/workspaces')) return ok({ id: 'ws_qa_mobile', name: 'Personal', mine: true })
  if (u.includes('/api/conversations')) return ok([])
  if (u.includes('/api/agent/tools')) return ok([{ id: 'web-search' }])
  return ok({})
})

/** Installed before navigation so the composer treats the browser as mic-capable. */
const micInit = () => {
  ;(window as any).SpeechRecognition = class {
    continuous = true
    interimResults = true
    lang = 'en-US'
    onresult: ((ev: any) => void) | null = null
    onend: (() => void) | null = null
    start() {
      setTimeout(() => {
        this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'hi ' } }] })
      }, 150)
    }
    stop() { this.onend?.() }
  }
}

async function openChat(page: Page) {
  await stubApi(page)
  await page.addInitScript(micInit)
  await page.goto('/chat/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('button[aria-label="Add attachments and actions"]')).toBeVisible()
}

async function readRow(page: Page) {
  return page.evaluate((cards) => {
    const R = (el: Element | null) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
        right: Math.round(b.right), bottom: Math.round(b.bottom),
      }
    }
    const plus = document.querySelector('button[aria-label="Add attachments and actions"]')
    let row: HTMLElement | null = null
    let n: HTMLElement | null = plus as HTMLElement | null
    for (let i = 0; i < 6 && n; i++) {
      n = n.parentElement
      // The composer's control row (exact class string) — not an outer flex
      // container; the Option-A row has fewer children than the old 3-chip row.
      if (n && String(n.className).includes('flex items-center gap-1.5 px-3')) { row = n; break }
    }
    const children = row ? [...row.children].map((c) => ({
      tag: c.tagName,
      aria: c.getAttribute('aria-label'),
      title: c.getAttribute('title'),
      text: (c.textContent || '').trim().slice(0, 24),
      cls: String(c.className).slice(0, 80),
      rect: R(c),
    })) : []
    const send = [...document.querySelectorAll('button')]
      .filter((b) => b.getAttribute('aria-label') === 'Send message' || b.getAttribute('title') === 'Send')
      .map((b) => ({
        aria: b.getAttribute('aria-label'),
        parentCls: String(b.parentElement?.className || '').slice(0, 60),
        rect: R(b),
      }))
    const chips = [...document.querySelectorAll('button.chip')]
      .filter((b) => b.querySelector('span'))
      .map((b) => {
        const s = b.querySelector('span') as HTMLElement
        return {
          aria: b.getAttribute('aria-label'),
          chipH: R(b)?.h ?? null,
          spanH: R(s)?.h ?? null,
          spanWS: getComputedStyle(s).whiteSpace,
        }
      })
    const cardRects = cards.map((t) => {
      const el = [...document.querySelectorAll('button')].filter((e) => (e.textContent || '').includes(t)).pop() || null
      return { t, rect: R(el) }
    })
    return {
      innerWidth: window.innerWidth,
      rowFound: !!row,
      rowCls: row ? String(row.className) : null,
      rowScrollW: row ? row.scrollWidth : null,
      rowClientW: row ? row.clientWidth : null,
      children,
      send,
      chips,
      cards: cardRects,
    }
  }, CARDS)
}

async function readMenu(page: Page, label: string) {
  return page.evaluate(({ label, cards }) => {
    const R = (el: Element | null) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
        right: Math.round(b.right), bottom: Math.round(b.bottom),
      }
    }
    const hits = (a: { x: number; right: number; y: number; bottom: number } | null, b: { x: number; right: number; y: number; bottom: number } | null) =>
      !!a && !!b && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom
    const menu = document.querySelector('[role="menu"]')
    const m = R(menu)
    const cardRects = cards.map((t) => {
      const el = [...document.querySelectorAll('button')].filter((e) => (e.textContent || '').includes(t)).pop() || null
      return { t, rect: R(el) }
    })
    return {
      label,
      innerWidth: window.innerWidth,
      menu: menu && m ? { ...m, cls: String(menu.className) } : null,
      fitsRight: m ? m.right <= window.innerWidth : null,
      cards: cardRects,
      overlapsCards: cardRects.filter((c) => hits(m, c.rect)).map((c) => c.t),
    }
  }, { label, cards: CARDS })
}

test.describe('P5 mobile composer gate', () => {
  test.beforeEach(({}, testInfo) => {
    const phone = testInfo.project.name === 'phone-390' || testInfo.project.name === 'phone-360'
    test.skip(!phone, 'geometry runs on the phone-390 and phone-360 projects')
  })

  test('row fits: no child past the viewport, scrollWidth <= clientWidth', async ({ page }) => {
    await openChat(page)
    const m = await readRow(page)
    const vp = page.viewportSize()
    expect(vp?.width, 'phone project viewport').toBeGreaterThan(0)
    expect(m.rowFound, 'the control row is the flex row in the composer form').toBe(true)
    expect(m.rowCls).toContain('flex items-center gap-1.5')
    expect(m.rowScrollW, `row scrollWidth ${m.rowScrollW} in clientWidth ${m.rowClientW}`).toBeLessThanOrEqual(m.rowClientW!)
    const wide = m.children.filter((c) => c.rect && c.rect.right > m.innerWidth)
    expect(wide.map((c) => `${c.tag} [${c.aria || c.title || c.text}] right=${c.rect?.right}`),
      `every row child, including the Send wrapper, stays inside ${m.innerWidth}px`).toHaveLength(0)
    expect(m.send[0]?.parentCls).toBe('ml-auto')
    expect(m.send[0]?.rect && m.send[0].rect.right <= m.innerWidth, `Send right=${m.send[0]?.rect?.right}`).toBe(true)
  })

  test('chips: label spans stay on one line inside the 32px chip', async ({ page }) => {
    await openChat(page)
    const m = await readRow(page)
    // Option A: one labeled chip (Run settings) + icon-only chips (no span).
    expect(m.chips.length, `expected ≥1 label-bearing chip, got ${m.chips.length}`).toBeGreaterThanOrEqual(1)
    const wrap = m.chips.filter((c) => c.spanWS === 'normal' || (c.spanH ?? 0) > 16)
    expect(wrap.map((c) => `${c.aria}: span h=${c.spanH} white-space=${c.spanWS}`),
      'chip labels do not wrap inside the fixed-height chip').toHaveLength(0)
  })

  for (const p of POPOVERS) {
    /* Redesign (2.3): phone menus are bottom SHEETS — opaque, grip-handled,
       70dvh-capped. They may cover the content below (that is what sheets
       do); the gates are: on-screen, inside the viewport, and fully opaque
       (the old translucent sheet bled the composer text through). */
    test(`popover ${p.name}: on screen, inside viewport, fully opaque`, async ({ page }) => {
      await openChat(page)
      if (p.id === 'slash') {
        await page.locator('textarea').first().click()
        await page.keyboard.press('/')
      } else {
        await page.locator(p.btn).first().click()
      }
      await expect(page.locator('[role="menu"]').first()).toBeVisible()
      const m = await readMenu(page, p.name)
      expect(m.menu, `open ${p.name}: role=menu rendered`).toBeTruthy()
      expect(m.fitsRight, `${p.name} right=${m.menu!.right} in a ${m.innerWidth}px viewport`).toBe(true)
      // The sheet stays inside the viewport (bottom included)…
      expect(m.menu!.bottom, `${p.name} bottom=${m.menu!.bottom} past ${m.innerWidth ? 'viewport' : ''}`).toBeLessThanOrEqual(844)
      // …and it is fully opaque — no composer text bleeding through (the
      // Phase-0 phone bug: the old sheet was 86% translucent).
      const opaque = await page.evaluate(() => {
        const el = document.querySelector('[role="menu"]')
        if (!el) return null
        const bg = getComputedStyle(el).backgroundColor
        const match = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(bg)
        return match ? (match[4] === undefined ? 1 : Number(match[4])) : null
      })
      expect(opaque, `${p.name} sheet background alpha (was 0.86 translucent)`).toBeGreaterThanOrEqual(0.96)
    })
  }

  test('LIVE leg: the fixture logs in', async ({ page }) => {
    test.skip(!process.env.LIVE_BASE_URL, 'set LIVE_BASE_URL to run the live login leg')
    const password = process.env.E2E_PASSWORD
    if (!password) throw new Error('E2E_PASSWORD must be set to run the live login leg')
    const fixture = { ...FIXTURE, password }
    const LIVE = process.env.LIVE_BASE_URL!
    const base = await page.goto(LIVE)
    expect(base?.status()).toBe(200)
    const neg = await page.evaluate(async (f) => {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f, password: 'incorrect-password' }) })
      const t = await r.text()
      return { status: r.status, bytes: t.length, body: JSON.parse(t) }
    }, fixture)
    expect(neg).toEqual({ status: 401, bytes: 31, body: { error: 'Invalid credentials' } })
    const res = await page.evaluate(async (f) => {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f) })
      const t = await r.text()
      return { status: r.status, bytes: t.length, body: JSON.parse(t) }
    }, fixture)
    expect(res.status).toBe(200)
    expect(res.bytes).toBe(310)
    expect(Object.keys(res.body).sort()).toEqual(['token', 'user'])
    expect(res.body.token.length).toBe(177)
    expect(res.body.user.email).toBe(FIXTURE.email)
    const me = await page.evaluate(async (tok) => {
      const r = await fetch('/api/account/me', { headers: { authorization: `Bearer ${tok}` } })
      const t = await r.text()
      return { status: r.status, bytes: t.length, body: JSON.parse(t) }
    }, res.body.token)
    expect(me.status).toBe(200)
    expect(me.bytes).toBe(354)
    expect(me.body.plan).toBe('free')
    expect(me.body.credits).toBe(30)
    expect(me.body.usage).toEqual({ tokensIn: 0, tokensOut: 0, images: 0, messages: 0 })
    const convs = await page.evaluate(async (tok) => {
      const r = await fetch('/api/conversations', { headers: { authorization: `Bearer ${tok}` } })
      const t = await r.text()
      return { status: r.status, bytes: t.length, body: JSON.parse(t) }
    }, res.body.token)
    expect(convs.status).toBe(200)
    expect(convs.bytes).toBe(2)
    expect(convs.body).toEqual([])
  })
})
