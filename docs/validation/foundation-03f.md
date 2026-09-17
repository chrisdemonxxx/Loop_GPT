# Foundation checkpoint 03f: legacy hosted messages and selection retirement

Date: 2026-09-16. Local, uncommitted changes only. No production deployment,
external provider request, live credentials, remote CI or payment action.

## Scope and implementation

The legacy message route could accept per-request provider/multi-model settings,
mutate shared multi-model state and fall back to process-held provider credentials.
The `/api/models/selection` endpoint also read/wrote that singleton and bypassed
authentication implicitly in development. This checkpoint removes both HTTP paths
to the shared selection state.

- `messages.ts` inspects raw JSON with `resolveHostedModelRequest` before generic
  schema validation can strip unknown fields. Rejected overrides cause no model
  client creation or conversation write.
- Hosted chat/vision now instantiate request-local clients/abort signals and use
  operator-resolved targets. Owned history/private attachments and response
  envelopes remain. Existing image generation/private-artifact storage remains.
- No shared multi-model/interaction-mode imports, eager global OpenAI client,
  provider fallback, canned no-provider answer, or raw exception reflection.
- Unsupported legacy modes/schedules/placeholders return explicit 400 responses;
  this retires old handlers, not the planned replacement capabilities.
- Model selection endpoints return authenticated 410 for all verbs/subpaths.
  Public catalog metadata remains available; no shared credentials/configuration
  are returned. Old singleton service source files remain on disk, unused by these
  HTTP routes. Administrator-only provider settings are unchanged.

## Observed validation

| Check | Result |
| --- | --- |
| Windows TypeScript build | Passed after correcting two local type errors |
| Windows unit suite | 225 passed, 17 files |
| Linux validation image build/unit suite | 225 passed, 17 files |
| Final Windows integration suite | 122 passed, one existing symlink skip |
| Linux integration suite | 123 passed, no skips |
| New legacy-message suite | 19 passed on both platforms |
| Fresh migration deployment | All three existing migrations applied |
| Repeat migration deployment | No pending migrations |
| Schema diff | No difference detected |
| Production image HTTP smoke | `200,401,410,400`, UID 1000, external network disabled |
| `git diff --check` | Passed |

Combined Linux result: **348 passing tests**. Model and image responses are mocked
in integration tests; authentication, HTTP disconnects, PostgreSQL ownership and
record writes are real. Existing private-file integration tests also passed,
including vision attachment bytes and generated-image behavior. No live model,
image-provider or client UI compatibility is claimed.

The new tests cover raw URL/key-field rejection (including null/empty values),
provider switches across tool types, unsupported legacy modes/placeholders, content
length, missing attachments, conversation ownership, hosted large-tier routing,
response envelope/history, concurrent users with different tiers and private
prompts, SDK constructor/provider/empty-answer failures, disconnect cancellation,
and global model-selection retirement. Shared dispatcher/fallback spies remain
uncalled throughout the suite.

Validation image: `loop-gpt-backend:validation-03f`
`sha256:1124c2c8df6c0a7426c911276ec9c2e1e6eebc21ad64a4efc88f1e88a95a98ee`

Production image: `loop-gpt-backend:foundation-03f`
`sha256:d2e4cb94ce2b5bd5e4eba868b612023ec51e0f27a2b4e673a02420649c35ed76`

Dependency install/Prisma generation layers were cached; no cold dependency audit
or SDK network-behavior certification was performed.

## Reproduction

From repository root:

```powershell
npm.cmd --prefix backend run build
npm.cmd --prefix backend test
docker run --rm -d --name loop-gpt-legacy-db-03f -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1::5432 postgres:16-alpine
docker port loop-gpt-legacy-db-03f 5432
```

Host port in this run: 54603. From `backend/`, explicitly set both `DATABASE_URL`
and `TEST_DATABASE_URL` to
`postgresql://loop_test:local-test-only@127.0.0.1:54603/loop_foundation_test?schema=public`.
Prisma loads `.env`, so the explicit override is required. The integration harness
also rejects nonlocal/nondedicated databases. Run:

```powershell
npm.cmd run migrate:deploy
npm.cmd run test:integration
npm.cmd run migrate:deploy
npx.cmd prisma migrate diff --from-url "$env:DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

From repository root:

```powershell
docker build --target validation -t loop-gpt-backend:validation-03f backend
docker run --rm --network container:loop-gpt-legacy-db-03f -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03f npm run test:integration
docker build -t loop-gpt-backend:foundation-03f backend
```

Production smoke used `docker run --rm --network none` with a fixture-only JWT
secret and a small loopback Express app importing compiled `models` and `messages`
routers. It asserted public catalog 200, unauthenticated selection 401,
authenticated selection 410, and a rejected legacy credential override 400.
Output: `legacy route smoke passed: 200,401,410,400; uid=1000`.
No database or provider request was needed for this smoke.

Fixture suites removed only their test-owned records. The disposable
`loop-gpt-legacy-db-03f` container was stopped and automatically removed; the
subsequent name-filtered running-container check returned no rows. No external
database, persistent production volume or user configuration was erased.

## Files changed

```text
backend/src/routes/messages.ts
backend/src/routes/models.ts
backend/src/middleware/validation.ts
backend/src/services/__tests__/legacyHostedMessages.integration.test.ts
docs/RUNTIME_AUTHORIZATION.md
docs/PUBLIC_HTTP.md
docs/BUILD_PROGRESS.md
docs/validation/foundation-03f.md
README.md
```

## Compatibility and remaining gates

This changes old clients: remove provider/key/URL/multi-model fields, use hosted
model aliases per request and the public catalog, and stop calling global model
selection. Only omission/`ask` is supported for legacy interaction mode. Use the
workspace streaming route for current agent/research execution; durable automation
and packaged MCP still need implementation. Upstream provider/model metadata is
no longer included in legacy chat responses.

SDK redirects, DNS pinning, response limits and operator endpoint/credential policy
remain separate work. Image generation has not gained transport cancellation or
egress isolation. User messages may persist after failure/disconnect; cancellation
checks are not atomic with database writes. Full legacy workspace revocation,
no-database fallback removal, metering, idempotency, durable execution and frontend
migration remain release blockers. No production-readiness claim is made.
