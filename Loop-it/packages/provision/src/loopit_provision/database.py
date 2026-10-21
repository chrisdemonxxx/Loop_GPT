"""Managed Postgres provisioning for generated apps.

The schema emitter is still the only component that writes RLS DDL. This module
owns the operational side: a per-project schema, a per-project login role, a
transactional migration journal, seed execution, and a catalog verifier that
turns invariant I9 into a live database check.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Protocol

from .identifiers import validate_identifier
from .rls import APP_ROLE, RlsError
from .schema import TableSpec, emit_migration


class ProvisioningError(RuntimeError):
    """Provisioning failed before a generated app credential could be issued."""


class MigrationConflict(ProvisioningError):
    """A migration id was already applied with different SQL."""


@dataclass(frozen=True, slots=True)
class ProjectDatabaseNames:
    """Safe Postgres identifiers derived from tenant/project ids."""

    schema: str
    owner_role: str
    app_role: str
    migration_role: str


@dataclass(frozen=True, slots=True)
class Migration:
    """One generated migration to apply to the project's schema."""

    migration_id: str
    sql: str

    @property
    def checksum(self) -> str:
        return hashlib.sha256(self.sql.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class SeedData:
    """Seed SQL executed after migrations with bound parameters only."""

    statement: str
    values: tuple[object, ...] = ()


@dataclass(frozen=True, slots=True)
class DatabaseProvisionRequest:
    """Everything needed to create/update one generated app database schema."""

    tenant_id: str
    project_id: str
    tables: tuple[TableSpec, ...]
    migrations: tuple[Migration, ...] = ()
    seed_data: tuple[SeedData, ...] = ()
    app_password: str | None = None
    #: ``dev`` (preview/agent) or ``prod`` (first publish). Separate schemas so
    #: publish never reuses the developer's scratch data (Phase 2.7).
    environment: str = "dev"


@dataclass(frozen=True, slots=True)
class ProvisionedDatabase:
    """Non-secret metadata for a generated app database."""

    tenant_id: str
    project_id: str
    names: ProjectDatabaseNames
    applied_migrations: tuple[str, ...]
    verified_tables: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class RlsVerificationResult:
    """Live catalog measurement of whether every generated table is protected."""

    tables: tuple[str, ...]
    unprotected: tuple[str, ...]

    @property
    def percentage(self) -> float | None:
        if not self.tables:
            return None
        return 100.0 * (len(self.tables) - len(self.unprotected)) / len(self.tables)

    def require_full_coverage(self) -> None:
        if not self.tables:
            raise RlsError("post-provision RLS verification measured no generated tables")
        if self.unprotected:
            raise RlsError(
                "post-provision RLS verification failed for table(s): "
                + ", ".join(self.unprotected)
            )


class RlsCatalogVerifier(Protocol):
    """Checks the database catalog, not emitted SQL, after provisioning."""

    def verify_schema(self, schema: str) -> RlsVerificationResult: ...


class DatabaseProvisioner(Protocol):
    """Creates isolated generated-app database schemas and applies migrations."""

    def provision(self, request: DatabaseProvisionRequest) -> ProvisionedDatabase: ...


def project_database_names(
    tenant_id: str, project_id: str, *, environment: str = "dev"
) -> ProjectDatabaseNames:
    """Derive collision-resistant, valid identifiers from external ids.

    ``environment="dev"`` keeps the historic ``tenant:project`` digest so
    existing Phase 1.9 schemas stay reachable. ``prod`` (and any other label)
    mixes the environment into the hash so publish gets an isolated database.
    """

    env = (environment or "dev").strip().lower() or "dev"
    if env == "dev":
        material = f"{tenant_id}:{project_id}"
    else:
        material = f"{tenant_id}:{project_id}:{env}"
    digest = hashlib.sha256(material.encode()).hexdigest()[:24]
    return ProjectDatabaseNames(
        schema=validate_identifier(f"p_{digest}", kind="schema"),
        owner_role=validate_identifier(f"p_{digest}_owner", kind="role"),
        app_role=validate_identifier(f"p_{digest}_app", kind="role"),
        migration_role=validate_identifier(f"p_{digest}_migrator", kind="role"),
    )


def scoped_tables(tables: Sequence[TableSpec], schema: str) -> tuple[TableSpec, ...]:
    """Copy agent table specs into the project schema."""

    validate_identifier(schema, kind="schema")
    return tuple(replace(table, schema=schema) for table in tables)


def generated_table_migration(
    migration_id: str,
    tables: Sequence[TableSpec],
    *,
    schema: str,
) -> Migration:
    """Emit the structural RLS migration for project-scoped tables."""

    return Migration(migration_id=migration_id, sql=emit_migration(scoped_tables(tables, schema)))


class PgCatalogRlsVerifier:
    """RLS verifier backed by ``pg_class`` and ``pg_policies``."""

    def __init__(self, conn: Any) -> None:
        self._conn = conn

    def verify_schema(self, schema: str) -> RlsVerificationResult:
        validate_identifier(schema, kind="schema")
        rows = self._conn.execute(
            """
            SELECT c.relname,
                   c.relrowsecurity,
                   c.relforcerowsecurity,
                   EXISTS (
                       SELECT 1
                       FROM pg_policies p
                       WHERE p.schemaname = n.nspname
                         AND p.tablename = c.relname
                   ) AS has_policy
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = %s
              AND c.relkind IN ('r', 'p')
            ORDER BY c.relname
            """,
            (schema,),
        ).fetchall()
        tables: list[str] = []
        unprotected: list[str] = []
        for row in rows:
            name = str(row["relname"] if isinstance(row, Mapping) else row[0])
            relrowsecurity = bool(row["relrowsecurity"] if isinstance(row, Mapping) else row[1])
            relforcerowsecurity = bool(
                row["relforcerowsecurity"] if isinstance(row, Mapping) else row[2]
            )
            has_policy = bool(row["has_policy"] if isinstance(row, Mapping) else row[3])
            tables.append(name)
            if not (relrowsecurity and relforcerowsecurity and has_policy):
                unprotected.append(name)
        return RlsVerificationResult(tables=tuple(tables), unprotected=tuple(unprotected))


class PsycopgDatabaseProvisioner:
    """Real provisioner for a shared Postgres instance (Neon/Supabase/RDS)."""

    def __init__(self, admin_dsn: str) -> None:
        self._admin_dsn = admin_dsn

    def provision(self, request: DatabaseProvisionRequest) -> ProvisionedDatabase:
        import psycopg
        from psycopg import sql
        from psycopg.rows import dict_row

        names = project_database_names(
            request.tenant_id, request.project_id, environment=request.environment
        )
        migrations = self._migrations_for(request, names.schema)
        applied: list[str] = []

        with psycopg.connect(self._admin_dsn, row_factory=dict_row) as conn:
            self._ensure_project_boundary(conn, names, app_password=request.app_password)
            for migration in migrations:
                if self._migration_already_applied(conn, names.schema, migration):
                    continue
                try:
                    conn.execute(migration.sql)
                    conn.execute(
                        sql.SQL(
                            """
                            INSERT INTO {}.schema_migrations (migration_id, checksum)
                            VALUES (%s, %s)
                            ON CONFLICT (migration_id) DO NOTHING
                            """
                        ).format(sql.Identifier(names.schema)),
                        (migration.migration_id, migration.checksum),
                    )
                    applied.append(migration.migration_id)
                except Exception:
                    conn.rollback()
                    raise
            for seed in request.seed_data:
                conn.execute(seed.statement, seed.values)
            verifier = PgCatalogRlsVerifier(conn)
            verification = verifier.verify_schema(names.schema)
            verification.require_full_coverage()
            conn.commit()

        return ProvisionedDatabase(
            tenant_id=request.tenant_id,
            project_id=request.project_id,
            names=names,
            applied_migrations=tuple(applied),
            verified_tables=verification.tables,
        )

    def _ensure_project_boundary(
        self,
        conn: Any,
        names: ProjectDatabaseNames,
        *,
        app_password: str | None,
    ) -> None:
        from psycopg import sql

        for role in (APP_ROLE, names.owner_role, names.migration_role):
            conn.execute(
                sql.SQL(
                    "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = {role_lit}) "
                    "THEN CREATE ROLE {role_ident} NOLOGIN; END IF; END $$;"
                ).format(role_lit=sql.Literal(role), role_ident=sql.Identifier(role))
            )
        conn.execute(
            sql.SQL(
                "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = {role_lit}) "
                "THEN CREATE ROLE {role_ident} LOGIN PASSWORD {password}; END IF; END $$;"
            ).format(
                role_lit=sql.Literal(names.app_role),
                role_ident=sql.Identifier(names.app_role),
                password=sql.Literal(
                    app_password or hashlib.sha256(names.app_role.encode()).hexdigest()
                ),
            )
        )
        conn.execute(
            sql.SQL("GRANT {} TO {}").format(
                sql.Identifier(APP_ROLE), sql.Identifier(names.app_role)
            )
        )
        conn.execute("CREATE SCHEMA IF NOT EXISTS auth")
        conn.execute(
            """
            CREATE OR REPLACE FUNCTION auth.uid()
                RETURNS uuid
                LANGUAGE sql
                STABLE
                SET search_path = pg_catalog
            AS $$
                SELECT nullif(
                    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
                    ''
                )::uuid;
            $$;
            """
        )
        conn.execute(
            sql.SQL("GRANT USAGE ON SCHEMA auth TO {}, {}").format(
                sql.Identifier(APP_ROLE), sql.Identifier(names.app_role)
            )
        )
        conn.execute(
            sql.SQL("GRANT EXECUTE ON FUNCTION auth.uid() TO {}, {}").format(
                sql.Identifier(APP_ROLE), sql.Identifier(names.app_role)
            )
        )
        conn.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(sql.Identifier(names.schema)))
        conn.execute(
            sql.SQL("ALTER SCHEMA {} OWNER TO {}").format(
                sql.Identifier(names.schema), sql.Identifier(names.owner_role)
            )
        )
        conn.execute(
            sql.SQL("REVOKE ALL ON SCHEMA {} FROM PUBLIC").format(sql.Identifier(names.schema))
        )
        conn.execute(
            sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(
                sql.Identifier(names.schema), sql.Identifier(names.app_role)
            )
        )
        conn.execute(
            sql.SQL(
                "CREATE TABLE IF NOT EXISTS {}.schema_migrations ("
                "migration_id text PRIMARY KEY, checksum text NOT NULL, "
                "applied_at timestamptz NOT NULL DEFAULT now())"
            ).format(sql.Identifier(names.schema))
        )

    def _migration_already_applied(self, conn: Any, schema: str, migration: Migration) -> bool:
        from psycopg import sql

        row = conn.execute(
            sql.SQL("SELECT checksum FROM {}.schema_migrations WHERE migration_id = %s").format(
                sql.Identifier(schema)
            ),
            (migration.migration_id,),
        ).fetchone()
        if row is None:
            return False
        checksum = str(row["checksum"] if isinstance(row, Mapping) else row[0])
        if checksum != migration.checksum:
            message = (
                f"migration {migration.migration_id!r} was already applied "
                "with a different checksum"
            )
            raise MigrationConflict(message)
        return True

    def _migrations_for(
        self, request: DatabaseProvisionRequest, schema: str
    ) -> tuple[Migration, ...]:
        migrations = list(request.migrations)
        if request.tables:
            migrations.insert(
                0, generated_table_migration("0001_generated_tables", request.tables, schema=schema)
            )
        return tuple(migrations)


@dataclass(slots=True)
class _FakeTable:
    rls_enabled: bool = False
    rls_forced: bool = False
    policies: set[str] = field(default_factory=set)


class InMemoryDatabaseProvisioner:
    """A strict fake that models schema isolation, rollback, retry, and RLS checks."""

    def __init__(self) -> None:
        self.schemas: dict[str, dict[str, _FakeTable]] = {}
        self.roles: dict[str, str] = {}
        self.migrations: dict[str, dict[str, str]] = {}
        self.seeded: list[SeedData] = []

    def provision(self, request: DatabaseProvisionRequest) -> ProvisionedDatabase:
        names = project_database_names(
            request.tenant_id, request.project_id, environment=request.environment
        )
        self.roles[names.app_role] = names.schema
        self.schemas.setdefault(names.schema, {})
        self.migrations.setdefault(names.schema, {})

        applied: list[str] = []
        migrations = list(request.migrations)
        if request.tables:
            migrations.insert(
                0,
                generated_table_migration(
                    "0001_generated_tables",
                    request.tables,
                    schema=names.schema,
                ),
            )
        for migration in migrations:
            recorded = self.migrations[names.schema].get(migration.migration_id)
            if recorded is not None:
                if recorded != migration.checksum:
                    message = (
                        f"migration {migration.migration_id!r} was already applied "
                        "with a different checksum"
                    )
                    raise MigrationConflict(message)
                continue
            before = self._snapshot(names.schema)
            try:
                self._apply_sql(names.schema, migration.sql)
            except Exception:
                self.schemas[names.schema] = before
                raise
            self.migrations[names.schema][migration.migration_id] = migration.checksum
            applied.append(migration.migration_id)

        self.seeded.extend(request.seed_data)
        verification = self.verify_schema(names.schema)
        verification.require_full_coverage()
        return ProvisionedDatabase(
            tenant_id=request.tenant_id,
            project_id=request.project_id,
            names=names,
            applied_migrations=tuple(applied),
            verified_tables=verification.tables,
        )

    def verify_schema(self, schema: str) -> RlsVerificationResult:
        tables = tuple(sorted(self.schemas.get(schema, {})))
        unprotected = tuple(
            table
            for table in tables
            if not self.schemas[schema][table].rls_enabled
            or not self.schemas[schema][table].rls_forced
            or not self.schemas[schema][table].policies
        )
        return RlsVerificationResult(tables=tables, unprotected=unprotected)

    def assert_role_can_only_access_schema(self, role: str, schema: str) -> None:
        allowed = self.roles.get(role)
        if allowed != schema:
            raise PermissionError(f"role {role!r} cannot access schema {schema!r}")

    def inject_unprotected_table(self, schema: str, table: str) -> None:
        self.schemas.setdefault(schema, {})[table] = _FakeTable()

    def _snapshot(self, schema: str) -> dict[str, _FakeTable]:
        return {
            table: _FakeTable(
                rls_enabled=state.rls_enabled,
                rls_forced=state.rls_forced,
                policies=set(state.policies),
            )
            for table, state in self.schemas[schema].items()
        }

    def _apply_sql(self, schema: str, sql: str) -> None:
        statements = [statement.strip() for statement in sql.split(";") if statement.strip()]
        for statement in statements:
            if "RAISE_MIGRATION_FAILURE" in statement:
                raise ProvisioningError("fake migration failure requested")
            lowered = statement.lower()
            table = self._extract_table(statement)
            if table is None:
                continue
            current = self.schemas.setdefault(schema, {}).setdefault(table, _FakeTable())
            if lowered.startswith("alter table") and "enable row level security" in lowered:
                current.rls_enabled = True
            elif lowered.startswith("alter table") and "force row level security" in lowered:
                current.rls_forced = True
            elif lowered.startswith("create policy"):
                current.policies.add(statement)

    def _extract_table(self, statement: str) -> str | None:
        import re

        lowered = statement.lower()
        if lowered.startswith("create policy"):
            pattern = r'\bon\s+"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?'
        elif lowered.startswith("create table"):
            pattern = (
                r'create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?'
                r'\."?([a-z_][a-z0-9_]*)"?'
            )
        elif lowered.startswith("alter table"):
            pattern = r'alter\s+table\s+"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?'
        else:
            return None
        match = re.search(pattern, statement, re.IGNORECASE)
        if match is None:
            return None
        return match.group(2)


__all__ = [
    "DatabaseProvisionRequest",
    "DatabaseProvisioner",
    "InMemoryDatabaseProvisioner",
    "Migration",
    "MigrationConflict",
    "PgCatalogRlsVerifier",
    "ProjectDatabaseNames",
    "ProvisionedDatabase",
    "ProvisioningError",
    "PsycopgDatabaseProvisioner",
    "RlsCatalogVerifier",
    "RlsVerificationResult",
    "SeedData",
    "generated_table_migration",
    "project_database_names",
    "scoped_tables",
]
