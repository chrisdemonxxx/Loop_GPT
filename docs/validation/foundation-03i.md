# Foundation checkpoint 03i: independent provider and media migration

Date: 2026-09-16. Local, uncommitted work only. No deployment, production migration,
live provider request, real credential use, commit, push or remote CI execution.

## Verified results

| Check | Result |
| --- | --- |
| Windows and Linux TypeScript build | Passed |
| Windows and Linux unit tests | 611 passed in 26 files |
| Windows PostgreSQL integration tests | 141 passed, one existing symlink skip |
| Linux PostgreSQL integration tests | 142 passed in 7 files, no skips |
| New coverage versus 03h | 315 unit and 15 integration tests |
| Fresh migrations | All three existing migrations applied |
| Repeat migrations / schema diff | None pending / no difference detected |
| Validation and production images | Built successfully |
| Compiled transport smoke on Windows | Passed |
| Production transport smoke | Passed with network disabled, UID 1000 |
| Final whitespace check | `git diff --check` passed |

Combined Linux result: **753 passing tests**. Builds reused the unchanged cached
dependency-install/Prisma layers from 03h; they are not new clean-install evidence.
The current source compiled and the complete unit suite ran in the validation
build. Existing Vite CJS/dependency deprecations are not resolved by passing tests.

Image IDs reported by Docker:

- `loop-gpt-backend:validation-03i`:
  `sha256:32a621a6f3d350cb91242a8aa0d58708aefdd71c15126fb7b6bfef12bfcce797`
- `loop-gpt-backend:foundation-03i`:
  `sha256:e3704364eb6fb471018fad976b72fdea099d600ee4aaffe50f52413ffea71b18`

An initial combined image-inspection template requested a missing User field on
the validation stage. Inspection was repeated with `.Id` only; the runtime smoke
independently confirmed UID 1000. This was not a build/test failure.

## Coverage

Public-provider tests cover URL/origin/header constraints, all-answer public DNS,
pinned lookup, fresh resolution, late/cancelled DNS, redirect/error suppression,
body/header limits, framing/encoding validation, EOF and lifecycle cleanup. Sidecar
tests cover separate private-address rules, fixed paths, credentials prohibition
and host/port/base-path preservation. Tiny response chunks are coalesced into
bounded blocks without changing bytes; signed queries containing `@` are retained.

Consumer tests cover fixed-origin discovery/Anthropic calls, isolated credentials,
embedding pooling, image response formats and batch retry/deadline/disconnect
behavior, sidecar reference inputs, image fallback, video polling/CDN credential
segregation, persisted-job origin validation, cancellation, budget anchoring and
generic errors. Credit-check rejection dispatches neither image nor video work.
Detached worker DB rejection is handled without logging raw database details.

The 13 new provider-flow integration tests use real PostgreSQL and private files:
resumption, authenticated same-origin polling, anonymous CDN retrieval, artifact
ownership/hash/bytes, malicious persisted URLs, origin changes, watcher cancellation,
completed-job reruns, expired budgets and sanitized provider failures. Two added
runtime-isolation tests abort research planning/verification without fallback or
synthesis. A real-SDK unit case verifies `completeOnce` signal forwarding.

## Reproduction

From `backend/`:

```powershell
npm.cmd run build
npm.cmd test
```

Owned temporary DB (no production volumes):

```powershell
docker run --rm -d --name loop-gpt-provider-db-03i -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1::5432 postgres:16-alpine
docker port loop-gpt-provider-db-03i 5432
```

This run allocated port **52235**. Explicitly set both environment variables to
`postgresql://loop_test:local-test-only@127.0.0.1:52235/loop_foundation_test?schema=public`
before invoking Prisma/tests. Prisma loads `.env`; explicit override prevents
using a real database. The integration harness requires a dedicated local DB.

```powershell
npm.cmd run migrate:deploy
npm.cmd run test:integration
npm.cmd run migrate:deploy
npx.cmd prisma migrate diff --from-url "$env:DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
node scripts/provider-transport-smoke.cjs
```

From repository root:

```powershell
docker build --target validation -t loop-gpt-backend:validation-03i backend
docker build -t loop-gpt-backend:foundation-03i backend
docker run --rm --network container:loop-gpt-provider-db-03i -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03i npm run test:integration
docker run --rm --network none --mount "type=bind,source=$PWD/backend/scripts/provider-transport-smoke.cjs,target=/app/scripts/provider-transport-smoke.cjs,readonly" loop-gpt-backend:foundation-03i node scripts/provider-transport-smoke.cjs
docker stop loop-gpt-provider-db-03i
git diff --check
```

Production smoke output:

```text
loopback sidecar healthy; uid=1000
oversize blocked
redirect blocked
encoded blocked
stall blocked
caller cancellation blocked stalled response
public-private destination and sidecar credentials rejected before dispatch
```

The checked-in smoke script creates only a temporary loopback server and restores
its environment; it has a 10-second watchdog and cleans up its sockets. The CI
workflow now includes the same network-disabled runtime check, but remote CI has
not run. The disposable database was stopped/automatically removed; its filtered
running-container check was empty. No existing user environment was erased.

## Files in this slice

Production: `backend/src/services/{providerHttp,aiProviders,imageApi,mediaJobs}.ts`,
`backend/src/routes/{v1,settings,messages}.ts`,
`backend/src/agent/{httpClient,llmClient}.ts`,
`backend/src/agent/tools/{generateImage,generateVideo}.ts`,
`backend/src/agent/research/deepResearch.ts`.

Tests under `backend/src/services/__tests__/`:
`providerHttp.test.ts`, `aiProvidersTransport.test.ts`,
`settingsProviderTransport.test.ts`, `v1ProviderTransport.test.ts`,
`imageApiTransport.test.ts`, `mediaJobsTransport.test.ts`,
`providerFlows.integration.test.ts`, `runtimeIsolation.integration.test.ts`.

Tests under `backend/src/agent/__tests__/`:
`generateMediaTransport.test.ts`, `httpClientTransport.test.ts`, `modelTransport.test.ts`.

Also: `backend/scripts/provider-transport-smoke.cjs`,
`.github/workflows/backend-validation.yml`, `README.md`,
`docs/{PROVIDER_MEDIA_HTTP,MODEL_HTTP,PUBLIC_HTTP,RUNTIME_AUTHORIZATION,BUILD_PROGRESS}.md`,
and this evidence file. Earlier foundation changes remain in the dirty tree.

## Remaining release limits

See `../PROVIDER_MEDIA_HTTP.md` for exact policy and compatibility changes. Public
DNS/TLS/live provider contracts were mocked, not production-qualified. A real local
HTTP smoke does not change that. Billing reservations, legacy metering, job leases,
workspace lifecycle, orphan cleanup, egress firewall, credential replacement and
owned UI/native work remain. This completes the transport slice, not foundation M1
or the production rebuild.
