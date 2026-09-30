# P5 delta for `ui-visual` — re-fired by `hr-bot`, HEAD `8346c2d`

Your ask is `team/P5_KICKOFF_ui-visual.md` (read it first — it is the contract, unchanged). This note
is only the delta since it was filed.

## State, measured on a real build (not a class grep)

HEAD = **`8346c2df5bb2322551016edd5519310d3f8d6dff`** (`8346c2d`). The defect is **unchanged**:
`team/EVIDENCE_p5_geometry_HEAD092dcb0.txt` (9,204 B) is byte-for-byte the same geometry measured on
`1b9806e` — so nothing landed in between.

```
@390x844  row "flex items-center gap-1.5 px-3 pb-2.5 pt-1" (Composer.tsx:285)
          x=13 w=364 right=377   row.scrollWidth = 455        (91 px of overflow INSIDE the row)
  Send (aria "Send message") 424..460  ->  70 px past a 390 px viewport
  Reasoning menu x=238 right=486  fitsRight=false, overlaps all four suggestion cards
@360x800  same row; Send 424..460  ->  100 px past a 360 px viewport
```

## Acceptance (the kickoff's, unchanged — these are the units a verifier measures)

On a real build, at **390x844 AND 360x800**: every composer control — **including the `ml-auto` Send
wrapper** — has `right <= innerWidth`; the control row's `scrollWidth <= clientWidth`; every chip
label span `h <= 16` (no wrap inside a 32 px chip); each of the four popovers has
`right <= innerWidth` and covers **no** suggestion card. A green suite is not the evidence — the
control's `right` is.

## Bounds

- You are the single writer of `frontend/app/globals.css`, `frontend/app/components/chat/Composer.tsx`
  and `frontend/app/components/chat/composer/**`; `frontend/app/chat/hooks.ts` is yours alone.
- `qa-verify` is being re-fired **in parallel** and owns `frontend/tests/**` (the RED gate spec). Do not
  edit `frontend/tests/**`; if you need a test-side change, file it in one line.
- Deliverable: **one** frontend-only commit + `team/UI_MOBILE_WEB_ui-visual.md` carrying the
  **after** geometry from the same probe (`team/probe_mobile_geometry.cjs`), before/after side by side.
- Then the five gates in `frontend/`: `npx tsc --noEmit`, `npm run lint`, `npm test`,
  `npx playwright test`, `npm run build` — paste each exit code. Note the clean step: drop
  `frontend/tsconfig.tsbuildinfo` as well as `.next`, or the build can report a RED that is its own cache.
