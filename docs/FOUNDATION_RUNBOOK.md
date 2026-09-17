# Foundation development and release runbook

Run commands from `backend/`. Node 22 is the container/CI baseline.

## Local unit validation

```sh
npm ci --no-audit --no-fund
npm run generate
npm run build
npm test
```

Prisma generation does not apply schema changes. Unit tests clear DATABASE_URL
and ADMIN_INVITE_CODE. Integration tests use a separate explicit configuration.

## Disposable PostgreSQL integration validation (PowerShell)

Start only the dedicated local container below. Never substitute a staging or
production connection string. The password is a disposable local test fixture.

```powershell
docker run --detach --rm --name loop-gpt-foundation-db --label loop-gpt.purpose=foundation-tests -e POSTGRES_USER=loop_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=loop_foundation_test -p 127.0.0.1:55439:5432 postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685
docker exec loop-gpt-foundation-db pg_isready -U loop_test -d loop_foundation_test
$env:DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:55439/loop_foundation_test'
$env:TEST_DATABASE_URL=$env:DATABASE_URL
npm run migrate:deploy
npm run migrate:deploy
npx --no-install prisma migrate diff --from-url $env:TEST_DATABASE_URL --to-schema-datamodel prisma/schema.prisma --exit-code
npm run test:integration
docker stop loop-gpt-foundation-db
```

Wait until pg_isready reports accepting connections before migrating. If the
named container already exists, inspect ownership rather than deleting it. The
tests clean up only their randomly prefixed fixture records. Stop the dedicated
container after validation, including after a test failure. --rm removes its
container filesystem and anonymous test storage; no production volume is mounted.

## Database release contract

Application startup never applies migrations. A release job must run
`npm run migrate:deploy` successfully before starting the new application version.
Generate/review future migrations in an isolated development database, commit
them, and test upgrade/rollback procedures in staging. Do not use db push in a
production release or discard failed migration exit codes.

The initial migration is for a fresh database. Existing databases created by
the old db-push flow require a backup, schema reconciliation, and an explicit
Prisma baseline procedure before deployment. Do not automatically mark this
migration applied or run reset against an existing database.

## Startup requirements

For NODE_ENV=production:
- DATABASE_URL: non-placeholder PostgreSQL URL.
- JWT_SECRET: non-default random secret, at least 32 characters.
- FRONTEND_URL: explicit comma-separated HTTPS origins, no paths or credentials.
- ENABLE_DEV_MODE: absent or false.

Validation failures terminate startup before provider/job initialization.
Dependency reachability/readiness and the remaining permissive route-level
fallbacks still require additional hardening; configuration validation alone does
not establish application health.

## Token rollout note

New verification/reset tokens are stored as SHA-256 digests. Previously issued
plaintext tokens are not accepted by the new reader; request fresh links after
deployment. This is intentional credential invalidation, not a schema migration.
Password reset/session invalidation as a complete HTTP workflow remains to be
verified separately.

## External operations

No deployment, processor setup, provider account purchase, signing-key creation,
credential revocation, or store submission is performed by these local checks.
