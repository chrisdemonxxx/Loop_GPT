"""A checkpoint tree that survives a process restart.

``CheckpointStore`` keeps its tree in memory, so every version, rollback target
and published snapshot vanished whenever the API restarted. This keeps the same
interface and writes through to a directory: blob bytes go to a
``FileSystemBlobStore`` and each project's tree (checkpoint records plus the
current pointer) to one JSON index file, replaced atomically on every change.

Pins stay in memory on purpose: they mark checkpoints held by *open* runs, and
no run survives the restart that would read them back.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

from .blobs import FileSystemBlobStore
from .errors import CheckpointError
from .tree import Checkpoint, CheckpointStore

log = logging.getLogger(__name__)

#: Tenant and project ids become directory and file names.
_SEGMENT = re.compile(r"[A-Za-z0-9_-]{1,128}")
_INDEX_VERSION = 1


class FileCheckpointStore(CheckpointStore):
    """``CheckpointStore`` persisted under ``root`` (``blobs/`` and ``index/``)."""

    def __init__(self, root: Path) -> None:
        super().__init__(FileSystemBlobStore(root / "blobs"))
        self._index_root = root / "index"
        self._index_root.mkdir(parents=True, exist_ok=True)
        self._load()

    # --- Writing --------------------------------------------------------------

    def _commit(
        self,
        *,
        project_id: str,
        tenant_id: str,
        files: Mapping[str, str],
        parent_id: str | None,
        db_snapshot_id: str | None,
        verified: bool,
        label: str | None,
    ) -> Checkpoint:
        checkpoint = super()._commit(
            project_id=project_id,
            tenant_id=tenant_id,
            files=files,
            parent_id=parent_id,
            db_snapshot_id=db_snapshot_id,
            verified=verified,
            label=label,
        )
        self._persist(tenant_id, project_id)
        return checkpoint

    def rollback(self, project_id: str, checkpoint_id: str, *, tenant_id: str) -> Checkpoint:
        target = super().rollback(project_id, checkpoint_id, tenant_id=tenant_id)
        self._persist(tenant_id, project_id)
        return target

    def prune(self, checkpoint_id: str, *, tenant_id: str) -> None:
        project_id = self.get(checkpoint_id, tenant_id=tenant_id).project_id
        super().prune(checkpoint_id, tenant_id=tenant_id)
        self._persist(tenant_id, project_id)

    def _index_path(self, tenant_id: str, project_id: str) -> Path:
        return self._index_root / _segment(tenant_id) / f"{_segment(project_id)}.json"

    def _persist(self, tenant_id: str, project_id: str) -> None:
        path = self._index_path(tenant_id, project_id)
        records = [
            _to_record(checkpoint)
            for checkpoint in self.list_for_project(project_id, tenant_id=tenant_id)
        ]
        current = self._current.get(project_id)
        body = {
            "version": _INDEX_VERSION,
            "tenant_id": tenant_id,
            "project_id": project_id,
            "current": current if current in self._checkpoints else None,
            "checkpoints": records,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        staging = path.with_suffix(".partial")
        staging.write_text(json.dumps(body, sort_keys=True), encoding="utf-8")
        staging.replace(path)

    # --- Loading --------------------------------------------------------------

    def _load(self) -> None:
        for path in sorted(self._index_root.glob("*/*.json")):
            try:
                body = json.loads(path.read_text(encoding="utf-8"))
                checkpoints = [_from_record(record) for record in body["checkpoints"]]
            except (OSError, ValueError, KeyError, TypeError, CheckpointError) as exc:
                # One unreadable project must not take every other project's
                # history down with it at boot.
                log.warning("skipping unreadable checkpoint index %s: %s", path, exc)
                continue
            for checkpoint in checkpoints:
                self._checkpoints[checkpoint.checkpoint_id] = checkpoint
            current = body.get("current")
            if isinstance(current, str) and current in self._checkpoints:
                self._current[str(body["project_id"])] = current


def _segment(value: str) -> str:
    """A file-name-safe stand-in for an id. Ids are read back from the index
    body, never from the path, so hashing an unusual id loses nothing."""
    if _SEGMENT.fullmatch(value):
        return value
    return "h-" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]


def _to_record(checkpoint: Checkpoint) -> dict[str, Any]:
    return {
        "checkpoint_id": checkpoint.checkpoint_id,
        "project_id": checkpoint.project_id,
        "tenant_id": checkpoint.tenant_id,
        "files": dict(checkpoint.files),
        "parent_id": checkpoint.parent_id,
        "db_snapshot_id": checkpoint.db_snapshot_id,
        "verified": checkpoint.verified,
        "label": checkpoint.label,
        "created_at": checkpoint.created_at.isoformat(),
    }


def _from_record(record: dict[str, Any]) -> Checkpoint:
    return Checkpoint(
        checkpoint_id=str(record["checkpoint_id"]),
        project_id=str(record["project_id"]),
        tenant_id=str(record["tenant_id"]),
        files={str(path): str(digest) for path, digest in dict(record["files"]).items()},
        parent_id=record.get("parent_id"),
        db_snapshot_id=record.get("db_snapshot_id"),
        verified=bool(record.get("verified", False)),
        label=record.get("label"),
        created_at=datetime.fromisoformat(str(record["created_at"])),
    )
