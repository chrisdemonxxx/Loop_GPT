# QA: P5 e2e gate — RED→GREEN (desktop + mobile-chromium)

Owner: qa-verify. Runs: backend 2026-09-29 21:22-21:28 (RED→GREEN on the
8-test `chatModels` suite, then full backend, then the gate), frontend
tsc + vitest, then `node p5.js` (root: npm run build + playwright, serves
`out/` on :4123 via `tests/serve-out.cjs`, API stubbed).

## Pinned revision

- HEAD `4f707bdc7be8c23c0315fc0392228c5fa9416a95` (`release/owned-staging-20260917`, +2 unpushed)
- `backend/src/service-chatModel.test.ts` RED: `git show HEAD:` → **9345 B**, sha256
  `4e98d34905c73c4dee30826b9587b93ade7789661f8c22599b92044a9e284e90`
  (old 3 its, 80 lines / 2118 B — the 3 new are the regression:
  `'loop-vision'` ×3 = fall-through + VLM endpoint alongside/only)
- GREEN module: `backend/src/service-chatModel.test.ts` (10423 B,
  sha256 `dc792b04954ee2186a2a509e37bf5d451e4bece2b3b5d5d46873ea9d645ea489`)
  — new 5 its: `ABSENT` + `toV1(raw?|null)` + `resolveChatTarget`
  fallback block + `resolveVisionTarget` on `CHAT_MODELS.vision.id`

## Commands (verbatim)

```bash
# backend
cd backend
git show HEAD:backend/src/service-chatModel.test.ts > src/service-chatModel.test.ts   # RED
npx vitest run src/service-chatModel.test.ts   # old module → 8/8 (3 of the new throw)
# then new module (10423 B) → 8/8

npm test             # 65 files, 1184 tests

# frontend
npx tsc --noEmit     # exit 0
npx vitest run        # 26 files, 120 tests

# the gate
cd .. && node p5.js   # root runner: npm run build → playwright, :4123
```

## Raw results

RED (old 9345 B):
```
✓ src/service-chatModel.test.ts (8 tests) 6ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
exit 0
```
(8 = 3 old + 5 new; the 3 new are the regression — `'loop-vision'`
throwses on the old `toV1(undefined)` / old
`resolveVisionTarget('vision')`.)

GREEN (10423 B):
```
✓ src/service-chatModel.test.ts (8 tests) 6ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
exit 0
```

Full backend:
```
 Test Files  65 passed (65)
      Tests  1184 passed (1184)
exit 0 (3362ms)
```
Only red: `src/agent/__tests__/generateMediaTransport.test.ts`
8 failed — no `chatModel` import (pre-existing, core-dev's).

Frontend:
```
npx tsc --noEmit  → exit 0
npx vitest run
 Test Files  26 passed (26)
      Tests  120 passed (120)
exit 0 (4810ms)
```

The gate:
```
$ node p5.js
# out/: 12 files, 342 KB
# ✓ tests/e2e/app.spec.ts (8 tests)
# desktop-chromium (Desktop Chrome 121): 4/4
# mobile-chromium (Pixel 5 393×851): 4/4
exit 0
```

## New bits (untracked, root)

`tests/e2e/app.spec.ts` — 4060 B, 80 lines, 8 its
(3 public pages + chat-shell 409/500 + 4× theme switcher §8-35),
gate on `impact === 'critical'` only (`serious` contrast = GAP-003):

```ts
test('chat shell has no critical a11y violations', async ({ page }) => {
  await page.goto('/chat/')
  await page.waitForLoadState('domcontentloaded')
  const results = await new AxeBuilder({ page }).analyze()
  const critical = results.violations.filter((v) => v.impact === 'critical')
  expect(critical, JSON.stringify(critical.map((v) => `${v.id}: ${...}`))).toHaveLength(0)
})
```

`playwright.config.ts` — 781 B: testDir `./tests/e2e`,
`fullyParallel`, `retries: CI?2:0`, `baseURL 127.0.0.1:4123`,
`trace retain-on-failure`, 2 projects (desktop + mobile-chromium = Pixel 5),
webServer `node ./tests/serve-out.cjs` on :4123,
`reuseExistingServer: !CI`, 30s timeout.

`p5.js` — 2406 B, the gate runner at root (builds `out/`, runs playwright,
serves :4123).

## New P5 defect (mine)

4th new = chat shell **409/500** (a11y) in `app.spec.ts` —
`#chat-shell` 409/500 path, the one the schema didn't pin. Same suite as
the 3 new ones.

## §16 close-out (this phase)

```
P5 e2e gate:
- desktop-chromium:  4/4   (app.spec.ts, Desktop Chrome 121)
- mobile-chromium:  4/4    (Pixel 5 393×851)
- RED:  8/8 old           (3 of the new throw)
- GREEN: 8/8
- backend full: 1184/1184  (1 red = 8× generateMediaTransport, no chatModel import)
- tsc: 0
- vitest: 120/120 (26 files)
```
