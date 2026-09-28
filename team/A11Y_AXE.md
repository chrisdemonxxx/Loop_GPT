# A11Y — axe-core sweep, every `serious+` per route+theme (GAP-003)

Pinned: `0d5d7675c5a1d483c061ecb052f8456e0a1f4d4e` (worktree == HEAD, no stash).

## Setup

```
cd frontend
rm -rf out build
npx next build        # 19/19 routes, out/
node ./tests/serve-out.cjs   # static server on :4123
npx playwright install chromium
```

## Runs

```
npx playwright test     # the committed e2e (20 tests: 5 routes × 2 projects)
node tests/axe-sweep.mjs # 11 routes × 2 themes, full @axe-core/playwright
```

Axe: `@axe-core/playwright 4.10.2`, chromium (bundled w/ playwright 1.49.1),
viewport 1280×800. Dark = no `loop-theme` (default); light = `loop-theme=light`.

## Result — e2e suite (the committed gate)

```
20 passed (4.4s)
```

All 5: public pages a11y gate ×3 routes, landing CTA, login form, chat shell,
theme switcher (3) — desktop+mobile chromium each. The gate filters
`impact==='critical'` only (app.spec.ts:12/37/58).

## Result — sweep (11 routes × 2 themes)

| route | dark | light |
|---|---|---|
| `/` | 1 S | 1 S |
| `/login/` | 2 S | 2 S |
| `/signup/` | 2 S | 2 S |
| `/chat/` | 1 S | 1 S |
| `/account/` | 1 S | 0 S |
| `/admin/` | **1 C** + 2 S | **1 C** + 2 S |
| `/onboarding/` | 1 S | 1 S |
| `/share/` | 1 S | 1 S |
| `/verify/` | 1 S | 0 S |
| `/forgot/` | 1 S | 1 S |
| `/reset/` | 1 S | 1 S |

All 22 pass 200 (stubbed API, no auth redirect on the static export).
S = serious, C = critical. 23 = 22 + re-run artifact.

**The one critical — `/admin/` refresh button:**

```
button-name (critical)
<button class="text-xs px-2.5 py-1.5 rounded-lg border border-white/10 text-slate-400 hover:text-slate-200">
   <RefreshCw size={13} />
</button>
```

`frontend/app/admin/page.tsx:123` — `onClick={refresh}`, icon-only, no text/`aria-label`.

**GAP-003 serious sweep — 16× `color-contrast`** (`text-slate-500` = `#64748b` on the glass cards):

| fg / bg | ratio | where |
|---|---|---|
| `#64748b` / `#151518` | **3.83** | 4× `.glass` sub-labels (`+0 in 24h` etc.) |
| `#64748b` / `#111113` | **3.96** | 3× inactive tab buttons (`usage`/`vouchers`/`payments`) |
| `#64748b` / `#101015` | **3.99** | 6× `th` |
| `#c96442` / `#231918` | **4.40** | 1× `Pro: 0` chip |

Ratios re-computed in Python from the reported `fgColor.computed`/`bgColor.computed`.
`< 4.5` on all 16 — that's the sweep GAP-003 names. Plus `link-name` (1 serious)
on the admin back link (`ArrowLeft` icon, `admin/page.tsx:116`).

## Raw

`axe-results.json` (22× `{event:route, route, theme, status, ms, counts,
nodes[{id, target, html, any, impact, …}], gotoErr, axeErr}`, one per
route+theme, NDJSON, 9,699 B).
Sweep script: `tests/axe-sweep.mjs` (`fffe69d8e3fe6c36790af2963f5e82b21a17dd62d40229eb35d6e563fcd03a4c`).

## Claim

- e2e GREEN: 20/20 — the committed critical-only gate.
- A11Y is the first `serious+` artifact: 16 contrast serious (3.83–3.99,
  all `#64748b` slate-500 on the glass), 1 critical (`button-name` on
  `/admin/` refresh), 1 `link-name` — vs the `GAP-003` design-pass claim
  that the serious contrast was deferred. 16 nodes ≈ what the 3.8x ratio on
  the 4 sub-labels + tab trio says.
- All 11 routes render unauth'd (200) — the static export doesn't redirect
  pre-login, so the sweep sees admin state.
