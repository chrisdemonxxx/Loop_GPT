# Local packaging validation

## Review fixes and focused regressions — 2026-09-17, 15:06 EDT

Working tree based on `c6b20263423b8ab4d5c14c0f13900c7b91953c0e`.
Backend source was concurrently changing; these are local working-tree/image
snapshot results, not qualification of a frozen release commit. Host Node
`v24.18.0`, container Node `v22.23.2`, Docker Engine `29.8.0`, Compose `5.5.1`.

### Changes

- Supervisor readiness retains its in-flight guard after the 5-second deadline
  until actual I/O settles. Late completion cannot restore readiness; a new
  successful probe is required. The exact probe controller is importable for tests
  without starting application services or loading compiled backend modules.
- Web entrypoint rejects CR/LF anywhere in origin, upstream and port values before
  regex validation or nginx rendering.
- Staging-specific, web and standard-backend Docker ignore files end with precise
  recursive `.env`, `.env.*` and `tunnel-creds.json` exclusions. No broad exclusion
  of code, tests, fixture directories, or names containing `env`/`credentials`.
- Smoke cleanup uses unique run labels, attempts remaining cleanup after failure,
  verifies absence of owned containers/networks/volumes, and fails the process on
  cleanup failure. Final success follows cleanup, never precedes it.
- Railway runbook now explicitly replaces the config-as-code start command during
  maintenance, specifies UID/GID, disables healthchecks/restarts, and restores the
  non-root supervisor and `/ready` on 3002 afterward. Actual Railway maintenance
  execution remains unqualified; image CMD alone is not a start-command override.

### Commands and results

`node --test deploy/owned-staging/regressions.test.mjs`: **11/11 passed** on the
Windows host. Tests cover timed-out resolved/rejected probes with ten skipped
polls, fresh-check recovery, normal failures, shutdown, success ordering, combined
errors, real child-process nonzero exits, already-absent resources, failed removal
with continued cleanup, and residual-resource detection. Failure tests use fakes
and disposable Node child processes, creating no Docker resources.

`node deploy/owned-staging/smoke.mjs --build`: **passed**, project
`owned-smoke-8d8136b35b`, including:

- The same **11 focused tests**, automatically included in the existing CI command.
- **3 real Docker context regressions**, using disposable synthetic directories:
  staging excluded 15 sensitive filenames / retained 5 legitimate inputs; web
  excluded 21 / retained 5; standard backend excluded 21 / retained 6. Total:
  **57 exclusion assertions and 16 retention assertions**. These fixtures contain
  generated nonsecret text; only ignore-rule files are read from the real tree.
- **All six existing acceptance groups**: storage preparation/init/migrations,
  four-child startup/readiness, failure/recovery, proxy/PWA/SSE, worker exit and
  graceful SIGTERM. Both deliverable images rebuilt successfully.
- **9 new early-rejection cases**: CR, LF and CRLF in each of `API_UPSTREAM`,
  `OWNED_WEB_ORIGIN`, `PORT`; each exits 1 with the operator-validation diagnostic,
  not merely a later nginx syntax failure. Rejection containers use `--network none`.
- Cleanup absence verification passed before the final success message.

The 11 focused tests also passed inside the non-root backend image on Node
22.23.2 with `--network none`. Exact invocation (PowerShell, repository root):

```powershell
docker run --rm --network none --mount "type=bind,source=$PWD/deploy/owned-staging/regressions.test.mjs,target=/fixtures/deploy/owned-staging/regressions.test.mjs,readonly" --mount "type=bind,source=$PWD/deploy/owned-staging/smoke-lifecycle.mjs,target=/fixtures/deploy/owned-staging/smoke-lifecycle.mjs,readonly" --mount "type=bind,source=$PWD/backend/scripts/staging-runtime.mjs,target=/fixtures/backend/scripts/staging-runtime.mjs,readonly" loop-owned-staging-backend:local node --test /fixtures/deploy/owned-staging/regressions.test.mjs
```

Node 22 emitted its expected experimental MockTimers notice; zero failed/skipped
tests. The image inspection reported `User=node`,
`Cmd=["node","scripts/staging-runtime.mjs"]`.

Image IDs observed after the successful smoke:

- Backend: `sha256:9db50e99ccd063a924ed4fa140441e119343cf37710bf478cbbeb6463d54b037`.
- Web: `sha256:c847d140b6ee1e4569445f9483dacc020b584b34d7f1a788c204574d854d4453`.

An earlier attempt (`owned-smoke-ff85dbf1ef`) correctly exited nonzero when the new
synthetic-context test used Docker stdin tar input, which did not apply the
client-side ignore rules. That test was corrected to use actual directory
contexts, then the full `--build` smoke above passed. This was a regression-harness
defect, not a leak of real credentials. Cleanup completed on the failed path too.

### Cleanup and scope

Post-run queries for `owned-smoke-*` containers, networks and volumes all returned
no resources. `docker image ls loop-owned-context-check` returned no test images;
synthetic temporary contexts were removed. Deliverable images/build cache remain.
Protected container `07401ce0af0c` (`loop-daily-accounting-20260916`) was `Up 20 hours`
before and after; it was not stopped, restarted or removed.

Changes are limited to 11 packaging/runtime/test/evidence files: eight modified
files plus three new helper/test modules. No backend/src or workflow edits, main
checkpoint document changes, staging/commits, cloud deployments, or live-provider
qualification were performed. Only the focused tests and packaging smoke were run;
the full backend and browser suites remain the main owner's responsibility.

## Independent local rerun — 2026-09-17

Working directory: `C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt`.
HEAD: `c6b20263423b8ab4d5c14c0f13900c7b91953c0e`; existing uncommitted and
concurrently changing work was present, so this is a working-tree validation.
Node `v24.18.0`, npm `12.0.2`, Docker Engine `29.8.0`, Compose `v5.5.1`.

Exact validation command: `node deploy/owned-staging/smoke.mjs --build`.
Completed successfully with six PASS groups and the final
`LOCAL PACKAGING SMOKE PASSED` message:

1. Runtime refuses an uninitialized PVC.
2. Initialization rejects an unidentified nonempty namespace.
3. Migrations, four-child runtime, DB/storage/API readiness, disabled payments,
   static/PWA headers and SPA behavior.
4. UUID mismatch and script-path rejection; storage readiness failure/recovery.
5. Fixed upstream, POST/auth/query forwarding, early SSE frame, disconnect
   propagation, restart and injection rejection.
6. Essential-child exit fails the container; ordinary SIGTERM drains to exit 0.

Image evidence collected after the run with:

```powershell
docker image inspect loop-owned-staging-backend:local loop-owned-staging-web:local --format '{{json .RepoTags}} ID={{.Id}} RepoDigests={{json .RepoDigests}}'
```

- Backend image ID: `sha256:7ae5017eee0bafe91e80fedfc1c79b5115d05b1454eab1b95a788be2bfe7b20a`.
  RepoDigest: `loop-owned-staging-backend@sha256:7ae5017eee0bafe91e80fedfc1c79b5115d05b1454eab1b95a788be2bfe7b20a`.
- Web image ID: `sha256:f7496b5055157a5b8ccfda6da0406234659aeb1fd29089b88e114d7943ed4e74`.
  RepoDigest: `loop-owned-staging-web@sha256:f7496b5055157a5b8ccfda6da0406234659aeb1fd29089b88e114d7943ed4e74`.
- Backend runtime inspection reported `User=node` and
  `Cmd=["node","scripts/staging-runtime.mjs"]`.

Cleanup checks, run both before and after smoke:

```powershell
docker ps -a --filter 'name=owned-smoke-' --format '{{.ID}} {{.Names}} {{.Status}}'
docker network ls --filter 'name=owned-smoke-' --format '{{.ID}} {{.Name}}'
docker volume ls --filter 'name=owned-smoke-' --format '{{.Name}}'
docker ps -a --filter 'name=loop-daily-accounting-20260916' --format '{{.ID}} {{.Names}} {{.Status}}'
```

All three owned-smoke queries returned no resources before and after. The harness
reported no cleanup error; its random project name was not printed on success.
Protected container `07401ce0af0c` (`loop-daily-accounting-20260916`) remained
`Up 17 hours` in both checks. Images/build cache remain for reuse.

No release-validation defects found. Two metadata-only inspection attempts failed:
the first requested absent web-image `.Config.User`; the second Go-template
`index .Config "User"` attempt hit PowerShell/native quoting (`function "User"
not defined). The exact successful ID/digest query is above; these were inspection
command errors, not build/runtime failures.

The companion web build, 94 unit/component tests and four Playwright fixture tests
passed; see `../../web/VALIDATION.md`. This rerun did not run the backend full suite,
read secrets, call live providers, deploy, commit, modify source/schema/client,
or remove unrelated containers. Only the two validation documents were edited.

## Earlier packaging evidence

Observed on 2026-09-17, Windows host with Docker Desktop Linux containers.
Host Node 24.18.0, Docker Engine 29.8.0, Compose v5.5.1.

## Passed

- Built `web/Dockerfile` with **web/** context using the pinned Node digest and
  nginx 1.28.0 image; `npm ci`, TypeScript check and Vite production build passed.
- Built `deploy/owned-staging/backend.Dockerfile` with repository-root context;
  lockfile install, Prisma generation, TypeScript compilation and non-root runtime
  image construction passed. No host backend build artifacts were used.
- `node deploy/owned-staging/smoke.mjs --build` passed against the rebuilt images
  after incorporating the concurrently updated checkout/fulfillment flag contract.
- Disposable real PostgreSQL migrations applied successfully through the explicit
  one-off. Runtime refused pending migrations and an uninitialized private volume.
- Private-store `--init` rejected unidentified nonempty storage without writing a
  marker, matching-marker initialization was idempotent, and a mismatched UUID
  failed `--check`. Basename path traversal configuration was rejected.
- API plus daily settlement, API settlement and video workers ran under one
  supervisor; readiness checked database, private-store canary and API health.
  Removing the marker degraded readiness to 503; restoring it recovered readiness.
- Payment `enabled`, `checkoutEnabled` and `fulfillmentEnabled` were false.
- nginx SPA fallback, missing asset 404, no-cache HTML/SW, manifest MIME type,
  immutable assets, no-store API, CSP and nosniff headers passed.
- An isolated local mock upstream verified POST body, Authorization and query
  forwarding to the fixed operator host despite an untrusted request Origin/query;
  first SSE frame arrived before the delayed final frame; cancelling the client
  stream closed the upstream request. Config-injection input failed startup.
- nginx restart preserved valid runtime rendering.
- Essential worker exit (even a graceful worker stop) failed the entire container
  with exit 1. Normal backend SIGTERM drained to exit 0.
- Smoke-created containers, networks and volumes were removed by the harness.
- Built the optional root-only `storage-maintenance` target and ran it against a
  disposable tmpfs mount; empty-directory preparation passed. Rebuilt the default
  target and inspected `USER=node` and `CMD=node scripts/staging-runtime.mjs`.
- Node syntax checks passed for supervisor, smoke and preparation scripts.

## Boundaries

This validates local packaging against a snapshot of an actively changing working
tree, not a frozen release commit. Release owner must rerun on the final commit
and record image digests. No backend source tests or pytest assumptions were added.

Railway deployment, attached-volume maintenance, private IPv6 DNS resolution,
public HTTPS upstream/SNI, edge timeouts and Railway termination grace have not
been exercised. The template supports platform DNS IPv6 and verified HTTPS, but
those paths need environment-specific checks. No live login, provider request,
payment fulfillment, video qualification, backup restore drill, native device or
full-product validation was performed. Nothing was deployed, committed or pushed.
