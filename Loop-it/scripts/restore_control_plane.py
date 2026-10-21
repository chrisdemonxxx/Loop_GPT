"""Restore a control-plane backup into a scratch database and verify integrity."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tarfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import psycopg
from loopit_store.postgres import PostgresAuditStore
from loopit_telemetry import LocalObjectStore, verify_audit_mirror
from psycopg.rows import dict_row


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Restore and verify a Loop-it control-plane backup."
    )
    parser.add_argument("--backup-dir", type=Path, required=True)
    parser.add_argument("--target-dsn", default=os.getenv("SCRATCH_DATABASE_URL", ""))
    parser.add_argument("--reset-schema", action="store_true")
    parser.add_argument("--restore-checkpoints-to", type=Path)
    parser.add_argument("--restore-audit-worm-to", type=Path)
    args = parser.parse_args()

    if not args.target_dsn:
        print("SCRATCH_DATABASE_URL is unset; skipping restore drill.")
        return 0

    manifest_path = args.backup_dir / "manifest.json"
    dump_path = args.backup_dir / "control-plane.dump"
    if not manifest_path.exists():
        raise SystemExit("backup-dir must contain manifest.json")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("skipped"):
        print(f"backup was skipped: {manifest.get('reason', 'unknown reason')}")
        return 0
    if not dump_path.exists():
        raise SystemExit("backup-dir must contain control-plane.dump")
    if args.reset_schema:
        _reset_public_schema(args.target_dsn)
    _restore_dump(args.target_dsn, dump_path)
    _verify_row_counts(args.target_dsn, manifest.get("row_counts", {}))
    _verify_audit(args.target_dsn, manifest.get("audit", {}), args.backup_dir)
    _extract_optional(
        args.backup_dir, manifest.get("checkpoint_archive"), args.restore_checkpoints_to
    )
    _extract_optional(
        args.backup_dir, manifest.get("audit_worm_archive"), args.restore_audit_worm_to
    )
    print("restore drill verified row counts and audit hash chains")
    return 0


def _require_tool(name: str) -> str:
    resolved = shutil.which(name)
    if resolved is None:
        raise SystemExit(f"required executable not found on PATH: {name}")
    return resolved


def _run(argv: list[str]) -> None:
    subprocess.run(argv, check=True)  # noqa: S603


def _reset_public_schema(dsn: str) -> None:
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("DROP SCHEMA IF EXISTS public CASCADE")
        conn.execute("CREATE SCHEMA public")


def _restore_dump(dsn: str, dump_path: Path) -> None:
    pg_restore = _require_tool("pg_restore")
    _run([pg_restore, "--no-owner", "--dbname", dsn, str(dump_path)])


def _verify_row_counts(dsn: str, expected: Mapping[str, Any]) -> None:
    mismatches: list[str] = []
    with psycopg.connect(dsn) as conn:
        for table, raw_expected in expected.items():
            if int(raw_expected) < 0:
                continue
            value = conn.execute(f"SELECT count(*) FROM {table}").fetchone()  # noqa: S608
            actual = int(value[0]) if value else 0
            if actual != int(raw_expected):
                mismatches.append(f"{table}: expected {raw_expected}, got {actual}")
    if mismatches:
        raise SystemExit("row count verification failed:\n" + "\n".join(mismatches))


def _verify_audit(dsn: str, expected: Mapping[str, Any], backup_dir: Path) -> None:
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        store = PostgresAuditStore(conn)
        if not store.verify_chain():
            raise SystemExit("restored audit_log hash chain is invalid")
        if expected.get("chain_valid") is False:
            raise SystemExit("backup manifest recorded an invalid audit hash chain")
        archive = backup_dir / "audit-worm.tar.gz"
        tenants = tuple(str(value) for value in expected.get("tenants", ()))
        if archive.exists() and tenants:
            worm_root = backup_dir / "_audit_worm_verify"
            _extract_archive(archive, worm_root)
            object_store = LocalObjectStore(worm_root)
            failures = []
            for tenant in tenants:
                result = verify_audit_mirror(store, object_store, tenant_id=tenant)
                if not result.ok:
                    failures.append(f"{tenant}: {result}")
            if failures:
                raise SystemExit("audit WORM verification failed:\n" + "\n".join(failures))


def _extract_optional(backup_dir: Path, archive_name: object, destination: Path | None) -> None:
    if not archive_name or destination is None:
        return
    _extract_archive(backup_dir / str(archive_name), destination)


def _extract_archive(archive_path: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "r:gz") as archive:
        archive.extractall(destination, filter="data")


if __name__ == "__main__":
    raise SystemExit(main())
