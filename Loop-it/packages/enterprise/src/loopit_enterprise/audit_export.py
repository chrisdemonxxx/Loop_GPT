from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from typing import Any

from loopit_auth import Actor
from loopit_store import AuditRecord, AuditStore
from loopit_store.models import audit_row_hash
from loopit_telemetry import AuditWormMirror, FakeObjectStore, verify_audit_mirror


@dataclass(frozen=True, slots=True)
class AuditExportManifest:
    org_id: str
    record_count: int
    first_audit_id: int | None
    last_audit_id: int | None
    terminal_row_hash: str | None
    payload_sha256: str
    signature: str


@dataclass(frozen=True, slots=True)
class AuditExport:
    jsonl: str
    manifest: AuditExportManifest


def export_audit_log(
    audit_store: AuditStore,
    *,
    actor: Actor,
    org_id: str,
    signing_key: bytes,
    page_size: int = 100,
) -> AuditExport:
    if page_size < 1:
        raise ValueError("page_size must be positive")
    if actor.org_id != org_id or actor.tenant_id != org_id or actor.role not in {"owner", "admin"}:
        raise PermissionError("audit export requires org admin/owner")
    mirror_store = FakeObjectStore()
    mirror_prefix = f"audit-export/{org_id}"
    AuditWormMirror(mirror_store, prefix=mirror_prefix).mirror_tenant(audit_store, org_id)
    mirror_result = verify_audit_mirror(
        audit_store, mirror_store, tenant_id=org_id, prefix=mirror_prefix
    )
    if not mirror_result.ok:
        raise ValueError("audit chain failed WORM verifier before export")
    records = audit_store.list_for_tenant(org_id)
    chunks: list[str] = []
    for start in range(0, len(records), page_size):
        for record in records[start : start + page_size]:
            chunks.append(json.dumps(_row(record), sort_keys=True, separators=(",", ":")))
    jsonl = "\n".join(chunks) + ("\n" if chunks else "")
    payload_hash = hashlib.sha256(jsonl.encode("utf-8")).hexdigest()
    first_audit_id = records[0].audit_id if records else None
    last_audit_id = records[-1].audit_id if records else None
    terminal_row_hash = records[-1].row_hash if records else None
    manifest_body: dict[str, object] = {
        "org_id": org_id,
        "record_count": len(records),
        "first_audit_id": first_audit_id,
        "last_audit_id": last_audit_id,
        "terminal_row_hash": terminal_row_hash,
        "payload_sha256": payload_hash,
    }
    signature = hmac.new(
        signing_key, json.dumps(manifest_body, sort_keys=True).encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return AuditExport(
        jsonl,
        AuditExportManifest(
            org_id=org_id,
            record_count=len(records),
            first_audit_id=first_audit_id,
            last_audit_id=last_audit_id,
            terminal_row_hash=terminal_row_hash,
            payload_sha256=payload_hash,
            signature=signature,
        ),
    )


def import_and_verify_audit_export(export: AuditExport, *, signing_key: bytes) -> bool:
    manifest = export.manifest
    manifest_body = {
        "org_id": manifest.org_id,
        "record_count": manifest.record_count,
        "first_audit_id": manifest.first_audit_id,
        "last_audit_id": manifest.last_audit_id,
        "terminal_row_hash": manifest.terminal_row_hash,
        "payload_sha256": manifest.payload_sha256,
    }
    expected = hmac.new(
        signing_key, json.dumps(manifest_body, sort_keys=True).encode("utf-8"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, manifest.signature):
        return False
    if hashlib.sha256(export.jsonl.encode("utf-8")).hexdigest() != manifest.payload_sha256:
        return False
    previous: str | None = None
    count = 0
    terminal: str | None = None
    for line in export.jsonl.splitlines():
        row = json.loads(line)
        occurred_at = AuditRecord.__annotations__  # keep import used for typing-only builds
        del occurred_at
        expected_hash = audit_row_hash(
            event_id=str(row["event_id"]),
            tenant_id=str(row["tenant_id"]),
            event_type=str(row["event_type"]),
            payload=dict(row["payload"]),
            occurred_at=_parse_dt(str(row["occurred_at"])),
            prev_row_hash=row["prev_row_hash"],
        )
        if (
            row["tenant_id"] != manifest.org_id
            or row["prev_row_hash"] != previous
            or row["row_hash"] != expected_hash
        ):
            return False
        previous = str(row["row_hash"])
        terminal = previous
        count += 1
    return count == manifest.record_count and terminal == manifest.terminal_row_hash


def _row(record: AuditRecord) -> dict[str, Any]:
    return {
        "audit_id": record.audit_id,
        "event_id": record.event_id,
        "tenant_id": record.tenant_id,
        "event_type": record.event_type,
        "payload": record.payload,
        "prev_row_hash": record.prev_row_hash,
        "row_hash": record.row_hash,
        "occurred_at": record.occurred_at.isoformat(),
    }


def _parse_dt(value: str) -> Any:
    from datetime import datetime

    return datetime.fromisoformat(value)
