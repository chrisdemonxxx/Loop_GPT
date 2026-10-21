"""The immutable checkpoint tree (Doc 06 §3, Doc 07 §6.2).

A checkpoint is a manifest — path → blob digest — plus its parent. Nothing is
ever edited: a rollback creates no data and destroys none, it only moves the
project's current pointer. Later checkpoints stay in the tree, so undoing an
undo is just another pointer move.

Tenant isolation is enforced on every read. Checkpoints are the durable form of
a tenant's entire codebase, so a cross-tenant read here is the highest-value
target in the data plane.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import MappingProxyType
from typing import TYPE_CHECKING

from .blobs import BlobStore, ensure_blobs_present
from .errors import (
    CheckpointError,
    CheckpointNotFound,
    CrossTenantAccess,
    ImmutabilityViolation,
    InconsistentSnapshot,
    PruneRefused,
)

if TYPE_CHECKING:
    from .workset import WorkingSet


@dataclass(slots=True)
class Checkpoint:
    """An immutable snapshot of a project's filesystem at one moment.

    Immutability is enforced rather than documented: attribute assignment after
    construction raises. A checkpoint that could be edited in place would let a
    later run rewrite what an earlier one is diffing against, and the audit
    trail would describe a history that no longer exists.

    Attributes:
        files: path → blob digest. A mapping proxy, so the manifest cannot be
            edited through a reference someone kept.
        db_snapshot_id: the project database snapshot taken at the same moment.
            Stored on the checkpoint rather than beside it so the two cannot be
            restored independently and produce files-without-schema.
        verified: whether verification was green here. Rollback targets default
            to green checkpoints — restoring to a known-broken state is rarely
            what "undo" is meant to do.
    """

    checkpoint_id: str
    project_id: str
    tenant_id: str
    files: Mapping[str, str]
    parent_id: str | None = None
    db_snapshot_id: str | None = None
    verified: bool = False
    label: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        if not self.project_id or not self.tenant_id:
            raise CheckpointError("a checkpoint must be bound to a project and a tenant")
        object.__setattr__(self, "files", MappingProxyType(dict(self.files)))

    def __setattr__(self, name: str, value: object) -> None:
        if hasattr(self, name):
            raise ImmutabilityViolation(
                f"cannot reassign {name!r}: checkpoint {self.checkpoint_id} is immutable; "
                "record a new checkpoint instead"
            )
        object.__setattr__(self, name, value)

    def __delattr__(self, name: str) -> None:
        raise ImmutabilityViolation(f"cannot delete {name!r}: checkpoints are immutable")

    def digest_for(self, path: str) -> str:
        try:
            return self.files[path]
        except KeyError:
            raise CheckpointError(f"{path!r} is not in checkpoint {self.checkpoint_id}") from None

    def __contains__(self, path: str) -> bool:
        return path in self.files


class CheckpointStore:
    """The checkpoint tree for all projects, held in data-plane storage.

    In-memory here; the production implementation is the same interface over
    Postgres plus object storage. Keeping the interface narrow is what lets the
    scheduler and orchestrator depend on checkpoints without depending on where
    they are kept.
    """

    def __init__(self, blobs: BlobStore) -> None:
        self._blobs = blobs
        self._checkpoints: dict[str, Checkpoint] = {}
        self._current: dict[str, str] = {}
        self._pins: dict[str, set[str]] = {}

    # --- Writing --------------------------------------------------------------

    def snapshot(
        self,
        *,
        project_id: str,
        tenant_id: str,
        files: Mapping[str, bytes],
        parent_id: str | None = None,
        db_snapshot_id: str | None = None,
        verified: bool = False,
        label: str | None = None,
    ) -> Checkpoint:
        """Take a checkpoint from raw file contents.

        Copies no data for files that already exist as blobs, which is what makes
        checkpointing cheap enough to do on every verified-good step.
        """
        if parent_id is not None:
            parent = self.get(parent_id, tenant_id=tenant_id)
            if parent.project_id != project_id:
                raise CheckpointError(
                    f"parent {parent_id} belongs to project {parent.project_id}, not {project_id}"
                )

        manifest = {path: self._blobs.put(content) for path, content in files.items()}
        return self._commit(
            project_id=project_id,
            tenant_id=tenant_id,
            files=manifest,
            parent_id=parent_id,
            db_snapshot_id=db_snapshot_id,
            verified=verified,
            label=label,
        )

    def commit_manifest(
        self,
        *,
        project_id: str,
        tenant_id: str,
        files: Mapping[str, str],
        parent_id: str | None = None,
        db_snapshot_id: str | None = None,
        verified: bool = False,
        label: str | None = None,
    ) -> Checkpoint:
        """Take a checkpoint from an already-resolved manifest.

        Used by :meth:`WorkingSet.commit`, where unchanged files are already
        known by digest and re-reading their contents would defeat the point of
        copy-on-write.
        """
        ensure_blobs_present(self._blobs, files)
        return self._commit(
            project_id=project_id,
            tenant_id=tenant_id,
            files=files,
            parent_id=parent_id,
            db_snapshot_id=db_snapshot_id,
            verified=verified,
            label=label,
        )

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
        checkpoint = Checkpoint(
            checkpoint_id=f"ckpt_{uuid.uuid4().hex}",
            project_id=project_id,
            tenant_id=tenant_id,
            files=files,
            parent_id=parent_id,
            db_snapshot_id=db_snapshot_id,
            verified=verified,
            label=label,
        )
        self._checkpoints[checkpoint.checkpoint_id] = checkpoint
        self._current[project_id] = checkpoint.checkpoint_id
        return checkpoint

    # --- Reading --------------------------------------------------------------

    def get(self, checkpoint_id: str, *, tenant_id: str) -> Checkpoint:
        """Fetch a checkpoint, refusing cross-tenant reads."""
        try:
            checkpoint = self._checkpoints[checkpoint_id]
        except KeyError:
            raise CheckpointNotFound(f"no checkpoint {checkpoint_id!r}") from None

        if checkpoint.tenant_id != tenant_id:
            raise CrossTenantAccess(
                f"tenant {tenant_id!r} may not read checkpoint {checkpoint_id!r}"
            )
        return checkpoint

    def read_file(self, checkpoint: Checkpoint, path: str) -> bytes:
        return self._blobs.get(checkpoint.digest_for(path))

    def put_blob(self, content: bytes) -> str:
        """Store file content and return its digest."""
        return self._blobs.put(content)

    def current(self, project_id: str, *, tenant_id: str) -> Checkpoint:
        """The checkpoint the project currently points at."""
        try:
            checkpoint_id = self._current[project_id]
        except KeyError:
            raise CheckpointNotFound(f"project {project_id!r} has no checkpoints") from None
        return self.get(checkpoint_id, tenant_id=tenant_id)

    def ancestors(self, checkpoint: Checkpoint) -> Iterator[Checkpoint]:
        """Walk from a checkpoint's parent to the root."""
        parent_id = checkpoint.parent_id
        while parent_id is not None:
            parent = self._checkpoints[parent_id]
            yield parent
            parent_id = parent.parent_id

    def latest_green(self, project_id: str, *, tenant_id: str) -> Checkpoint:
        """The most recent verified checkpoint — the default rollback target."""
        candidate: Checkpoint | None = self.current(project_id, tenant_id=tenant_id)
        while candidate is not None:
            if candidate.verified:
                return candidate
            candidate = (
                self._checkpoints[candidate.parent_id] if candidate.parent_id is not None else None
            )
        raise CheckpointNotFound(
            f"project {project_id!r} has no verified checkpoint to roll back to"
        )

    def list_for_project(self, project_id: str, *, tenant_id: str) -> tuple[Checkpoint, ...]:
        """All checkpoints for a project in creation order, tenant-scoped."""
        return tuple(
            checkpoint
            for checkpoint in sorted(self._checkpoints.values(), key=lambda item: item.created_at)
            if checkpoint.project_id == project_id and checkpoint.tenant_id == tenant_id
        )

    # --- Forking and rollback -------------------------------------------------

    def fork(self, checkpoint: Checkpoint, *, tenant_id: str, run_id: str) -> WorkingSet:
        """Open a mutable working set over an immutable base.

        Pins the base for the life of the run so it cannot be pruned out from
        under the work that is diffing against it.
        """
        from .workset import WorkingSet

        base = self.get(checkpoint.checkpoint_id, tenant_id=tenant_id)
        self.pin(base.checkpoint_id, run_id=run_id)
        return WorkingSet(store=self, base=base, run_id=run_id)

    def rollback(self, project_id: str, checkpoint_id: str, *, tenant_id: str) -> Checkpoint:
        """Point the project at an earlier checkpoint.

        Destroys nothing: later checkpoints stay in the tree, so the rollback is
        itself reversible.
        """
        target = self.get(checkpoint_id, tenant_id=tenant_id)
        if target.project_id != project_id:
            raise CheckpointError(
                f"checkpoint {checkpoint_id} belongs to project {target.project_id}"
            )

        live = self._current.get(project_id)
        if (
            live is not None
            and self._checkpoints[live].db_snapshot_id is not None
            and target.db_snapshot_id is None
        ):
            raise InconsistentSnapshot(
                f"checkpoint {checkpoint_id} has no database snapshot but the project has "
                "database state; restoring files alone would leave schema and code out of step"
            )

        self._current[project_id] = checkpoint_id
        return target

    # --- Retention ------------------------------------------------------------

    def pin(self, checkpoint_id: str, *, run_id: str) -> None:
        """Mark a checkpoint as in use by an open run."""
        self._pins.setdefault(checkpoint_id, set()).add(run_id)

    def unpin(self, checkpoint_id: str, *, run_id: str) -> None:
        holders = self._pins.get(checkpoint_id)
        if holders:
            holders.discard(run_id)
            if not holders:
                del self._pins[checkpoint_id]

    def is_pinned(self, checkpoint_id: str) -> bool:
        return bool(self._pins.get(checkpoint_id))

    def prune(self, checkpoint_id: str, *, tenant_id: str) -> None:
        """Remove a checkpoint, refusing if anything still depends on it."""
        checkpoint = self.get(checkpoint_id, tenant_id=tenant_id)

        if self.is_pinned(checkpoint_id):
            holders = ", ".join(sorted(self._pins[checkpoint_id]))
            raise PruneRefused(f"checkpoint {checkpoint_id} is in use by run(s): {holders}")

        if self._current.get(checkpoint.project_id) == checkpoint_id:
            raise PruneRefused(
                f"checkpoint {checkpoint_id} is the current state of project "
                f"{checkpoint.project_id}"
            )

        children = [
            other.checkpoint_id
            for other in self._checkpoints.values()
            if other.parent_id == checkpoint_id
        ]
        if children:
            raise PruneRefused(
                f"checkpoint {checkpoint_id} has {len(children)} descendant(s); pruning it "
                "would orphan them"
            )

        del self._checkpoints[checkpoint_id]

    def __len__(self) -> int:
        return len(self._checkpoints)
