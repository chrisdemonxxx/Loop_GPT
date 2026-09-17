# Foundation checkpoint 03a: workspace configuration and credential vault

Date: 2026-09-16. All work is local and uncommitted on top of foundation batches
1 and 2. No production deployment, production migration, or external connector
request was performed. This completes the configuration/storage substep, not
foundation batch 3 or runtime tenant isolation.

## Observed results

| Validation | Result |
| --- | --- |
| TypeScript build, Windows and Linux/Node 22 | Passed |
| Unit tests, Windows and Linux | 13 files, 109 passed |
| Integration tests, Windows | 45 passed, one existing symlink-privilege skip |
| Integration tests, Linux Docker/PostgreSQL | 3 files, 46 passed, zero skipped |
| New tests in this checkpoint | 15 vault unit tests + 17 workspace HTTP/DB tests |
| Fresh database migration | All three migrations applied |
| Repeated migrate:deploy | No pending migrations |
| Database-to-Prisma schema diff | No difference detected |
| Production Docker image build | Passed |
| Final production image make-admin --help, network disabled | Passed |
| git diff --check | No whitespace errors; existing line-ending warnings |

Combined Linux result: **155 passing tests**. The workspace suite uses actual
JWT authentication, Express routes, PostgreSQL, transactions and encryption.
No provider calls are made by these workspace endpoints. Existing model mocks
remain in the older file integration suite. This checkpoint did not run a full
production-container HTTP smoke; HTTP tests mount the real workspace router in
a test Express process.

## Commands

From `backend/` on Windows (npm.cmd/npx.cmd):

```text
npm run generate
npm run build
npm test
npm run migrate:deploy
npm run test:integration
npm run migrate:deploy
npx prisma migrate diff --from-url <explicit-test-URL> --to-schema-datamodel prisma/schema.prisma --exit-code
docker build --target validation -t loop-gpt-backend:validation-03a .
docker run --rm --network container:loop-gpt-workspace-db -e TEST_DATABASE_URL=<explicit-test-URL> loop-gpt-backend:validation-03a npm run test:integration
docker build -t loop-gpt-backend:foundation-03a .
docker run --rm --network none loop-gpt-backend:foundation-03a node scripts/make-admin.mjs --help
```

`DATABASE_URL` was explicitly overridden for migration commands. The database
was `loop_foundation_test`, user `loop_test`, with a disposable test-only password.
Host connection used `127.0.0.1:55439`; the Linux suite shared the dedicated DB
container's network namespace and used `127.0.0.1:5432`. No existing `.env` database
was targeted. The harness rejects nonlocal/non-test database names.

PostgreSQL image used:
`postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685`

Final validation image:
`sha256:fd1e5a848b6d08293bfead69e9b4fd4980d8c76039cae7b758067113b94007ab`

Final production image:
`sha256:a9c5bed2bc362a5edf67b3d5be8dcdf5135ecdd0f61840e7c80688d0283d31ba`

## Important assertions

- Eight concurrent personal-workspace requests produce one workspace, one owner
  membership, and one creation audit event.
- Platform administrator status does not bypass workspace membership.
- Foreign workspace reads/writes are rejected; an owned workspace ID cannot be
  substituted to update/delete/decrypt another workspace's connection.
- Viewers cannot load credentials. Editors cannot mutate credentials/members.
  Owners cannot be demoted/deleted through the generic member endpoints.
- Metadata responses and audit events do not contain credential values or
  ciphertext. Unknown fields, ownership injection, missing required credentials,
  unsupported connectors and configurable destinations are rejected.
- Missing/malformed encryption keys fail closed without creating plaintext rows.
- AES-GCM roundtrip, random IVs, altered IV/tag/ciphertext, cross-workspace/record
  substitution, invalid envelopes and wrong keys are tested.
- PUT requires a positive integer expected version at both service and HTTP
  boundaries. Undefined Prisma predicates cannot silently remove CAS checks.
- Concurrent replacements yield one 200 and one 409, increment once and append
  exactly one committed update audit event.
- The internal loader rejects stale versions, disabled/deleted records, and
  downgraded/removed memberships. Maximum stored PostgreSQL integer versions
  remain readable even when further increments are no longer supported.
- JSON parsing rejects over-64-KiB and malformed requests without reflecting
  submitted secrets. Metadata pagination returns 100+1 distinct rows and no keys.
- Catalog responses explicitly declare execution disabled at this checkpoint.

## Files added/changed for this checkpoint

```text
README.md
backend/prisma/schema.prisma
backend/prisma/migrations/20260916020000_workspace_connections/migration.sql
backend/src/server.ts
backend/src/routes/workspaces.ts
backend/src/services/workspaces.ts
backend/src/services/workspaceConnections.ts
backend/src/services/credentialVault.ts
backend/src/services/__tests__/credentialVault.test.ts
backend/src/services/__tests__/workspaces.integration.test.ts
docs/BUILD_PROGRESS.md
docs/WORKSPACES.md
docs/validation/foundation-03a.md
```

Existing earlier-batch modifications were preserved. No dependencies were added
or updated in this checkpoint.

## Cleanup and next boundary

Tests remove only their uniquely prefixed fixture accounts/workspaces. The
`loop-gpt-workspace-db` container was stopped; the subsequent label-filtered
container listing was empty. Build images/caches remain available. No background
build process, commit, push, or remote CI run was created.

The credential loader is **not yet connected to tool dispatch**. Shared legacy
MCP/connectors/plugins/custom tools/skills and their management endpoints remain
unchanged and block public release. Next: workspace identity on each run,
per-run tool definitions, external authorization before every dispatch (including
inline/research paths), retiring global customer configuration, and safe provider
request construction. Organization membership, invitations, ownership transfer,
master-key rotation/KMS, billing reservations and other milestone work remain
pending. See `docs/WORKSPACES.md` for the exact supported API and limits.
