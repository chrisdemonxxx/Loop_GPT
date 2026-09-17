# Checkpoint 03n — daily/JWT accounted video and mixed-pool integrity

Date: 2026-09-17. Local uncommitted work only. No production migration, deployment,
live provider/payment calls, commit, push or remote CI run. Both video flags remain
default-off; no operator environment was changed to enable delivery.

## Final independent validation

| Check | Result |
| --- | --- |
| Prisma generation on Windows and Linux | Passed |
| Windows/Linux TypeScript | Passed |
| Windows/Linux unit suites | 767 passed, 32 files |
| Windows integration | 417 passed, three platform-specific skips |
| Linux integration | 420 passed, 15 files, no skips |
| New daily-video integration coverage | 32 cases |
| Fresh migrations | Nine additive migrations applied |
| Repeat / schema comparison | No pending migrations / no difference |
| Production worker help | Exit 0 without network/DB |
| Production worker --once | Exit 0 on empty fixture queue with both flags disabled |

Linux backend total: **1,187 tests**. The Windows skips are the existing symlink
case and two POSIX-specific prepaid worker signal tests, executed on Linux. Unit
count is unchanged from 03m; the added coverage uses real PostgreSQL/HTTP/filesystem.
External provider transport remains mocked and genuine MP4 fixture bytes are used.
Web/native work is unchanged by this checkpoint.

Image IDs:

- `loop-gpt-backend:validation-03n`:
  `sha256:a05ffef59e55a98acc294a392ba9f08daab54acf6a309f250ff76318ea2300bc`
- `loop-gpt-backend:foundation-03n`:
  `sha256:be7a14dbd04dbb81f0938c5f5b4789f8452b7b1a4d1d6b3f80745a370d88aed0`

Dependency layers were cached; this is not a clean-install/dependency audit claim.
Current Prisma clients were regenerated in both image stages, current source
compiled and full units ran in validation; main ran the full Linux integration suite.

## Review correction

Static review identified a persisted-data integrity issue: cancellation could refund
the mutable current debit/window fields rather than the original values. No ordinary
HTTP field-writing path was found. The migration now rejects updates to reservation
identity/owner, credits, imageCredits, bypass and windowStart. Regression tests attempt
to inflate message/image refunds and move a hold into the current window; the writes
are rejected and cancellation/worker rejection never creates extra allowance.

This protects ordinary application/internal writers; it is not a defense against a
DB administrator disabling constraints, nor a repair for historical corruption.
The existing old-window test now inserts consistent historical fixture data instead
of rewriting the immutable window after creating a real reservation.

Main's first build used a stale local generated Prisma client and reported missing
new fields. Running `npm run generate` resolved it; the subsequent full build/tests
passed. No type checks or constraints were suppressed.

## Coverage

The daily suite verifies atomic rollback on insertion failure, concurrent allowance
exhaustion, database-enforced single-ledger/job relations, mixed pool claims,
default-off/admin behavior, daily-only/common flag pauses, mid-claim and multi-wave
flag changes, zero-credit bypass, changed server plan/role/unlimited binding,
deleted accounts, forged cost/owner fields, and immutable refund evidence.

Lifecycle checks cover queued cancellation across reset windows, retained uncertain
post-submit cost, in-flight abort/late MP4, no repeated POST, failed evidence/capture/
publication, recovery before publication, status-only cancellation and lease expiry
while waiting on the daily account lock. Real JWT login and API-key middleware verify
that every developer key is excluded from daily job endpoints while owner JWTs and
account-wide artifact access retain their documented semantics.

The prior prepaid/MP4/provider/settlement suites also pass against the extended schema.
This is local qualification, not live-provider or deployment acceptance.

## Reproduction

Create the dedicated local fixture DB from repository root:

```powershell
docker run --rm -d --name loop-gpt-dailyvideo-db-03n -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1::5432 postgres:16-alpine
docker port loop-gpt-dailyvideo-db-03n 5432
```

Main's port was **60708**. From `backend/`, explicitly set `DATABASE_URL` and
`TEST_DATABASE_URL` to
`postgresql://loop_test:local-test-only@127.0.0.1:60708/loop_foundation_test?schema=public`.
Explicit values override Prisma's `.env` database selection.

```powershell
npm.cmd run generate
npm.cmd run build
npm.cmd test
npm.cmd run migrate:deploy
npm.cmd run test:integration
npm.cmd run migrate:deploy
npx.cmd prisma migrate diff --from-url "$env:DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

From root:

```powershell
docker build --target validation -t loop-gpt-backend:validation-03n backend
docker build -t loop-gpt-backend:foundation-03n backend
docker run --rm --network container:loop-gpt-dailyvideo-db-03n -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03n npm run test:integration
docker run --rm --network none loop-gpt-backend:foundation-03n node scripts/video-job-worker.mjs --help
docker run --rm --network container:loop-gpt-dailyvideo-db-03n -e DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' -e ACCOUNTED_VIDEO_JOBS_ENABLED=false -e ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED=false loop-gpt-backend:foundation-03n node scripts/video-job-worker.mjs --once
```

One-shot output reported zero claimed/advanced/retry/reconciliation/unavailable jobs,
`aborted:false`, and `dispatchEnabled:false`. This packaging check used an empty
fixture queue; seeded daily recovery/publication is covered by the integration suite.

## Exact changed files

Cleanup: the owned `loop-gpt-dailyvideo-db-03n` fixture container was stopped and
removed; the filtered running-container check was empty. `git diff --check` and
worker script syntax checks passed. Existing line-ending warnings remain. No
background worker, real environment change or production data deletion was left.

- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260917030000_daily_video_jobs/migration.sql`
- `backend/scripts/video-job-worker.mjs`
- `backend/src/routes/media.ts`, `backend/src/routes/v1.ts`
- `backend/src/services/accountedVideoJobs.ts`
- `backend/src/services/dailyReservations.ts`
- `backend/src/services/videoJobWorker.ts`
- `backend/src/services/__tests__/dailyVideoJobs.integration.test.ts`
- `backend/src/services/__tests__/dailyReservations.integration.test.ts`
- `backend/src/services/__tests__/providerFlows.integration.test.ts`
- `backend/src/services/__tests__/videoLifecycle.integration.test.ts`
- `docs/ACCOUNTED_VIDEO_JOBS.md`, `docs/ACCOUNTING.md`, `docs/BUILD_PROGRESS.md`
- `docs/PRODUCTION_CHECKLIST.md`, this evidence file, `README.md`

Remaining: global/user queue limits, idempotent HTTP creation, durable production
storage/GC, live provider qualification, session/workspace lifecycle, payments and
the other product/native milestones in `PRODUCTION_CHECKLIST.md`.
