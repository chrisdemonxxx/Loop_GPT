# Checkpoint 03k — durable daily settlement recovery

Date: 2026-09-17. Local, uncommitted changes only. No live provider/payment calls,
production migration, deployment, commit, push or remote CI execution.

## Verification

| Check | Final result |
| --- | --- |
| Windows/Linux backend TypeScript | Passed |
| Windows/Linux unit tests | 675 passed, 30 files |
| Windows PostgreSQL integration | 307 passed, existing symlink skip |
| Linux PostgreSQL integration | 308 passed, 12 files, no skips |
| New recovery coverage | 37 unit/CLI cases + 24 PostgreSQL cases |
| Fresh migration application | Six additive migrations applied |
| Repeat/schema diff | None pending / no difference detected |
| Production image worker --help | Exit 0 without network/DB |
| Production image worker --once | Exit 0, correctly reported empty fixture queue |

Linux backend total: **983 passing tests**. The full integration suite includes
real separate-process CLI recovery after a capture failure, and SIGINT/SIGTERM
shutdown on Linux. External providers are mocked. Actual PostgreSQL and compiled
Node services execute; the production-image standalone smoke was an empty sweep,
not itself a seeded recovery demonstration.

Image IDs:

- `loop-gpt-backend:validation-03k`:
  `sha256:fe244ca09cf1db7285fc0370956044d13da5ef2a1d74790253e58eabf179c2f5`
- `loop-gpt-backend:foundation-03k`:
  `sha256:c7c698dd49515acd2255979b8e7acdce8a077e8d237608da76a0d11ec970997f`

Builds reused cached dependency/Prisma layers already generated during implementation;
this is not a new dependency audit. Main reran source compilation/full tests and
built both final images after review fixes. Web was unchanged; its last verification
remains checkpoint 03j (94 tests plus four browser checks).

## Review findings and regressions

- Corrected whole-batch pre-leasing: locally queued rows could lose leases and
  consume retries without attempting capture. Batches now claim only available
  concurrency slots. A real-DB regression requires six single-slot claim waves,
  each completed exactly once with one delivery attempt.
- Corrected cancelled `--once` success: summaries expose unprocessed and aborted
  work; exit-code selection treats both as incomplete. Tests cancel during claim
  and after an in-flight capture, verifying untouched later work remains pending.
- CLI rejects inherited object-property names as flags.
- Existing coverage verifies immutable evidence, conflicting enqueues, missing
  evidence, failed intent/capture persistence, disjoint claims, SKIP LOCKED,
  expired/replaced fences, foreground/worker races, duplicate capture, committed
  capture with lost acknowledgement, retry backoff and terminal conflicts/exhaustion.

## Reproduction

From repository root:

```powershell
docker run --rm -d --name loop-gpt-recovery-db-03k -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1::5432 postgres:16-alpine
docker port loop-gpt-recovery-db-03k 5432
```

This run used port **60578**. From `backend/`, explicitly set both `DATABASE_URL`
and `TEST_DATABASE_URL` to
`postgresql://loop_test:local-test-only@127.0.0.1:60578/loop_foundation_test?schema=public`.
Prisma may load `.env`; these explicit overrides ensure the dedicated fixture DB.

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run migrate:deploy
npm.cmd run test:integration
npm.cmd run migrate:deploy
npx.cmd prisma migrate diff --from-url "$env:DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

From root:

```powershell
docker build --target validation -t loop-gpt-backend:validation-03k backend
docker build -t loop-gpt-backend:foundation-03k backend
docker run --rm --network container:loop-gpt-recovery-db-03k -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03k npm run test:integration
docker run --rm --network none loop-gpt-backend:foundation-03k node scripts/daily-settlement-worker.mjs --help
docker run --rm --network container:loop-gpt-recovery-db-03k -e DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:foundation-03k node scripts/daily-settlement-worker.mjs --once
```

Production one-shot output:

```json
{"event":"daily_settlement_batch","claimed":0,"succeeded":0,"retry":0,"conflict":0,"dead_letter":0,"lease_lost":0,"unavailable":0,"unprocessed":0,"aborted":false}
```

## Files

Cleanup: `docker stop loop-gpt-recovery-db-03k` removed the owned disposable DB
container; the filtered running-container check was empty. `git diff --check` and
worker script syntax validation passed. No production data/environment was removed.
The CI worker-packaging check was added but has not executed remotely.

- `backend/src/services/dailyReservations.ts`
- `backend/src/services/billing.ts`
- `backend/src/services/dailySettlementRecovery.ts`
- `backend/src/services/__tests__/dailySettlementRecovery.test.ts`
- `backend/src/services/__tests__/dailySettlementRecovery.integration.test.ts`
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260917000000_daily_settlement_recovery/migration.sql`
- `backend/scripts/daily-settlement-worker.mjs`
- `backend/Dockerfile`, `backend/package.json`
- `.github/workflows/backend-validation.yml`
- `docs/DAILY_SETTLEMENT_RECOVERY.md`, `docs/PRODUCTION_CHECKLIST.md`
- `docs/ACCOUNTING.md`, `docs/BUILD_PROGRESS.md`, this evidence file, `README.md`

Only daily settlement recovery is complete in this slice. Prepaid reconciliation,
provider dispatch/task workers, video accounting, payments, product/native features
and release qualification remain. See the explicit full-scope checklist.
