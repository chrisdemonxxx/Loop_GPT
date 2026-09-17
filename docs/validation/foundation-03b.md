# Foundation checkpoint 03b: workspace-bound built-in execution

Date: 2026-09-16. Local/uncommitted work on top of checkpoints 01/02/03a.
No live model/provider requests, deployment, production migration, commit or
push were performed. Earlier work was preserved.

## Final verification

| Check | Observed result |
| --- | --- |
| TypeScript, Windows and Linux/Node 22 | Passed |
| Unit suite, Windows and Linux | 13 files, 109 passed |
| Integration suite, Windows | 71 passed, one existing symlink-privilege skip |
| Integration suite, Linux/PostgreSQL | 4 files, 72 passed, zero skipped |
| New runtime isolation integration tests | 26 passed |
| Fresh migration deployment | Existing three migrations applied |
| Repeated migration deployment | No pending migrations |
| Database/schema diff | No difference detected |
| Validation and production Docker builds | Passed, clean npm ci |
| Production-image agent bootstrap, network disabled | `Agent ready — 7 tools registered` |
| git diff --check | No whitespace errors; existing line-ending warnings |

**181 tests pass on Linux.** New tests execute real JWT middleware, both streaming
aliases, the agent loop, tool gate, calculator and PostgreSQL authorization. Model
responses, research search/fetch and inference clients are mocked. The actual SSE
route returns a calculator result of 42 and persists the mocked final response.
No external credentials were used. The production smoke checks module bootstrap,
not a full production-container HTTP/inference flow.

AJV is now a direct pinned dependency at **8.20.0**, retaining the version already
present transitively in the original lockfile. An intermediate older pin was
replaced before final validation. Windows npm reported blocked install scripts
under its existing policy; no policy bypass was applied. Clean Linux npm ci,
Prisma generation, compilation, unit tests and integration tests all succeeded.
Other dependency deprecation warnings remain; no full vulnerability audit is
claimed.

## Commands and environment

From `backend/` (npm.cmd/npx.cmd on Windows):

```text
npm install --save-exact ajv@8.20.0 --no-audit --no-fund
npm run build
npm test
npm run migrate:deploy
npm run test:integration
npm run migrate:deploy
npx prisma migrate diff --from-url <explicit-local-test-URL> --to-schema-datamodel prisma/schema.prisma --exit-code
docker build --target validation -t loop-gpt-backend:validation-03b .
docker run --rm --network container:loop-gpt-runtime-db -e TEST_DATABASE_URL=<explicit-local-test-URL> loop-gpt-backend:validation-03b npm run test:integration
docker build -t loop-gpt-backend:foundation-03b .
docker run --rm --network none loop-gpt-backend:foundation-03b node -e "require('./dist/agent/index.js').initAgent().catch(()=>process.exit(1))"
```

Dedicated database: `loop_foundation_test`, test user `loop_test`, disposable
test-only password. Host port: `127.0.0.1:55439`; Linux tests shared the database
container namespace on `127.0.0.1:5432`. Migration commands explicitly overrode
DATABASE_URL; the existing .env database was not targeted. Integration tests
retain the localhost/exact-database-name guard.

Final validation image:
`sha256:1cfa99f4bcbcb3f571a0741289a864f396d880aab8b04ff7b6fadc60f56b3a99`

Final production image:
`sha256:c42720a0505f0f28341284db17b27f9bf8a48195c29f77da14bcba29b8cd62ae`

## New assertions

- Fabricated, copied or serialized grants fail before contacting a model.
- Grant broadening and identity tampering fail; registered-but-unselected tools
  cannot execute. Global handler replacement does not retarget a captured tool.
- Native and inline model calls share enforcement; denied calls do not enter
  successful toolsUsed. Plain chat stays tool-free even if a native call arrives.
- Extra fields, wrong types, null/falsy inline arguments and malformed native
  JSON fail validation instead of being silently coerced.
- Removal of membership between two calls in one turn blocks the second handler
  and the next model turn. Viewers, deleted conversations and cancelled runs fail.
- Legacy conversations bind only to personal workspaces and cannot be moved by
  selecting another workspace. Both HTTP aliases enforce owner/workspace checks.
- Skill-trigger words do not enable chat tools. A selected calculator executes
  through the actual authenticated SSE route and the final message is persisted.
- Unknown tool requests, incomplete research permissions and credit-check
  exceptions fail before creating a conversation/contacting a model.
- Global configuration verbs/subpaths return 410 at both mounts, including paths
  otherwise shaped like conversation stream routes. Anonymous requests return 401.
- The tool catalog excludes shared extensions and global creator tools.
- Process-wide provider settings reject customers and unauthenticated development
  access; only explicitly provisioned administrators may use those routes.
- Research requires both permissions before planning. Revocation before search
  or fetch prevents those helpers from running and is not swallowed as fallback.

## Files changed/added in this checkpoint

```text
README.md
backend/package.json
backend/package-lock.json
backend/src/server.ts
backend/src/agent/index.ts
backend/src/agent/types.ts
backend/src/agent/toolRegistry.ts
backend/src/agent/agentRuntime.ts
backend/src/agent/runAuthorization.ts
backend/src/agent/research/deepResearch.ts
backend/src/agent/__tests__/tools.test.ts
backend/src/routes/agent.ts
backend/src/routes/settings.ts
backend/src/services/runWorkspace.ts
backend/src/services/__tests__/runtimeIsolation.integration.test.ts
docs/BUILD_PROGRESS.md
docs/WORKSPACES.md
docs/RUNTIME_AUTHORIZATION.md
docs/validation/foundation-03b.md
```

## Cleanup and limits

Fixtures remove their own conversations, workspaces and accounts only. The
`loop-gpt-runtime-db` container was stopped; the label-filtered running-container
listing was empty. Build images/caches remain; no background work was scheduled.

Stored workspace connectors are **not executable yet**. Their catalog still
reports execution disabled. This checkpoint does not replace them with unsafe
shared adapters. Outbound URL/redirect/response controls and fresh connection
version checks are the next integration boundary.

Legacy message/media/file routes still use user-ownership semantics, and the CLI
completion relay still needs billing/provider-policy integration. Full workspace
lifecycle, organization invitations, private skills, packaged MCP, durable jobs,
ledger reservations and UI/mobile work remain. See `docs/RUNTIME_AUTHORIZATION.md`
for breaking changes and exact limits. Public production readiness is not claimed.
