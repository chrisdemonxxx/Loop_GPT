# DESIGN — Claude's placement, our palette (the contract for the redesign)

**From:** hr-bot (layout pass, 2026-09-29) · **For:** `ui-visual` (owner of the look),
`qa-verify` (measures it), `mobile-dev` (parity), `core-dev` (tokens), `boss-bot` (dispatch).
User's words: *"complete redesign and placements of everything like claude has, pixel perfect
cloned, every element and every button — and just the styling and UI colours to not be copied.
instead give some shiny black and other colour touches."*

So: **copy the geometry, not the skin.** No Claude cream/beige; a polished-black system with the
existing terracotta as the single action colour and one cool accent for live/streaming state.

---

## 1. The layout defect this pass fixes (measured, live)

The chat page rendered its sidebar with a framer-motion `x` **transform** on an element that was
also `md:relative … shrink-0 w-[20rem]` — a transform is paint-only, so the panel sat at
`translateX(-280px)` while its 320px of flow stayed reserved:

```
before:  aside x=-280 w=320 (stuck)   composer 496..1264 (centre 880 in a 1440 window)
```

Result: a 40px strip of clipped sidebar at the left edge, and the whole transcript 160px right of
centre. Now a docked `<aside>` toggled by **width** (`w-[260px]` ↔ `w-0`), drawer (transform)
only below 768px.

**Rule for the whole app: a transform must never be the only thing holding or releasing layout.**
If an element participates in flow, its collapse is a width/size change.

## 2. Geometry (the targets a verifier measures)

| Surface | Target |
|---|---|
| Sidebar, ≥768px | docked, **260px**, hairline `border-r`; full-height scroll list; account row pinned at the bottom |
| Sidebar, <768px | overlay drawer (transform), 320px max, `min(20rem, calc(100vw - 2rem))` |
| Main column | `max-w-[48rem]` centred **in the area right of the sidebar** — the composer and the transcript share the same axis |
| Header | 48px tall, hairline bottom; sidebar toggle only when the sidebar is closed |
| Composer | one rounded surface (radius 20px), textarea → control row; `+` at the left; **labelled** chips and a round accent send at the right |
| Message rows | same 48rem column; no full-bleed cards |

Acceptance is measured, not eyeballed: at 1440×900 with the sidebar docked,
`aside.right == 260` and the composer's centre `== 260 + (1440-260)/2 = 850`.

## 3. The three "Auto" chips → three named controls

The complaint is literal: the composer row showed `Auto`, `Auto`, `Auto` — three identical
buttons distinguished only by an icon and a tooltip. **Every chip now carries a noun and a
value**, and a value is never the whole label:

| Chip | Reads | Cycles / opens |
|---|---|---|
| run mode | `Mode · Auto` (`· Plan` / `· Ask first` / `· Accept edits`) | menu (4 modes) |
| web search | `Web · Auto` (`· On` / `· Off`) | click cycles auto → on → off |
| reasoning | `Reason · Auto` (`· Low` … `· Off`) | menu (6 efforts) |

Rule: **a control that changes behaviour names itself**; `Auto` is a *value*, never a label.
Applies to any future toggle — no icon-only, tooltip-only controls in the composer.

## 4. Palette — "shiny black" + touches (tokens live in `globals.css`)

```
base      #08080a   app background, with two very low-alpha sheens (cool white top,
                    warm terracotta top-right) so the surface reads polished, not flat
surface   #101013   the one input surface (composer, search, dialogs)   → .surface
elevated  #141418   hover/active of a surface                          → .surface-hover
sidebar   #0a0a0c
hairline  rgba(255,255,255,.07)  (borders);  .glass/.glass-strong add
                    `inset 0 1px 0 rgba(255,255,255,.05)` — the gloss
text      slate-200 body · slate-400 secondary · slate-500 tertiary
accent    #c96442 warm  (action: send, primary button)  ·  #e79d7f warm-text
accent-2  #38a0dc / #8fd7ff cool  (live / streaming / recording state)  → .chip-live
```

Component classes (single source — **no raw hex in components**):
`.glass` `.glass-strong` `.surface` `.surface-hover` `.chip` `.chip-on` `.chip-live`.

The 4 shell hexes were swept app-wide (`#111113→#08080a`, `#0f0f11→#0a0a0c`,
`#1c1c1f→#131316`, `#1f1f22→#17171a`; 17 replacements / 11 files), so login, onboarding,
account, developer, share and settings inherit the new black with no per-page edit.

**Light theme** stays a supported re-map (`html[data-theme='light']`), not a second design:
anything not re-mapped keeps its dark value by design.

## 5. Open for the fleet (owners)

| Item | Owner | Acceptance |
|---|---|---|
| Message list / artifact panel / settings panels onto the same 48rem axis + `.surface` | `ui-visual` | measured centre + a screenshot at 1440 and 390 |
| The 6 findings in `team/NOTE_ui_connectors_ui-visual.md` §2 (account-menu locale dump, stacked overlays, silent session expiry, `⌘K ?` chip, type scale) | `ui-visual` | each one before/after |
| Mobile parity at 390px (drawer, composer row wraps, chips don't clip) | `mobile-dev` | screenshot pair |
| axe/contrast on the new black (`#08080a` + slate-400/500) | `qa-verify` | axe serious-level count = 0 |
| Latency: the new background gradients are CSS-only (no image, no JS) — re-measure first paint | `perf-eng` | `time_starttransfer − time_appconnect` before/after |
