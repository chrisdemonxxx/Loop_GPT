# Loop-IT side by side on Railway

Code and config only. Nothing in this directory creates Railway services or
cloud accounts. Names and values for environment variables are in [ENV.md](ENV.md).
Do not put secret values in git.

The nested tree stays at `Loop-it/` until its history is imported by hand.
Compose builds from that directory (`../../Loop-it`).

## Temporal

The sandbox **scheduler** (`Loop-it/services/scheduler`) does not import
Temporal and does not read `LOOPIT_TEMPORAL_*`. It boots from its lease store
and `LOOPIT_SANDBOX_PROVIDER`. This stack sets that provider to `e2b` and does
not run a Temporal server.

Durable agent runs are a different process: `Loop-it/services/orchestrator`.
That package depends on `temporalio` and a reachable Temporal frontend. It is
**not** in this minimal stack. The API is set to `LOOPIT_RUN_EXECUTION_MODE=local`,
so it serves without Temporal. Live model calls still need `HF_TOKEN`; without
it the API starts in its existing offline mode.

When durable runs are turned on later, point the same three variables at either
backend below and set `LOOPIT_RUN_EXECUTION_MODE=orchestrator`. The compose file
does not embed a Temporal service, so either address works without editing the
service list.

### Temporal Cloud (recommended)

`temporal start-dev` has no auth and local storage. A self-hosted history
cluster (the production Temporal server plus its database) does not fit a
small Railway service. Use Temporal Cloud. Set `LOOPIT_TEMPORAL_ADDRESS` to
the Cloud frontend and supply the Cloud namespace and API key on the
orchestrator service when that service is added.

### Self-hosted Temporal

Run Temporal outside this compose file (the full `Loop-it/docker-compose.yml`
`temporal` service is `start-dev` and is local-only). Set
`LOOPIT_TEMPORAL_ADDRESS` to that frontend (`host:7233`). Keep it off the
public internet until mTLS and namespace auth are in place. See
`Loop-it/docs/self-hosting.md`.

## Services

| Service | Image Dockerfile (context `Loop-it/`) | Listen port |
| --- | --- | --- |
| migrate | `apps/api/Dockerfile` (one-shot command) | none |
| router-svc | `services/router-svc/Dockerfile` | 8001 |
| scheduler | `services/scheduler/Dockerfile` | 8004 |
| preview-proxy | `services/preview-proxy/Dockerfile` | 8003 |
| api | `apps/api/Dockerfile` | 8000 |

The scheduler image installs the `providers` extra (Docker and E2B). This
compose forces `LOOPIT_SANDBOX_PROVIDER=e2b` and does not mount a Docker socket.

## Start order

1. **migrate** — `python -m loopit_store.migrate --dsn "$DATABASE_URL"`. Creates
   schema `loopit` if needed and applies store migrations only inside it.
2. **router-svc**, **scheduler**, and **preview-proxy** — after migrate exits 0.
3. **api** — after those three are healthy.
4. On the Loop-GPT web service, set `LOOPIT_API_UPSTREAM` to this API
   (`http://<loopit-api>.railway.internal:8000`). Until that variable is set,
   nginx `/api/loopit/` follows the main Loop-GPT API and changes nothing.

Pin each Railway service `PORT` to the listen port above. The image
`HEALTHCHECK` uses that port literally.

## Railway services

Create one service per row. Root directory `Loop-it`. Dockerfile path from the
table. Do not override the image command except for migrate:

```text
python -m loopit_store.migrate --dsn "$DATABASE_URL"
```

Run migrate once before the others, and again on each store migration. Private
networking replaces the compose DNS names. Set:

```text
LOOPIT_ROUTER_URL=http://<router>.railway.internal:8001
LOOPIT_SCHEDULER_URL=http://<scheduler>.railway.internal:8004
LOOPIT_PREVIEW_PROXY_URL=http://<preview>.railway.internal:8003
```

Leave `LOOPIT_ROUTER_URL` and the other two at their compose defaults
(`http://router-svc:8001` and so on) only when using this compose file.

Web build arg, on the existing Loop-GPT web service, not on these services:
`LOOPIT_ENABLED=1` shows the Build link and sends `/code` to `/build`. Unset
or any other value keeps today's `/developer` redirect. The `/build` page is a
placeholder until the native UI lands.

## Local compose

From the repo root, with the variables in ENV.md exported and no secret files
committed:

```text
docker compose -f deploy/loopit/docker-compose.yml up --build
```

## Toolchain

Two package graphs stay side by side. Do not move Loop-it onto npm, and do not
bump ESLint or TypeScript across either tree, as a consolidation step.

| Tree | JavaScript | Python |
| --- | --- | --- |
| Repo root (`package.json` workspaces `apps/*`, `packages/*`; `backend/` is its own npm project) | npm (`package-lock.json`). ESLint 8 with eslintrc: `apps/web/.eslintrc.json` extends `next/core-web-vitals`; `backend/.eslintrc.json` extends `eslint.base.json`. TypeScript 5.3 (`typescript` ^5.3.3). | none |
| `Loop-it/` | pnpm 9.15 (`packageManager` in `Loop-it/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`). ESLint 9 flat config (`Loop-it/eslint.config.mjs`). TypeScript 5.7 (`typescript` ^5.7.2). | uv (`Loop-it/pyproject.toml`, `Loop-it/uv.lock`) |

The backend ESLint config was left on ESLint 8. The web app has no flat
config to copy. Matching it would mean upgrading ESLint and
`typescript-eslint` and rewriting `backend/.eslintrc.json` plus the `lint`
script (`--ext` is an eslintrc flag). That is more than a rename.

## Loop-it admin

`Loop-it/apps/admin` (`@loopit/admin`) stays where it is. It is a single Vite
screen, and it is an operator console: abuse queue, tenant quotas, kill
switches, and an audit log. It authenticates with a platform operator token
(`platform:operate`), renders through `@loopit/ui-kit`, and calls incident,
audit, sandbox-kill, and tenant-suspend APIs. Those APIs are not in this
compose file (the admin image expects `abuse-engine` on port 8007). Folding
that into `apps/web/app/admin` is a product port, not a file move.

The parent admin portal links to it at `/admin/loopit`. That page opens
`NEXT_PUBLIC_LOOPIT_ADMIN_URL` when the web app is built with it, otherwise
`http://127.0.0.1:5174` (`pnpm --filter @loopit/admin dev` from `Loop-it`).

Remaining port work, before the nested app can be dropped:

1. Rebuild the four panels as a Next route under `apps/web/app/admin`, using
   `@loop/ui` (or local components) instead of `@loopit/ui-kit`.
2. Decide how operators sign in: keep the platform operator JWT, or use the
   parent admin session.
3. Proxy `/v1/incidents`, `/v1/audit`, sandbox kill, and tenant suspend
   through the parent API. Do not call the abuse engine from the browser
   with a pasted token.
4. Move `Loop-it/apps/admin/tests/logic.test.ts` with the UI.
5. Add the abuse-engine service to this stack. Until it is deployed, a
   ported page has nothing real to operate.

## Retirement candidates

Leave these in the tree until parity is confirmed. Deletion is a later
change, after a staging check with `LOOPIT_ENABLED=1`.

| Path | Remove only when |
| --- | --- |
| `@loopit/ui-kit` (`Loop-it/packages/ui-kit`) | No Loop-it app still imports it. The admin console above is a current importer, so this waits on that port (or an explicit decision to keep the nested admin and drop only unused kit pieces). |
| `Loop-it/apps/web` (`@loopit/web`) | `apps/web` routes `/build` and `/build/[runId]` cover the console: run board, task graph, approval gates, checkpoints, preview, and deploy. Confirm that on staging before deleting the Vite app. |
| `Loop-it/apps/console-mobile` | The Capacitor wrap of `@loopit/web` has no remaining operator, and `mobile/` can open the web app's `/build` route. Confirm that path on a device before removing the wrap. |
