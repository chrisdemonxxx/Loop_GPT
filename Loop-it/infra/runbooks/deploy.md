# Runbook: deploy Loop-it

**Owner:** platform
**Applies to:** P4-16, P4-17, Fly.io control-plane deployment
**Last verified:** 2026-09-03

This runbook describes the GitHub Actions deployment path in `.github/workflows/deploy.yml`.
It builds GHCR images, runs release blockers, migrates the control-plane database, deploys
Fly apps with a canary strategy, and verifies `/healthz` before moving to the next service.

---

## 0. Deployment shape

The checked-in Fly configs deploy these services:

| Service        | Fly config                          | Default app name        | Health check |
| -------------- | ----------------------------------- | ----------------------- | ------------ |
| router-svc     | `infra/fly/fly.router-svc.toml`     | `loopit-router-svc`     | `/healthz`   |
| egress-proxy   | `infra/fly/fly.egress-proxy.toml`   | `loopit-egress-proxy`   | `/healthz`   |
| scheduler      | `infra/fly/fly.scheduler.toml`      | `loopit-scheduler`      | `/healthz`   |
| preview-proxy  | `infra/fly/fly.preview-proxy.toml`  | `loopit-preview-proxy`  | `/healthz`   |
| api            | `infra/fly/fly.api.toml`            | `loopit-api`            | `/healthz`   |
| web            | `infra/fly/fly.web.toml`            | `loopit-web`            | `/healthz`   |

Private services use Fly private networking. Public services should also expose a GitHub
Environment variable with their public health URL so Actions can `curl` them directly.

---

## 1. First-time GitHub setup

Create two GitHub Environments: `staging` and `prod`. Configure required reviewers on
`prod`; the workflow already attaches deploy, eval, red-team, migration, and rollback jobs
to the selected environment so GitHub enforces the approval gate.

Set these **environment variables** in both `staging` and `prod`:

| Name                            | Purpose                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `FLY_ROUTER_SVC_APP`            | Fly app for `router-svc`.                                          |
| `FLY_EGRESS_PROXY_APP`          | Fly app for `egress-proxy`.                                        |
| `FLY_SCHEDULER_APP`             | Fly app for `scheduler`.                                           |
| `FLY_PREVIEW_PROXY_APP`         | Fly app for `preview-proxy`.                                       |
| `FLY_API_APP`                   | Fly app for `api`.                                                 |
| `FLY_WEB_APP`                   | Fly app for `web`.                                                 |
| `ROUTER_SVC_HEALTH_URL`         | Optional public health URL, when exposed.                          |
| `EGRESS_PROXY_HEALTH_URL`       | Optional public health URL, when exposed.                          |
| `SCHEDULER_HEALTH_URL`          | Optional public health URL, when exposed.                          |
| `PREVIEW_PROXY_HEALTH_URL`      | Public preview proxy health URL.                                   |
| `API_HEALTH_URL`                | Public API health URL.                                             |
| `WEB_HEALTH_URL`                | Public web health URL.                                             |
| `HF_BILL_TO`                    | Hugging Face billing account for release evals.                    |
| `LOOPIT_ROUTER_BASE_URL`        | Router base URL for release evals; defaults to HF Router if unset. |
| `LOOPIT_SANDBOX_PROVIDER`       | Must be `docker` or `e2b` for release eval/red-team gates.         |
| `LOOPIT_SANDBOX_IMAGE`          | Docker sandbox image for release evals when provider is `docker`.  |
| `LOOPIT_SANDBOX_DOCKER_NETWORK` | Docker network for sandbox release evals.                          |
| `LOOPIT_E2B_TEMPLATE_ID`        | E2B template when provider is `e2b`.                               |
| `LOOPIT_EVAL_CREDIT_LIMIT`      | Per-run eval credit ceiling.                                       |
| `LOOPIT_LIVE_SANDBOX_REDTEAM`   | Must be `1`; otherwise deploy fails closed.                        |
| `LOOPIT_EGRESS_PROXY_ADDR`      | Egress proxy address for live red-team checks.                     |
| `LOOPIT_SANDBOX_RESOLVER_ADDR`  | Resolver address for live red-team checks.                         |

Set these **environment secrets**:

| Name                         | Purpose                                              |
| ---------------------------- | ---------------------------------------------------- |
| `FLY_API_TOKEN`              | Fly deploy/rollback token scoped to the target apps. |
| `CONTROL_PLANE_DATABASE_URL` | Target Postgres DSN for migrations and backup.       |
| `HF_TOKEN`                   | Hugging Face token used by real eval harness runs.   |
| `SCRATCH_DATABASE_URL`       | Scratch Postgres DSN for backup/restore drills.      |

Do not print secret values. Use Fly secrets for runtime service configuration:

```bash
fly secrets set -a "$FLY_API_APP" LOOPIT_ENV='production' DATABASE_URL='...' LOOPIT_IDENTITY_SECRET='...' \
  LOOPIT_PREVIEW_SIGNING_KEY='...' LOOPIT_OPERATOR_IDENTITY_SECRET='...' HF_TOKEN='...' HF_BILL_TO='...'
fly secrets set -a "$FLY_ROUTER_SVC_APP" LOOPIT_IDENTITY_SECRET='...' \
  LOOPIT_LEASE_TOKEN_SECRET='...' LOOPIT_MODEL_API_KEY='...' HF_TOKEN='...' HF_BILL_TO='...'
fly secrets set -a "$FLY_SCHEDULER_APP" DATABASE_URL='...' LOOPIT_LEASE_TOKEN_SECRET='...' \
  LOOPIT_SERVICE_TOKEN='...'
fly secrets set -a "$FLY_PREVIEW_PROXY_APP" DATABASE_URL='...' LOOPIT_PREVIEW_SIGNING_KEY='...'
fly secrets set -a "$FLY_ABUSE_ENGINE_APP" DATABASE_URL='...' LOOPIT_IDENTITY_SECRET='...' \
  LOOPIT_OPERATOR_IDENTITY_SECRET='...' LOOPIT_SERVICE_TOKEN='...'
```

Canonical secret names are `POSTGRES_PASSWORD` (16+ chars),
`LOOPIT_IDENTITY_SECRET`, `LOOPIT_OPERATOR_IDENTITY_SECRET`,
`LOOPIT_PREVIEW_SIGNING_KEY`, `LOOPIT_LEASE_TOKEN_SECRET`, `LOOPIT_SERVICE_TOKEN`,
and `LOOPIT_MODEL_API_KEY` (32+ chars each). Do not use legacy names (`LOOPIT_IDENTITY_KEY`,
`LOOPIT_IDENTITY_TOKEN_SECRET`, `SECRETS_MASTER_KEY`). Rotate by rolling every
issuer/verifier pair together; drain previews/leases before replacing those keys.
`LOOPIT_SECRETS_ROOT_KEY` is optional and only needed once a trusted service
instantiates the Postgres-backed `loopit_secrets` store described in ADR-0019.
No running service currently instantiates that persistent store, and there is no
standalone secret-broker Fly app or health endpoint.

If GHCR packages are private, grant the Fly organization pull access or set registry
credentials through Fly using a least-privileged GHCR token. Do not bake credentials into
images or TOML files.

---

## 2. Release blockers

A deploy cannot start until these jobs pass:

1. Python full CI: `uv sync --all-extras --dev`, `uv run pytest`, ruff format/check, and mypy.
2. TypeScript full CI: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
3. Contract schemas: `uv run python packages/contracts/validate_schemas.py`.
4. Invariants: `uv run python scripts/check_invariants.py`.
5. Eval harness T0-T3 regression: real executor, baseline comparison, 5% tolerance.
6. Full red-team suite: `uv run pytest evals/redteam -v` with live sandbox checks enabled.

The eval and red-team jobs fail closed when credentials or live sandbox configuration are
absent. Emergency override is available only through manual workflow dispatch with
`override_release_blockers=true` and a non-empty `override_reason`; the reason is written to
the Actions step summary for audit.

---

## 3. Deploying

Staging deploys automatically on pushes to `main`:

```bash
git push origin main
```

Manual deploys choose `staging` or `prod` from **Actions → Deploy → Run workflow**. Prod waits
for GitHub Environment reviewers before protected jobs run.

The workflow deploys with Fly's `--strategy canary`, waits for health checks, and then verifies
`/healthz`. Services deploy one at a time in dependency order.

---

## 4. PLAN.md deviation: Fly canaries, not Argo Rollouts

PLAN.md §1 and P4-16 named Argo Rollouts. That is Kubernetes-specific and would force this
budget PaaS deployment onto a cluster before the platform needs one. ADR-0020 records the
accepted deviation: Fly canary/rolling deploys now, Argo Rollouts only if Loop-it moves to
Kubernetes.

---

## 5. Rollback

One-click rollback is **Actions → Rollback → Run workflow**. Choose environment, service, and a
target release/image.

One-command equivalent:

```bash
fly deploy -c infra/fly/fly.api.toml -a "$FLY_API_APP" \
  --image "ghcr.io/OWNER/REPO/api:<previous-sha>" --strategy immediate
```

Find candidates with:

```bash
fly releases -a "$FLY_API_APP"
```

If the bad rollout included a migration, roll code back only after confirming the migration is
additive. Store migrations are forward-only; prefer a hotfix over destructive schema changes.

---

## 6. Post-deploy checks

1. Check Actions summary for release-blocker status and any override entry.
2. Run `fly checks list -a <app>` for each service.
3. Curl public health URLs for `web`, `api`, and `preview-proxy`.
4. Check Grafana golden signals and audit mirror alerts from `infra/runbooks/observability.md`.
