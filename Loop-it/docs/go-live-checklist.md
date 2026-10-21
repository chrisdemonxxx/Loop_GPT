# Go-live checklist

Run these steps in order. Do not skip a failed security, quota, backup, or gate check.

## 1. Credential inventory

- Production domain and DNS provider access.
- TLS certificate automation account or load-balancer certificate access.
- `DATABASE_URL` and backup/restore credentials for Postgres 16.
- `LOOPIT_AUDIT_DSN` for the insert-only `loopit_audit_writer` edge role; do not reuse
  `DATABASE_URL`/`LOOPIT_STORE_DSN` for preview or egress audit writes.
- Object storage endpoint, bucket, access key, secret key, region, and retention/WORM settings.
- Vault address/token or encrypted secret-store credentials.
- `LOOPIT_IDENTITY_SECRET`, `LOOPIT_IDENTITY_KID`, issuer, and audience for customer tokens.
- Separate `LOOPIT_OPERATOR_IDENTITY_SECRET`, `LOOPIT_OPERATOR_IDENTITY_KID`, issuer, and audience for
  platform operator actions.
- Model router upstream base URL and server-side model provider tokens such as `HF_TOKEN`.
- Sandbox provider credentials for Docker/E2B/live microVM provider plus network-policy configuration.
- Stripe API key, webhook secret, price IDs for `free`, `pro`, and `team` where applicable.
- Fly/deploy provider token, organization/app names, and rollback credentials.
- VPS slice capacity for `services/deployer`: slice-agent HTTPS API endpoint and credential,
  container runtime with non-privileged per-tenant isolated networks, metadata-endpoint
  egress drops, and image registry pull access.
- Apps base domain (separate from the platform domain), wildcard DNS + wildcard TLS cert,
  and scoped DNS-provider API token (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).
- Registrar account and credential, if domain purchasing is enabled.
- `LOOPIT_SERVICE_TOKEN` for service-to-service auth (app-proxy and deployer call the
  domains service with it; workspace-dispatch authenticates to the scheduler with it).
- `LOOPIT_LEASE_TOKEN_SECRET` and `LOOPIT_SANDBOX_SIGNING_KEY` for lease-authorised tool
  dispatch into sandboxes.
- OIDC client IDs/secrets and callback URLs for production auth.
- Abuse-report, security, support, and billing inboxes.

## 2. Domain, DNS, and TLS

### 2.1 Platform hostnames

1. Point production DNS for web, API, preview, status, and `/.well-known/security.txt`.
2. Enable TLS and HSTS after certificate issuance succeeds.
3. Confirm no internal hostnames appear in public errors or HTML.

### 2.2 Customer app hosting (apps base domain)

Customer projects are served by `services/app-proxy` on hostnames allocated by
`services/domains`. This requires a **second, separate domain** from the platform domain.

1. Register an apps domain (for example `loopit.app`) and set `LOOPIT_APPS_BASE_DOMAIN`.
   Do **not** reuse the platform domain. Customer-controlled content on a platform
   subdomain shares the platform's cookie scope and reputation; a wildcard cert plus a
   cookie scoped to the parent domain is a cross-tenant session-theft vector, and a single
   abusive app can get the whole apex blocklisted.
2. Create a wildcard DNS record `*.LOOPIT_APPS_BASE_DOMAIN` pointing at the app-proxy
   ingress, and set `LOOPIT_APP_PROXY_DNS_TARGET` to that target.
3. Obtain a wildcard TLS certificate for `*.LOOPIT_APPS_BASE_DOMAIN`. TLS is terminated
   upstream of app-proxy by the ingress/CDN; compose exposes plain HTTP for local use only.
4. Add the apps domain to the [Public Suffix List](https://publicsuffix.org/submit/).
   This is what stops one customer app from setting cookies readable by another.
5. Set `LOOPIT_PLATFORM_HOSTNAMES` (reserved labels that must never be allocated) and
   `LOOPIT_SUBDOMAIN_BRAND_DENYLIST` (brands to refuse, to limit phishing on our domain).

### 2.3 DNS provider automation

1. Set `LOOPIT_DOMAINS_DNS_PROVIDER=cloudflare` (default `memory` is dev-only and
   performs no real DNS changes).
2. Provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the production
   secret store — never in compose, `.env`, or source control.
3. The token must be a **scoped** API token with `Zone:DNS:Edit` on the apps zone only.
   Do not use a Global API Key: it is account-wide, cannot be scoped, and cannot be
   revoked independently of the account.
4. Rotate the token immediately if it is ever pasted into a chat, ticket, or log.

### 2.4 Custom domains and registrar

1. Customer custom domains are verified by TXT ownership challenge before any traffic is
   served. Verify the verification path works end to end before enabling the feature.
2. Domain purchasing calls a real registrar and spends real money. Configure the registrar
   credential in the secret store, and confirm purchase idempotency keys are honoured
   before enabling it for customers — a retried purchase must never buy twice.
3. Confirm quota checks (`custom_domains`) refuse **before** any registrar call.

## 3. Secrets

1. Run `uv run python scripts/generate_secrets.py` for initial strong values.
2. Store secrets in the production secret store; do not add fallbacks or defaults.
3. Run `uv run python scripts/selfhost_preflight.py` and resolve every failure.
4. Confirm `LOOPIT_DEV_SINGLE_TENANT` and `LOOPIT_AUDIT_EPHEMERAL` are unset/`0`.
5. Document rotation owner, cadence, and emergency rotation command for each secret.

## 4. Database, migrations, and backups

1. Apply migrations against production.
   Set `LOOPIT_AUDIT_ROLE_PASSWORD` during migration so the least-privilege
   `loopit_audit_writer` role is created/rotated before edge services start.
2. Run `uv run python scripts/backup_control_plane.py --dsn <production-dsn>`.
3. Restore into a disposable database with `uv run python scripts/restore_control_plane.py`.
4. Verify audit hash-chain and checkpoint/object references after restore.

## 5. Validation and smoke tests

1. Run the full validation gate from the repository root.
2. Run `uv run python scripts/check_compose_services.py` to statically verify compose service
   dependencies, Python module entrypoints, and `/healthz` handlers before using Docker.
3. Run `uv run python packages/contracts/validate_schemas.py`.
4. Run `uv run python scripts/check_invariants.py`.
5. Run `uv run python scripts/smoke_model_endpoint.py --bill-to <org> --structured`.
6. Run `uv run python scripts/phase1_exit_gate.py --provider docker` or the configured E2B provider.

## 6. Canary and rollback

1. Deploy to staging and run T0-T3 evals plus red-team release blockers.
2. Start canary with one internal tenant, then one friendly customer tenant.
3. Watch p95 latency, error rate, credit spend, sandbox leases, egress denies, and abuse signals.
4. If any release blocker fails, pause canary and execute `.github/workflows/rollback.yml`.

## 7. Incident readiness

Use [`../infra/runbooks/incident-response.md`](../infra/runbooks/incident-response.md) for the canonical
incident process. On-call matrix:

| Severity | Response target | Lead | Escalation |
| --- | --- | --- | --- |
| SEV0 | 15 minutes | Incident lead + security owner | Founders, legal/comms, affected customers |
| SEV1 | 30 minutes | Platform on-call | Incident lead and customer comms |
| SEV2 | 2 hours | Service owner | Platform channel |
| SEV3 | Next business day | Triage owner | Ticket queue |

## 8. Final launch decision

Record what was verified in live infrastructure and what remains first-live-run risk. Do not claim uptime,
success rates, or reliability that have not been measured.
