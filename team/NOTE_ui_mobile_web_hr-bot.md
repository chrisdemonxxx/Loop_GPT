# NOTE — the mobile **web** breakage is real, reproduced, and has no owner

**From:** hr-bot (roster owner; filed because the user re-reported it in the room)
**To:** `boss-bot` (dispatch) · `ui-visual` (the responsive web surface) · `mobile-dev` (FYI — `mobile/` is a different app) · `qa-verify` (gate)
**Filed:** 2026-09-29 ~20:5x EDT. The user submitted 6 phone screenshots (590×1280, live
`loop-gpt.cyou`). Every defect below was then **re-measured live at a phone viewport**
(390×844 and 360×800, `Emulation.setDeviceMetricsOverride`, mobile=true) in a real browser on a
throwaway account — the numbers are raw `getBoundingClientRect()` output, not impressions.

## 0. Why this file exists

`docs/PROGRESS.md:334` — *"Phase 2.6 — Mobile + responsive (audit P6) — SHIPPED (2026-09-26,
commit `78e5e83`)"* — with **frontend 60/60, Playwright 12/12 (desktop + mobile)**. The live
phone viewport still breaks (below). The gate was satisfied by jsdom + class assertions plus a
Playwright pass that never opens a composer popover at a phone width. So the phase is *shipped per
assertions, broken on a device*. Compounding it: the roster has **no owner for the responsive web
surface** — `mobile-dev` owns `mobile/` (Expo/React-Native, a different app), and `ui-visual`'s
live pass (`team/NOTE_ui_connectors_ui-visual.md` §2) was measured at **1258×566**.

## 1. The user's screenshots (raw, as submitted)

`C:/Users/chris/Desktop/photo_*.jpg` — all **590×1280**, all mobile browser chrome (`loop-gpt.cyou`):

| file | bytes | sha256[:16] | what it shows |
|---|---|---|---|
| `photo_2026-09-29_20-33-28.jpg` | 58200 | `785e520c6751cf56` | REASONING dropdown open, covering the suggestion list; hint lines clipped |
| `photo_1_2026-09-29_20-33-40.jpg` | 51030 | `205bee010af002f3` | run-mode popover (Auto/Plan/Ask first/Accept edits) over chips **and** the input |
| `photo_2_2026-09-29_20-33-40.jpg` | 53888 | `e9cca23333beed38` | clean composer: `Mode ·`/`Auto`, `Web ·`/`Auto`, `Reason ·`/`Auto` each wrap to two lines |
| `photo_3_2026-09-29_20-33-40.jpg` | 55636 | `5932717a66fd4617` | Settings → Tools sheet: intro text collides with `View audit log`; last card cut at the sheet edge |
| `photo_4_2026-09-29_20-33-40.jpg` | 40997 | `e9e0beedf32b5236` | Settings → Connectors sheet: titles truncated to `GitHu`, `GitLat`, `Sentr` |
| `photo_5_2026-09-29_20-33-40.jpg` | 43129 | `e04fec23dd05b990` | same sheet scrolled: `PRODUCTIVITY 4` half-clipped at the sheet's bottom edge |

## 2. Live reproduction (390×844, then 360×800) — raw geometry

**2a. The composer's control row does not fit and does not reflow.** At 390px the five right-side
controls are laid out at `x = 67 … 418`:

```
[+]      x=25   w=36  right=61
Mode     x=67   w=91  right=158
Web      x=164  w=67  right=232
Reason   x=238  w=101 right=339
Mic      x=345  w=33  right=378
Send     x=384  w=34  right=418   <-- 390px viewport: 28px off-screen
```

At 360px two chips are past the edge: `right=378` and `right=418` (**58px cut**).
`documentElement.scrollWidth == innerWidth` (390) — it is clipped, not scrollable, and nothing
wraps the row. Source: `frontend/app/components/chat/Composer.tsx:285` — one
`flex items-center gap-1.5` row with six controls and **zero breakpoint classes**.

**2b. The chip labels wrap inside a fixed-height chip.** Every chip's label span measures
`spanH=24` inside a `height:2rem (32px)` chip, and computed `white-space: normal` —
which is the user's `Mode ·` / `Auto` two-line label. Source:
`frontend/app/globals.css:209-217` (`.chip { display:inline-flex; height:2rem; … }`, **no
`white-space: nowrap`**).

**2c. Every composer popover is left-anchored at a fixed width → off-screen at phone width.**
With the Reasoning menu open at 390×844:

```
menu  : x=238  y=375  w=248  h=380  right=486  bottom=755
card  : x=28   y=348  right=362  bottom=395
overlaps_suggestion_card = true      fits_viewport_right = false   (96px past the edge)
```

The right 96px of the panel — the hint column of all six rows — is off-screen, which is exactly
the `Quick CoT — easy st…` / `Max effort — ~8k tok…` clipping in the user's screenshot, plus the
card occlusion. Source: `frontend/app/components/chat/composer/EffortSelector.tsx:90`
(`absolute bottom-full mb-2 left-0 w-[15.5rem] z-20`), and the identical pattern in
`composer/PlusMenu.tsx:41` (`w-56`), `composer/SlashPalette.tsx:34,110` (`w-60`).

**2d. The `⌘K ?` chip sits on the composer.** `role=button`, `aria-label="Keyboard shortcuts"`,
`text="⌘K ?"`, rect `x=325 y=794 w=49 h=34` at 390px — bottom-right, over the container border
and the disclaimer line. It is also a keyboard glyph on a touch device (already flagged by
ui-visual as item 5; confirmed here on the phone).

**2e. Settings sheet vs. the phone's own chrome.** Settings → Connectors opens a 358×726 sheet at
`y=59 … bottom=785` in a chrome-free 844px viewport. A real phone browser spends the bottom
~90–110px on its toolbar, so the sheet's last row lands under it — matching photo_3/4/5. The
truncated card titles (`GitHu`/`GitLat`/`Sentr`) come from title + `+ Add` sharing one row in a
2-column grid.

## 3. Fix direction (for the owner to accept, adjust, or reject — not a directive)

1. `.chip { white-space: nowrap }` (+ `flex: none`) so a chip's label can never wrap, and give
   the row a small-screen rule: hide chip labels below a breakpoint (icon-only chips, as the voice
   /mic chips already are) and/or `flex-wrap` with the send button pinned.
2. Popovers: keep `bottom-full` but anchor with a collision-safe rule — `right-0` / `max-w-[calc(100vw-2rem)]`
   on small screens, or render them as a bottom sheet below a breakpoint. All four call sites.
   This is one shared primitive, not four fixes.
3. The `⌘K ?` chip: gate on a pointer/keyboard-capable device (or place it inside the empty state).
4. The settings sheet: `pb-[env(safe-area-inset-bottom)]` + a bottom spacer so the last row clears
   browser chrome; title and `+ Add` on separate lines on small screens.

## 4. Acceptance ("done" for this item)

- A **phone-viewport gate** that measures, not asserts classes: at 390×844 and 360×800 on the live
  URL, every composer control's `right ≤ innerWidth`; the label span of each chip has
  `height ≤ 16`; with each of the four popovers open, `menu.right ≤ innerWidth` and, with the
  suggestion list visible, the menu covering no suggestion card the user may need to tap.
- The same gate runs in Playwright's `mobile-chromium` project (the phase-2.6 run used desktop +
  a mobile project, but never with a popover open).
- Evidence: raw geometry pasted beside the fix, as above.

## 5. Evidence artifacts (checked in)

| file | bytes | sha256[:16] |
|---|---|---|
| `team/evidence-ui-mobile-390-popover-open.png` | 148984 | `72c5c1d5de2d79e5` |
| `team/evidence-ui-mobile-360-chipwrap.png` | 142728 | `35ec9972c9a23ca1` |
| `team/evidence-ui-mobile-390-connectors.png` | 121001 | `7335811471d99bc0` |

Source references resolve in the working tree at the time of writing:
`Composer.tsx:285` · `composer/EffortSelector.tsx:90` · `globals.css:209-217` ·
`composer/PlusMenu.tsx:41` · `composer/SlashPalette.tsx:34,110` · `docs/PROGRESS.md:334`.
