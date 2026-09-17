# Checkpoint 03m — accounted prepaid video dispatch and publication

Date: 2026-09-17. Local uncommitted work only. No production migration, deployment,
live provider/payment calls, commit, push or remote CI run. Dispatch remains off
unless explicitly configured; JWT video creation still returns 503.

## Final checks

| Check | Result |
| --- | --- |
| Windows/Linux TypeScript | Passed |
| Windows/Linux unit suites | 767 passed, 32 files |
| Windows integration | 385 passed, three platform-specific skips |
| Linux integration | 388 passed, 14 files, no skips |
| Fresh migrations | Eight additive migrations applied |
| Repeat / schema comparison | No pending migrations / no difference |
| Production worker help | Exit 0 with network disabled |
| Production worker one-shot | Exit 0 on empty fixture queue, dispatchEnabled false |
| Production continuous worker | Readiness observed; SIGTERM then exit 0 |

Linux backend total: **1,155 tests**. Windows skips remain one symlink test and two
POSIX-specific prepaid worker signal cases. Web was unchanged; its prior evidence
remains checkpoint 03j. Cached dependency/Prisma layers were reused; main compiled
the current source and ran the full current tests, not a new dependency audit.

Image IDs:

- `loop-gpt-backend:validation-03m`:
  `sha256:dae1c1cd033abdd6b77fe929a98f52d2678abfb563fdc151024d0c50e14cf73b`
- `loop-gpt-backend:foundation-03m`:
  `sha256:a01391e07349a7c32df8b7e134d28dfd1d0267b03a1b082ece47e35c322c3960`

## Audit corrections and coverage

1. Fixed status-only cancellation racing asynchronous artifact verification. The
   publication transaction rechecks cancellation under its locks, captures known
   work if appropriate, but publishes neither cancelled output nor completed status.
2. Replaced ftyp-only evidence with bounded MP4/AVC admission. The success fixture
   is a genuine tiny video; fabricated headers, audio-only, truncated and oversized
   output cannot create a settlement intent or accessible artifact.
3. Feature/config unavailability now pauses network jobs instead of cancelling queued
   jobs or terminally stranding polling jobs. Committed settling work still proceeds.
4. Defined and tested account-wide artifact access versus original-key job scope;
   this is not cross-user access or a per-key file permission model.

An earlier origin-binding fixture used a reserved `.test` endpoint; the new public
configuration gate correctly paused it. The fixture now uses a syntactically public
different origin so it exercises binding mismatch, with all provider networking
still mocked.

Legacy unaccounted worker dispatch was retired. `mediaJobsTransport.test.ts` now
contains eight retirement/config/CLI cases instead of twenty old dispatch cases.
Worker safety coverage moved into real-DB suites: providerFlows now has 39 cases
and videoLifecycle adds 19, including previously absent race/acknowledgement cases.
The MP4 validator adds 59 unit cases. Compared with 03l, totals increase by 47 unit
and 45 integration tests; the aggregate is not evidence that every possible race
or provider format is qualified.

Verified scenarios include atomic job/hold insertion, competing claims, crash before
and after submit marker, no repeated POST, same-origin polling/anonymous CDN,
persisted malicious URLs, bounded nested results/deadlines, DB-renewal failure,
late provider responses, queued/after-submit/manual cancellation, staged corruption,
failed evidence/ledger/publication transactions, and lost acknowledgements after
actual evidence/publication commits. Tests also hold reservation/balance locks
past finalization lease expiry and verify only a fresh lease can publish.

HTTP ownership tests use real login/JWT/API-key middleware, two same-user keys,
another user and revoked keys. Provider calls alone are mocked; PostgreSQL and
private artifact bytes remain real. Test fixtures were generated and decode-checked
using local FFmpeg during validator implementation. No FFmpeg runtime dependency
was added; production validation is structural, not full codec decoding.

## Commands and infrastructure

Owned disposable DB:

```powershell
docker run --rm -d --name loop-gpt-video-db-03m -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1::5432 postgres:16-alpine
docker port loop-gpt-video-db-03m 5432
```

Main's assigned port was **64197**. In `backend/`, explicitly set `DATABASE_URL`
and `TEST_DATABASE_URL` to
`postgresql://loop_test:local-test-only@127.0.0.1:64197/loop_foundation_test?schema=public`.
This overrides any Prisma `.env` database selection.

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run migrate:deploy
npm.cmd run test:integration
npm.cmd run migrate:deploy
npx.cmd prisma migrate diff --from-url "$env:DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

From repository root:

```powershell
docker build --target validation -t loop-gpt-backend:validation-03m backend
docker build -t loop-gpt-backend:foundation-03m backend
docker run --rm --network container:loop-gpt-video-db-03m -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03m npm run test:integration
docker run --rm --network none loop-gpt-backend:foundation-03m node scripts/video-job-worker.mjs --help
docker run --rm --network container:loop-gpt-video-db-03m -e DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' -e ACCOUNTED_VIDEO_JOBS_ENABLED=false loop-gpt-backend:foundation-03m node scripts/video-job-worker.mjs --once
```

One-shot output:

```json
{"event":"video_job_batch","claimed":0,"advanced":0,"retry":0,"paused":0,"needs_reconciliation":0,"lease_lost":0,"unavailable":0,"aborted":false,"dispatchEnabled":false}
```

A separately named `loop-gpt-video-cli-smoke-03m` container ran continuous polling
against the fixture DB. After observing batch output, main sent SIGTERM and
`docker wait` returned **0**. That container was removed. This was an idle lifecycle
smoke, not a live provider dispatch demonstration.

## Files changed

Final cleanup: the owned `loop-gpt-video-db-03m` disposable DB container was
stopped/removed and its filtered running-container check was empty. No worker
daemon remains. `git diff --check` and worker syntax validation passed; existing
line-ending conversion warnings remain. The added CI packaging step has not run remotely.

Production under `backend/`:
`src/services/{accountedVideoJobs,videoJobWorker,mp4Validation,apiReservations,
mediaJobs,privateFiles}.ts`, `src/routes/{v1,media}.ts`,
`scripts/video-job-worker.mjs`, `Dockerfile`, `package.json`,
`prisma/schema.prisma`, and
`prisma/migrations/20260917020000_accounted_video_jobs/migration.sql`.

Tests under `backend/src/services/__tests__/`:
`mediaJobsTransport.test.ts`, `providerFlows.integration.test.ts`,
`videoLifecycle.integration.test.ts`, `mp4Validation.test.ts`, and fixtures
`tinyVideoMp4.ts`, `tinyHighVideoMp4.ts`, `tinyAudioMp4.ts` under `fixtures/`.

Shared: `.github/workflows/backend-validation.yml`, `README.md`,
`docs/ACCOUNTED_VIDEO_JOBS.md`, `docs/ACCOUNTING.md`, `docs/BUILD_PROGRESS.md`,
`docs/PRODUCTION_CHECKLIST.md`, and this evidence file.

Prepaid dispatch is implemented but default-off/unqualified. Daily job billing,
global scheduling, idempotent HTTP creation, shared production storage/GC and live
provider validation remain. See `ACCOUNTED_VIDEO_JOBS.md`; this is not completion
of the full production build.
