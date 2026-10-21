"""Content-addressed checkpoint facade for control-plane checkpoint records."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime

from loopit_store import CheckpointRecord
from loopit_store import CheckpointStore as CheckpointRecordStore

from .blobs import BlobStore, ensure_blobs_present


class ContentAddressedCheckpointStore:
    """Store checkpoint metadata only after referenced blobs are durable.

    Blob bytes are content-addressed and intentionally tenant-neutral: identical
    bytes from two tenants share a digest just like Git objects. Tenant isolation
    stays on checkpoint metadata reads; callers must not expose raw blob lookup
    by digest to tenants.
    """

    def __init__(self, records: CheckpointRecordStore, blobs: BlobStore) -> None:
        self._records = records
        self._blobs = blobs

    def put_blob(self, content: bytes) -> str:
        return self._blobs.put(content)

    def put(self, content: bytes) -> str:
        return self.put_blob(content)

    def create(self, checkpoint: CheckpointRecord) -> CheckpointRecord:
        ensure_blobs_present(self._blobs, checkpoint.manifest)
        return self._records.create(checkpoint)

    def commit_manifest(
        self,
        *,
        checkpoint_id: str,
        project_id: str,
        tenant_id: str,
        files: Mapping[str, str],
        parent_id: str | None = None,
        db_snapshot_id: str | None = None,
        verified: bool = False,
        label: str | None = None,
        created_by_run_id: str | None = None,
        created_at: datetime | None = None,
    ) -> CheckpointRecord:
        ensure_blobs_present(self._blobs, files)
        checkpoint = CheckpointRecord(
            checkpoint_id=checkpoint_id,
            tenant_id=tenant_id,
            project_id=project_id,
            manifest=dict(files),
            parent_id=parent_id,
            db_snapshot_id=db_snapshot_id,
            verified=verified,
            label=label,
            created_by_run_id=created_by_run_id,
            **({"created_at": created_at} if created_at is not None else {}),
        )
        return self._records.create(checkpoint)

    def read_file(self, checkpoint: CheckpointRecord, path: str) -> bytes:
        return self._blobs.get(checkpoint.manifest[path])

    def get(self, checkpoint_id: str, *, tenant_id: str) -> CheckpointRecord | None:
        return self._records.get(checkpoint_id, tenant_id=tenant_id)

    def current(self, project_id: str, *, tenant_id: str) -> CheckpointRecord | None:
        return self._records.current(project_id, tenant_id=tenant_id)

    def ancestors(self, checkpoint_id: str, *, tenant_id: str) -> tuple[CheckpointRecord, ...]:
        return self._records.ancestors(checkpoint_id, tenant_id=tenant_id)

    def set_current(self, project_id: str, *, tenant_id: str, checkpoint_id: str) -> None:
        self._records.set_current(project_id, tenant_id=tenant_id, checkpoint_id=checkpoint_id)

    def pin(self, checkpoint_id: str, *, run_id: str) -> None:
        self._records.pin(checkpoint_id, run_id=run_id)

    def unpin(self, checkpoint_id: str, *, run_id: str) -> None:
        self._records.unpin(checkpoint_id, run_id=run_id)

    def is_pinned(self, checkpoint_id: str) -> bool:
        return self._records.is_pinned(checkpoint_id)
