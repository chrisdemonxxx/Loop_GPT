# Foundation checkpoint 03h: pinned DNS and bounded model lifecycles

Date: 2026-09-16. Local, uncommitted changes only. No deployment, production
migration, live inference/provider call, real credential use or remote CI run.

## Results

| Check | Result |
| --- | --- |
| Windows/Linux TypeScript build | Passed |
| Final Windows/Linux unit suite | 296 passed, 18 files |
| Windows integration suite | 126 passed, one existing symlink skip |
| Final Linux integration suite | 127 passed, no skips |
| Added unit regressions | 31; model transport file now has 71 tests |
| Added HTTP/DB regressions | Two v1 disconnect tests, streaming and nonstreaming |
| Clean Docker installs | Validation npm ci: 539 packages; runtime omit-dev: 467 packages |
| Prisma generation | 5.22.0 client generated successfully in both stages |
| Fresh/repeat migrations | Three applied; repeat had none pending |
| Schema diff | No difference detected |
| Production container smoke | Oversize/stalled bodies rejected; UID 1000; network disabled |

Combined Linux result: **423 passing tests**. Clean installs emitted existing
deprecation warnings; this is not a vulnerability audit. node-fetch 2.7.0 and its
2.6.13 type definitions were declared directly, matching existing transitive
versions. Lockfile update used offline, package-lock-only, ignore-scripts mode.

The initial response wrapper exposed the SDK's web-vs-Node declaration mismatch.
It now uses a concrete Node fetch/Response contract with a narrow SDK constructor
type adapter, verified against the actual installed SDK parser. No private shim
import or global fetch replacement is required.

Validation image: `loop-gpt-backend:validation-03h`
`sha256:10eff3907b51ffbfb62348f1a1c9dd2c2f092752aac8cccead2d2d6bfb6139f6`

Production image: `loop-gpt-backend:foundation-03h`
`sha256:7f5411302c7cd98beafbf45c1a10d5ab1f8b1ed1f814ee7e9a9bf87e07fe195e`

## Coverage and limitations

- Empty/private/mixed/malformed DNS answers rejected before fetch; checked IPv4/IPv6
  lookup callbacks pin a single address; repeated requests re-resolve rather than
  inheriting a prior public answer. Host/SNI destination remains the original URL.
- Stalled/late DNS and ignored fetch cancellation terminate promptly; late fetch
  bodies are destroyed. One deadline spans DNS and body consumption, not separate
  restarted timeouts. Unconsumed bodies, source errors and premature closes clean up.
- Request/header limits, response-header limits, invalid/oversized Content-Length,
  EOF mismatch and incremental response-byte overflow fail closed.
- Identity encoding is forced and node-fetch decompression is disabled; gzip,
  deflate and Brotli responses are rejected before decoding.
- Cancellation/timer/listener cleanup and real SDK SSE rejection after partial
  output are exercised. Oversized or stalled streams do not produce successful
  final SDK turns. Previously emitted deltas cannot be retracted.
- Real HTTP/API-key/PostgreSQL tests demonstrate v1 disconnect propagation before
  any model output and no late completed usage charge in those fixture scenarios.
  This does not implement or certify partial-usage settlement/reservations.

DNS and fetch are mocked in transport tests. Actual Node streams, node-fetch
Responses, SDK JSON/SSE/native-tool parsing and lookup callbacks are exercised.
No real external DNS/TCP/TLS path or live provider identity-encoding compatibility
was qualified. The byte cap excludes HTTP/TLS framing, and timers cannot preempt
synchronous parsing CPU. Aggregate run/concurrency budgets and other transports
remain separate work. See `docs/MODEL_HTTP.md`.

## Commands and test infrastructure

From `backend/`:

```powershell
npm.cmd install --package-lock-only --ignore-scripts --offline --no-audit --no-fund
npm.cmd run build
npm.cmd test
```

The DB was created with:

```powershell
docker run --rm -d --name loop-gpt-stream-db-03h -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1::5432 postgres:16-alpine
docker port loop-gpt-stream-db-03h 5432
```

Reported host port: 51787. `DATABASE_URL` and `TEST_DATABASE_URL` were explicitly
set to `postgresql://loop_test:local-test-only@127.0.0.1:51787/loop_foundation_test?schema=public`.
Prisma loads `.env`; the explicit override prevents using any real database. The
integration harness also rejects nonlocal/nondedicated databases. Then:

```powershell
npm.cmd run migrate:deploy
npm.cmd run test:integration
npm.cmd run migrate:deploy
npx.cmd prisma migrate diff --from-url "$env:DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

From repository root:

```powershell
docker build --target validation -t loop-gpt-backend:validation-03h backend
docker run --rm --network container:loop-gpt-stream-db-03h -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03h npm run test:integration
docker build -t loop-gpt-backend:foundation-03h backend
docker stop loop-gpt-stream-db-03h
```

Production smoke invoked the compiled guardedModelFetch with a fixture credential,
a fake node-fetch Response/PassThrough delegate, a 4-byte cap and 40-ms deadline
under `docker run --rm --network none`. It exercised a 5-byte body and a stalled
body, and required rejection plus destruction in both cases:

```text
size blocked; uid=1000
deadline blocked; uid=1000
```

Fixture cleanup removed only test-owned records. The owned disposable database
was stopped/automatically removed; the name-filtered running-container check was
empty. No production volume or user configuration was erased.

## Changed files

```text
backend/package.json
backend/package-lock.json
backend/src/services/publicHttp.ts
backend/src/services/modelTransport.ts
backend/src/agent/llmClient.ts
backend/src/agent/__tests__/modelTransport.test.ts
backend/src/routes/v1.ts
backend/src/services/__tests__/files.integration.test.ts
docs/MODEL_HTTP.md
docs/RUNTIME_AUTHORIZATION.md
docs/PUBLIC_HTTP.md
docs/BUILD_PROGRESS.md
docs/validation/foundation-03h.md
README.md
```

Other model/media/embedding clients, infrastructure egress rules, workspace lifecycle,
metering/reservations, durable execution and client migration remain release gates.
This checkpoint does not declare the full backend production-ready.
