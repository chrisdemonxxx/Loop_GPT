# Foundation batch 1: execution evidence

Date: 2026-09-16. Starting revision: c6b2026 (clean-main, initially clean).
Changes are local and uncommitted. No production deployment or remote CI run.

## Environment

- Host: Windows, Node v24.18.0, npm 12.0.2.
- Docker Desktop started for local validation; server v29.8.0.
- Production image runtime: Node v22.23.2, Debian bookworm, non-root node user.
- PostgreSQL: disposable local PostgreSQL 16 container, loop_foundation_test DB.
- Prisma client/CLI 5.22.0; Vitest 2.1.9.
- .env was loaded by Prisma CLI for schema generation; all migration commands
  explicitly overrode DATABASE_URL with the dedicated local test connection.
  No production database was connected by validation commands.

## Baseline

Executed `npm ci --no-audit --no-fund`, `npm run generate`, `npm run build`,
and `npm test` before implementation. Install and build succeeded; 26 tests
passed in four files. The lockfile was usable without modification.

## Final validation

| Command/check | Observed result |
| --- | --- |
| npm run build | TypeScript compilation successful |
| npm test | 10 files, 70 tests passed |
| npm run test:integration | 1 file, 7 PostgreSQL integration tests passed |
| npm run migrate:deploy (fresh local DB) | Initial migration applied successfully |
| npm run migrate:deploy (second run) | No pending migrations to apply |
| Prisma migrate diff: local DB to schema | No difference detected; exit 0 |
| docker build -t loop-gpt-backend:foundation-01 . | Successful on Linux/Node 22 |
| Final image without production configuration | Exit 1 before service initialization |
| Final image with local DB/test settings: GET /health | HTTP 200, status ok |
| Configured origin (including trailing slash in configuration) | Access-Control-Allow-Origin: https://app.example.test |
| Unconfigured sibling *.up.railway.app origin | No Access-Control-Allow-Origin header |
| git diff --check | No whitespace errors; Windows line-ending notices only |

Final local image ID:
`sha256:48a2512970ab03e6231fe54f3f646f3fffba9436f8c0046e3b904b5ad8025c3a`

Node base image pinned to:
`node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`

PostgreSQL image used and pinned in CI/runbook:
`postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685`

Selected final HTTP smoke output:

```json
{"health":{"status":"ok","timestamp":"2026-09-16T09:28:03.125Z"},"allowedOrigin":"https://app.example.test","unconfiguredOrigin":null}
```

Expected failure-mode output included:

```text
Invalid environment configuration: FRONTEND_URL: An explicit production origin allowlist is required; JWT_SECRET: Production requires a non-default secret of at least 32 characters; DATABASE_URL: A PostgreSQL database URL is required in production
PASS: final image fails closed with missing production configuration
```

## Database assertions exercised

1. Twelve simultaneous consumers of the same reset token: exactly one succeeds.
2. Expired tokens remain unused and cannot authenticate a reset.
3. A verification token cannot be consumed as a reset token.
4. Eight users competing for one voucher: one grant, one redemption, count one.
5. Eight redemptions by one user: one grant and one capacity decrement.
6. Failed grant for a nonexistent user rolls back voucher capacity and redemption.
7. Thirty-message conversation returns turns 27, 28, 29 for a three-message window.

Additional unit tests exercise serialization retries/exhaustion, stored token
digests, memory-store parity, invalid history limits, startup constraints, and CORS.

## Exact files changed or added

```text
.gitattributes
.gitignore
.github/workflows/backend-validation.yml
README.md
backend/.dockerignore
backend/Dockerfile
backend/docker-entrypoint.sh
backend/package.json
backend/prisma/schema.prisma
backend/prisma/migrations/migration_lock.toml
backend/prisma/migrations/20260916000000_initial_schema/migration.sql
backend/src/server.ts
backend/src/middleware/envValidation.ts
backend/src/middleware/corsPolicy.ts
backend/src/middleware/__tests__/envValidation.test.ts
backend/src/middleware/__tests__/corsPolicy.test.ts
backend/src/services/chatStore.ts
backend/src/services/tokens.ts
backend/src/services/billing.ts
backend/src/services/__tests__/chatStore.test.ts
backend/src/services/__tests__/chatStore.memory.test.ts
backend/src/services/__tests__/tokens.test.ts
backend/src/services/__tests__/voucher.test.ts
backend/src/services/__tests__/foundation.integration.test.ts
backend/vitest.config.ts
backend/vitest.integration.config.ts
docs/BUILD_PROGRESS.md
docs/FOUNDATION_RUNBOOK.md
docs/validation/foundation-01.md
```

## Cleanup and limits

- Dedicated API and DB test containers stopped; no foundation-test containers
  remained running at cleanup. Local Docker images/cache and node_modules remain.
- Docker Desktop remains available; no background build/agent job was scheduled.
- One intermediate restart hit Docker's asynchronous --rm name-release race;
  a fresh dedicated container name was used and the final smoke checks passed.
- CI workflow added but not remotely executed. No commit or push performed.
- /health is presently a liveness endpoint, not proof of dependency readiness.
- No live inference, email delivery, payment, OAuth, mobile, or sandbox-provider
  acceptance test was performed. Those are separate milestones.
- Dependency deprecation/security warnings remain tracked; no claim of a clean
  vulnerability audit or production readiness is made.
