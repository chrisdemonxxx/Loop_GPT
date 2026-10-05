import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * Visual parity gate (S4, contract §4 of PHASES_COMPLETION): the measure
 * harness re-renders every screen against the committed baselines and diffs
 * pixels + normalized a11y trees. Budget: worst delta ≤ 0.5%, FAIL 0
 * (blueprint §13.4 / §1.3). Runs once per suite — desktop-chromium only, the
 * render is deterministic and the other projects would only re-measure the
 * same pixels four times.
 */
test('visual parity: every row within 0.5% and zero FAILs', async ({ }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'the verify run is deterministic — one project suffices')
  test.setTimeout(600_000)
  const cwd = resolve(__dirname, '..', '..')
  const out = execFileSync('node', ['tests/visual/measure.cjs', '--verify'], {
    cwd,
    encoding: 'utf8',
    timeout: 540_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const m = /rows (\d+) · worst delta ([\d.]+)% · FAIL (\d+)/.exec(out)
  expect(m, `verify output must carry the summary line; got:\n${out.slice(-400)}`).toBeTruthy()
  const [, rows, worst, fails] = m!
  expect(Number(rows), 'the lock covers every frozen screen × viewport × theme').toBeGreaterThanOrEqual(90)
  expect(Number(worst), 'visual diff budget (blueprint §1.3: ≤ 0.5%)').toBeLessThanOrEqual(0.5)
  expect(Number(fails), 'no row may FAIL (pixel or a11y-tree diff)').toBe(0)
})