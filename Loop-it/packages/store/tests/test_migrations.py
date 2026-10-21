from __future__ import annotations

import os
import re
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any

import pytest
from loopit_agent_core.config import require_secret

MIGRATIONS = Path(__file__).resolve().parents[1] / "src" / "loopit_store" / "migrations"


def _migration_files() -> list[Path]:
    return sorted(MIGRATIONS.glob("*.sql"))


def test_shipped_migrations_stay_in_loopit_schema() -> None:
    from loopit_store.migrate import assert_sql_confined_to_loopit_schema

    for path in _migration_files():
        assert_sql_confined_to_loopit_schema(path.read_text(encoding="utf-8"))


def test_schema_guard_rejects_public_and_foreign_search_path() -> None:
    from loopit_store.migrate import SchemaEscapeError, assert_sql_confined_to_loopit_schema

    with pytest.raises(SchemaEscapeError):
        assert_sql_confined_to_loopit_schema("CREATE TABLE public.users (id int);")
    with pytest.raises(SchemaEscapeError):
        assert_sql_confined_to_loopit_schema("GRANT USAGE ON SCHEMA public TO loopit_audit_writer;")
    with pytest.raises(SchemaEscapeError):
        assert_sql_confined_to_loopit_schema("SET search_path = public")
    with pytest.raises(SchemaEscapeError):
        assert_sql_confined_to_loopit_schema("SET search_path = loopit, public")
    assert_sql_confined_to_loopit_schema("SET search_path = loopit")
    assert_sql_confined_to_loopit_schema("CREATE TABLE tenants (tenant_id text PRIMARY KEY);")


def test_migrations_are_numbered_and_ordered() -> None:
    files = _migration_files()
    assert files
    numbers = [path.name.split("_", 1)[0] for path in files]
    assert numbers == sorted(numbers)
    assert all(re.fullmatch(r"\d{3}", number) for number in numbers)
    assert len(set(numbers)) == len(numbers)


def test_migrations_leave_transaction_control_to_runner() -> None:
    for path in _migration_files():
        sql = path.read_text(encoding="utf-8")
        assert "BEGIN;" not in sql
        assert "COMMIT;" not in sql
        assert sql.count("(") == sql.count(")")
        assert "$$" not in sql.replace("$$", "", 2)


def test_every_table_declares_a_primary_key() -> None:
    sql = "\n".join(path.read_text(encoding="utf-8") for path in _migration_files())
    for match in re.finditer(r"CREATE TABLE(?: IF NOT EXISTS)? (\w+)\s*\((.*?)\);", sql, re.S):
        table, body = match.groups()
        assert "PRIMARY KEY" in body, f"{table} has no primary key"


def test_audit_log_is_append_only_in_sql() -> None:
    sql = "\n".join(path.read_text(encoding="utf-8") for path in _migration_files())
    assert "CREATE TRIGGER audit_log_no_update" in sql
    assert "CREATE TRIGGER audit_log_no_delete" in sql
    assert "RAISE EXCEPTION 'audit_log is append-only" in sql
    assert "REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC" in sql


def test_quota_ledger_entry_ids_are_tenant_scoped_in_sql() -> None:
    initial = (MIGRATIONS / "001_initial_control_plane.sql").read_text(encoding="utf-8")
    migration = (MIGRATIONS / "002_tenant_scope_quota_ledger_entry_id.sql").read_text(
        encoding="utf-8"
    )

    assert "PRIMARY KEY (tenant_id, entry_id)" in initial
    assert "current_pk_columns IS DISTINCT FROM ARRAY['tenant_id', 'entry_id']" in migration
    assert "ALTER TABLE quota_ledger ADD PRIMARY KEY (tenant_id, entry_id)" in migration


def test_audit_writer_role_is_least_privilege_in_sql() -> None:
    migration = (MIGRATIONS / "003_audit_writer_role.sql").read_text(encoding="utf-8")

    assert "CREATE ROLE loopit_audit_writer" in migration
    assert "GRANT INSERT ON audit_log TO loopit_audit_writer" in migration
    assert (
        "GRANT EXECUTE ON FUNCTION loopit_latest_audit_row_hash() TO loopit_audit_writer"
        in migration
    )
    assert "REVOKE SELECT, UPDATE, DELETE" in migration


@pytest.mark.skipif(not os.environ.get("LOOPIT_TEST_DSN"), reason="LOOPIT_TEST_DSN is unset")
def test_migrations_are_rerunnable_on_fresh_schema() -> None:
    from loopit_store.migrate import migrate

    dsn = _isolated_database()
    try:
        assert migrate(dsn) == ("001", "002", "003")
        assert migrate(dsn) == ()
        with closing(_connect(dsn)) as conn:
            outside = conn.execute(
                """
                SELECT n.nspname, c.relname
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relname IN ('tenants', 'schema_migrations', 'audit_log', 'users')
                  AND n.nspname <> 'loopit'
                  AND n.nspname NOT LIKE 'pg_%'
                """
            ).fetchall()
            assert list(outside) == []
            inside = conn.execute(
                """
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'loopit' AND table_name = 'tenants'
                """
            ).fetchone()
            assert inside is not None
    finally:
        _drop_database(dsn)


@pytest.mark.skipif(not os.environ.get("LOOPIT_TEST_DSN"), reason="LOOPIT_TEST_DSN is unset")
def test_migration_002_is_safe_from_001_schema() -> None:
    from loopit_store.migrate import migrate

    dsn = _isolated_database()
    try:
        from loopit_store.migrate import pin_loopit_schema

        with closing(_connect(dsn)) as conn:
            pin_loopit_schema(conn, create=True)
            conn.execute((MIGRATIONS / "001_initial_control_plane.sql").read_text(encoding="utf-8"))
            conn.execute("INSERT INTO schema_migrations (version) VALUES ('001')")
            conn.commit()
        assert migrate(dsn) == ("002", "003")
        assert migrate(dsn) == ()
    finally:
        _drop_database(dsn)


def _isolated_database() -> str:
    import psycopg

    admin_dsn = require_secret(os.environ, "LOOPIT_TEST_DSN", min_length=1)
    db_name = f"loopit_migration_test_{uuid.uuid4().hex}"
    with psycopg.connect(admin_dsn, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{db_name}"')
    return re.sub(r"/[^/?]+(\?.*)?$", f"/{db_name}\\1", admin_dsn)


def _drop_database(dsn: str) -> None:
    import psycopg

    admin_dsn = require_secret(os.environ, "LOOPIT_TEST_DSN", min_length=1)
    db_name = dsn.rsplit("/", 1)[1].split("?", 1)[0]
    with psycopg.connect(admin_dsn, autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)')


def _connect(dsn: str) -> Any:
    import psycopg

    return psycopg.connect(dsn)
