# Checkpoint 03l — prepaid confirmed-usage recovery

Date: 2026-09-17. Local uncommitted work. No deployment, production database
migration, live model/payment requests, commit, push or remote CI execution.

## Final independent validation

| Check | Result |
| --- | --- |
| Windows and Linux TypeScript | Passed |
| Windows and Linux unit suites | 720 passed, 31 files |
| Windows integration | 340 passed, three platform-specific skips |
| Linux integration | 343 passed, 13 files, no skips |
| New unit/CLI coverage | 45 cases |
| New integration coverage | 30 recovery cases + five paid-route cases |
| Fresh/repeated migrations | Seven applied; repeat had none pending |
| Schema comparison | No difference detected |
| Production worker help | Exit 0 without network/DB |
| Production seeded recovery/replay smoke | Exit 0, UID 1000, exactly one usage row |

Linux backend total: **1,063 tests**. Windows skips are the existing symlink case
and two POSIX-only interrupted-one-shot signal tests; those execute on Linux.
Web was unchanged; its previous results remain in `web/VALIDATION.md`.

Both image builds reused existing implementation build-cache layers. Main then
explicitly ran `npm run build`, `npm test` and the full integration suite inside
the final Linux validation image; success is not inferred solely from cached layers.
No new dependency audit or remote CI run is claimed.

Final image IDs:

- `loop-gpt-backend:validation-03l`:
  `sha256:4639c7667748b54053164f6fe05598e4b2943b53fb4252020bdbcce325b52c3c`
- `loop-gpt-backend:foundation-03l`:
  `sha256:d8df15475a05e6b29b78c686c5bccee4ee009d40e8bef85fcd696f0d2179ab87`

## Review and coverage

Scoped independent review found no further concrete defect in the new recovery
module. Tests exercise immutable/contradictory intents, account/key ownership,
bounded cost/metrics, capture after key revocation, failed evidence persistence,
failed capture followed by separate-process recovery, and retained unknown work
without an intent. Exact legacy null-reference captures remain unchanged.

Distributed tests cover free-slot waves, disjoint claims, SKIP LOCKED, stale fences
after lock waits, expiry while a valid capture holds its locks, foreground-worker
races, two separate worker processes, capture/acknowledgement failures, ambiguous
commit, bounded backoff/exhaustion, manual release/capture conflicts and duplicate
usage protection. Linux tests interrupt active `--once` with SIGINT/SIGTERM and
require drained work plus a nonzero incomplete exit.

The `/v1` tests confirm queued evidence is not reported as foreground success;
partial image work and missing provider usage remain uncertain rather than guessed.
External providers are mocked; PostgreSQL, compiled workers and HTTP tests are real.

## Reproduction

From repository root:

```powershell
docker run --rm -d --name loop-gpt-prepaid-db-03l -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1::5432 postgres:16-alpine
docker port loop-gpt-prepaid-db-03l 5432
```

Main's fixture port was **49547**. In `backend/`, explicitly set `DATABASE_URL`
and `TEST_DATABASE_URL` to
`postgresql://loop_test:local-test-only@127.0.0.1:49547/loop_foundation_test?schema=public`.
The explicit values prevent Prisma's `.env` load from selecting an operator DB.

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
docker build --target validation -t loop-gpt-backend:validation-03l backend
docker build -t loop-gpt-backend:foundation-03l backend
docker run --rm --network container:loop-gpt-prepaid-db-03l -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03l sh -c 'npm run build && npm test && npm run test:integration'
docker run --rm --network none loop-gpt-backend:foundation-03l node scripts/api-settlement-worker.mjs --help
```

Production fixture smoke used the same container network and fixture DB, with both
database variables set to the container-local URL and the checked-in smoke script
mounted read-only at `/app/scripts/api-settlement-smoke.mjs`. It invokes the worker
already packaged in the production image and makes no provider/payment request.

```text
capture recovered exactly once; uid=1000; balance=9960; usage=1
```

The fixture started at 10,000 micro-USD, reserved 100, captured 40 from confirmed
usage and returned the unused 60. Worker replay plus a foreground exact retry
left 9,960 and one usage row. Test-only account/reservation/intent/usage rows were
removed by the smoke's finally cleanup.

## Changed files in this slice

Cleanup and final checks: the owned `loop-gpt-prepaid-db-03l` disposable container
was stopped/removed; the filtered running-container check was empty. Worker/smoke
syntax checks and `git diff --check` passed. Existing line-ending warnings remain.
The CI packaging check was added but has not run remotely. No worker was left running.

- `backend/src/services/apiReservations.ts`
- `backend/src/services/apiBilling.ts`
- `backend/src/services/apiSettlementRecovery.ts`
- `backend/src/routes/v1.ts`
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260917010000_api_settlement_recovery/migration.sql`
- `backend/scripts/api-settlement-worker.mjs`
- `backend/scripts/api-settlement-smoke.mjs`
- `backend/Dockerfile`, `backend/package.json`
- `backend/src/services/__tests__/apiSettlementRecovery.test.ts`
- `backend/src/services/__tests__/apiSettlementRecovery.integration.test.ts`
- `backend/src/services/__tests__/apiPaidV1.integration.test.ts`
- `backend/src/services/__tests__/v1ProviderTransport.test.ts`
- `.github/workflows/backend-validation.yml`
- `docs/API_SETTLEMENT_RECOVERY.md`, `docs/ACCOUNTING.md`, `docs/BUILD_PROGRESS.md`
- `docs/PRODUCTION_CHECKLIST.md`, this evidence file and `README.md`

This completes confirmed-usage prepaid recovery, not missing-evidence/provider
reconciliation, general durable tasks or the whole production product. Remaining
limits and operational instructions are in `API_SETTLEMENT_RECOVERY.md`.
