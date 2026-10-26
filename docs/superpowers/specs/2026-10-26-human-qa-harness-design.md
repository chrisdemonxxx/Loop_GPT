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

## Drivers

| Surface | Primary driver | Fallback |
|---|---|---|
| `apps/web`, admin | Playwright plugin | `agent-browser`, Cursor IDE browser |
| `mobile` (Expo) | Maestro MCP on a local Android emulator | — (iOS is not testable on Windows) |
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

## Additional tooling (adds to the toolkit spec)

| Tool | Install | Trust |
|---|---|---|
| Maestro CLI + MCP (`maestro mcp`) | Maestro Windows installer; Java 21 is present | high (~16k stars) |
| Android emulator | Android Studio command-line tools | high |
| Electron Stagewright MCP | npm, gated by the low-trust read | low (12 stars) |
| `agent-browser` with its `dogfood` skill | already installed | high (~45k stars) |

## Limits

- Agent judgement covers broken, confusing, inconsistent, and inaccessible behaviour well.
  Taste-level calls (brand feel, perceived speed) are approximations.
- iOS is out of scope on this Windows machine.
- A full sweep is expensive; areas are re-swept when their code changes.

## Definition of done

- Inventory exists for every surface, with no `unexplained` elements left unresolved.
- Every applicable ledger row is `verified` with evidence.
- Every confirmed bug has a shipped fix, a regression test, and a passing post-deploy re-check,
  or is listed as waiting on the owner (destructive migration).
- Verified flows are codified and pass in CI.
