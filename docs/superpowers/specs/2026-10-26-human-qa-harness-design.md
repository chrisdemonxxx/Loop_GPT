# Human-Like QA Harness — Design

Date: 2026-10-26
Status: Approved (design), pending spec review
Depends on: `2026-10-26-production-toolkit-design.md` (drivers and scanners)

## Goal

Replace a dedicated human tester with agents that log in to production as a real user,
exercise every section, screen, button, and feature, judge the result from a user's point
of view, probe each working feature from multiple angles, fix confirmed bugs, ship the
fixes, and re-verify. Nothing counts as done without evidence.

## Decisions

| Topic | Decision |
|---|---|
| Environment | Production, full actions, on dedicated test accounts only |
| Payments | Real Stripe flows at $0 via a 100%-off promo code or comped plan |
| On confirmed bug | Fix, ship to production automatically, re-verify; no human review |
| Database migrations | Auto-ship only additive, backward-compatible migrations; destructive ones wait for the owner |
| Approach | Custom project skills over trusted drivers; community QA agents used as pattern references only |
| iOS | EAS Build simulator builds + Limrun cloud simulator (free trial first; owner approves the $20/month Entry plan before it is needed) |
| Taste judgements | Measurable checks + multi-model judge panel, calibrated to the owner with a ~40-screen golden set and a "your call" queue |

## Drivers

| Surface | Primary driver | Fallback |
|---|---|---|
| `apps/web`, admin | Playwright plugin | `agent-browser`, Cursor IDE browser |
| `mobile` (Expo), Android | Maestro MCP on a local Android emulator | Limrun Android emulator |
| `mobile` (Expo), iOS | Limrun MCP cloud iOS simulator | EAS Workflows Maestro iOS job (scripted flows only) |
| WebView and web content on Safari's engine | Playwright WebKit, local | Safari inside the Limrun simulator |
| `apps/desktop` (Electron) | Cursor computer use | Electron Stagewright MCP (gated, low trust) |
| Browser extensions | Playwright with the unpacked extension loaded | Cursor computer use |
| E2B desktop and sandbox views | Cursor IDE browser through noVNC | Cursor computer use |

## Components

All components live in the repo: skills under `.cursor/skills/`, state under `qa/`.

### 1. `qa/guardrails.md`

Loaded first by every QA skill. Rules:

- Act only as the dedicated test accounts listed in `.env.qa` (gitignored). Never read,
  log, or commit their credentials.
- Test accounts carry a test flag so PostHog excludes them and Sentry tags their events.
- Never invite, message, share with, or otherwise affect accounts outside the test set.
  Multi-user flows use a second test account.
- Prefix every created object with `qa-agent-<runId>` and delete it during run cleanup.
- Before any payment submission, confirm the discount is applied and the total is $0;
  abort the payment step otherwise.
- Per-run caps on E2B sandbox minutes, model spend, and deploy count. Stop when a cap is reached.
- Pace interactions below abuse-engine and rate-limit thresholds.
- Ask before irreversible account-level actions: deleting a test account, changing
  custom domains, publishing anything publicly visible.

### 2. `qa-inventory` skill

Produces `qa/inventory/<surface>.yaml`: every route, screen, button, link, field, menu,
modal, toast, keyboard shortcut, and empty, loading, and error state, per role.

- Pass 1, from code: route tables, page components, interactive components, permissions.
- Pass 2, from a live crawl as each test role.
- Elements found in only one pass are flagged as `unexplained` for the sweep to resolve.

Each element gets a stable ID (`web.settings.billing.cancel-button`) used everywhere else.

### 3. `qa-human-sweep` skill

Input: one inventory area. For each element, in order:

1. **Expect.** Screenshot the screen and write down what a first-time user would expect
   the element to do, using only what is visible and common web or mobile conventions.
   Source code is not read during this step.
2. **Exercise.** Apply every applicable angle:
   - Happy path: the result matches the label and makes sense to a user.
   - Input: empty, invalid, boundary, oversized, unicode/emoji, pasted, and whitespace values.
   - Repetition: double click, rapid repeat, and repeat after success.
   - Navigation: back, forward, refresh, deep link, opening in a new tab, and resuming later.
   - Persistence: the change survives reload and sign out / sign in, and shows on other screens.
   - Keyboard: tab order, Enter and Escape, focus return; axe WCAG 2 A/AA scan.
   - Viewports: phone, tablet, desktop.
   - Network: slow 3G and offline, then recovery.
   - Roles: lower-privilege roles are denied, and direct URL access is denied too.
   - Consistency: shared patterns (delete-confirm, save toast, modals) behave identically
     across entities; create and delete several in a row without reloading.
3. **Judge.** Compare observed to expected using HICCUPPS oracles (history, image,
   comparable products, claims, user expectations, product consistency, purpose, standards).
4. **Record.** Evidence per check: screenshot(s), console log, failed network requests,
   and a Playwright trace where available.

The sweep maintains `qa/mental-model.md`, the agent's running model of what the product
does, refined every run.

### 4. `qa-skeptic` verifier

A fresh subagent with no shared context reproduces each `bug` or `broken-expectation`
finding from its repro steps. Outcomes: confirmed, not reproducible, or downgraded.
Only confirmed findings proceed to fixing.

### 5. Ledger

`qa/ledger.json` (machine) and `qa/ledger.md` (human summary). One row per element ×
angle × role × viewport with status `verified`, `failed`, `blocked`, or `untested`, plus
an evidence path. An area is done when every applicable row is `verified`.

### 6. `qa-fix-ship` loop

For each confirmed finding, on its own branch:

1. Write a regression test that fails before the fix.
2. Fix the bug; the regression test passes.
3. Gates: typecheck, lint, unit and E2E suites, Semgrep scan, and migration classification.
   A migration that drops, renames, or narrows anything, or adds a NOT NULL column without
   a default, is destructive: stop and hand to the owner.
4. Merge and deploy to Railway with a Railway token from the owner, respecting
   one backend replica and no overlapping deployments.
5. Post-deploy, re-run the element's full angle set plus a smoke pass of neighbouring
   elements in production.
6. Roll back automatically by redeploying the previous image if any check regresses or
   the Sentry error rate for the release rises above baseline. One fix per deploy, so a
   rollback reverts only that fix.

Known limit: web clients with the app already open may keep the previous PWA shell until
all tabs close; post-deploy verification uses a fresh browser context.

### 7. Codify

Each verified flow becomes a permanent regression test: Playwright specs for web, desktop,
and extensions; Maestro YAML flows under `mobile/.maestro/` for mobile. The existing suite
runs first on every later sweep.

### 8. Orchestration

One subagent per inventory area, in parallel. Web areas may run as Cursor cloud agents.
Mobile and desktop areas run locally because they need the emulator and computer use.

### 9. iOS pipeline

- Add an `ios-simulator` profile to `mobile/eas.json` (`"ios": { "simulator": true }`).
  Simulator builds are unsigned, so no Apple Developer membership is needed. Built by
  EAS Build from Windows (free tier: 15 iOS builds per month).
- Interactive sweeps: the Limrun MCP creates a cloud iOS simulator, installs the build,
  and exposes screenshot + element tree, actions, logs, and a live stream. The sweep
  applies the same angle set as Android, plus iOS-specific angles: swipe-back gesture,
  safe areas and the notch, Dynamic Type sizes, dark mode, VoiceOver labels, and
  app backgrounding and resume.
- Spend control: the guardrail caps Limrun minutes per run. When trial credits run low,
  the harness stops and asks the owner to approve the Entry plan; it never enables
  overage itself.
- Regression: verified iOS flows run as Maestro YAML in an EAS Workflows Maestro job
  (alpha, free tier 60 CI minutes per month).
- Not covered by simulators: camera hardware, push delivery, and real touch latency.
  These rows are marked `blocked: needs-device` in the ledger rather than `verified`.

### 10. Taste judgement system

Three layers, applied in order. A layer that produces a confident answer ends the check.

1. Measurable proxies (deterministic):
   - Perceived speed: click-to-visible-feedback time per element, graded at 0.1 s,
     1 s, and 10 s; Core Web Vitals (LCP, INP, CLS) and Lighthouse for web; Flashlight
     score, FPS, and JS-thread CPU for Android; dropped frames in performance traces.
   - Brand consistency: computed colours, spacing, typography, and radius checked
     against the design tokens in `packages/ui`; Playwright screenshot baselines for drift.
   - Design match: screens compared with their Figma frames through the Figma plugin,
     where a frame exists.
2. Judge panel: at least three different models from those available in Cursor.
   - Each scores named criteria (Nielsen's 10 heuristics, visual hierarchy, alignment,
     readability, copy clarity), not an overall impression.
   - Pairwise comparisons against the previous release and against comparable
     production apps found through the Mobbin plugin.
   - Each verdict is repeated for three personas: first-time user, power user, low-vision user.
3. Owner calibration:
   - `qa/taste/golden-set/`: ~40 representative screens the owner rates once,
     per criterion and pairwise.
   - Each judge's agreement with the owner is measured per criterion (Cohen's kappa).
     A judge may decide a criterion alone only at kappa ≥ 0.6. Otherwise, panel
     disagreement or a low-agreement criterion sends the item to `qa/taste/queue.md`.
   - Each owner answer from the queue is appended to `qa/taste/examples/` as a few-shot
     example and re-scored into agreement, so the queue shrinks as calibration improves.

Taste findings follow the same skeptic, ledger, and fix-ship rules as functional findings.

### 11. Stale web shell fix (app change)

Open tabs can keep running the previous PWA shell after a deploy. Fix: expose the
deployed build version, have the client poll it and react to service-worker updates,
and prompt users to reload (or reload on next navigation). The fix ships through the
normal fix-ship loop. Afterwards, post-deploy checks also run in a pre-opened tab to
confirm that it picks up the new version.

## Additional tooling (adds to the toolkit spec)

| Tool | Install | Trust | Cost |
|---|---|---|---|
| Maestro CLI + MCP (`maestro mcp`) | Maestro Windows installer; Java 21 is present | high (~16k stars) | free |
| Android emulator | Android Studio command-line tools | high | free |
| EAS CLI | `npm i -g eas-cli`, Expo account sign-in | high (official) | free tier |
| Limrun plugin + MCP | `git clone https://github.com/limrun-inc/skills` into `~/.cursor/plugins/local/limrun`, gated by the low-trust read | medium (vendor) | trial, then $20/month on approval |
| Flashlight | Windows installer from flashlight.dev, downloaded and read before running (not piped into `iex`) | medium | free |
| Lighthouse CI | npm dev dependency in `apps/web` | high | free |
| Electron Stagewright MCP | npm, gated by the low-trust read | low (12 stars) | free |
| `agent-browser` with its `dogfood` skill | already installed | high (~45k stars) | free |

## Remaining limits

- Camera hardware, push delivery, and real touch latency on iOS need a physical device
  and are tracked as `blocked: needs-device`.
- Taste calibration reflects the owner's taste, not a broad user panel.
- A full sweep is expensive; areas are re-swept when their code changes.

## Definition of done

- Inventory exists for every surface, with no `unexplained` elements left unresolved.
- Every applicable ledger row is `verified` with evidence, except rows marked
  `blocked: needs-device`, which are listed for physical-device testing.
- Every confirmed bug has a shipped fix, a regression test, and a passing post-deploy re-check,
  or is listed as waiting on the owner (destructive migration).
- Verified flows are codified and pass in CI, including the EAS Maestro iOS job.
- Every taste check passed through a calibrated layer, or was answered by the owner.
- The taste queue is empty, and every judge used alone meets the agreement threshold.
