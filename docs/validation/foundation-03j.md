# Checkpoint 03j: combined prepaid/daily accounting and owned web validation

Local date: 2026-09-16 (final Linux runs crossed into 2026-09-17 UTC). All work is
uncommitted. No deployment, production DB migration, live inference/payment request,
commit, push, or remote CI run was performed.

## Final results

| Check | Result |
| --- | --- |
| Backend TypeScript, Windows/Linux | Passed |
| Backend unit suite, Windows/Linux | 638 tests passed, 29 files |
| Backend integration, Windows | 283 passed, one existing symlink skip |
| Backend integration, Linux | 284 passed, 11 files, no skips |
| New DB initialization | All five migrations applied |
| Repeat migrations / Prisma schema diff | None pending / no difference |
| Prisma generation | Both Linux build/runtime stages passed |
| Production transport smoke | Passed under network-none, UID 1000 |
| Owned web build | Passed, TypeScript + Vite |
| Owned web tests | 94 passed, five files |
| Owned web browser tests | Four passed, desktop/phone Chromium fixtures |

Linux backend total: **922**. Web adds **98** local tests, not native/iPhone Safari
qualification. Backend installs reused cached unchanged lockfile dependency layers;
this is not a fresh dependency audit. Prior web npm-audit evidence is recorded in
`web/VALIDATION.md`; no new audit is claimed here.

Final image IDs:

- `loop-gpt-backend:validation-03j`:
  `sha256:2090243abedb1a9b7de2c8b9128cf0218100bd00342d64ff81a3df59e33e6975`
- `loop-gpt-backend:foundation-03j`:
  `sha256:fb7bf1a776866e263d0662f13369988a4846be571d199abba1b73e176c6ccaa4`

## Findings fixed during combined validation

- Early response-close listeners and already-destroyed response checks cover
  reservation/conversation setup, not only inference. SSE setup is cleanup-protected.
- Cancellation during media reservation cannot mark known-unstarted work dispatched.
  Dispatch-marker transactions check cancellation before/after their write.
- Daily capture precedes assistant/artifact persistence; final success waits for
  capture rather than being forwarded before a potentially failed ledger write.
- Removed startup resumption of legacy video jobs lacking accounting linkage.
- Updated an existing mocked runtime to invoke its dispatch callback; capture
  correctly rejected its previous impossible success-without-dispatch fixture.
- A Linux-only legacy image fixture failure revealed reliance on the host's
  `IMAGE_API_URL`; the fixture now explicitly configures its mocked sidecar.
- Main's first browser rerun lacked the project-local Playwright cache variable.
  Repeating with the documented cache path passed all four browser tests; no new
  browser download or live API was needed.

The new daily disconnect suite has 50 real HTTP/PostgreSQL cases, including held
DB rows, setup failures, both aliases, cancellation, ledger failure and success-marker
ordering. Daily reservation integration has 50 cases. Prepaid coverage includes
13 ledger integration cases, 29 paid-route integration cases and bounded amount,
no-DB, transport, preview/top-up and unknown-work tests.

## Commands and infrastructure

From repository root, create only the disposable fixture DB:

```powershell
docker run --rm -d --name loop-gpt-ledger-db-03j -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1::5432 postgres:16-alpine
docker port loop-gpt-ledger-db-03j 5432
```

Reported port: **59305**. From `backend/`, explicitly override both `DATABASE_URL`
and `TEST_DATABASE_URL` with
`postgresql://loop_test:local-test-only@127.0.0.1:59305/loop_foundation_test?schema=public`.
Prisma loads `.env`, but these overrides prevent any real DB selection. Then:

```powershell
npm.cmd run migrate:deploy
npm.cmd run build
npm.cmd test
npm.cmd run test:integration
npm.cmd run migrate:deploy
npx.cmd prisma migrate diff --from-url "$env:DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

From root:

```powershell
docker build --target validation -t loop-gpt-backend:validation-03j backend
docker run --rm --network container:loop-gpt-ledger-db-03j -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03j npm run test:integration
docker build -t loop-gpt-backend:foundation-03j backend
docker run --rm --network none --mount "type=bind,source=$PWD/backend/scripts/provider-transport-smoke.cjs,target=/app/scripts/provider-transport-smoke.cjs,readonly" loop-gpt-backend:foundation-03j node scripts/provider-transport-smoke.cjs
```

Smoke: loopback sidecar healthy at UID 1000; oversize, redirects, encodings, stalled
body, caller cancellation, public-private destination and sidecar credential checks
all passed. No public provider DNS/TLS call was made.

From `web/`:

```powershell
npm.cmd run build
npm.cmd test
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.cache/ms-playwright"
npm.cmd run test:browser
```

The project-local browser cache already existed. On a new machine, install the
locked Playwright version's browser as described in `web/README.md`. New
`.github/workflows/web-validation.yml` specifies clean install/build/unit/browser
checks, but that remote workflow has not run.

## Changed files and scope

After the final Windows rerun, `docker stop loop-gpt-ledger-db-03j` removed the
owned disposable container; a name-filtered running-container check was empty.
`git diff --check` passed (existing line-ending conversion warnings only). No
existing environment, deployed service or production volume was removed.

Accounting production files: `backend/src/services/{apiReservations,apiBilling,
dailyReservations,billing}.ts`; `backend/src/routes/{v1,agent,messages,media}.ts`;
`backend/src/agent/{agentRuntime,research/deepResearch,tools/generateImage,
tools/generateVideo}.ts`; `backend/src/server.ts`.

Schema: `backend/prisma/schema.prisma` plus migrations
`20260916030000_api_reservations` and `20260916040000_daily_reservations`.

New accounting suites under `backend/src/services/__tests__/`:
`apiReservations.test.ts`, `apiReservations.integration.test.ts`,
`apiPaidV1.integration.test.ts`, `apiPaidV1.noDb.test.ts`,
`dailyReservations.integration.test.ts`, `dailyReservations.noDb.test.ts`,
`dailyDisconnect.integration.test.ts`. Existing billing/media/runtime/file fixtures
were updated to exercise the reservation contract; prior foundation files remain
in the dirty tree.

Owned client source/test manifest: `web/VALIDATION.md`. Shared updates:
`.github/workflows/web-validation.yml`, `docs/ACCOUNTING.md`, this evidence file,
`docs/BUILD_PROGRESS.md`, `docs/PROVIDER_MEDIA_HTTP.md`, `README.md`.

These results do not finish M1 or the full production rebuild. Accounting recovery,
signed payment webhooks, durable leases, workspace lifecycle, managed sandboxes,
Canvas/retrieval, complete API console, native editions and live qualification
remain. See `docs/ACCOUNTING.md` for failure/hold behavior and compatibility changes.
