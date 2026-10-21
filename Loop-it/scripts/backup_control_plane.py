"""Create a logical control-plane backup and optional checkpoint/WORM archives.

The script intentionally exits 0 when CONTROL_PLANE_DATABASE_URL is absent so it
can run in CI on forks. In release environments, the scheduled workflow provides
that DSN from a GitHub Environment secret.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tarfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
from loopit_store.postgres import PostgresAuditStore
from psycopg.rows import dict_row

ROW_COUNT_TABLES = (
    "tenants",
    "orgs",
    "users",
    "projects",
    "runs",
    "run_events",
    "checkpoints",
    "checkpoint_pins",
    "sandbox_leases",
    "quota_ledger",
    "audit_log",
    "secrets",
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Back up Loop-it control-plane state.")
    parser.add_argument("--dsn", default=os.getenv("CONTROL_PLANE_DATABASE_URL", ""))
    parser.add_argument("--out", type=Path, default=Path("artifacts/control-plane-backup/latest"))
    parser.add_argument("--checkpoint-root", type=Path, default=_env_path("LOOPIT_CHECKPOINT_ROOT"))
    parser.add_argument("--audit-worm-root", type=Path, default=_env_path("LOOPIT_AUDIT_WORM_ROOT"))
    args = parser.parse_args()

    if not args.dsn:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "manifest.json").write_text(
            json.dumps(
                {
                    "created_at": datetime.now(UTC).isoformat(),
                    "skipped": True,
                    "reason": "CONTROL_PLANE_DATABASE_URL is unset",
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print("CONTROL_PLANE_DATABASE_URL is unset; skipping backup.")
        return 0

    pg_dump = _require_tool("pg_dump")
    args.out.mkdir(parents=True, exist_ok=True)
    dump_path = args.out / "control-plane.dump"
    _run([pg_dump, "--format=custom", "--no-owner", "--file", str(dump_path), args.dsn])

    manifest: dict[str, Any] = {
        "created_at": datetime.now(UTC).isoformat(),
        "database_dump": dump_path.name,
        "row_counts": _row_counts(args.dsn),
        "audit": _audit_status(args.dsn),
        "checkpoint_archive": None,
        "audit_worm_archive": None,
    }

    if args.checkpoint_root and args.checkpoint_root.exists():
        manifest["checkpoint_archive"] = _archive(
            args.checkpoint_root, args.out / "checkpoints.tar.gz"
        )
    else:
        print("LOOPIT_CHECKPOINT_ROOT is unset or missing; checkpoint archive skipped.")

    if args.audit_worm_root and args.audit_worm_root.exists():
        manifest["audit_worm_archive"] = _archive(
            args.audit_worm_root, args.out / "audit-worm.tar.gz"
        )
    else:
        print("LOOPIT_AUDIT_WORM_ROOT is unset or missing; WORM archive skipped.")

    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"backup written to {args.out}")
    return 0


def _env_path(name: str) -> Path | None:
    value = os.getenv(name)
    return Path(value) if value else None


def _require_tool(name: str) -> str:
    resolved = shutil.which(name)
    if resolved is None:
        raise SystemExit(f"required executable not found on PATH: {name}")
    return resolved


def _run(argv: list[str]) -> None:
    subprocess.run(argv, check=True)  # noqa: S603


def _row_counts(dsn: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    with psycopg.connect(dsn) as conn:
        for table in ROW_COUNT_TABLES:
            try:
                value = conn.execute(f"SELECT count(*) FROM {table}").fetchone()  # noqa: S608
            except psycopg.errors.UndefinedTable:
                conn.rollback()
                counts[table] = -1
                continue
            counts[table] = int(value[0]) if value else 0
    return counts


def _audit_status(dsn: str) -> dict[str, Any]:
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        tenants = tuple(
            str(row["tenant_id"])
            for row in conn.execute("SELECT DISTINCT tenant_id FROM audit_log ORDER BY tenant_id")
        )
        store = PostgresAuditStore(conn)
        return {
            "tenants": tenants,
            "chain_valid": store.verify_chain(),
            "tenant_chain_valid": {tenant: store.verify_chain(tenant) for tenant in tenants},
        }


def _archive(root: Path, destination: Path) -> str:
    with tarfile.open(destination, "w:gz") as archive:
        archive.add(root, arcname=".")
    return destination.name


if __name__ == "__main__":
    raise SystemExit(main())
