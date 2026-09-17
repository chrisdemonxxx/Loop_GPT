# Foundation checkpoint 03c: bounded public web egress

Date: 2026-09-16. Local, uncommitted work on top of 03b. No production service
was deployed or migrated. No live website, model, search-provider or connector
API call was used to validate this checkpoint.

## Observed validation

| Check | Result |
| --- | --- |
| TypeScript build, Windows and Linux/Node 22 | Passed |
| Unit tests, Windows and Linux | 15 files, 198 passed |
| New public HTTP/consumer unit tests | 82 + 7 passed |
| Integration tests, Windows checkpoint run | 71 passed, one existing symlink-privilege skip |
| Final integration tests, Linux/PostgreSQL | 4 files, 72 passed, zero skipped |
| Fresh disposable database | Existing three migrations applied |
| Repeat migration | No pending migrations |
| Database/schema diff | No difference detected |
| Production Docker build | Passed |
| Production-image private-target rejection, networking disabled | `blocked_destination` |
| git diff --check | No whitespace errors; existing line-ending warnings |

Final Linux total: **270 passing tests**. New network tests mock DNS and HTTP(S)
request creation, using actual Node streams/zlib for body handling. They verify
checked addresses are supplied to the socket lookup and original hostnames are
retained, but do not establish live DNS/TLS/provider interoperability. Existing
integration tests exercise real Express, JWT, PostgreSQL and runtime permissions,
with model/search/fetch providers mocked as documented in earlier checkpoints.

## Assertions added

- Public IPv4/IPv6 classification; private, reserved and common metadata targets.
- Numeric/octal/hex loopback URLs, mapped IPv6, local names, URL credentials,
  nonstandard ports, non-HTTP protocols, backslashes and whitespace rejection.
- No socket creation on rejected URL/DNS, including empty/mixed-family/mixed
  public-private answers and DNS changes on same-host redirects.
- Original hostname retained, checked address pinned, dedicated agents with
  environment proxies disabled and response-header cap configured.
- Public anonymous redirect success, private/downgrade/credential redirect denial,
  bounded loops, no replay of authenticated bodies to redirect destinations.
- Exact-origin restrictions, TLS for credential/custom-header requests, forbidden
  framing/proxy/header overrides, CRLF rejection and request-body bounds.
- Content-length limits, chunked body counting, gzip/deflate/Brotli decoded-byte
  limits, unsupported encoding and sanitized HTTP/JSON/transport failures.
- Deadlines cover stalled DNS and response bodies; cancellation stops waiting,
  destroys requests and prevents late DNS results from opening a socket.
- Page reading uses the new client, final URL, byte/redirect bounds and cancellation;
  embedded scripts are not executed and raw errors are not reflected.
- Tavily/Brave use fixed origins; fallback requests do not inherit API credentials.
  DuckDuckGo/Bing use the bounded client; cancellation prevents provider fallback.
- Search query/result/title/snippet limits and rejection of private result URLs.

## Commands and environment

From `backend/` (npm.cmd/npx.cmd on Windows):

```text
npm run build
npm test
npm run migrate:deploy
npm run test:integration
npm run migrate:deploy
npx prisma migrate diff --from-url <explicit-local-test-URL> --to-schema-datamodel prisma/schema.prisma --exit-code
docker build --target validation -t loop-gpt-backend:validation-03c .
docker run --rm --network container:loop-gpt-egress-db-next -e TEST_DATABASE_URL=<explicit-local-test-URL> loop-gpt-backend:validation-03c npm run test:integration
docker build -t loop-gpt-backend:foundation-03c .
docker run --rm --network none loop-gpt-backend:foundation-03c node -e "require('./dist/services/publicHttp.js').publicRequest('http://127.0.0.1').then(()=>process.exit(1),e=>{if(e.code!=='blocked_destination')process.exit(1);console.log(e.code)})"
```

The host rejected the initially requested port 55439. The successful disposable
database container used Docker-assigned `127.0.0.1:50653`; Linux tests used its
network namespace at `127.0.0.1:5432`. Database: `loop_foundation_test`, user:
`loop_test`, disposable test-only password. Migration commands explicitly
overrode DATABASE_URL. No existing .env database was targeted.

Final validation image:
`sha256:23e9339dc0c71cfc7f7371b73c5d71e2c8b1d8c1bf44110391e820471fa13e0a`

Final production image:
`sha256:75148b2dfb21626b902f5a6b50bea0e4ceea53862c1a9cdf265ee8f49db2e822`

## Files added/changed

```text
backend/src/services/publicHttp.ts
backend/src/services/__tests__/publicHttp.test.ts
backend/src/agent/tools/webFetch.ts
backend/src/agent/tools/webSearch.ts
backend/src/agent/research/deepResearch.ts
backend/src/agent/__tests__/webConsumers.test.ts
backend/src/agent/httpClient.ts (legacy transport warning only)
README.md
docs/PUBLIC_HTTP.md
docs/RUNTIME_AUTHORIZATION.md
docs/BUILD_PROGRESS.md
docs/validation/foundation-03c.md
```

No dependency or schema changes were needed. Prior local work was preserved.

## Cleanup and remaining work

Test fixtures cleaned up their own records. The successful test container was
stopped; the `loop-gpt.purpose=egress-tests` running-container listing was empty.
Build images/cache remain. No commit, push or background job was created.

Stored connectors remain disabled. The code review recommends Notion search and
GitLab project search as the first scoped read-only adapters, not as already
implemented or live-certified integrations. The shared legacy factory must not
be re-enabled. See `docs/PUBLIC_HTTP.md` for the readiness matrix.

Other model/media HTTP paths, deployment-specific egress firewalls, real-provider
compatibility, aggregate quotas and isolated parsing remain. Application-layer
public-IP checks are not a complete network-security boundary and do not make
the entire backend production-ready.
