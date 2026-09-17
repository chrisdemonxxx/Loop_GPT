# Foundation checkpoint 03g: model SDK destination/credential guard

Date: 2026-09-16. Local uncommitted work. No deployment, external model/provider
call, live credential use, remote CI or payment action. See `docs/MODEL_HTTP.md`
for the exact policy and intentional compatibility changes.

## Validation results

| Check | Result |
| --- | --- |
| Windows TypeScript build | Passed |
| Windows/Linux unit suites | 265 passed, 18 files |
| Windows integration suite | 124 passed, one existing symlink skip |
| Final Linux integration suite | 125 passed, no skips |
| New SDK tests | 40 passed using real SDK construction/parsing and mocked fetch |
| New v1 route regressions | Two passed: generic construction-error 502 for both stream modes |
| Fresh/repeat migrations | Three existing migrations applied; repeat had none pending |
| Schema diff | No difference detected |
| Production build/smoke | Passed; destination mutation rejected, UID 1000 |

Combined Linux result: **390 passing tests**. Initial local compilation exposed
the SDK's private fetch field; the implementation was corrected to use its custom
fetch constructor option. A mocked response initially emitted string chunks and
was corrected to Buffer chunks matching actual node-fetch response streams.

The final production guard also verifies Content-Length against its JSON body and
explicitly enables certificate verification. Final images were rebuilt and all
Linux integration tests repeated against a second fresh disposable database.

Validation image: `loop-gpt-backend:validation-03g`
`sha256:5e412092dcf33c5f96e824ab523a73afd2e290c868b67138695ee5ae088a3d21`

Production image: `loop-gpt-backend:foundation-03g`
`sha256:9e635eac1d0a6e1e80527bcc20497c3a1dcb05a6a01d0dc0fe0eb0875caa7c0a`

Dependency installation and Prisma generation layers were cached. No cold
dependency audit or live TLS/provider interoperability check was performed.

## Test coverage

- Invalid HTTP/private literal/local-name/userinfo/port/query/fragment/escaped or
  dot-segment roots fail before client construction; HF is confined to configured
  roots and other compatible provider clients to their fixed roots.
- Missing/empty/malformed keys fail without a server-key fallback. Ambient OpenAI
  URL and tenant headers do not retarget requests.
- Real SDK JSON requests and SSE/native tool-call parsing work with mocked wire
  responses. Guards reject destination mutation, absolute URL escapes, query,
  authorization, routing/tenant/cookie and Content-Length overrides.
- All tested redirects (301/302/303/307/308) and 401/429/500 error responses are
  discarded without a second fetch or reflected provider body. Same-origin
  redirects and unexpected response URLs are rejected too.
- Supplied agents are replaced; requests use separate agents with direct proxy
  configuration and certificate verification, released on response consumption.
- Generic transport errors and cancellation forwarding/precancelled requests are
  checked. Real HTTP/DB tests verify v1 handles SDK setup failure before headers.

The network delegate is mocked. No DNS lookup, socket connection or TLS handshake
to an external model was performed. The tests do not establish DNS pinning,
full-stream deadlines/byte caps, proxy infrastructure compatibility or general DLP.

## Reproduction and cleanup

From repository root, run `npm.cmd --prefix backend run build` and
`npm.cmd --prefix backend test`. Create a disposable DB:

```powershell
docker run --rm -d --name loop-gpt-sdk-db-03g -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1::5432 postgres:16-alpine
docker port loop-gpt-sdk-db-03g 5432
```

The host port was 57470. In `backend/`, explicitly set `DATABASE_URL` and
`TEST_DATABASE_URL` to
`postgresql://loop_test:local-test-only@127.0.0.1:57470/loop_foundation_test?schema=public`.
Prisma loads `.env`; the explicit override is essential. Run `npm.cmd run
migrate:deploy`, `npm.cmd run test:integration`, repeat migration deployment, then
`npx.cmd prisma migrate diff --from-url "$env:DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code`.

From repository root:

```powershell
docker build --target validation -t loop-gpt-backend:validation-03g backend
docker run --rm --network container:loop-gpt-sdk-db-03g -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03g npm run test:integration
docker build -t loop-gpt-backend:foundation-03g backend
docker run --rm --network none -e HF_ENDPOINT_URL=https://hosted.example.com -e HF_TOKEN=fixture-smoke-only loop-gpt-backend:foundation-03g node -e "const c=require('./dist/agent/llmClient.js').createClient('huggingface');c.baseURL='https://other.example.com/v1';c.chat.completions.create({model:'fixture',messages:[{role:'user',content:'q'}]}).then(()=>{process.exitCode=1},e=>{if(e.cause?.constructor.name!=='ModelTransportError'){console.error('Unexpected rejection');process.exitCode=1}else console.log('SDK destination mutation blocked; uid='+process.getuid())})"
docker stop loop-gpt-sdk-db-03g
```

Smoke output: `SDK destination mutation blocked; uid=1000`. This used a fixture
key and external network disabled, and rejected the URL before network dispatch.
The final Linux run used `loop-gpt-sdk-db-03g-final` without a published host port,
deployed migrations, ran 125 integration tests and stopped/removed that container.
Both owned disposable containers were stopped and automatically removed. Fixture
cleanup affects only test-owned records; no production DB/volume was modified.

## Files changed

```text
backend/src/services/modelTransport.ts
backend/src/agent/llmClient.ts
backend/src/agent/__tests__/modelTransport.test.ts
backend/src/routes/v1.ts
backend/src/services/__tests__/files.integration.test.ts
docs/MODEL_HTTP.md
docs/RUNTIME_AUTHORIZATION.md
docs/PUBLIC_HTTP.md
docs/BUILD_PROGRESS.md
docs/validation/foundation-03g.md
README.md
```

Remaining blockers include checked/pinned DNS for model requests, full-response
budgets, other model/media/embedding transports, workspace lifecycle, metering,
durable execution and client migration. This checkpoint is not backend-wide SSRF
protection or production qualification.
