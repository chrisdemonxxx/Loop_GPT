# Runbook: deploy generated apps

**Owner:** platform
**Applies to:** checkpoint-sourced production deploys for generated apps on a Fly.io-class host
**Last verified:** 2026-09-03

This runbook covers what happens after a generated app has a green checkpoint:
optional Git export for no lock-in, then production deployment through
`loopit-deployer`. Previews remain separate and must continue to enter only via
`loopit-preview-proxy`; production deploys receive their own URL.

---

## 0. Shape of the deployment

- Source of truth: immutable `loopit_checkpoint` blobs, not a live sandbox.
- Git export: `loopit-gitsync` creates/binds a project repo and commits each
green checkpoint once with `Loopit-Checkpoint` and `Loopit-Run` trailers.
- Production deploy: `loopit-deployer` stages an artifact, attaches the
provisioned Postgres schema and storage prefix, runs migrations, checks health,
then promotes.
- Gate: deploy/promote is classified as `loopit_policy.ActionKind.DEPLOY` and
requires a durable orchestrator approval signal before any provider call.
- History: deployment records are currently in-memory behind a repository seam;
wire this to `packages/store` when persistent deployment tables land.

Generated code is never executed in the control plane. The provider builds and
runs it on the host/data-plane side.

---

## 1. Prerequisites

1. A green checkpoint for the project.
2. Provisioned backend resources from `loopit_provision`:
   - per-project Postgres schema and app role
   - project storage bucket/prefix
   - production secrets registered in the PROD secret store
3. A hosting org/app namespace with minimal machine defaults (shared CPU,
auto-stop where safe, low memory).
4. A GitHub org/user if operators want no-lock-in repository sync.

---

## 2. Configure environment

Set real values only in the process secret manager or Fly secrets, never in Git:

```bash
LOOPIT_DEPLOYER_PROVIDER=fly
LOOPIT_DEPLOYER_PUBLIC_BASE_DOMAIN=apps.example.com
LOOPIT_DEPLOYER_MAX_APPS=25
LOOPIT_DEPLOYER_MAX_MACHINE_MEMORY_MB=512
LOOPIT_FLY_API_TOKEN=******
LOOPIT_FLY_ORG=personal
LOOPIT_GITSYNC_PROVIDER=github
LOOPIT_GITHUB_OWNER=your-org
LOOPIT_GITHUB_APP_TOKEN=******
LOOPIT_PROVISION_POSTGRES_DSN=******
LOOPIT_STORAGE_BUCKET=loopit-generated-apps
```

`LOOPIT_FLY_API_TOKEN` and `LOOPIT_GITHUB_APP_TOKEN` are platform/control-plane
operator credentials. They are exchanged only by trusted provider adapters.
Sandboxes receive scoped short-lived leases for project secrets and never receive
these platform tokens.

---

## 3. Git sync / full export

1. Bind or create the project repository with `loopit-gitsync`.
2. Issue a short-lived `GIT_SYNC_TOKEN` lease through `loopit_secrets` for the
sync step.
3. Push the verified checkpoint. A retry of the same checkpoint produces the same
tree and returns the existing commit.
4. For a no-lock-in download, produce a zip/tar export. The exporter refuses
archives that are missing `package.json`, `.env.example`, or `migrations/`, and
scans for platform coupling or secret-like material.

The export includes a standalone README so a user can run independently with
`npm install`, `.env.example`, `npm run migrate`, and the app's start script.

---

## 4. Production deploy flow

1. Request a deploy approval in the orchestrator. Reject/no signal means no
provider staging, migration, health check, or promote call occurs.
2. Stage the checkpoint tree with the hosting provider.
3. Inject runtime config from the PROD broker only:
   - `GENERATED_DATABASE_URL`
   - `GENERATED_JWT_SECRET`
   - `S3_ACCESS_KEY_ID`
   - `S3_SECRET_ACCESS_KEY`
4. Run migrations before cutover.
5. Health-check the staged release.
6. Promote only after migration and health success.
7. Append a deployment history record with checkpoint, run, URL, provider
release id, and previous checkpoint.

If migrations or health checks fail, the current live deployment remains live and
a failed record is appended for auditability.

---

## 5. Rollback

Rollback chooses the previous `LIVE` deployment record for the project and asks
the provider to route traffic back to that checkpoint/release:

```bash
# Operator UI/API should call loopit_deployer.rollback_project(...)
# after approval and incident context are recorded.
```

Keep database migrations additive. If a release shipped a non-additive migration,
prefer a hotfix migration over destructive schema rollback.

---

## 6. Cost controls

- Cap generated app count with `LOOPIT_DEPLOYER_MAX_APPS`.
- Cap memory with `LOOPIT_DEPLOYER_MAX_MACHINE_MEMORY_MB`; start at 512 MB.
- Use auto-stop/auto-start for low-traffic apps where cold starts are acceptable.
- Prefer shared managed Postgres with per-project schemas while small.
- Use one shared S3-compatible bucket with per-project prefixes.
- Rotate provider tokens regularly and keep GitHub/Fly scopes to repo/app
creation plus deploy operations only.
