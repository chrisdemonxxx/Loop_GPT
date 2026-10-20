# Loop-IT environment names

No secret values belong in this file or in git. Set them on the Railway
service (or in a local shell) and keep `.env` files out of the repo.

## Database

Loop-IT shares Loop-GPT's Postgres and owns schema `loopit`. Prisma tables stay
in `public`. The migration runner creates `loopit` and sets `search_path` to
that schema before it applies SQL. It aborts if a migration names another
schema or creates a relation outside `loopit`.

`DATABASE_URL` (migrate) and `LOOPIT_STORE_DSN` (api, router) must be the same
database with the schema selected:

```text
postgresql://USER:PASSWORD@HOST:5432/DATABASE?options=-csearch_path%3Dloopit
```

Also set that `search_path` on:

| Variable | Who reads it |
| --- | --- |
| `DATABASE_URL` | migrate (`python -m loopit_store.migrate`) |
| `LOOPIT_STORE_DSN` | api, router-svc. Defaults to `DATABASE_URL` in compose |
| `LOOPIT_SCHEDULER_STORE_DSN` | scheduler lease store. Defaults to `DATABASE_URL` |
| `LOOPIT_AUDIT_DSN` | preview-proxy audit writes. Use role `loopit_audit_writer`, still with `search_path=loopit` |

`LOOPIT_AUDIT_ROLE_PASSWORD` is the password migrate applies to
`loopit_audit_writer`. It is not a Loop-GPT secret.

## Shared with Loop-GPT

Use the existing provider accounts. Do not mint a second Hugging Face token or
a second E2B key for this stack.

| Loop-IT variable | Loop-GPT variable | Sharing |
| --- | --- | --- |
| `HF_TOKEN` | `HF_TOKEN` | Same Hugging Face token. Loop-GPT chat, media, and sandboxes already use it. The Loop-IT API uses it for live model calls. |
| `LOOPIT_MODEL_API_KEY` | `HF_TOKEN` | Set this to the same token unless a separate router key is issued later. The router will not boot without it. |
| `HF_BILL_TO` | (none) | Loop-IT router only. Optional Hugging Face org to bill. Not a Loop-GPT variable. |
| `HF_BASE_URL` | `HF_ENDPOINT_URL` and `HF_LARGE_ENDPOINT_URL` | Not the same setting. Loop-IT defaults to `https://router.huggingface.co`. Do not copy Loop-GPT's dedicated endpoint URLs into `HF_BASE_URL`. |
| `E2B_API_KEY` | `E2B_API_KEY` | Same E2B account. Loop-GPT `execute_code` and the Loop-IT scheduler both read this name. Required only when `LOOPIT_SANDBOX_PROVIDER=e2b`. |
| (none) | `E2B_DESKTOP_TEMPLATE` | Loop-GPT bot Computer only. GNOME image id from `infra/e2b-gnome-desktop` — required for box boot / `createDesktop` (no stock XFCE). |
| `LOOPIT_E2B_TEMPLATE_ID` | (none) | Loop-IT sandbox template (from `Loop-it/sandbox/image` / `e2b.toml`). Required when provider is `e2b`. |
| `STRIPE_API_KEY` | `STRIPE_SECRET_KEY` | Same Stripe secret key when both use one account. **Leave Loop-IT's `STRIPE_API_KEY` unset** in this phase so checkout stays on Loop-GPT. This minimal stack does not run Loop-IT billing. |
| `STRIPE_WEBHOOK_SECRET` | `STRIPE_WEBHOOK_SECRET` | Not the same value. Each webhook endpoint has its own signing secret. Leave Loop-IT's unset until Loop-IT Stripe is deliberately turned on. |

## Other required names

These are Loop-IT-only. Generate them with Loop-IT's own tooling
(`uv run python scripts/generate_secrets.py` inside `Loop-it/`) and store them
on the services. Do not reuse Loop-GPT's `JWT_SECRET`.

| Variable | Services |
| --- | --- |
| `LOOPIT_IDENTITY_SECRET` | api, router-svc |
| `LOOPIT_LEASE_TOKEN_SECRET` | router-svc, scheduler, workspace-dispatch |
| `LOOPIT_SERVICE_TOKEN` | api, scheduler, workspace-dispatch, orchestrator |
| `LOOPIT_SANDBOX_SIGNING_KEY` | workspace-dispatch |
| `LOOPIT_PREVIEW_SIGNING_KEY` | api, preview-proxy |
| `LOOPIT_AUDIT_ROLE_PASSWORD` | migrate |

Optional identity labels, with compose defaults: `LOOPIT_IDENTITY_ISSUER`,
`LOOPIT_IDENTITY_AUDIENCE`, `LOOPIT_IDENTITY_KID`.

## Flag and proxy

| Variable | Where | Effect |
| --- | --- | --- |
| `LOOPIT_ENABLED` | Loop-GPT web **build** arg | `1`, `true`, or `yes` bakes the Build link and points `/code` at `/build`. Anything else keeps the current `/developer` redirect. |
| `LOOPIT_API_UPSTREAM` | Loop-GPT web **runtime** | `http://<loopit-api>.railway.internal:8000` (or https). Unset: `/api/loopit/` proxies to `API_UPSTREAM` and is inert. |
| `LOOPIT_USAGE_URL` | api | Loop-GPT **backend** usage endpoint, e.g. `http://<backend>.railway.internal:3001/api/loopit/usage`. Point it at the backend directly: through the web gateway `/api/loopit/*` is proxied to Loop-IT. Set: every Build model call is charged to the workspace owner's credits and a refused charge (402 or unreachable) stops the run. Unset: Build usage is not billed (logged at boot). Uses the shared `LOOPIT_IDENTITY_*` settings, so the kid/issuer/audience must match Loop-GPT's. |
| `LOOPIT_API_URL` | Loop-GPT **backend** | Loop-IT API base for the public `/v1/build` API (default `http://loopit-api.railway.internal:8000`). |
| `LOOPIT_MCP_URL` | Loop-GPT **backend** | Public **https** origin of compose service `loopit-mcp` (port 8010). When set, chat exposes `mcp__loopit__start_run`. Unset or non-https → tools stay hidden. |
| `LOOPIT_RUN_EXECUTION_MODE` | api | `local` (default) uses in-process `RunManager` (no Temporal, no sandbox shell). `orchestrator` starts Temporal workflows and needs the orchestrator worker + `LOOPIT_TEMPORAL_ADDRESS`. |
| `LOOPIT_TEMPORAL_ADDRESS` | api, orchestrator | Temporal Cloud frontend (`<ns>.tmprl.cloud:7233`) or self-hosted `host:7233`. Empty for local/offline. |
| `LOOPIT_TEMPORAL_NAMESPACE` | api, orchestrator | Default `default`. Use the Cloud namespace when that is the frontend. |
| `LOOPIT_TEMPORAL_TASK_QUEUE` | api, orchestrator | Default `loopit-runs`. |
| `LOOPIT_SANDBOX_PROVIDER` | scheduler, workspace-dispatch | `memory` (default in this compose — offline mock leases) or `e2b` (live). |
| `LOOPIT_SANDBOX_SIGNING_KEY` | workspace-dispatch | Signs sandbox runtime envelopes. Generate with Loop-IT secrets script. |
| `LOOPIT_SANDBOX_POOL_TARGET_SIZE` | scheduler | Warm-pool size (`scheduler/pool.py`). Default `0` offline; raise (e.g. `3`) for live E2B. |
| `LOOPIT_SANDBOX_POOL_MAX_LIVE` | scheduler | Cap on warm + assigned sandboxes (default `50`). |
| `LOOPIT_SANDBOX_POOL_MAX_IDLE_SECONDS` | scheduler | Retire unused warm sandboxes after this many seconds (default `900`). |
| `LOOPIT_EGRESS_ALLOW_PACKAGE_REGISTRIES` | egress-proxy | `1` (default) allows npm/pypi (and friends) through the default-deny egress proxy. |
| `LOOPIT_WORKSPACE_DISPATCH_URL` | api, orchestrator | Default `http://workspace-dispatch:8005/dispatch`. Agent shell / package / dev-server tools go here. |
| `LOOPIT_EGRESS_PROXY_URL` | api | Default `http://egress-proxy:8002`. Documented for sandbox HTTP_PROXY wiring (E2B template / Phase 1.3). |
| `LOOPIT_SERVICE_TOKEN` | api, scheduler, workspace-dispatch, orchestrator | Shared service auth for lease acquire/renew/release. |

### Enabling live Temporal Cloud + E2B

1. Build/push the E2B template (`Loop-it/sandbox/image`, `e2b.toml`) and set `LOOPIT_E2B_TEMPLATE_ID` + `E2B_API_KEY`.
2. Create a Temporal Cloud namespace + API key; set `LOOPIT_TEMPORAL_ADDRESS`, `LOOPIT_TEMPORAL_NAMESPACE` (and Cloud API key env as required by the orchestrator image / Temporal SDK).
3. `LOOPIT_SANDBOX_PROVIDER=e2b`, `LOOPIT_SANDBOX_POOL_TARGET_SIZE=3` (or higher).
4. `LOOPIT_RUN_EXECUTION_MODE=orchestrator`.
5. `docker compose --profile orchestrator -f deploy/loopit/docker-compose.yml up --build`.

Pause/resume of idle E2B VMs is **not** an HTTP API yet; the warm pool destroys on release and never recycles (cross-tenant safety). Idle cost control today is release + pool refill.

## Service URLs

Compose defaults, override on Railway with private domains:

```text
LOOPIT_ROUTER_URL=http://router-svc:8001
LOOPIT_SCHEDULER_URL=http://scheduler:8004
LOOPIT_PREVIEW_PROXY_URL=http://preview-proxy:8003
LOOPIT_WORKSPACE_DISPATCH_URL=http://workspace-dispatch:8005/dispatch
LOOPIT_EGRESS_PROXY_URL=http://egress-proxy:8002
LOOPIT_API_BASE_URL=http://api:8000
```

## Hosting, provision, secrets (Phase 1.8–1.11)

| Variable | Effect |
| --- | --- |
| `LOOPIT_DEPLOYER_PROVIDER` | `static` (default, local `.hosted/`), `fly`, or `fake`. |
| `LOOPIT_APPS_BASE_DOMAIN` | Opaque public hostnames: `https://p-….${domain}`. |
| `LOOPIT_DOMAINS_URL` | Domains service base; allocate subdomain on publish when set with `LOOPIT_SERVICE_TOKEN`. |
| `LOOPIT_FLY_API_TOKEN` / `LOOPIT_FLY_ORG` | Required for `fly` provider (Machines API). |
| `LOOPIT_FLY_IMAGE` | Image tag for Fly candidates (default `registry.fly.io/loopit-gen:latest`). |
| `LOOPIT_PROVISION_POSTGRES_DSN` | Real Postgres for generated-app schemas; unset → in-memory fake. |
| `LOOPIT_STORAGE_BUCKET` | Default S3/R2 bucket name for per-project prefixes. |
| `LOOPIT_SECRETS_ROOT_KEY` / `LOOPIT_SECRETS_ROOT_KEY_ID` | Envelope encryption when using Postgres secret rows. |
| `LOOPIT_SECRETS_POSTGRES_DSN` | Optional; falls back to `LOOPIT_STORE_DSN`. |

Offline defaults need none of the above: static hosting + memory DB/secrets.

## GitHub sync, custom domains, sharing, templates (Phase 2.3–2.6)

| Variable | Effect |
| --- | --- |
| `LOOPIT_GITSYNC_PROVIDER` | `fake` (default, offline) or `github`. |
| `LOOPIT_GITHUB_TOKEN` | PAT / App installation token for live `GithubProvider` pushes. Not required offline. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Loop-GPT platform GitHub OAuth (connector vault). Unset → `GET /api/loopit/github-sync/connect` returns stub docs. |
| `LOOPIT_DOMAINS_MODE` | `fake` (in-process DomainService + FakeCertificateAuthority) or `live` (HTTP to domains service). |
| `LOOPIT_DOMAINS_URL` + `LOOPIT_SERVICE_TOKEN` | Live custom-domain claim/verify via `services/domains`. |
| `LOOPIT_APPS_BASE_DOMAIN` | CNAME target shown in Domains UI / TXT challenge companion. |
| `LOOPIT_USAGE_URL` | When set, verified custom domains post `kind=custom_domain_months` (field `customDomainMonths`). |

Offline path: bind fake git remotes, claim/verify domains with `seed_txt`, share/remix via `.sharing/` sidecars, list `/api/templates` from curated + `stack-templates/recipes/*.json`. No live GH App or ACME credentials required.

## loopit-mcp (B20)

Compose service `loopit-mcp` listens on `8010` (`POST /mcp`, `GET /healthz`) and
proxies MCP tools to the Loop-IT API with the caller's identity JWT. Expose it
with a public HTTPS hostname on Railway and set Loop-GPT backend
`LOOPIT_MCP_URL` to that origin (no path). The built-in client refuses non-https.

