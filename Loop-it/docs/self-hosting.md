# Self-hosting Loop-it

This document is the reproducible starting point for self-hosted and VPC Loop-it deployments.
Keep generated code in the data plane: containers that run sandbox workloads must not mount
control-plane secrets.

## Minimum stack

Use docker compose or equivalent orchestration for:

- Postgres 16 for control-plane state and audit partitions.
- Temporal server and workers for durable runs.
- Redis or NATS-compatible event fan-out.
- Router service pointed at an OpenAI-compatible model endpoint.
- Scheduler plus sandbox provider adapter (managed microVMs or self-hosted Firecracker hosts).
- Egress proxy with default-deny categories and metadata/link-local blocks.
- S3-compatible object storage for checkpoints, audit WORM mirrors, and generated app assets.

## Required environment

`LOOPIT_ENV`, `LOOPIT_PUBLIC_URL`, `LOOPIT_POSTGRES_DSN`, `LOOPIT_TEMPORAL_ADDRESS`, `LOOPIT_REDIS_URL`,
`LOOPIT_OBJECT_STORAGE_ENDPOINT`, `LOOPIT_OBJECT_STORAGE_BUCKET`,
`LOOPIT_MODEL_ENDPOINT`, and `LOOPIT_SANDBOX_PROVIDER` are required. Run:

```bash
uv run python scripts/selfhost_preflight.py --env-file .env
```

The preflight runs offline and exits non-zero until all required values are present.

For local compose development, generate a complete `.env` with strong random values:

```bash
uv run python scripts/generate_secrets.py
```

### Canonical secret inventory

Use one name everywhere; do not set legacy aliases such as `LOOPIT_IDENTITY_KEY`,
`LOOPIT_IDENTITY_TOKEN_SECRET`, or `SECRETS_MASTER_KEY`.

| Name                              | Minimum                  | Used by                         | Rotation guidance                                    |
| --------------------------------- | ------------------------ | ------------------------------- | ---------------------------------------------------- |
| `POSTGRES_PASSWORD`               | 16 characters            | Postgres and `DATABASE_URL`     | Rotate with a DB user password change and app roll.  |
| `LOOPIT_IDENTITY_SECRET`          | 32 characters            | API, router, billing, abuse     | Add a new `LOOPIT_IDENTITY_KID`, roll all services.  |
| `LOOPIT_OPERATOR_IDENTITY_SECRET` | 32 characters            | Operator token issuer/abuse     | Rotate operator issuer and verifiers together.       |
| `LOOPIT_PREVIEW_SIGNING_KEY`      | 32 characters            | API and preview proxy           | Roll API and preview proxy; old preview URLs expire. |
| `LOOPIT_AUDIT_DSN`                | Postgres DSN             | Preview and egress proxies      | Use distinct `loopit_audit_writer`; never reuse the control-plane DSN. |
| `LOOPIT_AUDIT_ROLE_PASSWORD`      | 16 characters            | Migration-time audit role setup | Rotate with `python -m loopit_store.migrate` and restart edge proxies. |
| `LOOPIT_LEASE_TOKEN_SECRET`       | 32 characters            | Scheduler and router            | Drain active leases, then roll scheduler/router.     |
| `LOOPIT_SERVICE_TOKEN`            | 32 characters            | Internal service-to-service auth | Roll consumers and services in one maintenance window. |
| `LOOPIT_MODEL_API_KEY`            | 32 characters            | Router upstream credential      | Rotate at the upstream provider, then roll router.   |
| `LOOPIT_SANDBOX_SIGNING_KEY`      | 32 characters            | Eval/runtime key derivation root | Drain active leases; derived per-lease keys expire with leases. |

Startup and `scripts/selfhost_preflight.py` fail closed when any required secret is
missing, too short, or placeholder-like.

## Temporal `start-dev` replacement path

The compose stack currently runs `temporalio/server` with `server start-dev`. That mode has no
Temporal-layer auth, no TLS, and uses local development storage, so it is acceptable only for the
single-host compose deployment where the published Temporal frontend port is bound to
`127.0.0.1:${TEMPORAL_PUBLISHED_PORT:-7233}:7233`. The loopback bind prevents out-of-host callers
from bypassing Loop-it's `run:approve` confirmation gate by connecting directly to Temporal and
signalling workflows such as `approve_gate`; only local operators and compose services on the
control-plane network can reach the frontend.

Before any multi-host deployment, including the Fly.io migration or any setup where workers,
operators, or Temporal run on different hosts, replace `start-dev` with a production Temporal
deployment:

1. Enable authenticated transport: either self-host Temporal with mTLS between clients, workers, and
   frontend, or use Temporal Cloud with API-key authentication.
2. Move workflow state to persistent DB-backed storage with backups and restore drills; do not rely
   on dev-mode local storage.
3. Enforce namespace authorization so only the orchestrator/worker identity can signal Loop-it
   workflow namespaces and operator identities cannot directly complete approval gates outside the
   API's audited `run:approve` path.

**Trigger:** do this before changing the Temporal published port away from `127.0.0.1`, before
placing any Temporal client/worker on a different host than the compose stack, or before cutting the
first Fly.io/multi-host environment. The loopback binding must remain in place until the production
Temporal auth, storage, and namespace-authorization controls above are verified.

The edge proxies must write I10 audit decisions through `LOOPIT_AUDIT_DSN`.
`python -m loopit_store.migrate` creates/updates a `loopit_audit_writer` role
when `LOOPIT_AUDIT_ROLE_PASSWORD` is set. That role receives only audit append
privileges plus execute on the hash-chain helper function; it does not receive
the full control-plane DSN. `LOOPIT_AUDIT_EPHEMERAL=1` is reserved for local
development/tests and makes audit records process-local and volatile.

`LOOPIT_ABUSE_DRY_RUN` defaults to `0` (enforcement enabled). Set it to `1` only
for drills or audits in non-production environments; production preflight exits
non-zero when dry-run is enabled because T0-T3 automated abuse responses would
otherwise be advisory only.

`LOOPIT_DEV_SINGLE_TENANT=1` is a developer-only authentication bypass. It must
remain unset/`0` for production; preflight exits non-zero when it is enabled with
an unset, blank, or non-development `LOOPIT_ENV` (anything other than `dev`,
`development`, or `local`), with a non-local control-plane DSN, or with a DSN
whose host cannot be determined.

## Resources

Start with 4 vCPU / 16 GiB RAM for control-plane services, a separate Postgres volume with backups,
and isolated sandbox capacity sized for expected concurrency. Production VPC deployments should run
sandbox hosts in private subnets with the egress proxy as the only outbound path.

## Air-gapped or VPC substitutions

Replace hosted model APIs with an internal OpenAI-compatible endpoint, managed sandbox providers with
self-hosted Firecracker capacity, and public object storage with in-VPC S3-compatible storage. Mirror
package registries needed by the sandbox image and keep the egress allowlist default-deny.

## Upgrades

Back up Postgres and object storage manifests, run database migrations, roll control-plane services,
then recycle sandbox images. Never reuse an existing sandbox lease across an upgrade boundary.
