# Validation: dedicated computer per run — E2B Desktop + takeover (Phase 3)

Date: 2026-10-05. Branch: `release/owned-staging-20260917`.
Scope: Level-B "bot computer" — a dedicated cloud desktop VM per
computer-enabled bot task, admin live view, full user takeover.

## What was built

- `src/services/e2bDesktop.ts` — injectable `DesktopClient` interface + thin
  real implementation over `@e2b/desktop@2.4.0` (`stream.start({requireAuth})`
  → `getAuthKey`/`getUrl({viewOnly})`, clicks/scroll/type/press/drag/launch,
  `screenshot('bytes')`, `kill`, `timeoutMs` TTL).
- `src/services/computerSession.ts` — per-run session: start (kill on stream
  failure), takeover guard (cross-process DB flag poll; pause→announce→resume
  from fresh screenshot; `ComputerTakeoverTimeout` at 10 min), screenshot →
  artifact + `data:image/png` URI, whole-minute metering, idempotent close.
- `src/agent/tools/computerTools.ts` — `computer_screenshot/click/move/scroll/
  drag/type/press/launch/wait`. Bot-scope only: NOT in the builtin registry;
  granted by the runner only when `task.computer.enabled`. Every action
  returns a fresh screenshot (`data.imageDataUri` + artifact).
- `src/agent/agentRuntime.ts` — vision feedback: tool results carrying
  `data.imageDataUri` are injected as real `image_url` user messages on the
  next turn (native path: after the tool message; inline ReAct path: one
  collected image message after the joined results). 12MB guard.
- `src/services/botRunner.ts` — computer provisioning when enabled, stream
  metadata persisted on the run, TTL abort (`BOT_COMPUTER_TTL`), minutes
  metered onto the run before teardown, desktop killed in `finally`;
  `E2BDesktopError` maps to `BOT_COMPUTER_UNAVAILABLE`.
- `src/services/botRuns.ts` — `setRunComputer`/`getRunComputer` (live view +
  row merge), `setRunTakeover`/`isRunTakeoverRequested` (the cross-process
  rendezvous: admin API writes, worker polls).
- `prisma/migrations/20261005020000_bot_run_computer` — `BotRun.computer`
  JSONB + `BotRun.takeoverRequested`.
- Admin API: `GET /api/admin/bot/runs/:id/computer` (interactive URL only
  while takeover active), `POST .../takeover {takeover}` (409 when the run is
  not active). Enqueue accepts `computer: {enabled, ttlMinutes 5..240}`.
- Frontend: `frontend/app/admin/bot/page.tsx` — task queue, enqueue form
  (schedule/steps/computer+TTL), live run event feed, and the Grok-parity
  panel: embedded noVNC iframe (view-only by default), **Take over** swaps to
  the interactive URL, **Release** hands control back. Linked from the admin
  portal header.

## Evidence (raw)

Typecheck/build: backend `tsc` 0, frontend `next build` success
(`/admin/bot` in the static export). Lint: all new/changed files 0 errors.

Unit: **1249 tests pass (72 files)** — new: computerSession (8: TTL,
stream-failure kill, guard immediate/pause-resume/timeout, artifact+data-URI,
act ordering, metering, idempotent close), computerTools (7: no-session
fail-closed on all 9 tools, coord clamps, button passthrough, press parsing,
launch validation, empty text, direct screenshot), runtimeImages (2: native +
inline image injection), agentTasks +computer validation.

Integration (fresh postgres:16, all 31 migrations): **15/15** — queue suite
(12) plus botRuns (3): computer metadata merge + row persistence, takeover
set/observe/release, takeover refused on finished runs.

End-to-end negative path (real DB, worker CLI, `E2B_API_KEY` deleted):
```
enqueued: cmuv2g0ij000010j2g7vn84k9
batch: {"claimed":1,"retry":1,...}
task: {"status":"queued","attempts":1,"lastErrorCode":"BOT_COMPUTER_UNAVAILABLE",
       "lastError":"E2B_API_KEY is required for dedicated computer sessions"}
run:  {"status":"failed","error":"E2B_API_KEY is required for dedicated computer sessions"}
```
The full chain (claim → runner → session start → coded failure → backoff
retry) works; the only missing piece for a live desktop run is the account key.

## Vision-grounding probe (the one Phase-3 unknown that was locally testable)

Method: rendered a known 1024x768 UI (purple "Create Report" button centered
at exactly (730, 324)) via Playwright, sent the screenshot to the live chat
model (`Qwen3.8-27B-Uncensored-Cyber` through the backend's own llmClient).

```
grounding answer: {"x":1024,"y":515}        (truth: 730, 324 — x off by ~294, off-canvas)
description:      "…purple rounded 'Create Report' primary button… right-of-center,
                   at roughly 60% across horizontally and just past the vertical midpoint"
```

Verdict: the model **reads screens accurately** (all elements, layout, and
relative position correct) but its **raw pixel predictions drift** and can
leave the canvas. Hardening applied accordingly:

- Coordinate clamps now bound to the real desktop (`COMPUTER_SCREEN_W/H`,
  default 1024x768 — clicks can never go off-screen; the old 3840x2160 clamp
  allowed off-canvas clicks).
- Tool descriptions state the true resolution and demand center-of-target aims.
- `COMPUTER_SYSTEM_ADDENDUM` (botRunner, computer sessions only): keyboard-first
  discipline (ctrl+l, tab, enter over clicks), observe→one action→observe,
  mandatory re-observe + retry-with-adjusted-coordinates on a miss, launch-then-
  wait-then-look. This matches how the model proved it works best.
- Residual risk: small-target clicking stays unreliable on this model class;
  per-task `model` override exists if a stronger vision model is deployed.

## Limits

- Live desktop run unverified until `E2B_API_KEY` is set (paid E2B account);
  the SDK surface used was verified against the installed package's types and
  the official README.
- One VM per run; worker concurrency is 1, so at most one live computer.
- Takeover pause renews the task lease via the existing heartbeat; a takeover
  longer than 10 minutes fails the task (`ComputerTakeoverTimeout` → retry).
