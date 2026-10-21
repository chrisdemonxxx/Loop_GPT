from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from loopit_store.models import AuditRecord, audit_row_hash
from loopit_store.protocols import AuditStore


class ObjectStore(Protocol):
    def put_once(self, key: str, body: bytes, content_type: str = "application/json") -> None: ...

    def get(self, key: str) -> bytes: ...

    def exists(self, key: str) -> bool: ...


class LocalObjectStore:
    def __init__(self, root: Path | str) -> None:
        self._root = Path(root)
        self._root.mkdir(parents=True, exist_ok=True)

    def put_once(self, key: str, body: bytes, content_type: str = "application/json") -> None:
        del content_type
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open("xb") as handle:
                handle.write(body)
        except FileExistsError:
            raise FileExistsError(f"WORM object already exists: {key}") from None

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def _path(self, key: str) -> Path:
        clean = key.replace("\\", "/").lstrip("/")
        if ".." in Path(clean).parts:
            raise ValueError("object key must not traverse parents")
        return self._root / clean


class FakeObjectStore:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put_once(self, key: str, body: bytes, content_type: str = "application/json") -> None:
        del content_type
        if key in self.objects:
            raise FileExistsError(f"WORM object already exists: {key}")
        self.objects[key] = body

    def get(self, key: str) -> bytes:
        return self.objects[key]

    def exists(self, key: str) -> bool:
        return key in self.objects


@dataclass(frozen=True, slots=True)
class MirrorVerificationResult:
    ok: bool
    missing_audit_ids: tuple[int, ...] = ()
    tampered_keys: tuple[str, ...] = ()
    chain_valid: bool = True


class AuditWormMirror:
    def __init__(self, object_store: ObjectStore, *, prefix: str = "audit") -> None:
        self._object_store = object_store
        self._prefix = prefix.strip("/")

    def mirror_tenant(self, audit_store: AuditStore, tenant_id: str) -> tuple[str, ...]:
        keys: list[str] = []
        for record in audit_store.list_for_tenant(tenant_id):
            key = self.key_for(record)
            self._object_store.put_once(key, _record_body(record))
            keys.append(key)
        return tuple(keys)

    def mirror_record(self, record: AuditRecord) -> str:
        key = self.key_for(record)
        self._object_store.put_once(key, _record_body(record))
        return key

    def key_for(self, record: AuditRecord) -> str:
        return (
            f"{self._prefix}/tenant={record.tenant_id}/audit_id={record.audit_id:020d}/"
            f"event={record.event_id}.json"
        )


def verify_audit_mirror(
    audit_store: AuditStore, object_store: ObjectStore, *, tenant_id: str, prefix: str = "audit"
) -> MirrorVerificationResult:
    mirror = AuditWormMirror(object_store, prefix=prefix)
    missing: list[int] = []
    tampered: list[str] = []
    for record in audit_store.list_for_tenant(tenant_id):
        key = mirror.key_for(record)
        if not object_store.exists(key):
            missing.append(record.audit_id)
            continue
        body = object_store.get(key)
        try:
            mirrored = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            tampered.append(key)
            continue
        if (
            mirrored.get("record_sha256")
            != hashlib.sha256(_canonical(record).encode("utf-8")).hexdigest()
        ):
            tampered.append(key)
    chain_valid = audit_store.verify_chain(tenant_id)
    return MirrorVerificationResult(
        ok=not missing and not tampered and chain_valid,
        missing_audit_ids=tuple(missing),
        tampered_keys=tuple(tampered),
        chain_valid=chain_valid,
    )


def _record_body(record: AuditRecord) -> bytes:
    body = {
        "audit_id": record.audit_id,
        "event_id": record.event_id,
        "tenant_id": record.tenant_id,
        "event_type": record.event_type,
        "payload": record.payload,
        "prev_row_hash": record.prev_row_hash,
        "row_hash": record.row_hash,
        "occurred_at": record.occurred_at.isoformat(),
        "record_sha256": hashlib.sha256(_canonical(record).encode("utf-8")).hexdigest(),
    }
    return json.dumps(body, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def _canonical(record: AuditRecord) -> str:
    expected = audit_row_hash(
        event_id=record.event_id,
        tenant_id=record.tenant_id,
        event_type=record.event_type,
        payload=record.payload,
        occurred_at=record.occurred_at,
        prev_row_hash=record.prev_row_hash,
    )
    data: Mapping[str, Any] = {
        "audit_id": record.audit_id,
        "event_id": record.event_id,
        "tenant_id": record.tenant_id,
        "event_type": record.event_type,
        "payload": record.payload,
        "prev_row_hash": record.prev_row_hash,
        "row_hash": record.row_hash,
        "expected_row_hash": expected,
        "occurred_at": record.occurred_at.isoformat(),
    }
    return json.dumps(data, sort_keys=True, separators=(",", ":"), default=str)
