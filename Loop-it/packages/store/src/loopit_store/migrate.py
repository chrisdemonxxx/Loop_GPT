"""Tiny transactional migration runner for loopit_store."""

from __future__ import annotations

import argparse
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
from loopit_agent_core.config import SecretConfigurationError, require_secret
from psycopg import Connection

#: Dedicated schema on the shared Loop-GPT Postgres. Prisma keeps `public`.
LOOPIT_SCHEMA = "loopit"

_COMMENT_BLOCK = re.compile(r"/\*.*?\*/", re.DOTALL)
_COMMENT_LINE = re.compile(r"--[^\n]*")
_SEARCH_PATH = re.compile(
    r"\bsearch_path\s*(?:=|TO)\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)",
    re.IGNORECASE,
)
_ON_SCHEMA = re.compile(r"\bON\s+SCHEMA\s+([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE)
_PUBLIC_QUALIFIER = re.compile(r"\bpublic\s*\.", re.IGNORECASE)
_EXPLICIT_SCHEMA = re.compile(
    r"\b(?:TABLE|INTO|UPDATE|FROM|JOIN|SCHEMA|SEQUENCE|FUNCTION)\s+"
    r"([A-Za-z_][A-Za-z0-9_]*)\s*\.",
    re.IGNORECASE,
)
_ALLOWED_EXPLICIT_SCHEMAS = frozenset({LOOPIT_SCHEMA, "pg_catalog", "information_schema"})


class SchemaEscapeError(RuntimeError):
    """A migration tried to read or write a relation outside the loopit schema."""


@dataclass(frozen=True, slots=True)
class Migration:
    version: str
    path: Path
    sql: str


def load_migrations() -> tuple[Migration, ...]:
    # Migrations ship inside the package so the installed wheel carries them;
    # a repo-relative path breaks the moment the package is installed into a
    # venv (site-packages has no packages/store/migrations).
    root = Path(__file__).resolve().parent / "migrations"
    migrations: list[Migration] = []
    for item in sorted(root.iterdir(), key=lambda p: p.name):
        if not item.name.endswith(".sql"):
            continue
        version = item.name.split("_", 1)[0]
        migrations.append(Migration(version=version, path=Path(str(item)), sql=item.read_text()))
    return tuple(migrations)


def ensure_schema_migrations(conn: Connection[Any]) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )


def applied_versions(conn: Connection[Any]) -> set[str]:
    ensure_schema_migrations(conn)
    rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
    return {str(row[0]) for row in rows}


def pin_loopit_schema(conn: Connection[Any], *, create: bool = False) -> None:
    """Force the session onto the loopit schema.

    ``create`` is only for the migration role. Runtime connections set the
    search path and do not need permission to create schemas.
    """

    if create:
        conn.execute("CREATE SCHEMA IF NOT EXISTS loopit")
    conn.execute("SET search_path TO loopit")


def assert_sql_confined_to_loopit_schema(sql: str) -> None:
    """Reject SQL that names a schema other than loopit (catalogs excepted)."""

    stripped = _COMMENT_LINE.sub(" ", _COMMENT_BLOCK.sub(" ", sql))
    if _PUBLIC_QUALIFIER.search(stripped):
        raise SchemaEscapeError("migration SQL qualifies a relation in schema public")
    for match in _ON_SCHEMA.finditer(stripped):
        name = match.group(1).lower()
        if name != LOOPIT_SCHEMA:
            raise SchemaEscapeError(f"migration SQL targets schema {name!r}, not {LOOPIT_SCHEMA!r}")
    for match in _SEARCH_PATH.finditer(stripped):
        parts = [part.strip().lower() for part in match.group(1).split(",")]
        if parts != [LOOPIT_SCHEMA]:
            raise SchemaEscapeError(
                f"migration SQL sets search_path to {match.group(1)!r}, not {LOOPIT_SCHEMA!r}"
            )
    for match in _EXPLICIT_SCHEMA.finditer(stripped):
        name = match.group(1).lower()
        if name not in _ALLOWED_EXPLICIT_SCHEMAS:
            raise SchemaEscapeError(
                f"migration SQL qualifies {name!r}; only {LOOPIT_SCHEMA!r} is allowed"
            )


def _objects_outside_loopit(conn: Connection[Any]) -> set[tuple[str, str, str]]:
    """Relations and routines that live outside loopit and the system catalogs."""

    rows = conn.execute(
        """
        SELECT n.nspname, c.relname, 'relation'
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname <> 'loopit'
          AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND n.nspname NOT LIKE 'pg_temp%%'
          AND n.nspname NOT LIKE 'pg_toast_temp%%'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        UNION ALL
        SELECT n.nspname, p.proname, 'routine'
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname <> 'loopit'
          AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND n.nspname NOT LIKE 'pg_temp%%'
          AND n.nspname NOT LIKE 'pg_toast_temp%%'
        """
    ).fetchall()
    return {(str(row[0]), str(row[1]), str(row[2])) for row in rows}


def _assert_search_path(conn: Connection[Any]) -> None:
    row = conn.execute("SHOW search_path").fetchone()
    current = "" if row is None else str(row[0])
    parts = [part.strip().strip('"') for part in current.split(",")]
    if parts != [LOOPIT_SCHEMA]:
        raise SchemaEscapeError(f"search_path drifted to {current!r}")


def migrate(dsn: str) -> tuple[str, ...]:
    """Apply pending migrations into the loopit schema and return applied versions.

    Unqualified names follow ``search_path``. The runner pins that path to
    ``loopit`` and aborts if a migration creates a relation or routine anywhere
    else, or if its SQL names another schema.
    """

    applied: list[str] = []
    with psycopg.connect(dsn) as conn:
        pin_loopit_schema(conn, create=True)
        _configure_optional_audit_role_password(conn)
        before = _objects_outside_loopit(conn)
        done = applied_versions(conn)
        for migration in load_migrations():
            if migration.version in done:
                continue
            assert_sql_confined_to_loopit_schema(migration.sql)
            with conn.transaction():
                conn.execute(migration.sql)
                conn.execute(
                    "INSERT INTO schema_migrations (version) VALUES (%s)",
                    (migration.version,),
                )
                _assert_search_path(conn)
                escaped = _objects_outside_loopit(conn) - before
                if escaped:
                    sample = ", ".join(
                        f"{kind} {schema}.{name}" for schema, name, kind in sorted(escaped)[:8]
                    )
                    raise SchemaEscapeError(
                        f"migration {migration.version} touched objects outside "
                        f"{LOOPIT_SCHEMA}: {sample}"
                    )
            applied.append(migration.version)
    return tuple(applied)


def _configure_optional_audit_role_password(conn: Connection[Any]) -> None:
    try:
        password = require_secret(os.environ, "LOOPIT_AUDIT_ROLE_PASSWORD", min_length=16)
    except SecretConfigurationError:
        return
    conn.execute("SELECT set_config('loopit.audit_role_password', %s, false)", (password,))


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply loopit_store Postgres migrations.")
    parser.add_argument("--dsn", required=True, help="Postgres connection string")
    args = parser.parse_args()
    applied = migrate(args.dsn)
    if applied:
        print("applied migrations: " + ", ".join(applied))
    else:
        print("no pending migrations")


if __name__ == "__main__":
    main()
