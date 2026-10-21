# Runbook: deploy the control plane on Fly.io

**Owner:** platform
**Applies to:** minimal-budget managed PaaS deployment for the Loop-it control plane
**Last verified:** 2026-09-03

This runbook deploys the HTTP control-plane services from `infra/fly/*.toml`.
The sandbox data-plane image is intentionally separate and is not built by this flow.

---

## 0. Shape of the deployment

Public apps:

- `loopit-web` — static UI. Proxies `/api/` and preview traffic using runtime env vars.
- `loopit-api` — the gateway API.
- `loopit-preview-proxy` — public preview ingress with sandbox ports kept private.

Private apps:

- `loopit-router-svc`
- `loopit-egress-proxy`
- `loopit-scheduler`

All configs use `shared-cpu-1x` machines and the smallest practical memory settings.
Stateless public services are configured with Fly auto-start/auto-stop and
`min_machines_running = 0`. Keep at least one scheduler machine running if it is
responsible for background lease cleanup or warm-pool maintenance.

---

## 1. Prerequisites

1. Install and authenticate the Fly CLI:

   ```bash
   fly auth login
   ```

2. Pick globally unique app names. The checked-in configs use `loopit-*`; change
   the `app =` value in each `infra/fly/fly.*.toml` if those names are unavailable.
3. Choose Postgres:
   - Lowest operations burden: Neon or Supabase free tier.
   - Single-vendor option: Fly Postgres, sized down for development.

---

## 2. Create apps

Run from the repository root:

```bash
fly apps create loopit-web
fly apps create loopit-api
fly apps create loopit-preview-proxy
fly apps create loopit-router-svc
fly apps create loopit-egress-proxy
fly apps create loopit-scheduler
```

If you renamed apps in the TOML files, create those names instead.

---

## 3. Configure secrets

Set secrets per app; do not commit real values to `.env.example` or TOML.
Generate local development values with `uv run python scripts/generate_secrets.py`;
production values must come from a password manager or KMS.

```bash
fly secrets set -a loopit-api \
  LOOPIT_ENV='production' \
  DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/loopit' \
  LOOPIT_IDENTITY_SECRET='...' \
  LOOPIT_PREVIEW_SIGNING_KEY='...' \
  LOOPIT_OPERATOR_IDENTITY_SECRET='...' \
  HF_TOKEN='...' \
  HF_BILL_TO='your-org-or-user'

fly secrets set -a loopit-router-svc \
  LOOPIT_IDENTITY_SECRET='...' \
  LOOPIT_LEASE_TOKEN_SECRET='...' \
  LOOPIT_MODEL_API_KEY='...' \
  HF_TOKEN='...' \
  HF_BILL_TO='your-org-or-user'

fly secrets set -a loopit-scheduler \
  DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/loopit' \
  LOOPIT_LEASE_TOKEN_SECRET='...' \
  LOOPIT_SERVICE_TOKEN='...'

fly secrets set -a loopit-preview-proxy \
  DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/loopit' \
  LOOPIT_PREVIEW_SIGNING_KEY='...'

fly secrets set -a loopit-abuse-engine \
  DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/loopit' \
  LOOPIT_IDENTITY_SECRET='...' \
  LOOPIT_OPERATOR_IDENTITY_SECRET='...' \
  LOOPIT_SERVICE_TOKEN='...'
```

Canonical secret names and minimums: `POSTGRES_PASSWORD` (16 chars),
`LOOPIT_IDENTITY_SECRET`, `LOOPIT_OPERATOR_IDENTITY_SECRET`,
`LOOPIT_PREVIEW_SIGNING_KEY`, `LOOPIT_LEASE_TOKEN_SECRET`, `LOOPIT_SERVICE_TOKEN`,
and `LOOPIT_MODEL_API_KEY` (32 chars each). Do not use legacy aliases such as
`LOOPIT_IDENTITY_KEY`, `LOOPIT_IDENTITY_TOKEN_SECRET`, or `SECRETS_MASTER_KEY`.
Rotate signing secrets by rolling every issuer and verifier that shares the key;
drain active preview/lease tokens before changing preview or lease keys.

`LOOPIT_SECRETS_ROOT_KEY` and `LOOPIT_SECRETS_ROOT_KEY_ID` are optional and only
needed once a service instantiates the Postgres-backed `loopit_secrets` store
described in ADR-0019. No deployed service currently instantiates that persistent
store.

For Neon/Supabase, allow Fly outbound traffic and require TLS as directed by the provider.

---

## 4. Run migrations

Before the first app deploy and before any schema-dependent rollout:

```bash
fly ssh console -a loopit-api -C \
  'python -m loopit_store.migrate --dsn "$DATABASE_URL"'
```

For first deploys where no machine exists yet, run the same command locally from
a trusted environment with network access to Postgres:

```bash
uv sync --all-extras --dev
uv run python -m loopit_store.migrate --dsn "$DATABASE_URL"
```

---

## 5. Deploy

Deploy private dependencies first, then public entrypoints:

```bash
fly deploy -c infra/fly/fly.router-svc.toml
fly deploy -c infra/fly/fly.egress-proxy.toml
fly deploy -c infra/fly/fly.scheduler.toml
fly deploy -c infra/fly/fly.preview-proxy.toml
fly deploy -c infra/fly/fly.api.toml
fly deploy -c infra/fly/fly.web.toml
```

Smoke-check health:

```bash
fly status -a loopit-api
fly checks list -a loopit-api
curl https://loopit-web.fly.dev/healthz
```

---

## 6. Roll back

List releases and roll back the affected app:

```bash
fly releases -a loopit-api
fly deploy --image registry.fly.io/loopit-api:<previous-version> -a loopit-api
```

If a rollout included a migration, verify whether the migration is additive
before rolling code back. The store migrations are intended to be forward-only,
so prefer a hotfix over destructive schema rollback.

---

## 7. Cost controls

- Keep public stateless services on auto-stop/auto-start with zero minimum machines.
- Keep private stateless services scaled to zero when idle only if callers tolerate
  cold starts and Fly can route to the machine.
- Keep the scheduler at one small machine when background cleanup must run.
- Prefer Neon or Supabase free Postgres while traffic is low; move to Fly Postgres
  only when single-provider operations matter more than the extra baseline cost.
