# P5 KICKOFF — the geometry gate is yours, and it must be RED first

**From:** `boss-bot` (orchestrator) · **To:** `qa-verify` (dynamic lane)
**cc:** `ui-visual` (fix owner) · `code-review` · `hr-bot`
**Filed:** 2026-09-29 20:55 EDT. **Source defect:** `team/NOTE_ui_mobile_web_hr-bot.md` §4;
baseline geometry in `team/PHASES.md` §14 and `team/EVIDENCE_mobile_geometry_390_360.txt`.

## 1. Why this is a new gate and not a re-run

`docs/PROGRESS.md:334` (Phase 2.6, "SHIPPED", `78e5e83`) claims **Playwright 12/12 (desktop +
mobile)** and `frontend/app/components/chat/__tests__/responsive.test.tsx` asserts **classes** under
jsdom. Neither can see a `getBoundingClientRect`. The live phone viewport breaks anyway (six user
screenshots; reproduced and re-measured by me on a build of HEAD `1b9806e`). **The gate for P5
measures pixels or it is not the gate.**

## 2. Deliverable

`frontend/tests/e2e/mobile-composer.spec.ts` (**new file, yours**) + two projects in
`frontend/playwright.config.ts` — `phone-390` (390×844) and `phone-360` (360×800), `isMobile: true`,
Pixel-5-ish UA — asserting, in-page, at minimum:

```
row   = the div whose className contains 'flex items-center gap-1.5' inside the composer
        row.scrollWidth <= row.clientWidth
        every row child: rect.right <= window.innerWidth
chips:  every button.chip > span: rect.height <= 16 and computed white-space != 'normal'
popovers (all four: PlusMenu, RunModePicker, EffortSelector, SlashPalette):
        with it open → menu.right <= window.innerWidth
        and (when the suggestion cards are visible) no card rect intersects the menu rect
settings sheet (open Settings → Tools and → Connectors):
        sheet.bottom <= innerHeight - chromeBudget, and no card title is truncated
```

Reuse `team/probe_mobile_geometry.cjs` (my probe — `row.scrollWidth`, the `ml-auto` Send wrapper, the
card rects and the intersection test are all in it) rather than re-deriving the selectors.

## 3. Sequence and evidence (all three pastes are required)

1. **RED at HEAD, today:** run the spec against the built static export
   (`cd frontend && npx playwright test --project=phone-390 --project=phone-360`). Paste the raw
   failures. Expected baseline: Send `right=460` (viewport 390), row `scrollWidth=455` vs box 364,
   label span `24` in a 32px chip, Reasoning menu `right=486` overlapping **all four** cards.
   A gate that is green on HEAD is a broken gate.
2. **GREEN after `ui-visual`'s commit:** same command, raw output, plus the commit SHA.
   Unit gate beside it: `npx tsc --noEmit` exit 0, `npx vitest run` 23 files / 151 tests.
3. **LIVE re-measure (this is the acceptance):** the same spec pointed at `https://loop-gpt.cyou`
   (base URL override; the authed session is the fixture in **§3a** below — verified live by
   `boss-bot` 2026-09-30 01:0xZ, so nothing here waits on a human) at **390×844 and 360×800**, with
   raw rects pasted beside it. Until this line exists, P5 is not done.

### 3a. The live-session fixture — verified live, not taken from a note

```
POST https://loop-gpt.cyou/api/auth/login
     {"email":"hr.mobile.probe.20260929@example.com","password":"HrProbe!2941-aa"}
  -> HTTP=200  310 B  keys=['token','user']  token_len=177
GET  /api/account/me   (Bearer that token) -> HTTP=200 354 B  plan=free, credits=30,
                        usage={tokensIn:0,tokensOut:0,images:0,messages:0}
GET  /api/conversations                    -> HTTP=200 2 B   []
NEGATIVE CONTROL, password "wrong-2941-aa"  -> HTTP=401 31 B  {"error":"Invalid credentials"}
```

Disposable fixture, no data (`/api/conversations` empty; all usage counters zero). The 401 on a wrong
password is the point: it is real auth, not a stub that accepts anything. Script + raw output:
`team/probe_p5_fixture.py` (1,333 B, sha256 `e724fd538a92b01f…`),
`team/EVIDENCE_p5_fixture_probe.txt` (835 B, sha256 `4a848ef83cd4c0c2…`). Provenance and the full
argument: `team/PHASES.md` §15.2; the credential is also recorded in `team/NOTE_ui_mobile_web_hr-bot.md`
§2f (its author). If you rotate it, say so in one line and `hr-bot` updates §2f.

## 4. Boundaries

- `frontend/tests/**` and `__tests__/Composer.test.tsx` are yours alone (contract §E). Keep the jsdom
  `responsive.test.tsx` — it is a regression net, just not this gate.
- Do not touch `Composer.tsx` / `composer/**` / `globals.css`; those are `ui-visual`'s. If the gate
  needs a hook the code does not expose, hand off in one line rather than editing.
- Same class of defect to check while you are in there: `_qa-m1.mjs` (§13.4 of `PHASES.md`) is still
  exit 1 live; not this phase, but it is your file.
