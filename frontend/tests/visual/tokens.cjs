#!/usr/bin/env node
/**
 * pixel-measure (ledger P6 / BP P1) — token extraction, §15.2.
 *
 * Reads the REAL static export in `frontend/out/` served by `tests/serve-out.cjs`
 * on :4123 and writes `frontend/tokens.json`:
 *
 *   themes.<light|dark>.cssVariables  — every custom property the stylesheets
 *                                      declare, resolved via getComputedStyle,
 *                                      with the declaring selector recorded.
 *   themes.<light|dark>.semantic     — semantic tokens (--surface-1, --text-muted,
 *                                      --border-subtle, --accent, ...), each
 *                                      carrying the element selector, screen,
 *                                      property, family and measured value.
 *   themes.<light|dark>.elements     — de-duplicated computed-style +
 *                                      getBoundingClientRect dump of the DOM's
 *                                      structural elements (selector recorded).
 *   themes.<light|dark>.motion       — live Web-Animations-API dump
 *                                      (`document.getAnimations()`).
 *   themes.<light|dark>.breakpoints  — layout sweep 320 → 1920 in 8 px steps,
 *                                      logging the widths where layout changes.
 *
 * Usage: node tests/visual/tokens.cjs
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const net = require('net')
const { spawn, execSync } = require('child_process')
const { chromium } = require('playwright')

const ROOT = path.join(__dirname, '..', '..')            // frontend/
const OUT = path.join(ROOT, 'out')
const PORT = 4123
const BASE = `http://127.0.0.1:${PORT}`
const DEST = path.join(ROOT, 'tokens.json')

const THEMES = ['light', 'dark']
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }

// §15.2 families → the exact computed-style properties recorded per element.
const FAMILIES = {
  color: ['color', 'background-color', 'background-image', 'border-top-color', 'border-color', 'outline-color', 'fill', 'stroke'],
  typography: ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'font-feature-settings'],
  spacing: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap', 'row-gap', 'column-gap'],
  sizing: ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'box-sizing'],
  shape: ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius', 'border-top-width', 'border-left-width'],
  elevation: ['box-shadow'],
  motion: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'animation-name', 'animation-duration', 'animation-timing-function'],
  stacking: ['z-index', 'position', 'display', 'overflow', 'opacity'],
}
const PROPS = Object.values(FAMILIES).flat()
const PROPSET = new Set(PROPS)

/** Structural selectors sampled for the element dump (first match of each). */
const SAMPLE = [
  'body', 'header', 'aside', 'main', 'nav', 'footer', 'form',
  'h1', 'h2', 'h3', 'p', 'span', 'a', 'button', 'input', 'textarea', 'svg', 'img', 'ul', 'li',
  '[role="dialog"]', '[role="menu"]', '[role="listbox"]', '[role="tooltip"]', '[data-testid="theme-toggle"]',
]

/**
 * Semantic tokens. Every entry names its probe: which screen, which element
 * selector, which computed property. Nothing here is a hand-typed value.
 */
const SEMANTIC = [
  // ── landing `/` ──────────────────────────────────────────────────────────
  { name: '--surface-1',        family: 'color',      screen: 'landing', selector: 'body',                       property: 'background-color' },
  { name: '--surface-1-image',  family: 'color',      screen: 'landing', selector: 'body',                       property: 'background-image' },
  { name: '--text-body',        family: 'color',      screen: 'landing', selector: 'body',                       property: 'color' },
  { name: '--text-heading',     family: 'color',      screen: 'landing', selector: 'h1',                         property: 'color' },
  { name: '--text-muted',       family: 'color',      screen: 'landing', selector: 'a.text-slate-500',           property: 'color' },
  { name: '--accent',           family: 'color',      screen: 'landing', selector: '[class*="bg-[#c96442]"]',   property: 'background-color' },
  { name: '--accent-text',      family: 'color',      screen: 'landing', selector: '[class*="text-[#e79d7f]"]', property: 'color' },
  { name: '--surface-glass',     family: 'color',      screen: 'landing', selector: 'a.glass',                    property: 'background-color' },
  { name: '--border-glass',      family: 'color',      screen: 'landing', selector: 'a.glass',                    property: 'border-top-color' },
  { name: '--focus-ring',        family: 'color',      screen: 'landing', selector: 'button',                     property: 'outline-color' },
  { name: '--font-sans',        family: 'typography', screen: 'landing', selector: 'body',                       property: 'font-family' },
  { name: '--type-body-size',    family: 'typography', screen: 'landing', selector: 'body',                       property: 'font-size' },
  { name: '--type-h1-size',      family: 'typography', screen: 'landing', selector: 'h1',                         property: 'font-size' },
  { name: '--type-h1-weight',    family: 'typography', screen: 'landing', selector: 'h1',                         property: 'font-weight' },
  { name: '--type-h1-tracking',  family: 'typography', screen: 'landing', selector: 'h1',                         property: 'letter-spacing' },
  { name: '--type-h1-leading',   family: 'typography', screen: 'landing', selector: 'h1',                         property: 'line-height' },
  { name: '--type-h1-transform', family: 'typography', screen: 'landing', selector: 'h1',                         property: 'text-transform' },
  { name: '--radius-cta',       family: 'shape',      screen: 'landing', selector: '[class*="bg-[#c96442]"]',   property: 'border-top-left-radius' },
  { name: '--pad-cta-y',        family: 'spacing',    screen: 'landing', selector: '[class*="bg-[#c96442]"]',   property: 'padding-top' },
  { name: '--pad-cta-x',        family: 'spacing',    screen: 'landing', selector: '[class*="bg-[#c96442]"]',   property: 'padding-left' },
  { name: '--radius-glass',      family: 'shape',      screen: 'landing', selector: 'a.glass',                    property: 'border-top-left-radius' },
  { name: '--shadow-glass',      family: 'elevation',  screen: 'landing', selector: 'a.glass',                    property: 'box-shadow' },
  { name: '--motion-duration',  family: 'motion',     screen: 'landing', selector: 'a.transition',               property: 'transition-duration' },
  { name: '--motion-easing',    family: 'motion',     screen: 'landing', selector: 'a.transition',               property: 'transition-timing-function' },
  { name: '--motion-property',  family: 'motion',     screen: 'landing', selector: 'a.transition',               property: 'transition-property' },
  { name: '--size-icon',        family: 'sizing',     screen: 'landing', selector: 'svg',                        property: '__rect.width' },
  { name: '--size-icon-h',      family: 'sizing',     screen: 'landing', selector: 'svg',                        property: '__rect.height' },

  // ── chat shell `/chat/` ────────────────────────────────────────────────
  { name: '--surface-page-chat',   family: 'color',   screen: 'chat', selector: 'body',                              property: 'background-color' },
  { name: '--surface-sidebar',     family: 'color',   screen: 'chat', selector: 'aside',                             property: 'background-color' },
  { name: '--border-subtle',      family: 'color',   screen: 'chat', selector: 'aside',                             property: 'border-top-color' },
  { name: '--surface-header',      family: 'color',   screen: 'chat', selector: '[class*="bg-[#08080a]"]',          property: 'background-color' },
  { name: '--size-sidebar-width',  family: 'sizing',  screen: 'chat', selector: 'aside',                             property: '__rect.width' },
  { name: '--size-header-height',  family: 'sizing',  screen: 'chat', selector: '[class*="bg-[#08080a]"]',          property: '__rect.height' },
  { name: '--size-composer-minh',  family: 'sizing',  screen: 'chat', selector: 'textarea',                          property: '__rect.height' },
  { name: '--surface-composer',    family: 'color',   screen: 'chat', selector: 'textarea',                          property: 'background-color' },
  { name: '--text-composer',      family: 'color',   screen: 'chat', selector: 'textarea',                          property: 'color' },
  { name: '--type-composer-size',  family: 'typography', screen: 'chat', selector: 'textarea',                       property: 'font-size' },
  { name: '--type-composer-leading', family: 'typography', screen: 'chat', selector: 'textarea',                     property: 'line-height' },
  { name: '--pad-composer-y',      family: 'spacing', screen: 'chat', selector: 'textarea',                          property: 'padding-top' },
  { name: '--pad-composer-x',      family: 'spacing', screen: 'chat', selector: 'textarea',                          property: 'padding-left' },
  { name: '--z-sidebar',          family: 'stacking', screen: 'chat', selector: 'aside',                            property: 'z-index' },
  { name: '--radius-icon-button',  family: 'shape',   screen: 'chat', selector: '[data-testid="theme-toggle"]',        property: 'border-top-left-radius' },
  { name: '--motion-button',      family: 'motion',  screen: 'chat', selector: '[data-testid="theme-toggle"]',        property: 'transition-duration' },

  // ── settings dialog (`/chat/` + Agent settings open) ──────────────────
  { name: '--surface-panel',      family: 'color',     screen: 'settings', selector: '[role="dialog"]',   property: 'background-color' },
  { name: '--border-panel',      family: 'color',     screen: 'settings', selector: '[role="dialog"]',   property: 'border-top-color' },
  { name: '--radius-panel',      family: 'shape',     screen: 'settings', selector: '[role="dialog"]',   property: 'border-top-left-radius' },
  { name: '--shadow-panel',      family: 'elevation', screen: 'settings', selector: '[role="dialog"]',   property: 'box-shadow' },
  { name: '--z-dialog',         family: 'stacking',  screen: 'settings', selector: '[role="dialog"]',   property: 'z-index' },
  { name: '--size-panel-width',  family: 'sizing',    screen: 'settings', selector: '[role="dialog"]',   property: '__rect.width' },
  { name: '--size-panel-height', family: 'sizing',    screen: 'settings', selector: '[role="dialog"]',   property: '__rect.height' },
  { name: '--type-panel-title',  family: 'typography', screen: 'settings', selector: '[role="dialog"] h2', property: 'font-size' },
  { name: '--color-panel-title', family: 'color',     screen: 'settings', selector: '[role="dialog"] h2', property: 'color' },
]

// ── helpers ──────────────────────────────────────────────────────────────
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function probePort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    setTimeout(() => { s.destroy(); resolve(false) }, 800)
  })
}

async function ensureServer() {
  if (await probePort(PORT)) return { child: null }
  const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'serve-out.cjs')], {
    cwd: ROOT, stdio: 'ignore', detached: false,
  })
  for (let i = 0; i < 40; i++) {
    if (await probePort(PORT)) return { child }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('serve-out.cjs never opened :4123')
}

/** The in-page extractor: runs in Chromium, returns everything for one page. */
function extractInPage(args) {
  const { props, sample, semantic, families } = args
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

  /** Stable CSS path for a node (id → class → nth-of-type chain). */
  function cssPath(el) {
    if (el === document.body) return 'body'
    if (el === document.documentElement) return 'html'
    const parts = []
    let cur = el
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let part = cur.tagName.toLowerCase()
      if (cur.id) { parts.unshift(`#${cur.id}`); break }
      const cls = (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
      if (cls.length) part += '.' + cls.join('.')
      const parent = cur.parentElement
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName)
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`
      }
      parts.unshift(part)
      cur = cur.parentElement
    }
    return parts.join(' > ')
  }

  function styleMap(el) {
    const cs = getComputedStyle(el)
    const out = {}
    for (const p of props) out[p] = cs.getPropertyValue(p).trim()
    return out
  }

  // ── (a) custom properties declared by the loaded stylesheets ────────────
  const customNames = new Map()   // name → declaring selector (first seen)
  for (const sheet of Array.from(document.styleSheets)) {
    let rules = null
    try { rules = sheet.cssRules } catch { continue }   // cross-origin
    if (!rules) continue
    for (const rule of Array.from(rules)) {
      if (!rule.style) continue
      for (const name of Array.from(rule.style)) {
        if (name.startsWith('--') && !customNames.has(name)) customNames.set(name, rule.selectorText || sheet.href || '(anonymous)')
      }
    }
  }
  const rootStyle = getComputedStyle(document.documentElement)
  const cssVariables = Array.from(customNames.entries()).map(([name, sel]) => ({
    name, selector: sel, value: rootStyle.getPropertyValue(name).trim(),
  }))

  // ── (b) structural element dump, de-duplicated by style signature ──────
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } }
  const seen = new Map()   // signature → entry
  for (const sel of sample) {
    let nodes = []
    try { nodes = Array.from(document.querySelectorAll(sel)).slice(0, 3) } catch { continue }
    for (const el of nodes) {
      const styles = styleMap(el)
      const rect = rectOf(el)
      const sig = JSON.stringify(styles)
      const selector = cssPath(el)
      if (seen.has(sig)) {
        const e = seen.get(sig)
        if (!e.selectors.includes(selector) && e.selectors.length < 8) e.selectors.push(selector)
        e.count += 1
        continue
      }
      seen.set(sig, {
        selectors: [selector],
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) || undefined,
        rect,
        count: 1,
        styles,
      })
    }
  }

  // ── (c) semantic tokens from declared probes ──────────────────────────
  const semanticOut = semantic.map((p) => {
    let el = null
    try { el = document.querySelector(p.selector) } catch { el = null }
    if (!el) return { ...p, matched: false, value: null }
    if (p.property.startsWith('__rect.')) {
      const r = el.getBoundingClientRect()
      const key = p.property.slice('__rect.'.length)
      return { ...p, matched: true, value: `${Math.round(r[key] * 100) / 100}px`, rect: rectOf(el), elementPath: cssPath(el) }
    }
    return { ...p, matched: true, value: getComputedStyle(el).getPropertyValue(p.property).trim(), rect: rectOf(el), elementPath: cssPath(el) }
  })

  // ── (d) live motion via the Web Animations API ──────────────────────
  const motion = (document.getAnimations() || []).slice(0, 200).map((a) => {
    const t = a.effect && a.effect.target
    const timing = (a.effect && a.effect.getTiming && a.effect.getTiming()) || {}
    return {
      name: (a.animationName || (a.effect && a.effect.constructor && a.effect.constructor.name) || 'animation'),
      duration: timing.duration ?? null,
      easing: timing.easing ?? null,
      delay: timing.delay ?? null,
      iterations: timing.iterations ?? null,
      playState: a.playState,
      target: t && t.nodeType === 1 ? cssPath(t) : null,
    }
  })

  // ── (e) transition/animation families actually applied, distinct ────
  const distinct = {}
  for (const f of Object.keys(families)) distinct[f] = new Set()
  for (const e of seen.values()) for (const p of props) distinct[Object.keys(families).find((f) => families[f].includes(p))].add(e.styles[p])
  const distinctValues = Object.fromEntries(Object.entries(distinct).map(([k, v]) => [k, Array.from(v).sort()]))

  return {
    cssVariables,
    elements: Array.from(seen.values()),
    semantic: semanticOut,
    motion,
    distinctValues,
    html: { dataTheme: document.documentElement.getAttribute('data-theme'), colorScheme: getComputedStyle(document.documentElement).colorScheme },
    metrics: { elementCount: document.querySelectorAll('*').length, sampledUnique: seen.size },
  }
}

/** Layout sweep: 320 → 1920 in 8 px steps, log where layout changes. */
async function sweep(page, pageName) {
  const markers = ['header', 'aside', 'nav', 'main', 'textarea', 'button', 'a', 'h1', 'h2']
  const read = () => page.evaluate((tags) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
    const out = { counts: {}, scrollW: document.documentElement.scrollWidth }
    for (const t of tags) out.counts[t] = Array.from(document.querySelectorAll(t)).filter(vis).length
    return out
  }, markers)
  const changes = []
  let prev = null
  let start = null
  for (let w = 320; w <= 1920; w += 8) {
    await page.setViewportSize({ width: w, height: 900 })
    await page.waitForTimeout(16)
    const sig = await read()
    const key = JSON.stringify(sig)
    if (prev === null) { start = w; changes.push({ from: w, to: null, signature: sig }) }
    else if (key !== prev) {
      changes[changes.length - 1].to = w - 8
      changes.push({ from: w, to: null, signature: sig })
    }
    prev = key
  }
  if (changes.length) changes[changes.length - 1].to = 1920
  return { page: pageName, step: 8, range: [320, 1920], transitions: changes }
}

// ── main ──────────────────────────────────────────────────────────────
;(async () => {
  if (!fs.existsSync(OUT)) { console.error('out/ missing — run: npm run build'); process.exit(2) }
  const { child } = await ensureServer()
  const browser = await chromium.launch()
  const head = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim()
  const outIndex = fs.readFileSync(path.join(OUT, 'index.html'))

  const result = {
    generatedAt: new Date().toISOString(),
    command: 'node tests/visual/tokens.cjs',
    headRevision: head,
    source: {
      build: 'frontend/out (next build, static export)',
      servedBy: 'tests/serve-out.cjs on http://127.0.0.1:4123 (API stubbed)',
      outIndexBytes: outIndex.length,
      outIndexSha256: sha256(outIndex),
    },
    capture: {
      browser: `chromium ${browser.version()}`,
      deviceScaleFactor: 2,
      viewports: { desktop: `${DESKTOP.width}x${DESKTOP.height}`, mobile: `${MOBILE.width}x${MOBILE.height}` },
      fontsLoaded: 'document.fonts.ready',
      animations: 'document.getAnimations() paused for stills; live dump recorded under .motion',
      reducedMotion: 'reduce',
    },
    families: FAMILIES,
    semanticIndex: SEMANTIC.map(({ name, family, screen, selector, property }) => ({ name, family, screen, selector, property })),
    themes: {},
  }

  const distDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tokens-'))

  for (const theme of THEMES) {
    const ctx = await browser.newContext({
      viewport: DESKTOP, deviceScaleFactor: 2, reducedMotion: 'reduce',
      colorScheme: theme, locale: 'en-US', timezoneId: 'America/New_York',
    })
    await ctx.addInitScript((t) => { try { localStorage.clear(); localStorage.setItem('loop-theme', t) } catch {} }, theme)
    const page = await ctx.newPage()

    const themeOut = { theme, pages: {} }

    // landing
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('load').catch(() => {})
    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()))
    await page.waitForTimeout(500)
    themeOut.pages.landing = await page.evaluate(extractInPage, { props: PROPS, sample: SAMPLE, semantic: SEMANTIC.filter((s) => s.screen === 'landing'), families: FAMILIES })
    themeOut.breakpoints = { landing: await sweep(page, 'landing') }
    await page.setViewportSize(DESKTOP)

    // chat shell (mobile first so the composer/at-390 geometry is measurable)
    await page.setViewportSize(MOBILE)
    await page.goto(`${BASE}/chat/`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('load').catch(() => {})
    await page.waitForTimeout(700)
    themeOut.pages.chatMobile = await page.evaluate(extractInPage, { props: PROPS, sample: SAMPLE, semantic: SEMANTIC.filter((s) => s.screen === 'chat'), families: FAMILIES })
    await page.setViewportSize(DESKTOP)
    await page.waitForTimeout(300)
    themeOut.pages.chat = await page.evaluate(extractInPage, { props: PROPS, sample: SAMPLE, semantic: [], families: FAMILIES })
    themeOut.breakpoints.chat = await sweep(page, 'chat')
    await page.setViewportSize(DESKTOP)
    await page.waitForTimeout(200)

    // settings dialog
    await page.evaluate(() => {
      const open = document.querySelector('button[aria-label="Show sidebar"]')
      if (open) open.click()
    })
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const t = document.querySelector('aside .border-t button')
      if (t) t.click()
    })
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Settings')
      if (b) b.click()
    })
    try {
      await page.locator('[role="dialog"][aria-label="Agent settings"]').waitFor({ state: 'visible', timeout: 15000 })
      await page.waitForTimeout(400)
      themeOut.pages.settings = await page.evaluate(extractInPage, { props: PROPS, sample: SAMPLE, semantic: SEMANTIC.filter((s) => s.screen === 'settings'), families: FAMILIES })
    } catch (e) {
      themeOut.pages.settings = { error: String(e).slice(0, 200), semantic: [], elements: [], cssVariables: [], motion: [] }
    }

    // semantic: fold every page's probes into one flat, theme-level list
    themeOut.semantic = []
    for (const [pageName, data] of Object.entries(themeOut.pages)) {
      if (!data || !data.semantic) continue
      for (const s of data.semantic) themeOut.semantic.push({ ...s, measuredOn: pageName })
    }
    themeOut.cssVariables = (themeOut.pages.landing && themeOut.pages.landing.cssVariables) || []
    themeOut.motion = (themeOut.pages.landing && themeOut.pages.landing.motion) || []
    result.themes[theme] = themeOut

    fs.writeFileSync(path.join(distDir, `${theme}.json`), JSON.stringify(themeOut))
    await ctx.close()
    console.log(`  ${theme.padEnd(5)} semantic ${themeOut.semantic.length} probes · ${themeOut.semantic.filter((s) => s.matched).length} matched · ` +
      `elements ${(themeOut.pages.landing && themeOut.pages.landing.metrics.sampledUnique) || 0}/` +
      `${(themeOut.pages.chat && themeOut.pages.chat.metrics.sampledUnique) || 0} · cssVars ${themeOut.cssVariables.length} · motion ${themeOut.motion.length}`)
  }

  await browser.close()
  if (child) child.kill()

  fs.writeFileSync(DEST, JSON.stringify(result, null, 2) + '\n')
  const buf = fs.readFileSync(DEST)
  console.log(`\nTOKENS ${DEST}  ${buf.length} B  sha256 ${sha256(buf)}`)
  for (const t of THEMES) {
    const bad = result.themes[t].semantic.filter((s) => !s.matched)
    if (bad.length) console.log(`  UNMATCHED ${t}: ${bad.map((b) => `${b.name}(${b.selector})`).join(', ')}`)
  }
  console.log(`transitions: landing ${result.themes.light.breakpoints.landing.transitions.length} · chat ${result.themes.light.breakpoints.chat.transitions.length}`)
})().catch((e) => { console.error(e); process.exit(1) })
