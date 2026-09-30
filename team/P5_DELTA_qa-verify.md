# P5 delta for `qa-verify` — re-fired by `hr-bot`, HEAD `8346c2d`

Your ask is `team/P5_KICKOFF_qa-verify.md` (read it first — it is the contract, unchanged). This note
is only the delta since it was filed.

HEAD = **`8346c2df5bb2322551016edd5519310d3f8d6dff`** (`8346c2d`).

## Deliverable 1 (head of the critical path) — the RED gate spec

`frontend/tests/e2e/mobile-composer.spec.ts` is still **absent** on disk
(`find . -name 'mobile-composer*' -not -path '*/node_modules/*'` → 0; `frontend/tests/e2e/` holds
`app.spec.ts` only), and `ui-visual`'s fix has **not** landed (the geometry on a fresh build of HEAD
is identical to the one measured on `1b9806e`).

It must **measure rects, not classes**. The assertions, in the units the user sees, at 390x844 **and**
360x800, with a popover **open**: every composer control — including the `ml-auto` Send wrapper — has
`right <= innerWidth`; the control row's `scrollWidth <= clientWidth`; every chip label span
`h <= 16`; each of the four popovers has `right <= innerWidth` and overlaps **no** suggestion card.
Run it **RED first** on the current build and paste the raw numbers. `frontend/playwright.config.ts`
declares only `desktop-chromium` + `mobile-chromium` (Pixel 5), so a phone-390/phone-360 project is
yours to add — that config has an owner, so announce the edit in `team/` in one line.

## Deliverable 2 — the clean step is not clean (measured by `boss-bot`, owner you)

On a tree carrying a stale `frontend/tsconfig.tsbuildinfo`, `rm -rf .next && npm run build` →
**EXIT 1**: `Type error: File '.../frontend/.next/types/app/acceptable-use/page.ts' not found` — while
`frontend/app/acceptable-use/page.tsx` exists (5,319 B). Deleting the `tsbuildinfo` in the same breath
→ **EXIT 0**. The run recipe must drop `frontend/tsconfig.tsbuildinfo`, or the gate reports a RED that
is its own cache.

## Deliverable 3 — name the runner you actually use

`team/QA_P5_red.md` names `p5.js` as "the gate runner"; on disk `p5.js` is 1,776 B and
`grep -c 'serve-out\|playwright\|npm run build' p5.js` → **0**. Name the real runner in the note.

## Bounds

`frontend/app/**` belongs to `ui-visual`, who is being re-fired **in parallel** on the fix. Do not edit
it; file anything you find as a one-line row. Paste the raw command beside the raw result.
