# Validation: user-facing Loop Bot seam (B1–B5)

Date: 2026-10-05. Branch: `release/owned-staging-20260917` (post-d4956b9).
Scope: the bot queue goes multi-tenant. Ownership model, user routes,
per-user runner context, daily-credit metering, per-user concurrency.
B6 (image + flag) shipped earlier in 1c38053.

## What was built

- **B1 ownership**: `AgentTask.userId` (FK → User, cascade; NULL = system
  task, back-compat with the Phase-1 admin queue) + `conversationId` cache +
  `@@index([userId, status])` (migration `20261005130000_agent_task_ownership`).
  Every read/cancel in agentTasks and every run/computer/takeover read in
  botRuns takes an owner scope; scoped callers get 404/not_found, never a leak
  that another owner's task exists.
- **B2 user routes**: `routes/bot.ts` — 8 endpoints under `/api/bot/*`
  mirroring the admin surface with `authenticateToken` only; mounted before
  the generic limiter with its own 120/min bucket. Errors map: 400 invalid,
  403 plan-gated computer, 402 VM-minutes exhausted, 404 not-found,
  409 cancel/takeover conflict.
- **B3 per-user runner context**: `ensureRunIdentity` — user-owned tasks run
  AS the owner (their personal workspace, memory, standing "Loop Bot"
  conversation as the in-product result feed); system tasks keep the service
  account "Ops Bot" identity.
- **B4 metering**: new `'bot'` usage kind (CREDIT_COST 2) with the ledger's
  fail-closed SQL kind check widened (`20261005140000_bot_usage_kind` — the
  only place the financial invariants enumerate kinds; the /v1 api_intent set
  is untouched). Runner: `reserveDailyCredits` before ANY provisioning →
  `beforeDispatch: dailyDispatch(...)` on first model turn →
  `captureDailyReservation` with real token estimates on success →
  `cleanupDailyReservation` on every failure path (release/unknown per the
  accounting doctrine). VM minutes: per-plan daily budgets
  (free 0 / pro 30 / gold 120; admin+unlimited bypass) enforced at enqueue
  with TTL clamped to the remainder; metered per run on `BotRun.computer`.
- **B5 fair queueing**: claim SQL gains a NOT EXISTS guard — never claim a
  second task for a user who has one processing with a live lease; the worker
  claims one task per loop iteration so the guard is airtight at any
  batch-size setting.

## Evidence (raw)

Typecheck/build: `tsc` 0; unit suite **1249 passed (72 files)**; lint 0 errors
on all new/changed files.

Integration (fresh postgres:16, all 33 migrations): **28/28** —
agentTasks (18: queue suite + ownership scoping + claim guard + VM budgets),
botRuns (5: computer metadata + takeover + run/computer ownership scoping),
botRunner (5: per-user/system identity + reservation lifecycle:
reserve→dispatch→capture, cleanup-release, cleanup-unknown).

The ledger's SQL check did its job during development: the first capture for
kind 'bot' was REJECTED by `daily_intent_metrics` (23514) until the migration
widened it — the fail-closed doctrine caught the missing invariant before any
reviewer did.

End-to-end (real HF model, worker batch, fresh pro user):
```
enqueued: owner cmuv9zt9u0000lzkhgzo0k331
batch: {"claimed":1,"succeeded":1,...}
task: {"status":"succeeded","userId":"cmuv9zt9u..."}
reservation: {"state":"captured","credits":2}
usageEvent: {"kind":"bot","tokensIn":6,"tokensOut":2,"credits":2}
loop bot message: {"conversation":"Loop Bot","toolUsed":"bot","content":"PONG"}
credits: {"before":30,"after":28,"spent":2}
stranger sees tasks: 0
```

## Limits

- No user-facing UI in this slice (backend seam only): the `/api/bot/*`
  surface is ready for the product page; the admin console at `/admin/bot`
  already drives the same services unscoped.
- VM minutes are budgeted and metered, not yet credit-priced (pricing is a
  business decision; the per-day caps are the governor meanwhile).
- Scheduled user tasks bill per run at claim time, as designed.
