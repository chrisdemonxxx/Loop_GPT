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
| `E2B_API_KEY` | `E2B_API_KEY` | Same E2B account. Loop-GPT `execute_code` and the Loop-IT scheduler both read this name. |
| `LOOPIT_E2B_TEMPLATE_ID` | (none) | Loop-IT sandbox template. Required because this stack forces `LOOPIT_SANDBOX_PROVIDER=e2b`. |
| `STRIPE_API_KEY` | `STRIPE_SECRET_KEY` | Same Stripe secret key when both use one account. **Leave Loop-IT's `STRIPE_API_KEY` unset** in this phase so checkout stays on Loop-GPT. This minimal stack does not run Loop-IT billing. |
| `STRIPE_WEBHOOK_SECRET` | `STRIPE_WEBHOOK_SECRET` | Not the same value. Each webhook endpoint has its own signing secret. Leave Loop-IT's unset until Loop-IT Stripe is deliberately turned on. |

## Other required names

These are Loop-IT-only. Generate them with Loop-IT's own tooling
(`uv run python scripts/generate_secrets.py` inside `Loop-it/`) and store them
on the services. Do not reuse Loop-GPT's `JWT_SECRET`.

| Variable | Services |
| --- | --- |
| `LOOPIT_IDENTITY_SECRET` | api, router-svc |
| `LOOPIT_LEASE_TOKEN_SECRET` | router-svc, scheduler |
| `LOOPIT_SERVICE_TOKEN` | scheduler |
| `LOOPIT_PREVIEW_SIGNING_KEY` | api, preview-proxy |
| `LOOPIT_AUDIT_ROLE_PASSWORD` | migrate |

Optional identity labels, with compose defaults: `LOOPIT_IDENTITY_ISSUER`,
`LOOPIT_IDENTITY_AUDIENCE`, `LOOPIT_IDENTITY_KID`.

## Flag and proxy

| Variable | Where | Effect |
| --- | --- | --- |
| `LOOPIT_ENABLED` | Loop-GPT web **build** arg | `1`, `true`, or `yes` bakes the Build link and points `/code` at `/build`. Anything else keeps the current `/developer` redirect. |
| `LOOPIT_API_UPSTREAM` | Loop-GPT web **runtime** | `http://<loopit-api>.railway.internal:8000` (or https). Unset: `/api/loopit/` proxies to `API_UPSTREAM` and is inert. |
| `LOOPIT_RUN_EXECUTION_MODE` | api | `local` (default here) does not contact Temporal. `orchestrator` requires `LOOPIT_TEMPORAL_ADDRESS`. |
| `LOOPIT_TEMPORAL_ADDRESS` | api, later the orchestrator | Empty in this stack. Temporal Cloud or a self-hosted frontend. See README.md. |
| `LOOPIT_TEMPORAL_NAMESPACE` | api | Default `default`. Use the Cloud namespace when that is the frontend. |
| `LOOPIT_TEMPORAL_TASK_QUEUE` | api | Default `loopit-runs`. |

## Service URLs

Compose defaults, override on Railway with private domains:

```text
LOOPIT_ROUTER_URL=http://router-svc:8001
LOOPIT_SCHEDULER_URL=http://scheduler:8004
LOOPIT_PREVIEW_PROXY_URL=http://preview-proxy:8003
```
