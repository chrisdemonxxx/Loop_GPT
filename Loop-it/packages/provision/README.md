# loopit-provision managed backend

`loopit_provision` owns the managed backend that generated apps run against. The
agent still describes only tables; this package creates the project boundary and
uses the structural RLS emitter/verifier so invariant I9 is measured from the
database catalog after every provision.

## What is provisioned

- A deterministic per-project Postgres schema (`p_<hash>`) on a shared
  Neon/Supabase-compatible database.
- A per-project app login role that inherits `app_user`, has `USAGE` only on its
  own schema, and receives no admin privileges.
- Generated table migrations from `emit_migration(...)`, scoped to the project
  schema. Migrations are checksummed in `<schema>.schema_migrations`, skipped on
  idempotent retry, and rejected if the same id drifts.
- A post-provision RLS verifier backed by `pg_class.relrowsecurity`,
  `pg_class.relforcerowsecurity`, and `pg_policies`. Provisioning fails unless
  every generated table has RLS enabled, forced, and at least one policy.
- Optional seed SQL with bound values.
- JWT issuance helpers compatible with `stack-templates/react-postgres`: HS256
  bearer tokens with `sub` and optional `org_id` claims. The template sets
  `request.jwt.claims` in the same transaction so RLS policies enforce identity.
- S3-compatible bucket/prefix isolation for generated app objects. Use Cloudflare
  R2 or Tigris in production; tests use `InMemoryStorageProvisioner`.
- Generated database/JWT/storage credentials are registered in
  `loopit_secrets` and issued only as short-lived leases. They are never written
  into generated client code or rendered in provision outputs.

## Operator setup

Required environment:

```text
LOOPIT_PROVISION_POSTGRES_DSN=postgres://admin:...@.../postgres
LOOPIT_STORE_DSN=postgres://control-plane-store:...@.../loopit
LOOPIT_STORAGE_ENDPOINT=https://<account>.r2.cloudflarestorage.com
LOOPIT_STORAGE_BUCKET=loopit-generated-apps
LOOPIT_STORAGE_REGION=auto
```

`LOOPIT_PROVISION_POSTGRES_DSN` must be a control-plane/admin DSN capable of
creating schemas and roles on the shared Postgres instance. Generated apps
receive only project-scoped runtime leases for `GENERATED_DATABASE_URL`,
`GENERATED_JWT_SECRET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`.

`LOOPIT_SECRETS_ROOT_KEY` and `LOOPIT_SECRETS_ROOT_KEY_ID` are optional
Postgres-backed secret-store settings. Set them only when a running service
instantiates the persistent `loopit_secrets` store; the current compose/Fly
services do not wire that encrypted store yet.

For local/live smoke tests set:

```text
LOOPIT_TEST_DSN=postgres://admin:...@localhost/postgres
```

When `LOOPIT_TEST_DSN` is unset, live Postgres tests skip cleanly; fake
provisioner tests still cover isolation, rollback, retry, RLS verification,
JWT claim propagation, storage prefix isolation, and secret redaction.
