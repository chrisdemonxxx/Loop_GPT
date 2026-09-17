# Owned web + isolated staging candidate

Release packaging for a **new staging environment and new owned-web origin**.
Deployment has not been performed. Main/release owner controls the release branch,
Railway resources, deployment and any later cutover. This is a packaging candidate,
not native-app, complete-product, provider, payment or production qualification.

## Topology and files

```text
new HTTPS owned-web origin -> nginx:8080 -> backend API:3001
                                              |
                         one staging service / one replica
                         Node supervisor (readiness :3002)
                           |- compiled API (graceful wrapper)
                           |- daily-settlement-worker.mjs
                           |- api-settlement-worker.mjs
                           `- video-job-worker.mjs
                         all four share /private-store/files
                                              |
                                  new staging PostgreSQL
```

Railway volumes are **not shared between services**. Attach exactly one private
PVC to the backend service at `/private-store`; do not deploy the workers as
separate Railway services. PostgreSQL has its own independent database volume.
Set the backend to **one replica, one region, no overlapping deployment/writers**.
`STAGING_REPLICAS=1` is an explicit operator attestation, not a distributed lock or
an infrastructure-enforced replica count. The Railway metadata also requests one
replica. Stop the old container before a replacement takes the same namespace.

| File | Purpose / build context |
| --- | --- |
| `web/Dockerfile`, `web/.dockerignore` | Vite build, Node >=22.12, static nginx runtime; context **web/** |
| `web/nginx.template.conf` | SPA, PWA/cache/security headers, fixed runtime API proxy |
| `web/railway.json` | New web service, service root **/web** |
| `deploy/owned-staging/backend.Dockerfile` | Compiled API + existing three worker CLIs; context **repository root** |
| `backend.Dockerfile.dockerignore` | Dockerfile-specific allowlist; excludes backend `.env`, uploads, local modules, etc. |
| `railway.backend.json` | New backend service, service root **/**, custom config path `/deploy/owned-staging/railway.backend.json` |
| `backend/scripts/staging-runtime.mjs` | Supervisor, graceful API wrapper, migration-status preflight, readiness |
| `prepare-storage.mjs` | Explicit empty-directory ownership preparation; no marker creation |
| `compose.yaml` | Local isolated PostgreSQL/private volumes and release one-offs |
| `operator.env.example` | Placeholder configuration reference; not automatically loaded |
| `smoke.mjs`, `proxy-fixture.mjs` | Local Docker packaging smoke; fixture is not in either image |
| `regressions.test.mjs`, `smoke-lifecycle.mjs`, `docker-context-smoke.mjs` | Offline failure-path tests, verified cleanup, synthetic Docker context regression; not packaged |

The Node digest reuses the existing backend's pinned base. nginx is version/digest
pinned. PostgreSQL is version pinned. npm lockfiles are used with `npm ci`. OS
package repositories are not snapshot pinned, so these are reproducible build
instructions, not a promise of byte-identical images. Record final image digests
alongside the release commit, lockfiles and migration set.

## Build and local smoke

From the repository root, Docker Desktop/Linux containers and Compose v2+:

```powershell
docker build -t loop-owned-staging-web:local -f web/Dockerfile web
docker build -t loop-owned-staging-backend:local -f deploy/owned-staging/backend.Dockerfile .
# Optional root-only empty-PVC preparer; normal builds stay non-root:
docker build --target storage-maintenance -t loop-owned-staging-storage-maintenance:local -f deploy/owned-staging/backend.Dockerfile .
node deploy/owned-staging/smoke.mjs
# To build then test in one invocation:
node deploy/owned-staging/smoke.mjs --build
# Focused supervisor/cleanup regressions alone (no Docker or services):
node --test deploy/owned-staging/regressions.test.mjs
```

The smoke harness generates ephemeral fixture credentials into child-process
environment variables only. It creates a randomly named local Compose project,
dedicated volumes and loopback ports, runs explicit preparation/init/migrations,
then removes only that project's containers/volumes in `finally`. No provider keys,
real accounts, production database, Railway commands or automatic branch changes
are involved. Docker image/cache layers remain for reuse. Interrupted hard kills
may require cleanup of the printed/local `owned-smoke-*` project.

The smoke also runs the focused regressions, checks all three Docker ignore files
against disposable synthetic directory contexts, and rejects CR/LF in each proxy
configuration variable. Synthetic contexts contain only generated nonsecret
fixtures and the ignore rules, never the real repository contents. Their uniquely
tagged test images are removed. Final success is printed only after cleanup and
absence verification of this run's labeled containers, networks and volumes;
cleanup failure exits nonzero even when every functional assertion passed.

Checks include uninitialized/populated-store rejection, marker idempotency and UUID
mismatch, migration preflight/deploy, script-path rejection, API + workers,
DB/storage/API readiness, storage failure/recovery, disabled payment config, SPA
and missing-asset behavior, HTML/SW/manifest/asset cache headers, POST/auth/query
forwarding, early SSE frames and client disconnect propagation, fixed upstream and
injection rejection, nginx restart, worker-exit failure and clean SIGTERM.
The SSE upstream is a clearly nonproduction local fixture; provider calls are not
part of this test. Core backend source may be changing: rerun against the final
release commit. See [VALIDATION.md](VALIDATION.md) for the observed run.

## Manual local candidate

Supply credentials in the **operator environment**, not Docker build args, tracked
files or Vite variables. The Compose file has no default passwords. Generate once
per fresh database/volume; retain securely for the life of that local candidate:

```powershell
$env:STAGING_DB_PASSWORD = node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
$env:STAGING_JWT_SECRET = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$env:STAGING_CONNECTION_KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
$env:STAGING_STORE_ID = node -e "console.log(require('node:crypto').randomUUID())"
$env:OWNED_WEB_ORIGIN = 'https://localhost:8443'
$compose = 'deploy/owned-staging/compose.yaml'
docker compose -f $compose config --quiet
docker compose -f $compose build backend web
docker compose -f $compose up -d --wait postgres
# Fresh store only; stop backend/web first if they were previously running.
docker compose -f $compose run --rm --no-deps storage-prepare
docker compose -f $compose run --rm --no-deps storage-init
docker compose -f $compose run --rm --no-deps storage-check
docker compose -f $compose run --rm migrate
docker compose -f $compose up -d --wait backend web
curl.exe -f http://127.0.0.1:8302/ready
curl.exe -f http://127.0.0.1:8088/healthz
curl.exe -f http://127.0.0.1:8088/api/billing/config
```

Use URL-safe hex for the DB password because Compose inserts it into a URL.
Postgres initialization passwords only apply to an **empty** database volume;
regenerating a password for an existing volume will not change its DB user.
`STAGING_CONNECTION_KEY` is canonical base64 for 32 random bytes. Preserve it with
backups or existing encrypted connection records will be unreadable.

The local web endpoint is loopback HTTP at `http://127.0.0.1:8088`, a browser secure
context suitable for local PWA smoke. `https://localhost:8443` is a nonproduction
origin fixture to satisfy the backend production-only HTTPS origin validator.
For exact browser Origin/CORS parity put a **local trusted TLS terminator** on
8443 in front of 8088 and use that URL; TLS termination is not supplied by Compose.
Same-origin `/api` works through the HTTP proxy, but HTTP smoke does not qualify
Railway TLS, cross-origin CORS or Safari/iOS. Alternative loopback host ports:
`STAGING_WEB_PORT` and `STAGING_READY_PORT`. Database/API ports are not published.

For subsequent starts use `storage-check`, not `storage-prepare`. Preparation
refuses populated namespaces (including an already-initialized store); it is not
a recursive ownership repair. `docker compose -f $compose down` preserves data.
Only explicitly disposable local fixtures should be removed with `down --volumes`.

## Storage release contract

`PRIVATE_FILES_STORAGE_MODE=shared-filesystem`,
`PRIVATE_FILES_DIR=/private-store/files`, and a stable lowercase UUID in
`PRIVATE_FILES_STORE_ID` are mandatory. The root must be absolute, canonical,
not a symlink, writable by UID/GID 1000, and have at least the configured headroom.
The default free-space reserve is 64 MiB, advisory rather than a global quota.

The existing `scripts/private-storage.mjs --init` is the **only** initializer. It
creates `.loop-private-store.json` with `{ "version": 1, "id": "<namespace UUID>" }`
only in an empty directory; matching markers are idempotent. It refuses an
unidentified nonempty directory and mismatched/malformed markers. Do not fabricate
a marker to adopt unknown data. Inspect/restore the matching namespace or migrate
data through a separately reviewed release procedure with all writers stopped.

`prepare-storage.mjs` runs as root solely to prepare an empty `files` directory
owned by UID/GID 1000. It allows `lost+found` at a fresh ext4 volume root, rejects
other unexpected root entries, and never initializes or recursively changes data.
The long-running API/worker container runs as non-root `node`.

Startup performs **check only** and `prisma migrate status`. Missing markers,
pending/failed migrations or inaccessible storage stop startup. Normal startup
never runs `--init`, `db push`, `migrate dev`, or `migrate deploy`.

## New Railway services (release-owner instructions)

1. Use the owner-approved release branch in a **new isolated staging environment**.
   Create new PostgreSQL, backend, and owned-web services. Use only fresh staging
   DB URLs, namespace IDs and secrets; avoid inherited project-level production
   credentials. Set the root/config paths from the table above. For the web service,
   select `/web/railway.json` as config and `/web` as root so the Docker build context
   matches the local build. Resolve any platform UI path differences before build.
2. Attach one new PVC at `/private-store` to the backend service. Set one replica,
   one region and no deployment overlap. Set `PORT=3002`, `STAGING_API_PORT=3001`.
   Railway healthchecks target **PORT=3002**, path `/ready`. API traffic uses **3001**.
   This two-port distinction is intentional; do not point nginx at readiness.
3. Set backend variables from `operator.env.example` via Railway environment/secret
   management. `FRONTEND_URL` is the single exact **new HTTPS owned-web origin**.
   Generate actual secrets/UUID separately; all example values are placeholders.
4. Run `node node_modules/prisma/build/index.js migrate deploy` once against the
   **new staging DB** using this image as a release job. Migration needs no PVC.
   Review the SQL first and back up before upgrades. Never baseline or reset an
   existing production DB using this packaging.
5. With API/workers stopped, initialize **inside the backend service with its actual
   attached PVC**, not another service or a Railway predeploy container (predeploy
   must not be assumed to have the runtime volume). Root one-off command:
   `node scripts/prepare-storage.mjs`; then, as UID/GID 1000, run
   `node scripts/private-storage.mjs --init`, followed by `--check`.
    Use the platform's attached-volume maintenance execution/temporary command and
    user override. **Changing an image does not clear a configured start command.**
    `railway.backend.json` explicitly sets the supervisor command, `/ready` and
    restart-on-failure; these runtime settings must not apply during maintenance.
    Select a temporary maintenance config instead of the normal config-as-code
    (a UI setting alone may be overridden by config-as-code), and verify the
    effective command, user, healthcheck and restart settings before execution:

    | Phase, same backend service/PVC; no concurrent writers | Effective start command | Effective user | Deployment/image healthchecks | Restart policy |
    | --- | --- | --- | --- | --- |
    | Empty-directory preparation | `node scripts/prepare-storage.mjs` | `0:0` | Disabled; remove `/ready` | `NEVER` |
    | Marker initialization, candidate image | `node scripts/private-storage.mjs --init` | `1000:1000` (`node`) | Disabled | `NEVER` |
    | Namespace verification, candidate image | `node scripts/private-storage.mjs --check` | `1000:1000` (`node`) | Disabled | `NEVER` |
    | Normal runtime, only after successful maintenance | `node scripts/staging-runtime.mjs` | `1000:1000` (`node`) | `/ready` on 3002; restore runtime healthcheck | `ON_FAILURE`, max 3 |

    Require exit 0 at each maintenance phase; none is a continuously healthy web
    service. If the platform cannot disable inherited health/restart settings for
    an attached-volume one-off, stop here and resolve maintenance support first.
    If the platform cannot override USER, the release owner can build
    and publish the explicit `storage-maintenance` target above and temporarily run
    that image **on the same backend service/PVC**, with the effective preparation
    start command explicitly set (or cleared to use the image CMD), and runtime
    healthchecks/restarts disabled as above. It exits without creating a marker.
   Switch back to the non-root candidate image for the separate `--init` and `--check`
   commands. Never mount the volume on a concurrent helper service. Confirm this
   attached-volume maintenance workflow operationally before starting the candidate.
6. Restore normal user `node` and command `node scripts/staging-runtime.mjs` after
   maintenance. Start and check `/ready` on 3002. Set termination grace above
   `STAGING_SHUTDOWN_MS` (default 25 seconds; Compose uses 35 seconds). Verify stop
   and restart behavior on Railway; no local test can prove platform termination
   timing or volume attachment.
7. For nginx set `PORT=8080`, `OWNED_WEB_ORIGIN=https://<new-host>`, and fixed operator
   `API_UPSTREAM=http://<new-backend>.railway.internal:3001`. Runtime `/etc/resolv.conf`
   supplies the resolver; IPv6 literals are bracketed and nginx enables AAAA lookup.
   DNS is re-resolved with a 10-second cache. The API/readiness listeners are dual
   stack. Alternatively use `API_UPSTREAM=https://<new-public-api-host>` and set
   that backend public domain's **target port to 3001**, retaining PORT=3002 for
   healthchecks. HTTPS upstreams use SNI, hostname verification and the CA bundle.
8. Attach the new web domain to port 8080 with Railway TLS. The app and `/` service
   worker must live at the **root of this new dedicated origin**. Do not overlay an
   existing gateway/domain/service-worker scope. `OWNED_WEB_ORIGIN` is configuration
   validation, not DNS provisioning or proof that a hostname is new. No client
   Origin/Host/query parameter can select the proxy target. No extra CORS allowlist
   or wildcard is added by nginx; backend CORS still uses its exact configured origin.
9. After release-owner deployment verify readiness, real login/workspace access,
   POST SSE arrival/cancellation, authenticated artifact download, storage marker
   continuity and worker logs. Qualify Railway IPv6 routing or public TLS/SNI on
   that environment; the local suite exercises Docker DNS, not Railway DNS.

## Runtime flags and readiness limits

| Variable | Candidate behavior |
| --- | --- |
| `NODE_ENV` / `ENABLE_DEV_MODE` | `production` / `false`; existing production env validation runs |
| `STAGING_REPLICAS` | Must be exactly `1`; operator must enforce in hosting settings |
| `PORT` / `STAGING_API_PORT` | Readiness 3002 / compiled API 3001; distinct ports 1024..65535 |
| `STAGING_SHUTDOWN_MS` | 25000 default, 1000..120000; then remaining children are SIGKILLed and container exits nonzero |
| `STAGING_PAYMENTS_ENABLED` | Default false; removes inherited `STRIPE_*` secrets/config before imports/child launch, sets both payment flags false |
| `STRIPE_CHECKOUT_ENABLED` / `STRIPE_FULFILLMENT_ENABLED` | Explicit false. Backend also has `FULFILLMENT_IMPLEMENTED=false`; no environment switch makes payment fulfillment complete |
| `ACCOUNTED_VIDEO_JOBS_ENABLED` | Default false; removes `HF_VIDEO_ENDPOINT` while disabled |
| `ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED` | Default false; true requires the main accounted-video flag |
| `VIDEO_API_URL` / `HF_VIDEO_ENDPOINT_URL` | Removed by this supervisor; legacy direct-video dispatch stays disabled |
| `STAGING_API_SCRIPT` | Optional exact basename `server.js` only |
| `STAGING_DAILY_SCRIPT` | Optional exact basename `daily-settlement-worker.mjs` only |
| `STAGING_SETTLEMENT_SCRIPT` | Optional exact basename `api-settlement-worker.mjs` only |
| `STAGING_VIDEO_SCRIPT` | Optional exact basename `video-job-worker.mjs` only |

Entry basenames are exact allowlisted values, resolved relative to the image's
application root, never a shell command or arbitrary env-supplied path. The API
child uses the same script's internal `--api-child` wrapper to capture and close
its HTTP server on SIGTERM, wait for requests, disconnect Prisma and exit. The
worker CLIs handle SIGTERM and drain themselves. Any unexpected essential-child
exit, **including exit 0**, terminates the other children and fails the container.

`/ready` returns 200 only with four live children and a recent successful private
storage canary/headroom check, database `SELECT 1` and API `/health` request.
Checks run every 10 seconds with a 5-second readiness deadline and 20-second stale
limit. Failure returns 503; it does not reinitialize storage or mutate migrations.
The deadline marks the service unready but retains the in-flight probe guard until
the actual filesystem/database operation settles. Polls skip a stalled probe; a
late success cannot restore readiness. A fresh successful probe is required. A
permanently wedged dependency requires operator recovery/restart; no overlapping
readiness operations are accumulated to work around it.
Startup checks migration status; ongoing readiness does not continuously audit
schema drift. Worker batch failures can be caught/retried by the existing worker
CLIs without process exit: readiness proves liveness and dependencies, **not queue
progress, provider health, fulfillment correctness or successful settlement**.
Monitor batch logs, retry/dead-letter counts, queue age, disk space and DB separately.
Only PostgreSQL and `/private-store` are persisted by this topology. `/app/data`
and legacy `/app/uploads` are ephemeral; this package does not migrate legacy local
data. Existing backend proxy-trust/rate-limit behavior also applies: nginx is the
API's network peer, so IP-based limits may be shared across users unless a separate
reviewed backend proxy-trust configuration is introduced.

Web `/healthz` proves nginx only. `/api/*` is not cached, buffered, compressed or
automatically retried. It preserves method/body/Authorization/query and propagates
disconnects. HTML, manifest and service worker revalidate; hashed assets are immutable.
Security headers include same-origin CSP and frame denial. API read/send timeout is
650 seconds; align Railway/CDN limits separately. Only `/api` is proxied: developer
`/v1` and root OAuth relays are outside this owned-web slice. No HSTS is forced on
local HTTP; configure transport policy at the new HTTPS edge after qualification.

If explicitly testing signed payment ingress later, set `STAGING_PAYMENTS_ENABLED=true`
only with `STRIPE_MODE=test`, a test key, endpoint signing secret and explicit
`STRIPE_WEBHOOK_ACCOUNT=platform` or the expected connected account. Keep checkout
and fulfillment false. No code readiness lock is bypassed. Accounted video requires
qualified provider configuration (`HF_VIDEO_ENDPOINT`, `HF_TOKEN`) and deliberate
flags; default-disabled workers still run recovery. Disabling dispatch does not
cancel previously accepted provider work or undo charges; unknown work needs
operator reconciliation. Local candidate does not seed accounts, credits or providers.

## Backup, migration and rollback

Before upgrading any persisted candidate: stop API/workers, record image/commit and
applied migrations, snapshot PostgreSQL **and** the private volume with its marker,
and preserve encryption key + namespace UUID in a secret manager. Coordinate the
snapshots while writers are stopped: DB rows and private files are coupled. Test
restoration into a different isolated DB/volume. Do not advertise a volume as a backup.

For a local candidate, these POSIX-shell examples write backups outside the repo
(use an existing operator-selected directory with suitable access controls):

```sh
C=deploy/owned-staging/compose.yaml
docker compose -f "$C" stop web backend
docker compose -f "$C" exec -T postgres pg_dump -U staging -d loop_staging -Fc > "$BACKUP_DIR/database.dump"
docker compose -f "$C" run --rm --no-deps --user 0:0 storage-check tar -C /private-store -czf - . > "$BACKUP_DIR/private-store.tar.gz"
# Review migration SQL from the candidate, then apply once and verify:
docker compose -f "$C" run --rm migrate
docker compose -f "$C" run --rm --no-deps storage-check
docker compose -f "$C" up -d --wait backend web
```

Use a POSIX shell or binary-safe tooling for those redirects; Windows PowerShell
5.1 native-output redirection can corrupt binary dump/tar data. Verify backup
checksums and restoreability before proceeding. Railway backups/restoration must
use the actual attached volume and database backup mechanisms, not Compose volumes.

Prisma migrations are forward-only here. Rolling the image back is safe only if
the database schema remains compatible with the old build; `migrate status` may
reject a mismatched release and this is intentional. For an incompatible migration,
keep writers stopped and restore **both** consistent snapshots to a fresh isolated
DB and PVC, restoring original marker/UUID/key and UID/GID 1000 permissions, then
run storage check and the matching old image. Do not rerun `--init` on restored
data, delete the marker, clear reservations, replay provider POSTs or mark failed
migrations resolved merely to make startup green. Changes after a restored backup
may be lost; reconcile external provider/financial activity before resuming.

Web rollback also involves PWA caches: existing tabs may retain the previous shell
until all clients close. Validate update/rollback on the dedicated staging origin;
never clear another app's service-worker registration or caches.
