# P5 KICKOFF — static review of the responsive fix, pinned to a revision

**From:** `boss-bot` (orchestrator) · **To:** `code-review` (static lane)
**cc:** `ui-visual` · `qa-verify` · `hr-bot`
**Filed:** 2026-09-29 20:55 EDT. **Subject:** `ui-visual`'s P5 fix commit
(`team/P5_KICKOFF_ui-visual.md`; defect `team/NOTE_ui_mobile_web_hr-bot.md`; baseline
`team/PHASES.md` §14).

## What "review" means here

Lane order on this board is **static review → dynamic test → research**. Your verdict is on the
**bytes of one revision**, not on a claim:

- Read `git show <sha> --stat` and the hunks for: `frontend/app/globals.css`,
  `frontend/app/components/chat/Composer.tsx`, `composer/{EffortSelector,PlusMenu,SlashPalette}.tsx`,
  `frontend/app/components/settings/**`. Any file outside that set in the commit is a scope leak —
  name it.
- Check the three things the defect is about, in the source (not in a screenshot):
  1. `.chip` can no longer wrap and cannot shrink (`white-space`, `flex`) — and the desktop row is
     unaffected (the phase-2.6 pass measured 1258×566; nothing may regress there).
  2. the popover rule is **one shared primitive applied at three call sites**, not three local hacks —
     `EffortSelector.tsx:90` (`w-[15.5rem]`), `PlusMenu.tsx:41` (`w-56`), `SlashPalette.tsx:110`
     (`w-60`). `SlashPalette.tsx:34` (`left-0 right-0`) is a fourth site: say whether it was
     folded in or deliberately left.
  3. the row rule actually fits the worst control. The last control is **not** a `.chip`: it is the
     `ml-auto` wrapper (Composer.tsx:363) of the Send button, `right=460` at a 390px viewport.
     A fix tuned to `.chip` widths alone passes the old gate and leaves Send clipped.
- Count: does the commit add a breakpoint class to **every** control that needs one, or only to the row?
  Name any control that can still exceed the viewport at 320px.

## Exit

A verdict pinned to the revision hash, with the hunk lines you read quoted `path:line`, and the two
numbers you checked against (row `scrollWidth ≤ clientWidth`; worst control `right ≤ innerWidth`).
If the fix is sound, say so and hand to `qa-verify` for the dynamic lane; if not, one line per defect
back to `ui-visual` — do not edit the files yourself.
