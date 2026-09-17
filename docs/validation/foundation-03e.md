# Foundation checkpoint 03e: hosted model selection at HTTP boundaries

Date: 2026-09-16. All changes are local and uncommitted. No live model/provider
request, production migration, deployment, payment action or remote CI run.

## Change and scope

The agent route's old provider resolver accepted client provider/key/URL fields.
The shared SDK supports falling back to process-held keys, so combining those
behaviors allowed untrusted target selection to reach server credential resolution.
This checkpoint removes those client controls on **both agent stream aliases and
both CLI-completion aliases**, consistent with hosted-only launch scope.

`resolveHostedModelRequest` accepts optional hosted provider/model selection only;
destinations and upstream model names come from the operator catalog. It rejects
credential, URL and multi-model override fields, even null/empty values, before
conversation writes or client construction. Unknown bounded model strings retain
the catalog's standard fallback; the raw string is never sent to the SDK.

The CLI relay now validates its message/tool/stream envelope, catches SDK creation
and nonstreaming errors as well as streaming failures, returns generic errors and
propagates HTTP disconnect cancellation. Provider startup is awaited before SSE
headers, allowing startup errors to return HTTP 502. This does not add billing
reservations or workspace execution to the direct-completion relay.

## Observed results

| Check | Result |
| --- | --- |
| Windows TypeScript build | Passed |
| Windows unit tests | 225 passed across 17 files |
| Linux validation-image build/unit suite | 225 passed across 17 files |
| Windows integration suite | 103 passed, one existing symlink skip |
| Linux integration suite | 104 passed, no skips |
| New selection unit tests | 15 passed |
| New route regression tests | 13 passed; existing runtime file now has 39 |
| Fresh migrations | All three existing migrations applied |
| Repeat migration deployment | No pending migrations |
| Schema diff | No difference detected |
| Production image | Built; network-disabled boundary smoke passed as UID 1000 |

Combined Linux result: **329 passing tests**. HTTP authentication, owned fixture
records, conversation checks and HTTP disconnect behavior are real. Model SDK
construction and responses are mocked in integration tests. No live SDK/TLS/hosted
provider compatibility was tested. Docker dependency/Prisma layers were cached;
this is not a fresh dependency audit.

Validation image: `loop-gpt-backend:validation-03e`
`sha256:da2bbbb80093ed027c12658fbe11f66acc9144c588858a87ea75f543d2a0b310`

Production image: `loop-gpt-backend:foundation-03e`
`sha256:8976231583e3826635a402d90486603340df255d6acd53c45ccd63c66af0540b`

## Commands and test infrastructure

From repository root:

```powershell
npm.cmd --prefix backend run build
npm.cmd --prefix backend test
docker run --rm -d --name loop-gpt-hosted-db-03e -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1::5432 postgres:16-alpine
docker port loop-gpt-hosted-db-03e 5432
```

The reported host port was 58539. In `backend/`, explicitly set `DATABASE_URL` and
`TEST_DATABASE_URL` to
`postgresql://loop_test:local-test-only@127.0.0.1:58539/loop_foundation_test?schema=public`.
Prisma loads `.env`; the explicit override is mandatory. The integration harness
independently requires the dedicated local database. Run:

```powershell
npm.cmd run migrate:deploy
npm.cmd run test:integration
npm.cmd run migrate:deploy
npx.cmd prisma migrate diff --from-url "$env:DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

From repository root:

```powershell
docker build --target validation -t loop-gpt-backend:validation-03e backend
docker run --rm --network container:loop-gpt-hosted-db-03e -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03e npm run test:integration
docker build -t loop-gpt-backend:foundation-03e backend
docker run --rm --network none loop-gpt-backend:foundation-03e node -e "const {resolveHostedModelRequest:r,ModelSelectionError:E}=require('./dist/services/hostedModelRequest.js'); if(r({}).provider!=='huggingface')process.exit(1); let denied=false; try {r({provider:'openai',baseUrl:'http://127.0.0.1'})}catch(e){denied=e instanceof E} if(!denied)process.exit(1); console.log('hosted-only boundary passed; uid='+process.getuid())"
docker stop loop-gpt-hosted-db-03e
```

Smoke output: `hosted-only boundary passed; uid=1000`.
Fixture cleanup deleted only test-owned records. The disposable container was
stopped/automatically removed; a name-filtered running-container check returned
no rows. No external database, persistent volume or existing user files were erased.

## Files changed in this checkpoint

```text
backend/src/services/hostedModelRequest.ts
backend/src/services/__tests__/hostedModelRequest.test.ts
backend/src/routes/agent.ts
backend/src/services/__tests__/runtimeIsolation.integration.test.ts
docs/RUNTIME_AUTHORIZATION.md
docs/PUBLIC_HTTP.md
docs/BUILD_PROGRESS.md
docs/validation/foundation-03e.md
README.md
```

## Remaining gates

This is **not backend-wide destination isolation**. `routes/messages.ts` still
accepts provider/multi-model configuration through legacy services and mutates
shared multi-model state. `aiProviders.ts`/`agent/llmClient.ts` retain broad internal
APIs. Other model/media routes, operator endpoint policy, SDK redirects/DNS
pinning, streaming byte limits and request budgets still require review.

Hosted configuration must be secured operationally; the new resolver does not
validate operator URLs or replace the SDK transport with `publicHttp`. CLI metering,
full workspace lifecycle, durable execution and frontend migration remain release
blockers. Provider/key/baseUrl controls in old clients must be removed for these
endpoints. See `docs/RUNTIME_AUTHORIZATION.md` for exact client-facing behavior.
