# loopit-store

`packages/store` is the additive control-plane persistence layer for the current
in-memory API, router, scheduler, quota, checkpoint, audit, lease, and secrets
state. It provides typed repository protocols, fast in-memory implementations
for tests/local development, and sync psycopg-backed Postgres implementations.

## Schema

The initial migration creates:

- `tenants`, `orgs`, `users`, and `projects`
- `runs` with explicit I12 budget columns, progress, cost, and lifecycle timestamps
- `run_events` for run-local telemetry
- `checkpoints` as an immutable parent tree keyed by content-addressed checkpoint IDs
- `checkpoint_pins` for live run retention
- `sandbox_leases` with TTL, caps, tools, and lifecycle status
- `quota_ledger` as the append-only billing source of truth
- `audit_log`, partitioned by `occurred_at`, hash-chained with `prev_row_hash`/`row_hash`
- `secrets` with opaque `encrypted_blob bytea` plus key/metadata columns

`audit_log` is append-only at both layers: the SQL migration revokes update/delete
and installs triggers that raise on mutation, while `AuditStore` exposes only
append/read/verify methods.

## Running migrations

```bash
uv sync --dev
uv run python -m loopit_store.migrate --dsn postgresql://user:pass@host:5432/loopit
```

Each numbered SQL file in `packages/store/src/loopit_store/migrations` is applied transactionally
and recorded in `schema_migrations`.

Set `LOOPIT_AUDIT_ROLE_PASSWORD` while running migrations to create or rotate the
least-privilege `loopit_audit_writer` role used by edge services. Its DSN belongs
in `LOOPIT_AUDIT_DSN`; it is granted audit append privileges and execute on the
hash-chain helper only, not the full control-plane schema privileges.

## Adoption path

Follow-up wiring can replace process-local dictionaries incrementally:

1. Keep using the in-memory store bundle for unit tests and local demos.
2. Inject `RunStore`/`ProjectStore` into `apps/api` (`create_app` + `loopit_api.persist`)
   so started/finished runs are the catalog source of truth. Live SSE still uses
   `RunManager`.
3. Inject `QuotaStore` behind `router-svc` ledger settlement so `quota_ledger`
   becomes the billing source of truth.
4. Inject `AuditStore` wherever `AuditSink.emit` is used; append stores the
   redacted event payload and verifies hash-chain continuity.
5. Inject `LeaseStore` in `services/scheduler` and `CheckpointStore` around
   checkpoint pin/current-tree operations.

This package intentionally does not modify `apps/*` or `services/*`; those
adapters are follow-up work.
