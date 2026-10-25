"""Per-project DB / auth / storage / secrets for Build Mode (Phase 1.9 + 1.11 + 2.7).

Offline defaults: in-memory Postgres schema fake, in-memory S3 prefix, and an
in-memory secrets store (or encrypted Postgres when ``LOOPIT_SECRETS_*`` /
``LOOPIT_STORE_DSN`` are set). Credentials are never returned to the browser —
only names and non-secret metadata.

Phase 2.7: a separate **prod** schema is created on first publish; migrations
are applied then. Optional checkpoint DB dumps are stubbed (JSON under
``.db-snapshots/``) until Neon branching / ``pg_dump`` is wired.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from loopit_provision import (
    DatabaseProvisionRequest,
    GeneratedAppJwtIssuer,
    InMemoryDatabaseProvisioner,
    InMemoryStorageProvisioner,
    StorageBucket,
    TableSpec,
    parse_table_spec,
    project_database_names,
    provision as run_provision_tool,
)
from loopit_secrets import Environment, SecretClass, SecretStore, SecretValue, StoredSecret, store_from_env

LOGGER = logging.getLogger("loopit.api.project_backend")

_SECRET_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


@dataclass
class ProjectBackendState:
    """Process-local (plus optional durable secrets) backend for one API process."""

    database: InMemoryDatabaseProvisioner = field(default_factory=InMemoryDatabaseProvisioner)
    storage: InMemoryStorageProvisioner = field(
        default_factory=lambda: InMemoryStorageProvisioner(
            bucket=os.environ.get("LOOPIT_STORAGE_BUCKET", "loopit-generated-apps")
        )
    )
    build_secrets: SecretStore = field(default_factory=lambda: store_from_env(Environment.BUILD))
    prod_secrets: SecretStore = field(default_factory=lambda: store_from_env(Environment.PROD))
    #: table specs applied per project (for the Database tab when using the fake).
    tables: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    #: Prod-side table metadata (isolated from ``tables`` / dev).
    prod_tables: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    jwt_secrets: dict[str, str] = field(default_factory=dict)
    buckets: dict[str, StorageBucket] = field(default_factory=dict)
    pending_secret_requests: dict[str, list[dict[str, Any]]] = field(default_factory=dict)


def backend_from_env() -> ProjectBackendState:
    return ProjectBackendState()


def _meta_path(projects_root: Path, project_id: str) -> Path:
    return projects_root / ".project-backend" / f"{project_id}.json"


def load_backend_meta(projects_root: Path, project_id: str) -> dict[str, Any]:
    path = _meta_path(projects_root, project_id)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_backend_meta(projects_root: Path, project_id: str, meta: dict[str, Any]) -> None:
    path = _meta_path(projects_root, project_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    except OSError:
        LOGGER.warning("could not persist project backend meta for %s", project_id)


def ensure_runtime(
    state: ProjectBackendState,
    *,
    projects_root: Path,
    tenant_id: str,
    project_id: str,
) -> dict[str, Any]:
    """Ensure JWT secret + storage prefix exist; return public metadata."""
    meta = load_backend_meta(projects_root, project_id)
    names = project_database_names(tenant_id, project_id)
    if project_id not in state.jwt_secrets:
        state.jwt_secrets[project_id] = meta.get("jwt_secret") or secrets.token_urlsafe(32)
    if project_id not in state.buckets:
        state.buckets[project_id] = state.storage.provision_bucket(tenant_id, project_id)
    bucket = state.buckets[project_id]
    meta.update(
        {
            "tenant_id": tenant_id,
            "schema": names.schema,
            "app_role": names.app_role,
            "storage_bucket": bucket.bucket,
            "storage_prefix": bucket.prefix,
            "jwt_issuer": "loopit-provisioner",
            "jwt_secret": state.jwt_secrets[project_id],
            "tables": state.tables.get(project_id) or meta.get("tables") or [],
        }
    )
    save_backend_meta(projects_root, project_id, meta)
    if project_id not in state.tables and meta.get("tables"):
        state.tables[project_id] = list(meta["tables"])
    if project_id not in state.prod_tables and meta.get("prod_tables"):
        state.prod_tables[project_id] = list(meta["prod_tables"])
    return public_runtime_meta(meta, environment="dev")


def public_runtime_meta(meta: dict[str, Any], *, environment: str = "dev") -> dict[str, Any]:
    env = (environment or "dev").strip().lower() or "dev"
    if env == "prod":
        schema = meta.get("prod_schema")
        app_role = meta.get("prod_app_role")
        tables = list(meta.get("prod_tables") or [])
    else:
        schema = meta.get("schema")
        app_role = meta.get("app_role")
        tables = list(meta.get("tables") or [])
    return {
        "environment": env,
        "schema": schema,
        "app_role": app_role,
        "storage_bucket": meta.get("storage_bucket"),
        "storage_prefix": meta.get("storage_prefix"),
        "jwt_issuer": meta.get("jwt_issuer"),
        "tables": tables,
        "auth_ready": bool(meta.get("jwt_secret")),
        "prod_ready": bool(meta.get("prod_schema")),
        "prod_schema": meta.get("prod_schema"),
        "last_prod_migration_at": meta.get("last_prod_migration_at"),
        "provider": (
            "postgres"
            if os.environ.get("LOOPIT_PROVISION_POSTGRES_DSN")
            else "memory"
        ),
    }


def _table_specs_from_meta(tables: list[dict[str, Any]]) -> list[TableSpec]:
    specs: list[TableSpec] = []
    for entry in tables:
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        try:
            specs.append(
                parse_table_spec(
                    {
                        "name": name,
                        "access": "tenant",
                        "columns": [{"name": "title", "type": "text"}],
                    }
                )
            )
        except Exception:
            continue
    return specs


def ensure_prod_database(
    state: ProjectBackendState,
    *,
    projects_root: Path,
    tenant_id: str,
    project_id: str,
) -> dict[str, Any]:
    """Create the isolated prod schema on first publish (idempotent).

    Dev tables stay on the ``dev`` schema; prod gets its own identifiers and
    an empty (or migration-applied) schema — never a copy of live row data.
    """
    ensure_runtime(state, projects_root=projects_root, tenant_id=tenant_id, project_id=project_id)
    meta = load_backend_meta(projects_root, project_id)
    prod_names = project_database_names(tenant_id, project_id, environment="prod")
    created = not bool(meta.get("prod_schema"))
    meta["prod_schema"] = prod_names.schema
    meta["prod_app_role"] = prod_names.app_role
    meta["prod_owner_role"] = prod_names.owner_role
    if created:
        meta["prod_created_at"] = datetime.now(UTC).isoformat()
    # Ensure the fake (or real) provisioner knows about the prod boundary.
    state.database.roles[prod_names.app_role] = prod_names.schema
    state.database.schemas.setdefault(prod_names.schema, {})
    state.database.migrations.setdefault(prod_names.schema, {})
    save_backend_meta(projects_root, project_id, meta)
    return {
        "created": created,
        "schema": prod_names.schema,
        "app_role": prod_names.app_role,
        "environment": "prod",
    }


def apply_migrations_at_publish(
    state: ProjectBackendState,
    *,
    projects_root: Path,
    tenant_id: str,
    project_id: str,
) -> dict[str, Any]:
    """Ensure prod exists, then apply the current table set as prod migrations.

    Offline: feeds :class:`InMemoryDatabaseProvisioner`. Live Postgres uses the
    same request shape when ``LOOPIT_PROVISION_POSTGRES_DSN`` is set (via the
    provisioner already held on ``state.database`` for memory, or a future
    Psycopg swap).
    """
    ensure_prod = ensure_prod_database(
        state, projects_root=projects_root, tenant_id=tenant_id, project_id=project_id
    )
    meta = load_backend_meta(projects_root, project_id)
    dev_tables = list(state.tables.get(project_id) or meta.get("tables") or [])
    specs = _table_specs_from_meta(dev_tables)
    applied: list[str] = []
    if specs:
        result = state.database.provision(
            DatabaseProvisionRequest(
                tenant_id=tenant_id,
                project_id=project_id,
                tables=tuple(specs),
                environment="prod",
            )
        )
        applied = list(result.applied_migrations)
    prod_table_rows = [
        {"name": str(spec.name), "schema": ensure_prod["schema"], "rls": True}
        for spec in specs
    ]
    state.prod_tables[project_id] = prod_table_rows
    meta["prod_tables"] = prod_table_rows
    meta["last_prod_migration_at"] = datetime.now(UTC).isoformat()
    meta["last_prod_migrations"] = applied
    save_backend_meta(projects_root, project_id, meta)
    return {
        "environment": "prod",
        "schema": ensure_prod["schema"],
        "created": ensure_prod["created"],
        "applied_migrations": applied,
        "tables": prod_table_rows,
    }


def dump_db_snapshot_stub(
    state: ProjectBackendState,
    *,
    projects_root: Path,
    tenant_id: str,
    project_id: str,
    environment: str = "dev",
) -> str:
    """Record a lightweight DB snapshot id for a checkpoint (Neon/pg_dump stub).

    Returns a ``dbsnap_…`` id stored under ``.db-snapshots/<project>/``. When
    Neon is configured (``LOOPIT_NEON_API_KEY``) this is the seam for a branch;
    offline always writes a JSON schema stub so checkpoints can carry
    ``db_snapshot_id`` without a live provider.
    """
    env = (environment or "dev").strip().lower() or "dev"
    ensure_runtime(state, projects_root=projects_root, tenant_id=tenant_id, project_id=project_id)
    meta = load_backend_meta(projects_root, project_id)
    names = project_database_names(tenant_id, project_id, environment=env)
    if env == "prod":
        tables = list(state.prod_tables.get(project_id) or meta.get("prod_tables") or [])
        schema = meta.get("prod_schema") or names.schema
    else:
        tables = list(state.tables.get(project_id) or meta.get("tables") or [])
        schema = meta.get("schema") or names.schema
    snapshot_id = f"dbsnap_{secrets.token_hex(8)}"
    kind = "neon_branch" if os.environ.get("LOOPIT_NEON_API_KEY") else "stub"
    payload = {
        "snapshot_id": snapshot_id,
        "kind": kind,
        "environment": env,
        "tenant_id": tenant_id,
        "project_id": project_id,
        "schema": schema,
        "tables": tables,
        "created_at": datetime.now(UTC).isoformat(),
        "note": (
            "Neon branch stub — set LOOPIT_NEON_API_KEY for live branching."
            if kind == "neon_branch"
            else "Offline pg_dump/branch stub; schema metadata only."
        ),
    }
    path = projects_root / ".db-snapshots" / project_id / f"{snapshot_id}.json"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except OSError:
        LOGGER.warning("could not persist db snapshot stub %s", snapshot_id)
    return snapshot_id


def load_db_snapshot(
    projects_root: Path, project_id: str, snapshot_id: str
) -> dict[str, Any] | None:
    path = projects_root / ".db-snapshots" / project_id / f"{snapshot_id}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def migration_runner_for(
    state: ProjectBackendState,
    *,
    projects_root: Path,
    tenant_id: str,
    project_id: str,
):
    """Return a MigrationRunner that applies SQL via the in-memory provisioner."""

    def run_migration(sql: str) -> None:
        ensure_runtime(state, projects_root=projects_root, tenant_id=tenant_id, project_id=project_id)
        # The provision tool already emitted RLS SQL; record the table names from
        # a lightweight parse of CREATE TABLE lines for the Database tab.
        names = project_database_names(tenant_id, project_id)
        created = re.findall(
            r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[\w]+"?\.)?"?(\w+)"?',
            sql,
            flags=re.IGNORECASE,
        )
        tables = state.tables.setdefault(project_id, [])
        for table in created:
            if table.lower() in {"schema_migrations"}:
                continue
            entry = {"name": table, "schema": names.schema, "rls": True}
            if not any(item.get("name") == table for item in tables):
                tables.append(entry)
        # Feed the fake provisioner so schema isolation stays consistent.
        specs: list[TableSpec] = []
        for table in created:
            if table.lower() == "schema_migrations":
                continue
            try:
                specs.append(
                    parse_table_spec(
                        {
                            "name": table,
                            "access": "tenant",
                            "columns": [{"name": "title", "type": "text"}],
                        }
                    )
                )
            except Exception:
                continue
        if specs:
            from loopit_provision import DatabaseProvisionRequest

            state.database.provision(
                DatabaseProvisionRequest(
                    tenant_id=tenant_id,
                    project_id=project_id,
                    tables=tuple(specs),
                )
            )
        meta = load_backend_meta(projects_root, project_id)
        meta["tables"] = tables
        save_backend_meta(projects_root, project_id, meta)

    return run_migration


def provision_table(
    state: ProjectBackendState,
    *,
    projects_root: Path,
    tenant_id: str,
    project_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    runner = migration_runner_for(
        state, projects_root=projects_root, tenant_id=tenant_id, project_id=project_id
    )
    outcome = run_provision_tool(args, run_migration=runner)
    return {"ok": outcome.ok, "output": outcome.output, "detail": dict(outcome.detail)}


def list_tables(
    state: ProjectBackendState,
    *,
    projects_root: Path,
    tenant_id: str,
    project_id: str,
    environment: str = "dev",
) -> list[dict[str, Any]]:
    env = (environment or "dev").strip().lower() or "dev"
    ensure_runtime(
        state, projects_root=projects_root, tenant_id=tenant_id, project_id=project_id
    )
    meta = load_backend_meta(projects_root, project_id)
    if env == "prod":
        return list(state.prod_tables.get(project_id) or meta.get("prod_tables") or [])
    return list(state.tables.get(project_id) or meta.get("tables") or [])


def browse_table(
    state: ProjectBackendState,
    *,
    projects_root: Path,
    tenant_id: str,
    project_id: str,
    table: str,
    limit: int = 50,
    environment: str = "dev",
) -> dict[str, Any]:
    """Minimal table browser — fake provider has no row store, so return schema only."""
    del limit
    env = (environment or "dev").strip().lower() or "dev"
    tables = list_tables(
        state,
        projects_root=projects_root,
        tenant_id=tenant_id,
        project_id=project_id,
        environment=env,
    )
    match = next((item for item in tables if item.get("name") == table), None)
    if match is None:
        return {"table": table, "columns": [], "rows": [], "note": "table not found"}
    names = project_database_names(tenant_id, project_id, environment=env)
    fake = state.database.schemas.get(names.schema, {}).get(table)
    columns = ["id", "org_id", "created_at", "updated_at"]
    if fake is not None:
        columns = ["id", "org_id", "title", "created_at", "updated_at"]
    return {
        "table": table,
        "schema": names.schema,
        "environment": env,
        "rls": True,
        "columns": columns,
        "rows": [],
        "note": (
            "Row browse needs LOOPIT_PROVISION_POSTGRES_DSN; offline mode shows schema only."
            if not os.environ.get("LOOPIT_PROVISION_POSTGRES_DSN")
            else "No rows yet."
        ),
    }


def issue_dev_jwt(
    state: ProjectBackendState,
    *,
    projects_root: Path,
    tenant_id: str,
    project_id: str,
    user_id: str,
) -> dict[str, Any]:
    ensure_runtime(state, projects_root=projects_root, tenant_id=tenant_id, project_id=project_id)
    issuer = GeneratedAppJwtIssuer(secret=state.jwt_secrets[project_id])
    token = issuer.issue_token(user_id=user_id, org_id=tenant_id)
    return {"token": token, "issuer": issuer.issuer, "user_id": user_id, "org_id": tenant_id}


def list_secret_names(
    state: ProjectBackendState, *, tenant_id: str, project_id: str, environment: str = "build"
) -> list[dict[str, str]]:
    store = state.build_secrets if environment == "build" else state.prod_secrets
    names: list[dict[str, str]] = [
        {"name": name, "environment": environment}
        for name in store.names_for_project(tenant_id, project_id)
    ]
    # Also surface pending requests.
    for req in state.pending_secret_requests.get(project_id, []):
        if req.get("status") == "pending":
            names.append(
                {
                    "name": str(req["name"]),
                    "environment": environment,
                    "status": "requested",
                    "reason": str(req.get("reason") or ""),
                }
            )
    return names


def put_secret(
    state: ProjectBackendState,
    *,
    tenant_id: str,
    project_id: str,
    name: str,
    value: str,
    environment: str = "build",
) -> None:
    if not _SECRET_NAME.match(name):
        raise ValueError("secret name must match [A-Z][A-Z0-9_]{0,63}")
    if name.startswith("VITE_"):
        raise ValueError("VITE_ secrets are client-exposed; store them as plain env in the app instead")
    store = state.build_secrets if environment == "build" else state.prod_secrets
    env = Environment.BUILD if environment == "build" else Environment.PROD
    store.put(
        StoredSecret(
            name=name,
            environment=env,
            secret_class=SecretClass.PROJECT,
            tenant_id=tenant_id,
            project_id=project_id,
            value=SecretValue(value),
        )
    )
    # Clear matching pending request.
    pending = state.pending_secret_requests.get(project_id, [])
    state.pending_secret_requests[project_id] = [
        item for item in pending if not (item.get("name") == name and item.get("status") == "pending")
    ]


def delete_secret(
    state: ProjectBackendState,
    *,
    tenant_id: str,
    project_id: str,
    name: str,
    environment: str = "build",
) -> bool:
    store = state.build_secrets if environment == "build" else state.prod_secrets
    key = (tenant_id, project_id, name)
    by_key = getattr(store, "_by_key", None)
    if isinstance(by_key, dict) and key in by_key:
        del by_key[key]
        return True
    return False


def request_secret(
    state: ProjectBackendState,
    *,
    project_id: str,
    name: str,
    reason: str,
    run_id: str | None = None,
) -> dict[str, Any]:
    if not _SECRET_NAME.match(name):
        raise ValueError("secret name must match [A-Z][A-Z0-9_]{0,63}")
    req = {
        "request_id": f"sreq_{secrets.token_hex(6)}",
        "name": name,
        "reason": reason,
        "run_id": run_id,
        "status": "pending",
    }
    state.pending_secret_requests.setdefault(project_id, []).append(req)
    return req


def sandbox_env_for(
    state: ProjectBackendState,
    *,
    tenant_id: str,
    project_id: str,
    environment: str = "build",
) -> dict[str, str]:
    """Plaintext map for sandbox/deploy injection only (never sent to the client)."""
    ensure = {}
    meta_jwt = state.jwt_secrets.get(project_id)
    if meta_jwt:
        ensure["GENERATED_JWT_SECRET"] = meta_jwt
    bucket = state.buckets.get(project_id)
    if bucket:
        ensure["S3_BUCKET"] = bucket.bucket
        ensure["S3_PREFIX"] = bucket.prefix
    store = state.build_secrets if environment == "build" else state.prod_secrets
    for (t, p, name), secret in getattr(store, "_by_key", {}).items():
        if t == tenant_id and p == project_id:
            ensure[name] = secret.value.reveal()
    return ensure
