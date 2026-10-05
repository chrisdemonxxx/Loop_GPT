# Validation: bot task worker ("bot computer", Phase 1)

Date: 2026-10-05. Branch: `release/owned-staging-20260917`.
Scope: durable autonomous agent task queue + worker, fifth optional supervised
child, admin enqueue/observe/cancel API. No provider billing path touched.

## What was built

- `prisma/schema.prisma` + `migrations/20261005010000_bot_tasks`: `AgentTask`
  (queue row, lease columns, cancel flag) and `BotRun` (events/result/usage).
- `src/services/agentTasks.ts`: enqueue validation (zod + bounded interval
  schedules), priority-ordered `FOR UPDATE SKIP LOCKED` claims with DB-clock
  leases, guarded complete/fail acks, deterministic backoff, dead-letter at 3
  attempts, scheduled-task requeue, lease heartbeat renew, operator cancel.
- `src/services/botRunner.ts`: executes a claimed task through the same
  `runAgent` + `authorizeRunContext` pipeline as the interactive stream;
  service identity `BOT_USER_EMAIL` (find-or-create user/personal
  workspace/"Ops Bot" conversation); per-task tool allowlist (default:
  read-only set + `execute_code` + `create_document` + `remember`);
  `autoApprove` (no interactive gate off-HTTP); result posted as an assistant
  message into the Ops Bot conversation with sanitized metadata.
- `src/services/botRuns.ts`: live view + SSE subscribe + durable persistence
  (researchRuns analogue). Terminal persist is awaited (see fix below).
- `src/services/botWorker.ts` + `scripts/bot-task-worker.mjs`: bounded options,
  sequential batch, settlement-style summary + exit codes (0/1/2/3).
- `scripts/staging-runtime.mjs`: optional fifth essential child gated by
  `BOT_WORKER_ENABLED` (default false); readiness child count is now derived
  (`expectedChildren`) instead of hardcoded 4.
- `src/routes/admin.ts`: `POST/GET /api/admin/bot/tasks`,
  `GET /api/admin/bot/tasks/:id`, `POST .../cancel`,
  `GET /api/admin/bot/runs/:runId`, `GET .../events` (SSE replay + live).

## Evidence (raw)

Typecheck / build: `npx tsc --noEmit` exit 0; `npm run build` exit 0.
Lint: `eslint` on all new/changed files exit 0 (repo suite: 0 errors,
32 pre-existing warnings in unrelated files).

Unit: `npm test` — **68 files, 1213 passed, 5 skipped**, including new:
- `agentTasks.test.ts` (7): schedule bounds, enqueue schema, default allowlist
  ⊆ reviewed built-ins, mutation/media tools excluded.
- `botWorker.test.ts` (4): option bounds mirroring settlement workers, exit
  code mapping.

Supervisor regressions: `node --test deploy/owned-staging/regressions.test.mjs`
— **11/11 pass** (createReadinessCheck import unaffected by the new child).

CLI: `--help` prints usage without DB; bogus flag → exit 2.

Integration (fresh `postgres:16-alpine` container, all 29 migrations applied
via `prisma migrate deploy`, `loop_foundation_test`):
`agentTasks.integration.test.ts` — **12/12 pass**: claim lease, no double-claim,
crash replay after expiry, priority order, enqueue rejections, success ack,
lease-lost guarded ack, retry→dead-letter path, scheduled requeue with
attempt reset, heartbeat renew/refuse, immediate + flagged cancel, cancel
refusals.

End-to-end smoke 1 (in-process batch, real HF model):
```
enqueued: {"id":"cmuv1j8950000nc9ywvur2l3e","kind":"ops","status":"queued"}
batch: {"claimed":1,"succeeded":1,"retry":0,"cancelled":0,"dead_letter":0,...}
task: {"status":"succeeded","attempts":1,"lease":false,"lastErrorCode":null}
run: {"status":"completed","events":26,"result":"\n\nPONG","usage":{"tokensIn":6,"tokensOut":2}}
bot message: {"toolUsed":"bot","content":"\n\nPONG","metadata":{"steps":0,"usage":{...},"botRunId":"1f0956d0-...","artifacts":[],"botTaskId":"cmuv1j895..."}}
```

End-to-end smoke 2 (standalone CLI `bot-task-worker.mjs --once`, tool task):
```
{"event":"bot_task_batch","claimed":1,"succeeded":1,...}  WORKER EXIT: 0
task:  status succeeded, attempts 1
run:   completed, 297 events, toolCalls ["web_search","web_search"]
```
Note: `web_search` is set to `blocked` in this box's operator tool-permission
config; the bot honored the platform-wide block (model was told, adapted,
answered). Governance confirmed working: global overrides apply to bot runs;
per-task allowlists narrow further.

## Fix found during validation

Terminal BotRun persist was fire-and-forget; a reader querying immediately
after batch completion could see `status: running`. `botRuns.complete/fail`
now return the persist promise and `botRunner` awaits it before ack. Re-smoke
confirms `status: completed` with result/usage at batch return.

## Limits (documented, not hidden)

- No per-run billing/reservation in v1 (internal ops bot); token estimates are
  recorded on each BotRun. The `beforeDispatch` seam in `runAgent` is where
  user-facing metering attaches later.
- `execute_code` in the cloud is subprocess-isolated only (`SANDBOX_DOCKER=false`);
  real isolation arrives with the HF-sandbox phase.
- Bot visibility is via the admin API; a dedicated UI panel is a later slice.
  The Ops Bot conversation belongs to the service account.
- Deploy: run `prisma migrate deploy` as the separate reviewed release step,
  then set `BOT_WORKER_ENABLED=true` (+ `SANDBOX_DOCKER=false`) on the backend
  service and redeploy.
