#!/usr/bin/env node
/**
 * pixel-measure (ledger P6 / BP P1) — baseline capture + delta measurement.
 *
 * Reads the REAL static export in `frontend/out/` (never a mockup), served by
 * `tests/serve-out.cjs` on :4123, and writes:
 *   frontend/tests/baselines/<screen>/<theme>/<viewport>.png   (deviceScaleFactor 2)
 *   frontend/tests/baselines/a11y/<screen>.<theme>.json       (normalised a11y tree)
 *   frontend/tests/baselines/MANIFEST.json                   (bytes + sha256)
 *
 * Usage:
 *   node tests/visual/measure.cjs            # write the baseline set (freeze)
 *   node tests/visual/measure.cjs --verify   # re-render HEAD, diff vs baselines,
 *                                            # write tests/baselines/deltas.json
 *
 * Every number this prints is produced by a real Chromium render of `out/`.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const net = require('net')
const { spawn } = require('child_process')
const { PNG } = require('pngjs')
const { chromium } = require('playwright')

const ROOT = path.join(__dirname, '..', '..')            // frontend/
const OUT = path.join(ROOT, 'out')
const BASELINES = path.join(ROOT, 'tests', 'baselines')
const PORT = 4123
const BASE = `http://127.0.0.1:${PORT}`

const VERIFY = process.argv.includes('--verify')
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length)

const VIEWPORTS = [
  { id: '1440x900', width: 1440, height: 900 },
  { id: '1280x800', width: 1280, height: 800 },
  { id: '820x1180', width: 820, height: 1180 },
  { id: '390x844', width: 390, height: 844 },
  { id: '320x844', width: 320, height: 844 },   // §15.3 edge case (320 wide)
]
const THEMES = ['dark', 'light']

/** The screens that EXIST at HEAD 092dcb0. Missing §4 route trees are not waited on. */
const SCREENS = [
  {
    id: 'landing', url: '/',
    masks: [],
  },
  {
    id: 'chat-shell', url: '/chat/',
    // The chat shell stands in for /chat/:uuid — the static stub carries no
    // conversation rows, so the empty shell is the only render (A4.1).
    // P5 composer-overflow fix LANDED (392dd50, 2026-10-05): the 390/320
    // baselines are the fixed layout; no row is pending.
    masks: ['aside div.w-7'],
  },
  {
    id: 'settings', url: '/chat/',
    masks: [],
    setup: async (page) => {
      // Hydration can replace the header/sidebar nodes a beat after `load`; every
      // click here re-resolves its locator and falls back to a DOM-dispatched
      // click, so a detached node cannot stall the capture.
      await clickFirst(page, () => page.getByRole('button', { name: 'Show sidebar' }), { optional: true })
      await clickFirst(page, () => page.locator('aside .border-t button').first())
      await clickFirst(page, () => page.getByRole('button', { name: 'Settings', exact: true }))
      await page.locator('[role="dialog"][aria-label="Agent settings"]').waitFor({ state: 'visible', timeout: 15000 })
      await page.locator('[role="dialog"][aria-label="Agent settings"] h2').waitFor({ state: 'visible' })
    },
  },
]

/** Click a locator that may be swapped out by a hydration re-render. */
async function clickFirst(page, makeLocator, { optional = false } = {}) {
  for (let i = 0; i < 6; i++) {
    const loc = makeLocator()
    if (await loc.count().catch(() => 0)) {
      try { await loc.first().click({ timeout: 3000 }); return true } catch { /* fall through */ }
      const dispatched = await loc.first()
        .evaluate((el) => { el.click(); return true })
        .catch(() => false)
      if (dispatched) return true
    } else if (optional) {
      return false
    }
    await page.waitForTimeout(250)
  }
  if (optional) return false
  throw new Error('clickFirst: target never became clickable')
}

// ── helpers ──────────────────────────────────────────────────────────────────
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    setTimeout(() => { s.destroy(); resolve(false) }, 800)
  })
}

async function ensureServer() {
  if (await probe(PORT)) return { child: null }
  const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'serve-out.cjs')], {
    cwd: ROOT, stdio: 'ignore', detached: false,
  })
  for (let i = 0; i < 40; i++) {
    if (await probe(PORT)) return { child }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('serve-out.cjs never opened :4123')
}

/** role/name-only tree: strips state noise so the snapshot diff is a schema diff. */
function normalise(node) {
  if (!node) return null
  const out = { role: node.role }
  if (node.name) out.name = node.name
  if (Array.isArray(node.children) && node.children.length) {
    out.children = node.children.map(normalise).filter(Boolean)
  }
  return out
}

/** Deterministic freeze: reduced motion, fonts loaded, animations paused at t=dur. */
async function freeze(page) {
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()))
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      try { a.pause() } catch { /* ignore */ }
    }
  })
  await page.waitForTimeout(120)
}

async function render(browser, screen, theme, vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
    colorScheme: theme === 'light' ? 'light' : 'dark',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  })
  await ctx.addInitScript((t) => {
    try {
      localStorage.clear()
      if (t === 'light') localStorage.setItem('loop-theme', 'light')
      else localStorage.setItem('loop-theme', 'dark')
    } catch { /* private mode */ }
  }, theme)
  const page = await ctx.newPage()
  await page.goto(`${BASE}${screen.url}`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('load').catch(() => {})
  await page.waitForTimeout(600)          // let hydration settle before any click
  if (screen.setup) await screen.setup(page)
  await freeze(page)
  const mask = screen.masks.map((s) => page.locator(s))
  const png = await page.screenshot({ animations: 'disabled', mask, scale: 'device' })
  const a11y = normalise(await page.accessibility.snapshot())
  await ctx.close()
  return { png, a11y }
}

function pixelDiff(aBuf, bBuf) {
  const a = PNG.sync.read(aBuf)
  const b = PNG.sync.read(bBuf)
  if (a.width !== b.width || a.height !== b.height) {
    return { width: a.width, height: a.height, bWidth: b.width, bHeight: b.height, diff: -1, total: a.width * a.height, ratio: 1 }
  }
  const total = a.width * a.height
  let diff = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) diff++
  }
  return { width: a.width, height: a.height, diff, total, ratio: diff / total }
}

// ── main ──────────────────────────────────────────────────────────────────
;(async () => {
  if (!fs.existsSync(OUT)) {
    console.error('out/ missing — run: npm run build')
    process.exit(2)
  }
  const { child } = await ensureServer()
  const browser = await chromium.launch()
  const head = require('child_process')
    .execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim()

  const destRoot = VERIFY
    ? path.join(process.env.LOCALAPPDATA || require('os').tmpdir(), 'Temp', 'pixel-measure-verify')
    : BASELINES
  fs.mkdirSync(destRoot, { recursive: true })

  const manifestPath = path.join(VERIFY ? destRoot : BASELINES, 'MANIFEST.json')
  const manifest = { headRevision: head, capturedAt: new Date().toISOString(), command: VERIFY ? 'node tests/visual/measure.cjs --verify' : `node tests/visual/measure.cjs${ONLY ? ` --only=${ONLY}` : ''}`, entries: [] }
  const deltas = []

  for (const screen of (ONLY ? SCREENS.filter((s) => s.id === ONLY) : SCREENS)) {
    for (const theme of THEMES) {
      for (const vp of VIEWPORTS) {
        let out
        try {
          out = await render(browser, screen, theme, vp)
        } catch (e) {
          console.log(`  ${screen.id.padEnd(11)} ${theme.padEnd(5)} ${vp.id.padEnd(9)} RENDER-ERROR ${String(e && e.message || e).slice(0, 90)}`)
          deltas.push({ screen: screen.id, theme, viewport: vp.id, error: String(e && e.message || e), verdict: 'RENDER-ERROR' })
          continue
        }
        const { png, a11y } = out
        const rel = path.join(screen.id, theme, `${vp.id}.png`)
        const file = path.join(destRoot, rel)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, png)
        const bytes = png.length
        const hash = sha256(png)
        const a11yRel = path.join('a11y', `${screen.id}.${theme}.${vp.id}.json`)
        const a11yFile = path.join(destRoot, a11yRel)
        const a11yJson = JSON.stringify(a11y, null, 2) + '\n'
        fs.mkdirSync(path.dirname(a11yFile), { recursive: true })
        fs.writeFileSync(a11yFile, a11yJson)

        let delta = 0
        if (VERIFY) {
          const baseFile = path.join(BASELINES, rel)
          const baseA11y = path.join(BASELINES, a11yRel)
          if (fs.existsSync(baseFile)) {
            const baseBuf = fs.readFileSync(baseFile)
            const d = pixelDiff(png, baseBuf)
            delta = d.ratio
            const baseA11yJson = fs.existsSync(baseA11y) ? fs.readFileSync(baseA11y, 'utf8') : ''
            deltas.push({
              screen: screen.id, theme, viewport: vp.id,
              baseline: rel, baselineBytes: baseBuf.length, baselineSha256: sha256(baseBuf),
              liveBytes: bytes, liveSha256: hash,
              diffPixels: d.diff, totalPixels: d.total, deltaRatio: d.ratio,
              a11yDiff: a11yJson === baseA11yJson ? 0 : 1,
              verdict: d.ratio <= 0.005 && a11yJson === baseA11yJson ? 'PASS' : 'FAIL',
            })
          } else {
            deltas.push({
              screen: screen.id, theme, viewport: vp.id,
              baseline: rel, baselineBytes: null, baselineSha256: null,
              liveBytes: bytes, liveSha256: hash,
              diffPixels: null, totalPixels: null, deltaRatio: null,
              a11yDiff: null,
              verdict: screen.pending || 'NO-BASELINE',
            })
          }
        }

        manifest.entries.push({
          screen: screen.id, theme, viewport: vp.id, file: rel,
          bytes, sha256: hash, a11yFile: a11yRel, a11yBytes: Buffer.byteLength(a11yJson), a11ySha256: sha256(Buffer.from(a11yJson)),
          ...(VERIFY ? { deltaRatio: delta } : {}),
        })
        console.log(`  ${screen.id.padEnd(11)} ${theme.padEnd(5)} ${vp.id.padEnd(9)} ${String(bytes).padStart(8)} B  ${hash.slice(0, 16)}…  ${VERIFY ? (delta === 0 ? 'no-baseline' : (delta * 100).toFixed(4) + '%') : ''}`)
      }
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`\nMANIFEST ${manifestPath}  ${fs.statSync(manifestPath).size} B  sha256 ${sha256(fs.readFileSync(manifestPath))}`)

  if (VERIFY) {
    fs.writeFileSync(path.join(BASELINES, 'deltas.json'), JSON.stringify({ headRevision: head, command: deltas[0] ? 'node tests/visual/measure.cjs --verify' : '', rows: deltas }, null, 2) + '\n')
    const worst = deltas.reduce((m, r) => Math.max(m, r.deltaRatio), 0)
    const fails = deltas.filter((r) => r.verdict === 'FAIL')
    console.log(`\nrows ${deltas.length} · worst delta ${(worst * 100).toFixed(4)}% · FAIL ${fails.length}`)
    if (fails.length) for (const f of fails) console.log(`  FAIL ${f.screen} ${f.theme} ${f.viewport} delta ${(f.deltaRatio * 100).toFixed(4)}% a11yDiff=${f.a11yDiff}`)
  }

  await browser.close()
  if (child) child.kill()
})().catch((e) => { console.error(e); process.exit(1) })
