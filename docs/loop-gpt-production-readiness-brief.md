# Loop GPT — Production Readiness Completion Brief
**Based on:** `PROJECT_STATUS_REPORT.md`, 2026-09-22
**Goal:** Take Loop GPT from "demoable end-to-end" to "launchable to a paying audience." The UX/UI overhaul is done and verified — do not re-touch it except where explicitly noted. This brief is scoped entirely to closing the gap between "green test gates" and "real production readiness."

**Ground rule for the agents doing this work:** the previous session was honest about what it did and didn't do — preserve that standard. Every item below must be verified live (not just unit-tested) before being marked done. "Tests pass" is necessary but not sufficient; several of the items below exist specifically because tests passed while the real flow was never exercised.

---

## 0. Current State (do not re-litigate, just confirm before starting)

- Product is live at https://loop-gpt.cyou, both Railway services deployed SUCCESS, 21/21 migrations applied.
- Backend: 1041 tests passing, clean build. Frontend: clean typecheck/lint/build, 20 tests, 12 a11y passes.
- The UX brief (Settings IA, composer, slash palette, projects, agent activity panel, voice STT/TTS) is fully shipped and matches spec.
- **Everything from this session's overhaul is uncommitted in the working tree.** First action: **commit it** (see P3 item, but do this first — do not build P0 work on top of an uncommitted tree).

---

## 1. P0 — Launch Blockers (do these first, in this order)

### 1.1 Commit the existing working tree
Before any new work: `git add` + commit everything currently uncommitted from the UX overhaul session, with a clear commit message referencing the brief items delivered (§1.2 of the status report has the full list — use it as the commit body). Do not let new P0 work land in the same uncommitted pile.

### 1.2 Real authentication
**Problem:** Signup creates accounts with no verification. Password reset exists in code but nothing sends the email. No social/magic-link sign-in. This means every real signup today is potentially an orphaned, unverifiable account.

**Do:**
- Wire **Resend** (or equivalent SMTP provider) using the existing `services/email.ts` — it already has `voucherRedeemedEmail` and similar templates, so follow that pattern for verification and reset emails. Add real env vars (API key, from-address) in the production Railway environment.
- Enable **email verification** end-to-end: send on signup, add a verify endpoint/page, gate sensitive actions (or at least clearly flag unverified accounts) until verified.
- Enable **password reset** end-to-end: the `/api/auth/reset` route exists — connect it to real email delivery, verify the full loop (request → email received → link works → password changes → old sessions invalidated).
- Implement or enable **at least one** of magic-link or social sign-in (Google is the natural choice given Google OAuth already exists for connectors — reuse infrastructure where possible, but note login OAuth and connector OAuth are different scopes/flows, don't conflate them). `/api/auth/providers` is currently stubbed to return empty — replace with a real provider list once wired.
- **Verify live, not just unit-tested:** create a real test account end-to-end on the production URL — receive the actual email, click the actual link, confirm the account state changes in the database.

### 1.3 Payments — make a decision and execute it
**Problem:** Stripe is fully built (billing service, `stripeCustomerId`/`stripeSubId`, webhook handling) but disabled via env flags (`STRIPE_CHECKOUT_ENABLED=false`, `STRIPE_FULFILLMENT_ENABLED=false`). This is a business decision as much as an engineering one.

**Do — pick one explicitly, don't leave it ambiguous:**
- **Option A (turn it on):** Set live Stripe keys + webhook URL in the production env, flip both flags to `true`, run a real test purchase (use Stripe test mode first, then confirm with a real low-value live charge), confirm the webhook correctly upgrades the account and that `services/billing.ts` credit logic reflects the new plan immediately.
- **Option B (free-only for launch):** If payments aren't ready to go live yet, don't leave the current ambiguous state — explicitly hide/disable any UI that implies paid plans are purchasable, update the landing page and pricing copy to reflect "free tier only, paid plans coming soon," and leave the Stripe plumbing dormant but clearly flagged as "not live" in internal docs so no one mistakes it for done.
- Either way, this must not ship in the current silent-disabled state where the UI may still reference paid plans that can't actually be purchased.

### 1.4 Real connector smoke run
**Problem:** The new OAuth dual-write + marketplace flows are unit-tested against mocks only — never exercised against a real provider in the live environment.

**Do:**
- Pick at minimum: **Google Drive**, **Google Calendar**, and **one marketplace provider (Figma)** — per the status report's own recommendation.
- For each: perform the actual OAuth consent flow on production, confirm the connector shows Connected in Settings, confirm `Test connection` passes, and confirm the agent can actually call a real tool against it in a live chat (e.g., list files, read an event, fetch a Figma file) and get a correct result back — not just a 200 response.
- Fix anything that breaks in this loop; this is exactly the class of bug ("OAuth'd connectors never appeared in Settings") that was found and fixed once already this session — assume there are more like it until proven otherwise.
- Document the verified list in `docs/PROGRESS.md` or `GAP_REGISTER.md` so the next person knows what's actually been touched by a human vs. only unit-tested.

### 1.5 Backups + monitoring
**Problem:** Single Postgres instance, no backups, no point-in-time recovery, no alerting, no error/log shipping. This is a "one incident from losing everything" situation.

**Do:**
- Enable automated backups on the production Postgres instance (Railway has managed backup options — confirm point-in-time recovery is available, not just periodic snapshots, if the plan supports it).
- Wire basic error tracking (Sentry or equivalent) on both backend and frontend — confirm a deliberately-thrown test error actually shows up in the dashboard.
- Wire basic uptime/alerting (even a simple healthz ping monitor is better than nothing) so a production outage is known within minutes, not discovered by a user complaint.
- Optional but recommended: basic product analytics (PostHog or equivalent) if not already present, since there is currently no visibility into real usage patterns.

### 1.6 Set `ADMIN_INVITE_CODE` in production
Small but explicitly flagged — the env-based team invite code path is implemented (`services/billing.ts:154`) but the env var isn't set in production. Set it and verify the invite flow works end-to-end.

---

## 2. P1 — Required for a Respectable Product

Work these after P0 is fully verified live, not in parallel with it — P0 items are launch-blocking and should not compete for attention.

### 2.1 Mobile parity (GAP-070)
The Expo app exists but doesn't mirror the redesigned web IA. At minimum, bring the mobile app's **chat, settings, and projects** screens up to parity with the new web composer/settings/projects design. Full feature parity (skills editor, connector marketplace, voice) can follow in P2, but the core daily-use surfaces should not feel like a different, older product.

### 2.2 Document ingestion beyond plain text (GAP-041)
Currently knowledge upload only accepts `.txt/.md/.csv` (parsed client-side), and conversation attachments only accept images. Add a real backend extraction pipeline (`pdf-parse`, or Apache Tika, or equivalent) so users can upload PDF/DOCX/XLSX as both project knowledge and chat attachments. This is a core expectation for any product competing with Claude/ChatGPT, where PDF upload is table-stakes.

### 2.3 Nightly memory synthesis (GAP-044)
The schema (`Memory.source`: `user`/`agent`) and the manual "remember" path already work. Build the missing piece: a scheduled job that reviews recent conversations and synthesizes durable preferences/facts into memory automatically (matching how Claude/ChatGPT do passive memory learning), tagged with `source: agent` so it's visually distinguishable in the Memory tab from user-added entries (that UI distinction already exists — just needs a real producer).

### 2.4 Skill / plugin lifecycle and versioning (GAP-015 / GAP-048)
Skills currently overwrite in place with no version history and no install/update lifecycle; plugins have only one reference implementation (`text-utils`) with no marketplace. Add: version tracking on skill edits (so a bad edit can be reverted), and a minimal plugin lifecycle (install/enable/disable/uninstall) that at least one additional real plugin can be built against to prove the pattern works beyond the reference implementation.

### 2.5 Composer/session depth (GAP-045)
Add, in priority order:
- **IndexedDB local drafts** — so an in-progress message survives a refresh/crash.
- **Context meter** — visible indicator of how much context window is used, matching frontier products.
- **Extended-thinking display** — if the underlying model/agent produces intermediate reasoning, surface it the way Claude does (collapsible "thinking" section), rather than only showing the final answer.
- **Message branching** — allow editing an earlier message and forking the conversation from that point, rather than only linear history.
- **Incognito chats** — a session mode that doesn't persist to history or feed memory synthesis.

### 2.6 Shared research scratchpad (GAP-046)
Research currently keeps sub-agent state in-process. Add a durable scratchpad table so a research run can resume after a backend restart instead of losing in-flight state — this matters directly for reliability once real users run longer research tasks against a system that also needs to redeploy regularly.

---

## 3. P2 — Polish and Longer-Term

Work these opportunistically once P0/P1 are stable in production:

- **TOTP MFA** (GAP-042) — for account security, especially once real payments are live.
- **Backend-quality TTS** — replace browser `speechSynthesis` with the existing Kokoro `speak_text` tool once a streaming endpoint exists on the backend, for consistent voice quality across browsers/OSes (current TTS quality varies wildly by client, as flagged in the report).
- **Full hands-free voice mode** (continuous mic + spoken replies) — requires backend audio streaming; do this once the plumbing from the Kokoro item above exists, since it's the same underlying capability.
- **Research resume/branching** as a user-facing feature once the scratchpad (2.6) exists underneath it.
- **Connector tests as real CI** — build lightweight stub servers for the key providers (Drive, Figma, Linear, etc.) so connector regressions are caught in CI, not only by manual smoke runs.
- **Polish the Admin + Developer portals** — both currently function but are behind the visual bar set by the rest of the redesigned product.
- **A real onboarding / "what to try first" page** for end users — currently only internal docs (README, PROGRESS.md) exist; a real user has no in-product guide.
- **Clean up stale docs** flagged in GAP-062 (`PROVIDER_MEDIA_HTTP.md`, stale `/api/models/selection` references in `RUNTIME_AUTHORIZATION.md`/`BUILD_PROGRESS.md`, `ACCOUNTED_VIDEO_JOBS.md` path).
- **Project knowledge upload discoverability** — the empty "0 knowledge chunks" project card doesn't surface the upload action directly; add it inline as a quick win.

---

## 4. P3 — Hygiene (cheap, do whenever convenient)

- Fix the flaky Tavily-dependent test (`src/agent/__tests__/webConsumers.test.ts`) by injecting a fixture server in CI instead of hitting the real network.
- Align model-tier naming: the picker UI says "Large Looper"/"Small Looper" while the backend uses `large`/`standard` — pick one vocabulary and use it everywhere (UI, API, logs, docs).
- Resolve the leftover neon-gradient legacy CSS classes (`neon-violet`, `neon-cyan`, `neon-green`, `neon-fuchsia`) — either deliberately retire them in favor of the new single-accent (`#c96442`) system, or document explicitly why they're being kept and where.

---

## 5. The "Don't Trust Yet" List — Manual Verification Required

These are not known bugs, but they are unverified in a real environment and must be manually exercised before launch, independent of the P0–P3 work above:

1. **Google OAuth end-to-end** (live Drive/Gmail/Calendar/Sheets round-trip) — covered by P0 §1.4, but call out explicitly: token refresh must also be tested, not just initial auth.
2. **All 8 marketplace providers** (Outlook, OneDrive, Dropbox, Linear, Asana, Salesforce, Figma, Zoom) — only Figma is required for P0; the remaining 7 should each get at least one live smoke test before being presented to real users as "available," since Salesforce/Entra in particular are flagged as needing extra config the docs don't yet cover — write that config guidance as part of testing each one.
3. **Step mode ("Ask first")** — unit-tested via `requiresInteractivePause`, but never run end-to-end with a real model across a multi-step turn. Run a real multi-tool-call conversation in Ask First mode and confirm every tool call actually pauses for approval.
4. **Voice loop cross-browser** — STT/TTS behavior varies by browser and OS voice availability. Explicitly test Chrome, Edge, and Safari, and document what degrades gracefully vs. breaks on unsupported browsers (e.g., Firefox, which has weaker Web Speech API support).
5. **`create_skill` meta-tool** — registered, but never confirmed to actually produce a working skill via natural-language chat request. Run the exact flow ("create a skill that...") and confirm the resulting SKILL.md is valid and the skill is immediately usable.

---

## 6. Acceptance Checklist

**P0 (launch blockers — all required):**
- [ ] Working tree committed with clear history
- [ ] Email verification live and manually confirmed end-to-end
- [ ] Password reset live and manually confirmed end-to-end
- [ ] At least one of magic-link/social sign-in live
- [ ] Payments either fully live (real charge tested) or explicitly disabled with UI/copy updated to match
- [ ] Google Drive + Calendar + Figma connector flows manually verified live, including a real tool call
- [ ] Automated DB backups enabled and confirmed (test a restore if possible)
- [ ] Error tracking wired and confirmed with a deliberate test error
- [ ] Uptime/alerting wired
- [ ] `ADMIN_INVITE_CODE` set and invite flow verified

**P1 (required for respectable launch):**
- [ ] Mobile chat/settings/projects screens match new web IA
- [ ] PDF/DOCX/XLSX ingestion works for both knowledge and attachments
- [ ] Nightly memory synthesis job running and producing `source: agent` entries
- [ ] Skill versioning + at least one additional real plugin beyond `text-utils`
- [ ] IndexedDB drafts, context meter, extended-thinking display, message branching, incognito chats shipped
- [ ] Research scratchpad table in place and resume-tested across a backend restart

**Manual verification (independent of build work):**
- [ ] All 5 "Don't Trust Yet" items exercised live and results documented in `GAP_REGISTER.md`

Do not describe this project as "production-ready" again until every P0 box above is checked with real evidence (a screenshot, a log line, a database row) — not a passing test suite.
