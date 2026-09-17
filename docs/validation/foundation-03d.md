# Foundation checkpoint 03d: opt-in workspace search connectors

Date: 2026-09-16. Local, uncommitted work on top of checkpoints 03a-03c.
No deployment, production migration, remote CI run, live model call or live
Notion/GitLab call was performed. This is not production qualification.

## Results

| Check | Observed result |
| --- | --- |
| Windows `npm.cmd run build` | TypeScript passed |
| Windows `npm.cmd test` | 210 tests passed, 16 files |
| Docker validation target (Node 22/Linux) | Build and all 210 unit tests passed |
| Final Windows integration suite | 90 passed, one existing symlink skip; 5 files |
| Linux integration suite | 91 passed, no skips; 5 files |
| New connector integration suite | 19 passing HTTP/runtime/PostgreSQL tests on both platforms |
| New unit regressions | 10 adapter construction/projection tests; 2 pre-connect hook tests |
| Fresh migrations | Three existing migrations applied successfully |
| Repeat migration deployment | `No pending migrations to apply.` |
| Schema diff | `No difference detected.` |
| Production image | Built successfully; adapter imports succeeded with UID 1000 |
| Network-disabled transport smoke | Loopback URL rejected with `blocked_destination` |
| `git diff --check` | Passed; existing line-ending conversion warnings only |

Combined final Linux result: **301 passing tests**. Dependency install and Prisma
generation Docker layers were cached from the preceding validated build; this
checkpoint did not repeat a cold dependency install or vulnerability audit.

Validation image: `loop-gpt-backend:validation-03d`
`sha256:70eae05a68f54fc0df05149c0e265081ca53ae15e7ba05f9b2f14e71ddf08e83`

Production image: `loop-gpt-backend:foundation-03d`
`sha256:6280c2a58bad4f9015af4e8c2243e94c13257cc07ef2cea1bf7a9bf32f37fd86`

## Reproduction and isolation

From the repository root (PowerShell):

```powershell
npm.cmd --prefix backend run build
npm.cmd --prefix backend test
docker run --rm -d --name loop-gpt-adapters-db-03d -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1::5432 postgres:16-alpine
docker port loop-gpt-adapters-db-03d 5432
```

From `backend/`, set both `DATABASE_URL` and `TEST_DATABASE_URL` explicitly to
`postgresql://loop_test:local-test-only@127.0.0.1:<reported-port>/loop_foundation_test?schema=public`.
The host port in this run was 52373. Prisma loads `.env`, so the explicit override
is required; the integration harness independently rejects nonlocal/nondedicated
database names. Then run:

```powershell
npm.cmd run migrate:deploy
npm.cmd run test:integration
npm.cmd run migrate:deploy
npx.cmd prisma migrate diff --from-url "$env:DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

From the repository root:

```powershell
docker build --target validation -t loop-gpt-backend:validation-03d backend
docker run --rm --network container:loop-gpt-adapters-db-03d -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03d npm run test:integration
docker build -t loop-gpt-backend:foundation-03d backend
docker run --rm --network none loop-gpt-backend:foundation-03d node -e "const a=require('./dist/agent/connectors/reviewedAdapters.js'); if(!a.reviewedAdapter('notion') || !a.reviewedAdapter('gitlab') || a.reviewedAdapter('slack')) process.exit(1); console.log('reviewed adapters loaded; uid='+process.getuid()); require('./dist/services/publicHttp.js').publicRequest('http://127.0.0.1').then(()=>process.exit(1),e=>{if(e.code!=='blocked_destination')process.exit(1);console.log(e.code)})"
docker stop loop-gpt-adapters-db-03d
git diff --check
```

Fixture tests remove their uniquely prefixed users/workspaces/conversations. The
owned disposable database container was stopped and automatically removed; the
subsequent name-filtered running-container check returned no rows. No persistent
production database/volume or user configuration was erased. After strengthening
unit assertions for encoded echoes, truncation and malformed JSON, both images
were rebuilt. The final image repeated all 91 Linux integration tests against a
second fresh database container, `loop-gpt-adapters-db-03d-final`, with no published
host port. That container was also stopped/removed, and the runtime smoke repeated.

## Coverage and boundaries

- Real database storage/decryption, membership/version checks, private run grants,
  argument validation, authenticated discovery and both SSE route aliases.
- No credential decryption during discovery, demonstrated with the vault key
  temporarily absent; execution without the key fails without provider dispatch.
- Foreign workspace/connection selection, viewer access, copied/unissued context,
  model-supplied URL/header/token/method overrides and unsupported adapters denied.
- Captured access invalidated by rotation, disable/delete, member removal/downgrade
  and changed connection type. A newly issued run uses the rotated credential.
- Version recheck before credentials are sent; result withholding after membership
  removal or connection disable during the provider request.
- No default connector access without explicit selection. `toolNames` narrows
  opted-in connections. Duplicate/too many IDs, chat/research selection, unselected
  tool names and foreign/missing IDs are rejected before conversation creation.
- Fixed HTTP construction, search-filter injection resistance, argument/token
  validation, metadata projection, exact token/percent-encoded echo redaction,
  malformed JSON handling and summary byte caps.

Provider transport and model replies are mocked in connector integration tests.
The mock invokes the real adapter's `beforeConnect` callback, with controlled
permission changes before/after the simulated provider response. Separate public
HTTP unit tests mock DNS/socket construction and prove preflight rejection or
timeout opens no socket. This is not a live DNS/TLS/provider interoperability test.
HTTP deadlines do not bound every database access, and permission checks are not
atomic with remote dispatch. Revocation cannot retract a request already sent.

## Checkpoint files (relative to repository root)

```text
backend/src/agent/connectors/reviewedAdapters.ts
backend/src/agent/__tests__/reviewedAdapters.test.ts
backend/src/services/workspaceTools.ts
backend/src/services/workspaceConnections.ts
backend/src/services/runWorkspace.ts
backend/src/services/publicHttp.ts
backend/src/services/__tests__/workspaceTools.integration.test.ts
backend/src/services/__tests__/workspaces.integration.test.ts
backend/src/services/__tests__/publicHttp.test.ts
backend/src/routes/agent.ts
backend/src/routes/workspaces.ts
docs/WORKSPACES.md
docs/RUNTIME_AUTHORIZATION.md
docs/PUBLIC_HTTP.md
docs/BUILD_PROGRESS.md
docs/validation/foundation-03d.md
README.md
```

This continuation expanded `workspaceTools.integration.test.ts` and
`reviewedAdapters.test.ts` and updated the six documentation files above; the
other checkpoint implementation files were
already present and were validated without additional code changes this turn.

## Remaining work

Only read-only Notion title search and GitLab.com project search are enabled.
Notion uses API version `2022-06-28`; live compatibility/least-privilege provider
setup must be qualified before rollout. Pagination beyond the first page, write
approval/idempotency, OAuth, the remaining catalog and MCP remain pending. Do not
reactivate the unsafe legacy global connector factory.

Other model/media destinations and credential boundaries still need hardening.
Full workspace lifecycle, durable execution, billing reservations and client UI
remain release blockers. This checkpoint does not enable checkout or paid rollout.
