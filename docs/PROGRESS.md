# PROGRESS — master-prompt build ledger

Companion to `BUILD_PROGRESS.md` (the older foundation ledger, which stops at
validation 03s). This file records the master-prompt (A4/A9) delta and the
evidence for each claim. Every "Working" item was run.

## Production-readiness Phase 0 — audit §10 open questions resolved (2026-09-26, live-infra verified)

Resolved against live Railway + Resend state (not guesses). Audit = `AUDIT_REPORT.md` §10.

- **Q1/P10 Resend — RESOLVED DIFFERENTLY THAN ASSUMED.** The 11-domain Resend
  account never had `loop-gpt.cyou`. A **second Resend account** (free plan)
  already has exactly one domain: `loop-gpt.cyou`, status **verified** — no DNS
  work needed. The production backend's `RESEND_API_KEY` pointed at the old
  account, so the actual fix was swapping the prod key to the new account's
  key + setting `MAIL_FROM`. Email sending now live; E2E evidence below.
- **Q2/P11 backups — RESOLVED.** Prod Postgres was a raw
  `postgres:16.10-bookworm` image + volume (no PITR). Operator enabled Daily
  dashboard volume backups on `candidate-postgres-data`, then executed the
  **in-place image swap** to `ghcr.io/railwayapp-templates/postgres-ssl:16`
  (same service/volume/`DATABASE_URL`, ~2 min restart, no data cutover).
  Procedures + restore steps: `docs/RUNBOOK.md`. Scratch-restore rehearsal
  **pending** the `DATABASE_URL` value.
- **Q3/P8 marketplace OAuth — CONFIRMED NOT LIVE-TESTED.** Zero live
  round-trips for the 8 marketplace providers. Existing CI = generic
  marketplace-adapter stub only. Per-provider stub tests now added (below);
  live smoke runs (Figma first) still need real provider OAuth apps —
  NEEDS CONFIRMATION.
- **Q4 observability — CONFIRMED ABSENT, then wired.** `SENTRY_DSN`,
  `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_POSTHOG_KEY` were absent from
  production (backend 59 vars / web 16 vars). Keys supplied by operator and
  set; see "Observability wiring" below. Architectural note: `NEXT_PUBLIC_*`
  must be set on the **web** Railway service (baked at build inside
  `web/Dockerfile`).
- **Q5 web/ — SPLIT VERDICT.** `web/src` (Vite React-19 client) is dead code,
  never deployed — archived to `attic/web-client/`. BUT `web/Dockerfile` +
  `web/nginx.template.conf` (+ `.dockerignore`, `Dockerfile.dockerignore`,
  `railway.json`) ARE the live production deployment path (they build the
  Next.js `frontend/` static export and proxy `/api` + `/v1`). Kept in place.
- **Q6 loop-code/ — CONFIRMED DORMANT** (single initial commit, no live
  references; backend `POST /api/agent/completions` relay is its companion).
  Archived to `attic/loop-code/`.
- **Q7 gateway/ — EFFECTIVELY DEAD.** The legacy Railway project (`loop-gpt`,
  c4381399 — LibreChat + Mongo + rag + cf-tunnel) is fully **FAILED** since
  2026-09-05/06; the live product is served from the owned-staging project.
  Archived to `attic/gateway/`. (No DNS hostname known to still point at the
  dead project.)
- **Q8 pricing values — CONFIRMED.** `services/billing.ts`: PLAN_LIMITS
  free/pro/gold = 30/1000/5000 credits + 5/100/500 imageCredits per day;
  CREDIT_COST chat 1, agent 1, research 3, image 2, video 10. Copy mismatch
  found + fixed: landing free tier said "3 images/day" (actual 5) —
  `frontend/app/page.tsx` updated. `/account` Pro copy already matched.
- **§10 Q5 create_skill — RESOLVED SHIPPED** (E2E with real model, evidence
  in the 2026-09-22 pass above). §10 Q9/Q11/Q12 remain NEEDS CONFIRMATION
  (product decisions).

## Production-readiness Phase 1 — P0 blockers executed (2026-09-26)

- **1.2 DB — EXECUTED + VALIDATED.** Staged patch committed via MCP
  (`accept-deploy`, deployment `510bed66`): postgres image swapped in-place to
  `ghcr.io/railwayapp-templates/postgres-ssl:16` (same service/volume/
  `DATABASE_URL`). Startup logs: glibc 2.36→2.41 collation version mismatch
  auto-resolved by the template ("rebuilt 80 collation-dependent index(es);
  collation version stamps refreshed") — data dir reused, no re-init.
  Post-swap validation: all 5 services SUCCESS; `GET /healthz` → 200 through
  the web proxy; a real `POST /api/auth/register` (DB-backed) succeeded —
  proves backend → new Postgres end-to-end. Dashboard Daily volume backups:
  operator asserts ON. Scratch-restore rehearsal still pending the
  `DATABASE_URL` value (steps: `docs/RUNBOOK.md` §3a).
- **1.1 Email — WIRED + DELIVERY CONFIRMED.** Prod backend `RESEND_API_KEY`
  swapped to the account that owns the verified `loop-gpt.cyou` domain;
  `MAIL_FROM` = `Loop GPT <noreply@loop-gpt.cyou>`. Backend redeployed
  (deployment `7c3fc83e`). Evidence (Resend API `last_event`):
  direct smoke → `delivered`; real signup → welcome + verify emails
  `delivered` to chrisdemonxxx+loopgpt-e2e@gmail.com;
  `POST /api/auth/forgot` → reset email `delivered`.
  **NEEDS CONFIRMATION (operator click):** the `/verify` link (flips
  `emailVerified`) and the `/reset` link (flips password + sets
  `sessionInvalidatedAt`). SMTP fallback remains code-ready but unarmed
  (no `SMTP_*` in prod env; single env change when credentials exist).
  Resend free plan cap: 100 emails/day — fine for verification/reset volume.
- **1.4 Connector stub CI — SHIPPED.** New
  `backend/src/agent/connectors/__tests__/marketplaceProviders.test.ts`:
  44 tests, all 8 marketplace providers (registry contract incl. the
  Salesforce `{instanceUrl}` special case, PKCE init route per provider,
  adapter Bearer calls against each provider apiBase, probe 401/403
  semantics, missing-token handling). Full backend suite green:
  **1128 passed / 5 skipped across 56 files**. Live OAuth round-trips
  (Figma first) still open — need real provider OAuth apps
  (steps in `docs/CONNECTOR_SETUP.md`).
- **1.5 Payments — Option B re-verified.** No Stripe keys exist in prod;
  landing shows "Free during launch"; `/account` hides Upgrade when Stripe
  disabled. Copy fix shipped: landing free tier now says "5 images/day"
  (matches PLAN_LIMITS free imageCredits=5; was "3").
- **1.6 Archive sweep — SHIPPED.** `attic/{gateway, loop-code,
  web-vite-client}`; `web/` keeps only the live deployment files (Dockerfile,
  nginx.template.conf, Dockerfile.dockerignore, .dockerignore, railway.json).
  `web-validation.yml`: dead `web-harness` job removed, replaced with a
  deployment-file presence check. Frontend suite green (32 tests) +
  `next build` green.
- **1.3 Observability — code-ready, keys pending.** `SENTRY_DSN` (backend),
  `NEXT_PUBLIC_SENTRY_DSN` + `NEXT_PUBLIC_POSTHOG_KEY` (web service — baked
  at build in `web/Dockerfile`) will be set the moment keys are supplied;
  then an intentional test error verifies the Sentry pipeline. Uptime
  monitor on `https://loop-gpt.cyou/healthz` (UptimeRobot/BetterStack free
  tier) needs an operator account. Both NEEDS CONFIRMATION until then.

## Phase 1 CLOSE-OUT (2026-09-26, all P0 blockers resolved)

- **1.1 Email — FULLY CLOSED with production evidence.** Complete 6-step E2E
  chain against live prod: real signup → Welcome + Verify emails `delivered`
  (Resend `last_event`) → `POST /api/auth/verify` consumed the token and
  flipped `emailVerified` (visible as `t` in the DB dump taken later) →
  login(old password) OK → `POST /api/auth/reset` with a fresh token OK →
  **the pre-reset JWT was rejected 401 after reset** (`sessionInvalidatedAt`
  proven) → login(new password) OK. Notes: reset tokens TTL = 1h
  (`services/tokens.ts`; the browser-agent round trip outlived the first
  token — a fresh one was pulled from the delivered email body via the
  Resend API). Tokens are stored SHA-256-hashed with compare-and-set burn.
- **1.2 Backups — FULLY CLOSED.** Daily volume backups confirmed ON in the
  dashboard (retention 6 days). Scratch-restore rehearsal EXECUTED: temp
  TCP proxy → `pg_dump` (774 KB, SHA256 84D2669B…42470A) → `pg_restore` into
  a scratch postgres:16 container → **33/33 tables**, 13 users (incl. E2E
  account with `emailVerified=t`), 6 verify + 3 reset token rows, 199 usage
  events — restore path proven, proxy deleted immediately. Evidence in
  `docs/RUNBOOK.md` §3a.
- **1.3 Observability — WIRED + PIPELINES VERIFIED.**
  - Backend: `SENTRY_DSN` set (runtime env, deployment `2472bec4` live).
  - Web: `NEXT_PUBLIC_SENTRY_DSN` / `NEXT_PUBLIC_POSTHOG_KEY` /
    `NEXT_PUBLIC_POSTHOG_HOST` set on the web service — and a real gap was
    found + fixed: Railway passes service vars as Docker **build args**, but
    `web/Dockerfile` never declared them, so the static export shipped
    un-instrumented. Fix (commit `336f4c0`): `ARG`+`ENV` declarations before
    `npm run build`; all services redeployed on the branch push.
  - Pipeline verification: PostHog `capture/` → `{"status":"Ok"}`; Sentry
    envelope ingest → HTTP 200 on BOTH DSNs (backend event
    `bc9c0f11e06cc85b3654529eba14110e`, web event
    `c07056ba6a6aad87c13c31c0b1e41b6a`) — synthetic "Phase 1.3 pipeline
    verification" events visible in the Sentry dashboards.
  - REMAINING NEEDS CONFIRMATION: uptime monitor account on
    `https://loop-gpt.cyou/healthz` only (operator chose not to sign up for
    it in this pass). Post-deploy chunk verification DONE: the rebuilt
    bundle serves the PostHog key + web Sentry DSN in
    `_next/static/chunks/app/layout-a2d860bd651be591.js` and
    `app/chat/page-a032830b95bca0f7.js` (fetched from production).
- **Web bundle hygiene**: the deployed `web/` now builds from repo commit
  `336f4c0` (branch `release/owned-staging-20260917` pushed).

## Production-readiness Phase 4 — architecture cleanup (2026-09-26, executed before Phase 2 as planned)

Structural prerequisite for the Phase 2 UI rebuild; zero behavior change,
gated by the full suites.

- **`frontend/app/chat/page.tsx` (755 → 440 lines)** — thin orchestration
  shell. Extracted: `app/chat/hooks.ts` (`usePanels` panel/desktop state,
  `useWorkspaceProjects` bootstrap, `useConversationsData` react-query layer,
  `useChatStream` the live-run state machine + send pipeline incl. uploads,
  approval handshake, once-per-run activity auto-open); presentational
  `ChatHeader.tsx` (export-menu state now header-local).
- **`MessageList.tsx` (593 → 142)** — split into `MessageBubble.tsx`,
  `ArtifactCard.tsx` (+ fullscreen `ArtifactViewer`), `artifactUrl.ts`
  (authed URL hooks + download), `EmptyState.tsx` (+ `ThinkingDots`),
  shared `types.ts`. Same props contract.
- **`Composer.tsx` (432 → 252)** — public props unchanged (pinned by its
  test); `composer/SlashPalette.tsx` (also owns `RunModePicker`),
  `composer/PlusMenu.tsx` (also `AttachmentChips` + `DictationBar`).
  Menu mutual-exclusivity preserved via `onCloseOther` callbacks.
  (A `ComposerContext` was considered and deferred — Phase 2 will
  restructure the page→composer boundary anyway.)
- **Backend `routes/agent.ts` (788 → 389)** — the ~280-line
  `POST /:conversationId/stream` pipeline moved verbatim to
  `controllers/agentStream.ts` (`streamAgentRun`), `requestLifecycle`
  exported and shared with the completions route.
- **Backend ESLint — NEW.** ESLint 8 + @typescript-eslint 7 extending the
  shared root `eslint.base.json`; `npm run lint` gates CI
  (`backend-validation.yml`, after `npm ci`). Rollout fixed 26 errors:
  auto-fixables, regex class-escape cleanups, typed mock helpers,
  `chatStore` lazy bcrypt → dynamic import, a real paren repair in the
  `dailyDisconnect` it.each. Deliberate control-char sanitizers
  (provider/public http, httpClient, documentText) and the fail-closed
  cleanup throw (privateStorage) carry documented inline disables.
  29 `no-unused-vars` advisories remain as non-gating warnings.
- **`neon-*` Tailwind aliases — REMOVED.** The audit's own precondition was
  already stale: 39 references still existed (account/admin/auth pages,
  ArtifactsPanel, primitives, AgentComputer). All migrated to exact-value
  arbitrary classes (`text-[#c96442]` etc. — generated CSS identical), then
  the alias block deleted from `tailwind.config.js`.
- Gates: frontend `tsc` + 32 unit tests + 12 Playwright + `next build`;
  backend `tsc` + 1128 tests + lint 0 errors. Both commits pushed and
  deployed via the branch (`db08c53`, `22a7443`).

## Phase 2.2 — Right-hand panel is the artifact surface (audit P2) — SHIPPED (2026-09-26, commits `84ae3be`/`a1e249e`/`32960e4`)

- **Card → panel flow**: artifact cards (stored + live) open the
  `ArtifactsPanel` focused via page-owned `focusId` threaded through
  MessageList/MessageBubble; the inline `ArtifactViewer` modal is deleted;
  "Back to list" header state added. The panel is now exclusively for
  viewable output (the P1 mutex removal completed the hand-off).
- **Panel chrome** (all previously absent): persisted draggable resize
  (localStorage `artifactsPanelWidth`, 320–720px, lg+ handle), fullscreen
  toggle, device-size toggle (desktop/tablet/mobile widths) for HTML
  sandbox previews, Refresh (iframe nonce), and the **Fix error** flow —
  the sandbox srcDoc carries an error bridge reporting uncaught
  errors/rejections to the panel, which pre-fills the composer with the
  error + artifact source for regeneration.
- **In-panel viewers**: PDF (native-engine blob iframe), xlsx/csv (dynamic
  SheetJS table), Mermaid (dynamic mermaid render — `.mmd` artifacts and
  ```mermaid fences in Markdown, previously absent entirely).
- **"Open in new tab" for private artifacts** (previously 401-only for
  non-published): `POST /api/files/:id/signed-link` mints a 5-minute
  HMAC link (owner+file+expiry bound, timing-safe compare —
  `services/signedFileUrl.ts`); `GET /:id/content` accepts it without a
  session and renders **inline** under a sandboxed renderable CSP. Unit
  tests (round-trip, tamper, cross-file, expiry) + integration E2E
  (owner-mints/foreign-404/tampered-401/cross-file-401/inline-vs-attachment).
- **"Building…" per-artifact state**: in-flight
  create_document/generate_image/generate_video/generate_style tool steps
  render shimmer placeholders in the panel (page derives `buildingKinds`
  from `useChatStream` steps) — replacing the generic status-only signal.
- Focused image/video previews fixed to authed blob URLs (raw src 401s).
- 5 new panel component tests; suite **45/45**, Playwright **12/12**,
  build green (xlsx/mermaid are dynamic imports — initial bundle flat).

## Backend integrity: chronic CI red discovered + resolved (2026-09-26)

- **Discovery**: Backend validation CI had been **failing on every push since
  2026-09-21** (15/15 runs red; Railway deploys don't run GitHub Actions, so
  it went unnoticed — including by the 2026-09-22 readiness pass). Root
  causes: (1) real migration/schema drift — FK ON DELETE semantics, 4 stale
  indexes, SpendBudgetPolicy defaults edited in schema.prisma without
  migrations; (2) the conditional pgvector migration guaranteed diff drift on
  plain postgres CI images; (3) CI never reached `test:integration`, so 4
  stale tests sat unexercised (catalog id `loop-chat-large` vs renamed
  `loop-large`, `create_custom_tool`/`create_skill` now reviewed tools,
  the 410 "retired" config verbs superseded by the live config-store routes).
- **Fixes**: `20260926000000_schema_reconciliation` migration (verified by
  fresh shadow replay → only the irreducible embeddingVec artifacts remain);
  CI postgres image → `pgvector/pgvector:pg16` (pinned) so the vector path
  applies; the diff gate allowlists exactly the two embeddingVec artifacts;
  the 4 stale tests refreshed to pin the current contract. **First green
  backend CI run since 09-21** on `a1e249e`.
- **Production incident during rollout** (caught + fixed same day): the
  reconciliation failed on prod with FK 23503 — `Memory.projectId` had 5
  orphaned references (of 35) because the FK was never live, so Project
  deletes left dangling pointers. Fix: the migration now nullifies orphans
  first (exactly what `ON DELETE SET NULL` would have done). Applied to
  prod via `migrate resolve --rolled-back` + `migrate deploy` through a
  temporary (since-removed) TCP proxy; prod diff now shows only the
  expected pgvector-conditional column. Backend redeployed healthy; all CI
  workflows green on `32960e4`.
- Gates: backend unit **1132/5**, integration **457/3** (incl. signed-link
  E2E), lint 0 errors, tsc clean; frontend 45/45 + 12/12 Playwright + build.

## Phase 2.3 — Real HTTP byte-range video streaming (audit P3) — SHIPPED (2026-09-26, commit `c670a8c`)

- **Backend** (`privateFiles.ts`): `parseRange` + `sendFileResponse` — the
  FIRST content response now advertises `Accept-Ranges: bytes` (the missing
  piece that kept native players from even attempting range requests);
  `Range` requests return `206 Partial Content` with `Content-Range`
  (bounded `bytes=a-b`, open-ended `bytes=a-`, suffix `bytes=-n` forms),
  unsatisfiable ranges return `416` + `bytes */total`. Serves the
  header-auth path, the signed-link path, and the published-token route.
- **Frontend**: the blob-download video flow is gone. New
  `VideoPlayer.tsx` streams from a short-lived signed URL
  (`useSignedArtifactUrl`) so the native element issues real byte-range
  HTTP — instant playback start and streaming seeks. Adds the buffering
  indicator (waiting/stalled → spinner; playing/canplay clears), the
  first-frame poster via `preload="metadata"`, a **Picture-in-Picture
  control** where the engine supports it, and a one-shot re-mint when a
  session outlives the link TTL. Wired into the chat `ArtifactCard` and
  the focused panel view. No HLS/DASH — direct-URL ranges are the fix,
  per the plan.
- **Test-harness alignment fix**: the files integration app now mounts
  `publicFilesRouter` before `filesRouter` exactly like `server.ts` — the
  router-wide auth `use()` previously swallowed the anonymous public path
  (a real mounting-order dependency the stale suite never caught).
- **Tests**: 6 `parseRange` unit tests; 2 integration E2Es (first-response
  headers + all 206 forms + 416; ranges over signed links AND published
  tokens); 4 `VideoPlayer` component tests (signed src, buffering overlay,
  once-only re-mint). Gates: backend unit **1138/5**, integration
  **459/3**, lint 0, tsc clean; frontend **49/49**, Playwright **12/12**,
  build green. Deployed on `c670a8c`; live bundle carries the stream
  placeholder, signed-link minting, and PiP signatures; healthz 200.

## Phase 2.4 — Image CLS hygiene + real lightbox (audit P4) — SHIPPED (2026-09-26, commit `d870c05`)

- **Dimension pinning (now actually true)**: the brief's "vision pipeline
  already stores dimensions" was aspirational — nothing persisted them.
  Now: `services/imageDimensions.ts` sniffs intrinsic PNG/JPEG/WebP sizes
  from headers (no decode), and the stream controller persists
  `imageWidth`/`imageHeight` into the user-message metadata for the first
  uploaded image. The client sets explicit `<img width/height>` from that
  metadata — layout shift eliminated for new messages.
- **Lazy/async + shimmer everywhere**: stored user images
  (`loading="lazy" decoding="async"`), ArtifactCard images render a sized
  shimmer skeleton while the authed blob loads and fade in on load,
  the panel's focused image gets a shimmer placeholder, composer chips pin
  80×80.
- **`Lightbox.tsx`** (the real `ArtifactViewer` successor): body-ported
  fullscreen viewer — pinch/wheel/double-click zoom (1–4×) with drag-to-pan
  when zoomed, next/prev across the conversation's images (buttons, arrow
  keys, horizontal swipe, wrapping), swipe-down-to-close on touch, Esc and
  backdrop close. Opens from the panel's focused image via an expand
  affordance.
- **Tests**: 4 `imageDimensions` unit tests (PNG IHDR, JPEG SOF, malformed,
  data-URI), 5 Lightbox component tests (portal+counter, nav buttons/keys
  with wrap, double-click zoom, Esc/button close, single-image chrome).
  Gates: backend **1142/5** unit, **459/3** integration, lint 0, tsc clean;
  frontend **54/54**, Playwright **12/12**, build green. Deployed on
  `d870c05`; all four CI workflows green; healthz 200; live bundle carries
  the lightbox + metadata-dims signatures.
- Note: generated-image artifacts don't carry dimensions server-side yet
  (upload path only); their CLS is covered by the shimmer skeleton.

## Phase 2.5 — Transitions (audit P5) — SHIPPED (2026-09-26, commit `3eb2f74`)

- **Thinking pulse**: `ThinkingDots` upgraded from anonymous dots to a
  labeled "Thinking…" pulse (status role, terracotta dots, shimmer-text
  label) — it owns the dead gap between send and the first token/tool
  event; the status line takes over once the run reports progress.
- **Crossfade, not pop**: individual step cards already crossfade
  (150ms scale+fade, from 2.1); the TurnActivity block itself now eases
  in with a 150ms fade (no scale pop).
- **prefers-reduced-motion — verified inherited end-to-end**:
  `MotionConfig reducedMotion="user"` (providers) covers all framer
  transitions in the new components; the global CSS media-query
  kill-switch covers shimmer/bounce/pulse keyframes. No new animation
  escapes either.
- 2 new tests (status-region + label + dots; EmptyState starter-prompt
  dispatch). Gates: frontend **56/56**, Playwright **12/12**, tsc +
  build green. Deployed on `3eb2f74`; CI green; live bundle carries the
  pulse; healthz 200.

## Phase 2.6 — Mobile + responsive (audit P6) — SHIPPED (2026-09-26, commit `78e5e83`)

- **Real `md` breakpoint**: `usePanels` tracks tablet (≥768px) and desktop
  (≥1024px) separately — the sidebar is a persistent column from tablet up
  (`md:relative`/`md:z-20`), distinct from the phone drawer; the mobile
  backdrop renders only below 768px. The right panel still docks at lg.
- **iOS keyboard**: `useKeyboardSafeBottom` listens to `visualViewport`
  resize/scroll and writes the intrusion distance to `--kb-offset`; the
  composer's bottom padding is now
  `max(0.75rem, calc(env(safe-area-inset-bottom) + var(--kb-offset)))` so it
  lifts above the keyboard instead of being covered.
- **Sidebar width**: spec formula `w-[min(20rem,calc(100vw-2rem))]` — no
  overflow at 320px viewports (was a hardcoded 260px + 82vw).
- **44px touch targets**: `.tap-target` utility (pseudo-element pad, keeps
  the 28–32px visuals) on the composer `+`, mic, run-mode picker, and
  send/stop controls.
- **Bottom sheets on mobile**: the artifacts panel renders as a true bottom
  sheet below lg (slides up, 85dvh, rounded top, drag handle) instead of
  sliding in from the right; docked desktop panel and fullscreen overlay
  unchanged. (The ActivityPanel half of this item was already satisfied by
  2.1 — activity is inline per turn, no side panel.)
- **WCAG AA contrast pass** over the whole chat surface (16 files):
  `text-slate-500→400`, `600→500`, `700→500`, `placeholder-600→500`.
- **Tests**: 4 new (keyboard-offset math + no-viewport fallback, sheet-mode
  class assertions, tap-target presence); Playwright's mobile-chromium
  (Pixel 5) project exercises the responsive layout in the a11y gate.
  Gates: frontend **60/60**, Playwright **12/12** (desktop + mobile),
  tsc + build green. Deployed on `78e5e83`; CI green; live bundle carries
  keyboard-offset, tap-target, and bottom-sheet signatures; healthz 200.

**Phase 2 status: 2.1–2.6 all shipped.** Remaining from the Phase 2 brief:
2.7 composer gaps (drag-and-drop uploads with drop-zone overlay,
paste-image support, upload progress + visible errors).

## Phase 2.1 — Inline agent activity (audit P1) — SHIPPED (2026-09-26, commit `687abb4`)

- **`TurnActivity.tsx` (new)** renders the per-turn activity inline, directly
  below each assistant response: one-line summary ("Ran N steps" + state
  icon) expanding into the full tool-call timeline. Auto-expands while the
  run streams, **auto-collapses on completion** (the audit's missing
  behavior), per-step wall durations (`durationMs` stamped in
  `onToolResult`, formatted `480ms/1.2s/2m 05s`), a visible **Retry button
  on the error state**, and the approval card + available-tools popover in
  flow. Detail mode = the focused step's expanded card on demand.
- Stored turns summarize from `message.metadata.steps` (the runtime's final
  event persists `{tool, args, result}[]` — verified in
  `agentRuntime.ts`); live turns stream the full timeline.
- **Mutex dead**: `ActivityPanel.tsx` + `AgentComputer.tsx` deleted;
  `computerOpen`/`openComputer` removed from `usePanels`, header, and page;
  the right edge is now exclusively the `ArtifactsPanel` (the P2
  prerequisite). The once-per-run auto-open wiring is gone (nothing to
  open — activity is in-flow).
- 8 new component tests in
  `app/components/chat/__tests__/TurnActivity.test.tsx` (summary,
  expand, auto-collapse on completion, error retry, duration formatting,
  approval dispatch, empty-state). Gates: suite **40/40**, Playwright
  **12/12**, `next build` green. Deployed on `687abb4` and verified live
  (summary/durationMs/approval/error-state signatures present in the
  served chat chunk; healthz 200).


## Production-readiness pass (2026-09-22, phases 0–7) — COMPLETE

Full brief executed: P0 launch blockers → P1 product depth → P2 polish →
P3 hygiene, each with gates and (where possible) live evidence. Final state:
backend **1077 tests / 55 files**, frontend **tsc/lint/build + 32 tests +
Playwright 12**, mobile **tsc** — all green; **25/25 migrations applied**;
both Railway services **deployed SUCCESS**; live probes 200 across
`/healthz`, `/chat`, `/account`, `/onboarding`.

- **P0** (see GAP_REGISTER "live evidence" section): auth live (Google+GitHub
  sign-in 302s verified, providers endpoint live, session invalidation on
  reset), payments Option B (free-only, honest UI + `STRIPE_LIVE_CHECKLIST.md`),
  connector OAuth init bug found+fixed+verified (all four Google connectors
  + Figma guidance PASS), ADMIN_INVITE_CODE E2E (register→redeem→unlimited
  in DB→cleanup), step-mode + create_skill E2Es with the real model, all
  recorded with evidence. Email transport wired (RESEND_API_KEY + MAIL_FROM
  in production env) — **sending blocked by the Resend plan's domain limit**
  until `loop-gpt.cyou` is added (needs plan upgrade or a freed slot).
- **P1**: PDF/DOCX/XLSX ingestion (knowledge + chat attachments, server-side
  extraction, `documentText.ts` + upload routes + Composer/ProjectsPanel UI);
  nightly memory synthesis (03:00 cron, source:'agent', caps + dedupe +
  memoryEnabled + incognito gating, admin trigger, 5 tests); skill versioning
  (snapshots + revert + history UI) + plugin lifecycle (safe data-plugin
  manifests: install/uninstall routes + installer UI + new time-utils
  built-in); session depth — IndexedDB drafts, context meter,
  extended-thinking (reasoning_content split → collapsible Thoughts, live +
  persisted), message branching (`/fork` + Edit-to-branch), incognito
  conversations (migration, sidebar/synthesis/memory/tool exclusions, Ghost
  toggle); research scratchpad (per-query phase cache, 24h TTL, resume from
  last completed phase, fail-open); mobile parity (4-mode chips + thinking
  bubbles in Chat, new Settings + Projects screens, nav).
- **P2**: TOTP MFA (otplib v13; setup/verify/disable routes, login challenge,
  account-page QR, 4 tests); backend TTS route (`POST /api/tts` — Kokoro
  bytes; browser-speechSynthesis fallback for read-aloud everywhere);
  onboarding tour (`/onboarding` + empty-state link); connector CI stubs
  (7 fixture tests); project-card inline upload affordance.
- **P3**: Tavily flake root-caused + fixed (real rerank call in a bounds
  test — now SEARCH_RERANK=false); neon-* classes documented as legacy
  aliases of the terracotta palette; stale docs banners (GAP-062); stray
  `backend/backend` migration tree caught + moved into the real migrations
  dir; working tree fully committed (9 commits this pass).
- **Open external items** (need operator accounts/access, precisely scoped):
  ① Resend: add `loop-gpt.cyou` (plan upgrade or free a slot — the failed
  `xwf-adsgoogle.com` is a candidate) → verification + reset emails go live;
  ② Sentry DSN + PostHog key env vars (code ready, one env change);
  ③ DB backups: PITR needs the Postgres image migrated to
  `ghcr.io/railwayapp-templates/postgres-ssl` (planned maintenance; volume
  backups can be toggled from the dashboard today); ④ uptime monitor account
  (UptimeRobot/BetterStack free tier on `/healthz`); ⑤ provider consent
  clicks: Google console callback URIs + one OAuth consent per provider, and
  the Figma app creation (steps in `docs/CONNECTOR_SETUP.md`).

## This slice (HEAD: `release/owned-staging-20260917`)

| Item | Change | Evidence |
|---|---|---|
| Extension routes re-mounted (GAP-026) | Removed the blanket 410 on `/api/agent/{skills,plugins,connectors,mcp-servers,custom-tools}`; added real GET/POST/DELETE management routes; `initAgent()` now inits plugin/connector/custom-tool/MCP registries and registers the meta-tools. | `src/routes/agent.ts`, `src/agent/index.ts`; `src/routes/__tests__/agentConfig.test.ts` (8 tests) |
| Attach contract fixed | `stream.ts` now forwards `attachmentId`; `chat/page.tsx` reads `attachmentId` (was `imagePath`) — image attachments reach the vision path. | `frontend/app/lib/stream.ts`, `frontend/app/chat/page.tsx` |
| Video inline playback | `ArtifactRef.kind` gains `video`; `mp4/webm → video`; inline `<video controls>` cards + fullscreen viewer. | `src/agent/types.ts`, `src/agent/artifacts.ts`, `MessageList.tsx` |
| SearXNG primary + rerank (GAP-008) | Provider order is now SearXNG → Brave → Tavily → DDG → Bing; candidates reranked by bge-reranker (fail-open). | `src/agent/tools/webSearch.ts`; `webConsumers.test.ts` (updated for the new order) |
| Per-modality optimizer + reveal toggle (GAP-006) | `optimizePromptDetailed(raw, modality)` for chat/agent/research/image/video; raw stored, enhanced sent, pair in `metadata.prompt`; UI toggle. | `src/services/promptOptimizer.ts`, `routes/agent.ts`, `tools/generateImage.ts`, `tools/generateVideo.ts`, `MessageList.tsx`; `promptOptimizer.test.ts` |
| User skills injected (GAP-014) | Enabled user skills (skillLoader) selected by trigger and injected, with a name/description index. | `routes/agent.ts` |
| Code sandbox (GAP-011/012) | New `execute_code` tool: Docker isolation (network-none, caps, read-only+tmpfs) with host-subprocess fallback, scrubbed env, timeout, artifact collection. | `src/agent/tools/executeCode.ts`; `executeCode.test.ts` (5 tests, real JS execution) |
| Durable research (GAP-017/018) | `ResearchRun` model + migration; runs decoupled from the HTTP response, progress/report persisted; `GET /api/agent/research[/:id]`. | `prisma/schema.prisma`, `prisma/migrations/20260923000000_research_runs`, `src/services/researchRuns.ts`, `routes/agent.ts`; `researchRuns.test.ts` |
| Model selector (GAP-027) | Hosted-tier picker with capability badges; tier sent as `model`. | `components/ModelSelector.tsx`, `chat/page.tsx` |
| Artifacts panel (GAP-020) | Wired the unused panel into the header; sandboxed `<iframe srcDoc>` HTML preview. | `chat/page.tsx`, `ArtifactsPanel.tsx` |
| Per-tool permissions + audit (GAP-013) | allow/approval/blocked enforced in the loop; bounded audit log; `GET/POST /api/agent/permissions`, `GET /api/agent/audit`; Settings → Tools UI. | `configStore.ts`, `agentRuntime.ts`, `routes/agent.ts`, `SettingsPanel.tsx` |
| Memory + Styles UI (GAP-021/022) | New authenticated `routes/memory.ts`; `/api/styles` now authenticated; Settings tabs for both. | `routes/memory.ts`, `server.ts`, `routes/styles.ts`, `SettingsPanel.tsx` |
| Public artifact publish (GAP-020) | `POST/DELETE /api/files/:id/publish` + anonymous `GET /api/files/public/:token/content`; `publishToken` column; version compare (line diff) in the panel. | `privateFiles.ts`, `routes/files.ts`, `server.ts`, `ArtifactsPanel.tsx` |
| ref2lock multi-ref (GAP-005) | `reference_images[]` accepted; first anchors identity, extras forwarded; count returned. | `tools/generateVideo.ts` |
| pgvector (GAP-028) | Extension + `embeddingVec vector(1024)` + ivfflat index; ANN search with jsonb fallback. | `prisma/schema.prisma`, `prisma/migrations/20260923020000_pgvector`, `services/vectorSearch.ts`, `routes/projects.ts`, `tools/searchKnowledge.ts` |

## Verification commands (this session)

- `cd backend && npm run build` → exit 0.
- `cd backend && npm test` → **45 files, 1016 passed, 5 skipped** (unit; no DB).
- `cd backend && npm run generate` → Prisma client v5.22.0 generated.
- `cd frontend && npm run build` → exit 0 (16 routes).
- `cd frontend && npm run lint` → exit 0 (warnings only: `no-img-element`).

## Acceptance-criteria status (master §7)

1. Image render + download — code path + authed blob; **Pass (unit/build)**.
2. Video inline play + download — **Pass (build)**.
3. Image gen text + image+text — tool built; live endpoint pending.
4. Video ref2lock — single reference wired; multi-ref + consistency evidence pending.
5. Auto-optimized prompt + reveal toggle — **Pass (unit)**.
6. One attach entry point — **Pass**.
7. MCP discovery + approval + permission levels + audit — **Pass (unit)**: discovery, approval card, per-tool allow/approval/blocked, audit log.
8. One skill + one plugin end-to-end — **Pass (unit)**: create skill → enabled → injected; enable plugin → tool registered.
9. Resumable multi-step research — durable run + report persistence; live DB apply pending.
10. Real isolated code execution — **Pass (unit)**: real JS in the sandbox, artifacts returned.
11. Five docs consistent — `AUDIT.md`, `HF_ORG_INVENTORY.md`, `GAP_REGISTER.md`, `DECISIONS.md`, `PROGRESS.md` (this file).
12. Single HF GPU endpoint — **pending** (GAP-023).
13. Zero TODO/mock in shipped code — grep clean (only `placeholder` input hints).

## Live deployment (2026-09-21)

The rebuilt platform is live on the apex domain.

- **Railway project** `loop-gpt-owned-staging-20260917`
  (`8584f5ac-2000-4311-9dae-ae283b70216f`, production `2faec73c-…`).
- **Migrations**: all 19 applied to `loop_staging` (`prisma migrate deploy`
  against the Postgres TCP proxy). The pgvector migration is resilient when the
  extension is absent.
- **backend** deployed from repo root (`deploy/owned-staging/backend.Dockerfile`);
  `/ready` = 200. Fixed a deploy-blocking bug: `backend/.gitignore` had an
  unanchored `skills/` that excluded `backend/src/agent/skills/` from the
  `railway up` upload.
- **web** deployed from repo root (`web/Dockerfile` builds `frontend/` static
  export; nginx proxies `/api` + `/v1` to `backend.railway.internal:3001`).
- **DNS** (Cloudflare API): apex/app/api/chat/www CNAMEs re-pointed to the
  Railway edge for the new domains, with fresh `_railway-verify` TXTs.
- **Verified live**: `https://loop-gpt.cyou` → 200 (landing), `/chat/` → 200,
  `/login/` → 200, `/api/models/catalog` → 200, `/api/agent/tools` → 401
  (auth-gated), `/healthz` → 200; valid TLS. `app.loop-gpt.cyou`,
  `api.loop-gpt.cyou`, `chat.loop-gpt.cyou` → 200.
- **cf-tunnel**: a spare connector (env-driven creds) deployed in the active
  project; the apex currently resolves directly to the Railway edge, so the
  tunnel is a fallback path.

### Auth / OAuth fix (same day)

**Root cause (the big one): the page never hydrated.** The `web` service sent
`Content-Security-Policy: script-src 'self'` with no `'unsafe-inline'`. Next's
static export bootstraps hydration with **inline** `<script>` (flight data) and
uses inline `style` attributes; the CSP blocked them, so every client page
(`/login`, `/signup`, `/chat`) rendered but had **no React event handlers** — the
email form did a native GET submit, and the Google/GitHub buttons did nothing.
Fixed in `web/nginx.template.conf`: `script-src 'self' 'unsafe-inline'`,
`style-src 'self' 'unsafe-inline'`, `font-src 'self' data:`. Verified by a
headless browser on the live host: the button now has React props (hydrated),
email login POSTs and lands on `/chat/`, and the Google button opens the consent
screen.

Symptoms (reported): email login appeared broken and Google sign-in failed.

- **OAuth `redirect_uri` was the PRIVATE host.** The `web` proxy rewrites `Host`
  to `backend.railway.internal:3001`, and `reqBase()` used it, so the provider
  redirect was `http://backend.railway.internal:3001/...` (unreachable, and not
  registered). Fixed: `callbackUrl` now prefers `OAUTH_CALLBACK_BASE` /
  `PUBLIC_API_URL` (public), with the request base only as a fallback
  (`services/oauth.ts` `publicCallbackBase`).
- **`FRONTEND_URL` is a comma-separated origin list.** `FRONTEND()` in
  `routes/oauth.ts` used the whole string, producing a broken redirect target;
  it now takes the first origin.
- **Wrong OAuth app.** The staging backend carried a *different, unregistered*
  Google client (`600320683304-…`). Copied the registered production app
  credentials onto the live backend: Google `673922779423-…`, GitHub
  `Ov23liM1cpLvOTTmOo8v`. Verified Google's consent page now renders
  (no `redirect_uri_mismatch`) and GitHub accepts the callback.
- Backend env added: `OAUTH_CALLBACK_BASE=https://api.loop-gpt.cyou`.
- Verified: `POST /api/auth/login` 401 on bad creds / 200 on good; `POST
  /api/auth/register` 201; `/api/auth/providers` → google+github+password;
  Google authorize → consent; GitHub authorize → login.
- Tests: `src/services/__tests__/oauth.test.ts` (callback base precedence +
  `FRONTEND_URL` origin-list). Suite: **1021 passed**.

### Chat UX batch (same day)

- **Two models, not four.** The picker now lists exactly **Large Looper**
  (`loop-large`, flagship, vision-capable) and **Small Looper** (`loop-small`,
  fast). Removed the separate vision tier and the "Auto" row; the catalog
  (`chatModelCatalog`) returns two entries and the client defaults to Large.
  Image turns route to the vision-capable large target.
- **Multiple images.** Up to four images per turn: the composer takes a
  multi-select, previews a row of thumbnails, and uploads each; the stream
  accepts `attachmentIds[]` and sends every image as an `image_url` part.
  Verified live: two images uploaded and compared by the model.
- **Sessions/history retain.** The auth token was memory-only and cleared on
  `pagehide`, so any reload signed the user out and history looked lost. It is now
  persisted (`localStorage`, JWT-exp aware). Verified: reload stays on `/chat/`.
- **Rewind replaces the branch.** The retry/rewind action now truncates the
  conversation after the target prompt (`POST /api/conversations/:id/rewind`)
  and puts the prompt back in the composer — re-sending replaces the old answer
  instead of appending below it. Verified live.

### OAuth return URL leaked the internal port (fixed)

Symptom: after Google sign-in the browser landed on
`http://loop-gpt.cyou:8080/login/?token=…` (http, `:8080`).

Cause: the app is a static export with `trailingSlash`, so `/login` is a
directory. nginx's directory redirect used an **absolute** Location built from the
request host and the *container* port (8080), leaking the internal scheme/port.
The OAuth callback itself was already correct (`FRONTEND_URL`), it was the
directory hop that rewrote the URL.

Fix:
- `web/nginx.template.conf`: `absolute_redirect off; port_in_redirect off;`
  → all directory redirects are now relative (`/login/?…`).
- Backend redirects now target the trailing-slash routes directly
  (`/login/`, `/verify/`, `/reset/`) so there is no hop at all.
- Verified live: `GET /login?x=1` → `301 location: /login/?x=1`;
  `GET /login?token=…` lands on `/chat/`; the OAuth callback → `https://loop-gpt.cyou/login/?…`.

### "Nothing works inside chat" — root causes fixed (same day)

Verified with a headless browser against the live site, plus API probes.

- **Hydration (the big one).** The `web` CSP (`script-src 'self'`, no
  `'unsafe-inline'`) blocked Next's inline bootstrap/flight scripts, so `/login`,
  `/signup`, and `/chat` rendered with **no React handlers**: the email form did a
  native GET, the social buttons did nothing. Fixed in `web/nginx.template.conf`
  (`script-src`/`style-src` `'unsafe-inline'`, `font-src 'self' data:`).
  Live-verified: buttons now carry React props; email login POSTs and lands on
  `/chat/`; the Google button opens the consent screen.
- **Cold-start 503s.** The dedicated chat endpoint scales to zero/initializes; the
  provider failed the first turn. Added bounded, abort-aware retry (429/5xx +
  cold-start hints) in `llmClient` (`withColdStartRetry`), used by `streamTurn`
  and `completeOnce`, emitting `warming` between attempts.
- **Search quality.** SearXNG was not reachable/JSON; Bing redirects were ugly.
  Now: SearXNG JSON on a **Railway SearXNG service** (with the `use_default_settings`
  fix), a deterministic lexical relevance filter, Bing `/ck/a` redirect decoding,
  and reranker/embedding transport moved to the HF router.
- **Gradio media.** Current Spaces expose the **named-endpoint** API, not
  `/run/predict`. Added `agent/tools/gradio.ts` (discover `/gradio_api/info` →
  `POST /call/<api>` → SSE) used by `generate_image`/`generate_video`, with the
  legacy path as fallback; media budget raised to 15 min (env-overridable).
- **User skills.** The container cwd is read-only; `createUserSkill` now writes
  under the writable data dir (`AGENT_DATA_DIR/skills`). Live-verified create +
  list; deleted the probe.
- **Verified live (browser + API):** chat streamed a reply; model selector
  (Auto/Standard/Large/Vision) and the Large tier (`LARGE-OK`); `web_search`
  tool with citations; `remember` + `GET /api/memory`; `create_document` →
  approval card → `Smoke_UI.pdf` (persisted, `application/pdf`, `%PDF`, 1246 B);
  public publish link (anonymous 200); tool permission `blocked` enforced + audit
  log; connectors add/list and extension tools registered (16→18); skill create;
  all Settings tabs load real catalogs.

### "Not wired / not built" sweep — wiring + missing parts (2026-09-21/22)

- **Model endpoints were wrong (the real instability).** The env had stale URLs
  (`*.us-east-1.aws.endpoints.huggingface.cloud`). The live endpoints are
  `https://<id>.endpoints.huggingface.cloud`. Corrected `HF_ENDPOINT_URL` /
  `HF_MODEL` (qwen standard), `HF_LARGE_ENDPOINT_URL` / `HF_LARGE_MODEL`
  (deepseek flagship), `HF_IMAGE_ENDPOINT_URL`, `HF_VIDEO_ENDPOINT_URL`. Both
  tiers verified 200 + streaming.
- **Reasoning-model deltas.** The flagship (DeepSeek) streams its chain in
  `reasoning_content`/`reasoning`, not `content`. `streamTurn`/`completeOnce`
  now accept either.
- **Cold-start budget.** Retry widened to ~3 min with progressive `warming`
  messages (`llmClient.withColdStartRetry`).
- **GAP-063 Accept-edits.** `autoApprove` (stream input) → the approval gate
  auto-approves. Verified: `create_document` ran with no card.
- **GAP-064 per-chat tool picker.** `+` menu → Tools; `toolNames[]` sent per turn.
  Verified: toggling changes the count (e.g. 15/16).
- **GAP-065 slash commands (Claude/Copilot-style).** 16 commands in
  `lib/commands.ts`: modes (`/chat` `/agent` `/research` `/image` `/video`
  `/create` `/memory`) and actions (`/new` `/undo` `/retry` `/stop` `/export`
  `/screenshot` `/model` `/settings` `/help`). Generation commands pin the tool.
- **GAP-031 Projects.** New `ProjectsPanel` (list/create/select/ingest/delete) in
  the sidebar; conversations carry `projectId`; `search_knowledge` defaults to
  the conversation's project. Verified: project knowledge answered the chat.
- **GAP-036 Research panel.** `ResearchPanel` (runs list, live status, full cited
  report) via `GET /api/agent/research`.
- **GAP-034 Developer API page.** `/developer` (overview, keys create/list/revoke,
  quick-start, recent usage). Verified: key created → `/v1/chat/completions` → 200.
- **GAP-033 Connector OAuth button** in Settings for the wired providers
  (google_drive/gmail/github) via `/api/oauth-connector/init`.
- **Mount-order fix.** `projectRouter` was being swallowed by the workspaces
  catch-all 404; mounted first. And `projectRouter` now requires auth.
- **Project role enum drift.** The `ProjectRole` enum was missing in the DB
  (migration created `role TEXT`). Added `20260924000000_project_role_enum`.
- **Test gate (GAP-047).** Vitest + Testing Library + jsdom + axe +
  Playwright on `frontend/`; 10 unit + 12 e2e/a11y pass; wired into
  `web-validation.yml`.

## Still open

- **GAP-003** a11y contrast sweep (serious-level contrast on the dark theme — see
  the Playwright/axe report).
- **GAP-041** attachments beyond images (PDF/doc/code).
- **GAP-042** TOTP MFA; **GAP-043** magic-link login.
- **GAP-044** nightly memory synthesis (the user/agent `source` distinction and
  the master toggle shipped in this overhaul — see below); **GAP-045** incognito,
  IndexedDB drafts, context meter/compaction, extended-thinking display, message
  branching; **GAP-046** shared scratchpad; **GAP-048** skills versioning / plugin
  lifecycle.
- **GAP-067** delete-account / export-data.
- **GAP-068** connector breadth — marketplace tier shipped (user-owned OAuth
  apps + generic api_request adapter); live provider tests pending.
- **GAP-070** mobile parity (tools/artifacts/settings); **GAP-049** native signing.
- **GAP-057** backups/monitoring/load; **GAP-058** single-GPU consolidation.
- **Provisioning:** SMTP/Resend (GAP-051), Stripe (GAP-052), Brave/Tavily
  (GAP-053), PostHog/Sentry (GAP-054).
- **Stale docs** (GAP-062): `PROVIDER_MEDIA_HTTP.md`, `/api/models/selection` in
  `RUNTIME_AUTHORIZATION.md`/`BUILD_PROGRESS.md`, `ACCOUNTED_VIDEO_JOBS.md` path.

## UX/UI overhaul — frontier parity pass (2026-09-22)

The full brief (settings IA, composer modes/menu, slash palette, voice, projects,
app chrome, agent activity panel) implemented end-to-end. Verification: backend
`npm run build` + `npm test` → **1041 passed, 5 skipped** (one flaky external
Tavily network test re-ran green); frontend `tsc --noEmit` clean, `npm run lint`
exit 0 (warnings only), `npm run build` exit 0, `npm test` → **20 passed**,
`npx playwright test` → **12 passed** (incl. axe critical a11y).

- **Settings IA re-flowed** — tabs now **Skills · Plugins · Memory ·
  Personalization · Connectors · Tools**. The **Builder** tab (raw HTTP tool
  form) and the **Model/BYOK** tab are deleted; BYOK code (`getProviderSettings`,
  `aiProvider`/`aiModel`/`aiApiKey` localStorage) fully purged from
  `lib/api.ts` + `chat/page.tsx`. New shared primitives
  (`components/ui/primitives.tsx`: Card/Toggle/EmptyState/StatusDot/SearchInput/
  SectionHeader/Badge) unify the visual system (single accent `#c96442`).
- **Memory** (GAP-021/044 UX) — master toggle "Use memory across conversations"
  (`User.memoryEnabled` + `GET/POST /api/memory/enabled`; injection gated in
  `getMemories`), per-item **edit** (PATCH) + delete, **source badges**
  (`Memory.source`: `user` = settings UI, `agent` = the `remember` tool), search
  with result count, tag-grouped sections, real empty state. Migration
  `20260925000000_memory_source_toggle`.
- **Personalization** (GAP-022) — Styles renamed; preset gallery
  (Normal/Concise/Explanatory/Formal, selecting writes the default UserStyle),
  create-your-own card flow, **create-from-writing-sample** via new
  `POST /api/styles/from-sample` (shared `synthesizeStylePrompt` with the
  `generate_style` tool), active style displayed, plus **Voice preferences**
  (voice pick + rate, consumed by per-message TTS).
- **Skills** (GAP-014 UI) — card grid with built-in/custom badges + detail view;
  new `GET/PUT /api/agent/skills/:id` returns/updates the raw **SKILL.md**
  (YAML frontmatter — the Anthropic open standard); "Edit source" mono editor;
  create form with live SKILL.md preview; in-chat `create_skill` meta-tool
  advertises natural-language skill creation.
- **Connectors** (GAP-068) — every card is real. Available grid: 14 key-based +
  platform OAuth (Google Drive/Gmail/**Calendar**/**Sheets** — new scopes +
  adapters: drive list/read, gmail search/read/send, calendar list/create,
  sheets read/append, incl. token refresh) + GitHub + Custom HTTP (absorbs the
  Builder). **Key validation on save** + **Test connection** per card
  (`POST /api/agent/connectors/:id/test`, `probeConnector`; status/last-tested
  persisted on the connector). **Marketplace** (collapsed, not default): 8
  providers connect with the **user's own OAuth app credentials**
  (`clientId`/`clientSecret` through the PKCE flow, per-provider metadata in
  `oauthProviders.ts`) and get a real generic `api_request` tool; OAuth callback
  now **dual-writes** a configStore connector (fixes: connected OAuth apps
  previously never appeared in Settings and registered no tools). MCP servers
  moved into the tab's **Advanced** section.
- **Composer** — 4-mode switcher (Auto / Plan / **Ask first** / Accept edits)
  with icons, hints, and a visible active state; "Ask first" is a real run mode
  (`stepMode` → `requiresInteractivePause` forces the approval gate on every
  tool). "+" menu trimmed to Add photos & files · Take a screenshot ·
  Connectors · Create image + "Manage tools →" (Settings → Tools); the inline
  tool checklist is gone. **Mic dictation (STT)** via Web Speech API with live
  interim transcript, pulsing recording state, elapsed timer, cancel /
  stop-and-send (`lib/voice.ts useDictation`), feature-detected.
- **Per-message read aloud (TTS)** — speaker icon on each assistant message
  (next to copy/retry) with play/pause/stop via `speechSynthesis`, markdown
  stripped for reading, voice prefs from Personalization.
- **Slash palette** — compact single-line rows, section headers
  (Create/Manage/Session/Help), hint only on the highlighted row, **fuzzy
  subsequence filter**, keyboard nav fixed to state, and new commands:
  `/skills /projects /connectors /plugins`.
- **Projects** (GAP-031 UI) — first-class sidebar section with inline recent
  projects + active highlight; panel redesigned as Claude-style cards (chats /
  knowledge counts, last-active, instructions preview); dedicated two-step
  creation flow (details → knowledge); **knowledge file upload**
  (.txt/.md/.csv parsed client-side → existing `/ingest`).
- **Chrome** — export button now a **Markdown / PDF (print)** menu; "Large
  Looper" model picker restyled; artifacts panel unchanged (already had
  versions/diff/publish).
- **Agent activity panel** (formerly "Agent Computer") — 5 live status states
  (Idle/Thinking/Running tool/Waiting for input/Error) with animated dot;
  tool calls render as **collapsible cards** (icon, name, one-line args,
  timestamp, success/fail, expandable raw input/output in mono); step-grouped
  timeline; **clickable tool count** opens the available-tools list with a
  link to Settings → Tools; proper empty state; approval card restyled.
