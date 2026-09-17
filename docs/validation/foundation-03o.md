# Checkpoint 03o — shared video limits, private storage and owned staging

Date: 2026-09-17. Validation of the uncommitted working tree based on
`c6b20263423b8ab4d5c14c0f13900c7b91953c0e`, not a frozen release commit.
No production migration, deployment, live provider/payment call, commit, push or
remote CI run occurred. Checkout/fulfillment and both video pools remain disabled.

## Combined results

| Check | Result |
| --- | --- |
| Windows Prisma generation / TypeScript | Passed |
| Windows units | 936 passed, 5 platform-specific skips; 37 files |
| Linux units, validation image build | 941 passed, no skips; 37 files |
| Windows real PostgreSQL integration | 455 passed, 3 platform-specific skips; 18 files |
| Linux real PostgreSQL integration | 458 passed, no skips; 18 files |
| Fresh PostgreSQL migrations | All ten applied, through `20260917040000_video_queue_limits` |
| Repeat migration / schema comparison | No pending migrations / no difference detected |
| Production backend image / video-worker help | Built; help exited successfully with network disabled |
| Owned web TypeScript / production build | Passed |
| Owned web unit/component / Chromium fixtures | 94 tests / 4 browser tests passed |
| Isolated owned-staging build and smoke | Passed, six groups; separate validating agent |

Linux backend total: **1,399 tests**. Windows platform skips execute on Linux.
Tests exercise real PostgreSQL, filesystem and local HTTP; external provider
responses remain mocked. Signed payment tests use synthetic offline signatures.
No combined-suite regression required a source-code fix during this rerun.

Image IDs observed with `docker image inspect ... --format '{{.Id}} {{json .RepoTags}}'`:

- `loop-gpt-backend:validation-03o`:
  `sha256:984d039b2ae7e6dff967c78ec84eedee31c458b2c6fdc402ad5c98e0eb40cde4`
- `loop-gpt-backend:foundation-03o`:
  `sha256:bc90cb3778dcab32b244da8d2a37c1a3b9987618c7fbac3c63f15bb0015bee29`
- `loop-owned-staging-backend:local`:
  `sha256:7ae5017eee0bafe91e80fedfc1c79b5115d05b1454eab1b95a788be2bfe7b20a`
- `loop-owned-staging-web:local`:
  `sha256:f7496b5055157a5b8ccfda6da0406234659aeb1fd29089b88e114d7943ed4e74`

Dependency layers were cached. These results are not a fresh dependency audit,
clean-install guarantee, remote CI result or production qualification.

## Verified behavior

- Shared account/global admission limits reject before debit, across daily/prepaid
  jobs and API keys. Durable upstream slots, bounded fair claims and lock ordering
  preserve limits across independent worker processes and uncertain provider work.
- Private namespace configuration and bounded marker validation fail closed.
  Linux descriptor-anchored leaf I/O prevents root replacement from retargeting
  operations. Windows requires stable trusted ancestors/quiesced namespace changes.
- Low-space/write-probe failure can recover already-staged confirmed completion
  without new upstream claims. Missing or mismatched namespaces block all claims.
  Storage fault injection is not deployed-volume or backup/restore qualification.
- Unsigned payment fallback and legacy metadata-based grants are removed. Checkout
  and fulfillment remain code-locked; verified but unfulfilled events return 503
  rather than falsely acknowledging a durable inbox or credit grant.
- Isolated Compose smoke checks fresh migrations, initialization rejection,
  marker continuity, four-child supervision, readiness failure/recovery, static
  and PWA headers, fixed proxy target, local-fixture SSE/cancellation, essential
  worker exit and graceful SIGTERM. Details: `../../deploy/owned-staging/VALIDATION.md`.

## Reproduction and cleanup

From repository root:

```powershell
docker run --rm -d --name loop-foundation-db-03o -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1::5432 postgres:16-alpine
docker port loop-foundation-db-03o 5432
```

Observed loopback port: **58406**. From `backend/`, explicitly override both
database variables so Prisma cannot select an existing database from `.env`:

```powershell
$env:DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:58406/loop_foundation_test?schema=public'
$env:TEST_DATABASE_URL=$env:DATABASE_URL
npm.cmd run generate
npm.cmd run build
npm.cmd test
npm.cmd run migrate:deploy
npm.cmd run test:integration
npm.cmd run migrate:deploy
npx.cmd prisma migrate diff --from-url "$env:DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
docker build --target validation -t loop-gpt-backend:validation-03o .
docker build -t loop-gpt-backend:foundation-03o .
docker run --rm --network container:loop-foundation-db-03o -e DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03o npm run test:integration
docker run --rm --network none loop-gpt-backend:foundation-03o node scripts/video-job-worker.mjs --help
```

From root, the separate validation agent ran:
`node deploy/owned-staging/smoke.mjs --build`. Web commands/results are in
`../../web/VALIDATION.md`. The smoke harness removed its containers, networks and
volumes; the browser preview exited. Main stopped the owned
`loop-foundation-db-03o` container, created with `--rm`. The pre-existing
`loop-daily-accounting-20260916` container was left running and untouched.
Local images/build caches remain available.

## Release hygiene changes and limitations

- `.gitignore` now excludes environment variants, local Railway state and the
  tunnel credential, while permitting `.env.example`.
- `git rm --cached -- deploy/cloudflared/tunnel-creds.json` staged only removal
  from tracking. `Test-Path` returned True; `git check-ignore` confirms exclusion.
  No credential contents were read or printed in this checkpoint.
- `deploy/cloudflared/Dockerfile` no longer copies credentials. Its new
  `.dockerignore` permits only Dockerfile/config; `README.md` documents required
  runtime secret-file injection and historical exposure. No connector was rebuilt
  or deployed, and its legacy `latest` image is still not a pinned release.
- `backend/render.yaml` now generates Prisma before compilation and starts without
  destructive `db push --accept-data-loss`. Migrations/storage initialization are
  separate explicit release operations; the Render path was not deployed/tested.
- Added `.github/workflows/owned-staging-validation.yml` to run the already-passing
  fixture-only smoke for backend/web/staging changes. Workflow execution on GitHub
  remains pending; a local harness pass is not remote-run evidence.

Removing a tracked credential **does not revoke it or erase Git/image history**.
Coordinated rotation/revocation is still required; no production secret was rotated
and no history was rewritten. This narrow hygiene review is not a full repository
secret/security scan. Review the full intended release diff before publication,
without printing secret-bearing deletion hunks.

## Principal slice files

- `backend/prisma/schema.prisma` and migration `20260917040000_video_queue_limits`.
- Services `videoQueuePolicy.ts`, `accountedVideoJobs.ts`, `videoJobWorker.ts`,
  `privateStorage.ts`, `privateFiles.ts`, `stripe.ts`; routes `media.ts`, `v1.ts`,
  `billing.ts`; `middleware/envValidation.ts`.
- Scripts `private-storage.mjs`, `video-job-worker.mjs`, `staging-runtime.mjs`;
  backend Docker/package files and related service regression tests.
- `deploy/owned-staging/**`, `web/Dockerfile`, `web/.dockerignore`, web nginx and
  Railway configuration; related validation documents.
- Hygiene files listed above; `docs/BUILD_PROGRESS.md`, `PRODUCTION_CHECKLIST.md`,
  `PRIVATE_FILES.md`, `ACCOUNTED_VIDEO_JOBS.md` and this evidence record.

Remaining: full release review, remote CI and isolated Railway acceptance; complete
payment fulfillment/reconciliation; provider and deployed-storage qualification;
general task/sandbox/product/native milestones in `../PRODUCTION_CHECKLIST.md`.
