# P5 KICKOFF — the responsive web surface is YOURS, and it is RED

**From:** `boss-bot` (orchestrator) · **To:** `ui-visual` (the one owner of the fix)
**cc:** `qa-verify` (geometry gate) · `code-review` (static) · `ops-release` (deploy) · `mobile-dev` (FYI) · `hr-bot`
**Filed:** 2026-09-29 20:55 EDT. **Source defect:** `team/NOTE_ui_mobile_web_hr-bot.md` §2/§3/§4
(6 live phone screenshots from the user; breakage reproduced live and re-measured by me, §14 of
`team/PHASES.md`).

## 1. Ownership — settled, and it is you

- `TEAM_ROSTER.md` §2: `ui-visual` = Visual / UI; §5: `hooks.ts` (and by `CONTRACT_P2_STREAM.md` §E,
  `components/chat/Composer.tsx` + `components/chat/composer/**`) is a **single-writer** file set owned
  by you. `PHASES.md` §9.3 records the same ruling.
- `mobile-dev` owns `mobile/` (Expo/React-Native) — a **different app**. Do not touch it; do not ask it
  to fix this.
- Nobody else may write these files while P5 is open. If a fix needs a file outside
  `frontend/app/globals.css` and `frontend/app/components/chat/**` (and
  `frontend/app/components/settings/**` for item 4), hand it off in one line first.

## 2. The defect, re-measured by the orchestrator on a fresh build of HEAD `1b9806e`

Raw geometry (`rm -rf .next out && npm run build` → exit 0; `node tests/serve-out.cjs`;
Pixel 5 device metrics; probe `team/probe_mobile_geometry.cjs`; full output
`team/EVIDENCE_mobile_geometry_390_360.txt`):

```
@390x844  row "flex items-center gap-1.5 px-3 pb-2.5 pt-1" (Composer.tsx:285)
          box x=13 w=364 right=377   **row.scrollWidth = 455**   documentElement.scrollWidth == 390
  [+]        25..61 | Mode 67..158 | Web 164..232 | Reason 238..339
  hands-free 345..378 | Dictate 384..418 | **Send 424..460  (70px past a 390px viewport)**
  chip label span h=24 inside a 32px chip, computed white-space: normal
  Reasoning menu x=238 y=375 w=248 h=380 right=486  fitsRight=false
  overlapsCards = ALL FOUR suggestion cards (28..362 x 348..567)
  ⌘K ? chip x=325 y=794 w=49 h=34 (over the composer border)
@360x800  same layout, Send right=460 → 100px past the edge
```

**Two corrections to the note — carry these, do not re-derive:**
1. The control hr-bot's §2a calls `Send` at `384..418` is the **Dictate** mic. The real Send button
   (aria `Send message`, title `Send`) is the last child of the row inside a `<div className="ml-auto">`
   (Composer.tsx:363) and ends at **right=460 → 70px clipped at 390, 100px at 360** (the note's "28px"
   is the `.chip`-only view). **A gate that measures `button.chip` alone still passes with Send
   off-screen.**
2. The row is not just over-wide: its own `scrollWidth` (455) exceeds its box (364). That is the
   cleanest acceptance term — assert it on the row element, not on a control list.

## 3. What to change (your call on the mechanism; the acceptance is not negotiable)

- `globals.css:209-217` `.chip` — `white-space: nowrap` (+ `flex: none`) so a label can never wrap
  (that is the user's `Mode ·` / `Auto` two-line chip).
- `Composer.tsx:285` — the row has **zero breakpoint classes**. Give it a small-screen rule
  (icon-only chips and/or a wrap with Send pinned) so the row fits at 320px.
- The popovers — `EffortSelector.tsx:90` (`w-[15.5rem]`), `PlusMenu.tsx:41` (`w-56`),
  `SlashPalette.tsx:110` (`w-60`, the RunMode menu). One shared rule (collision-safe
  `right-0` / `max-w-[calc(100vw-2rem)]`, or a bottom sheet), **applied at all three call sites**.
  `SlashPalette.tsx:34` is `left-0 right-0` (container-wide) and already fits — leave it or fold it in
  deliberately, but say which.
- The `⌘K ?` chip (`Composer.tsx` empty state) — gate it on a pointer/keyboard-capable device.
- `components/settings/**` — the sheet (photos 3/4/5): `pb-[env(safe-area-inset-bottom)]` + a bottom
  spacer so the last row clears browser chrome (`page.tsx:615` already does this for the composer
  footer — reuse the pattern), and title vs `+ Add` on separate lines in the 2-column grid
  (`ConnectorsTab.tsx:178`, `:345` truncates).

## 4. Acceptance — "done" for P5 (note §4, plus two amendments)

At **390×844 and 360×800, on the LIVE URL** (`qa-verify`'s spec, measurement not class assertions):
- every composer control's `right ≤ innerWidth` — **including the `ml-auto` Send wrapper** — and the
  row's `scrollWidth ≤ clientWidth`;
- each chip's label span `height ≤ 16`;
- with each of the four popovers open: `menu.right ≤ innerWidth` and the menu covering **no**
  suggestion card the user may need to tap;
- **AMENDED (photo 3/4/5, missing from the note's §4):** the Settings sheet's last row and the sheet's
  bottom edge clear the browser-chrome budget, and connector/plugin card titles are not truncated.
- Runs in Playwright's `mobile-chromium` project (`frontend/playwright.config.ts:15` — the phase-2.6
  "12/12" used it, but never with a popover open).

## 5. Evidence and exit (one commit, then hand to `qa-verify`)

- **Before/after raw geometry** pasted in `team/UI_MOBILE_WEB_ui-visual.md`, same probe, both viewports,
  both before and after.
- **One commit**, frontend-only, clean tree. Paste `npx tsc --noEmit` (exit 0) and
  `npx vitest run` (23 files / 151 tests, the current green baseline) beside it.
- Do **not** edit the test files — `frontend/tests/**` and `__tests__/Composer.test.tsx` are
  `qa-verify`'s (contract §E).
- Then hand off in one line: commit SHA + the two gate lines. The gate is not "classes exist";
  `qa-verify` re-measures and can fail it.
