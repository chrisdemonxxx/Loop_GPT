# Foundation batch 2: account and private-file isolation

Date: 2026-09-16. Based on c6b2026 plus the uncommitted foundation-01 work.
All changes remain local and uncommitted. No production service was deployed.

## Final results

| Validation | Observed result |
| --- | --- |
| TypeScript build (Windows and Linux/Node 22) | Passed |
| Unit suite (Windows and Linux) | 12 files, 94 tests passed |
| Integration suite (Windows) | 28 passed, 1 skipped (symlink privilege unavailable) |
| Integration suite (Linux Docker + real PostgreSQL) | 29 passed, zero skipped |
| Fresh database migration | Both migrations applied |
| Repeat migration deployment | No pending migrations |
| Database-to-schema diff | No difference detected |
| Production Docker build | Passed |
| Non-root production-image upload/download/delete smoke | Passed |
| Production-image administrative CLI --help | Passed without network/database access |
| git diff --check | No whitespace errors; Windows line-ending notices remain |

The Linux run closes the Windows symlink-test gap. The combined suite has 123
passing tests on Linux (94 unit + 29 integration). The test image and production
image are separate Docker targets; production does not include test dependencies.

## Commands used

From backend/:

```text
npm run generate
npm run build
npm test
npm run migrate:deploy
npm run test:integration
docker build --target validation -t loop-gpt-backend:validation-02 .
docker run --rm --network container:loop-gpt-isolation-db -e TEST_DATABASE_URL=<dedicated-local-test-connection> loop-gpt-backend:validation-02 npm run test:integration
docker build -t loop-gpt-backend:foundation-02 .
docker run --rm --network none loop-gpt-backend:foundation-02 node scripts/make-admin.mjs --help
```

Integration database: loop_foundation_test, PostgreSQL 16, localhost only. All
Prisma migration commands explicitly set DATABASE_URL to the disposable local
database. The integration harness rejects a nonlocal/non-test connection.

Final production image:
`sha256:d9e1c6dd141f997310a77e0dbc4cf53fac972831a5e433f4b4c8f3ded1e178f0`

Final validation image:
`sha256:0df1a51f96afca64c2d1081af9877f4426a4213dd7bb5af8c3d407302d6be64f`

## Selected HTTP smoke evidence

The final production image ran as its configured non-root node user against the
local DB. A uniquely named fixture account uploaded an image, downloaded it with
its JWT, and deleted it. The account was removed after the check.

```json
{"health":200,"legacyUploads":410,"upload":201,"anonymousDownload":401,"ownerDownload":200,"delete":204}
```

This tests image signature acceptance and byte storage, not image decoding or
visual fidelity. Vision/agent/image-generation providers are mocked in the HTTP
integration suite; no live inference or external email was sent. Actual document
generation, storage, HTTP routing, authentication and PostgreSQL are exercised.

## Assertions added

- JWT syntax, supported signing algorithm, nonempty string userId, and no implicit
  guest/admin privileges.
- Signup remains user-role even for a matching ADMIN_EMAIL.
- Conversation reads, messages, updates and deletes reject other accounts.
- Explicit development identity retains ownership predicates.
- Upload-new creates a new conversation instead of selecting an existing one.
- Foreign uploads fail before any byte storage.
- Forged image signatures and over-limit uploads are rejected.
- Owner-only metadata/content, authenticated API-key downloads and revocation.
- Same-owner but wrong-conversation attachments are rejected.
- Both streaming aliases and the legacy message route reject imagePath input.
- Owned images become data URIs for model calls; foreign files never reach the model.
- Legacy vision and image generation use owned data and private output references.
- API media publication now produces privately stored content.
- Real generated CSV artifacts are owner-scoped.
- Tampered bytes and Linux symlink substitution are rejected.
- File deletion revokes access and is repeatable by the owner.
- Legacy /uploads returns 410 without exposing file existence.

## Changed/added files in this batch

```text
.github/workflows/backend-validation.yml
README.md
backend/Dockerfile
backend/package.json
backend/package-lock.json
backend/prisma/schema.prisma
backend/prisma/migrations/20260916010000_private_files/migration.sql
backend/scripts/make-admin.ts -> backend/scripts/make-admin.mjs
backend/src/agent/__tests__/tools.test.ts
backend/src/agent/artifacts.ts
backend/src/agent/tools/createDocument.ts
backend/src/agent/tools/generateImage.ts
backend/src/agent/tools/generateVideo.ts
backend/src/middleware/validation.ts
backend/src/middleware/__tests__/authentication.test.ts
backend/src/routes/agent.ts
backend/src/routes/auth.ts
backend/src/routes/conversations.ts
backend/src/routes/files.ts
backend/src/routes/messages.ts
backend/src/routes/v1.ts
backend/src/server.ts
backend/src/services/chatStore.ts
backend/src/services/mediaJobs.ts
backend/src/services/privateFiles.ts
backend/src/services/__tests__/chatStore.test.ts
backend/src/services/__tests__/fileValidation.test.ts
backend/src/services/__tests__/files.integration.test.ts
backend/vitest.integration.config.ts
docs/BUILD_PROGRESS.md
docs/PRIVATE_FILES.md
docs/validation/foundation-02.md
```

Multer is pinned to 2.4.0 and @types/multer to 2.2.0; npm ci succeeded in both
Docker build stages with the updated lockfile. Other dependency warnings remain.

## Cleanup and limits

- The dedicated API and PostgreSQL test containers were stopped. No containers
  labelled loop-gpt.purpose=isolation-tests remained running at cleanup.
- Local build images, dependency caches and Docker Desktop remain available.
- Tests remove only their fixture data/temp directories; no production data was
  accessed, migrated, erased or assigned to an owner.
- The global MCP/connector/custom-tool configuration is NOT yet tenant-isolated.
  This batch does not make the application safe for public onboarding by itself.
- Organization/workspace membership, credential vault, execution permissions,
  ledger reservations, object storage, quotas and orphan cleanup remain pending.
- Legacy clients expecting imagePath or anonymous URLs must be updated before
  deployment. See docs/PRIVATE_FILES.md. No frontend/mobile parity is claimed.
- CI workflow is updated but not remotely run. No commit, push or background
  autonomous build job was created.
