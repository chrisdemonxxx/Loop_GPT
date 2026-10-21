"""Mutable working sets over immutable checkpoints (Doc 02 §4).

A working set is one sandbox's view of a project: reads fall through to the base
checkpoint, writes stay local until committed. Two working sets forked from the
same checkpoint therefore share every unmodified file and diverge only where
they actually differ, which is what makes running two features in parallel
affordable.

Isolation between forks is total by construction — a fork holds its own overlay
and never consults another's — so a parallel task agent cannot observe a
sibling's in-progress writes, and a failed sibling leaves no trace.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from .blobs import digest_of
from .errors import CheckpointError

if TYPE_CHECKING:
    from .tree import Checkpoint, CheckpointStore

ChangeKind = Literal["added", "modified", "deleted"]


@dataclass(frozen=True, slots=True)
class FileChange:
    """One difference between a working set and its base."""

    path: str
    kind: ChangeKind


class WorkingSet:
    """A copy-on-write view of one checkpoint.

    Not thread-safe by design: a working set belongs to exactly one sandbox and
    one run. Sharing one across concurrent writers would reintroduce precisely
    the interference that forking exists to prevent.
    """

    def __init__(self, *, store: CheckpointStore, base: Checkpoint, run_id: str) -> None:
        self._store = store
        self._base = base
        self._run_id = run_id
        self._writes: dict[str, bytes] = {}
        self._deletes: set[str] = set()
        self._committed = False

    @property
    def base(self) -> Checkpoint:
        return self._base

    @property
    def run_id(self) -> str:
        return self._run_id

    @property
    def tenant_id(self) -> str:
        return self._base.tenant_id

    # --- Reads ----------------------------------------------------------------

    def read(self, path: str) -> bytes:
        """Read through the overlay to the base checkpoint."""
        if path in self._deletes:
            raise CheckpointError(f"{path!r} was deleted in this working set")
        if path in self._writes:
            return self._writes[path]
        return self._store.read_file(self._base, path)

    def exists(self, path: str) -> bool:
        if path in self._deletes:
            return False
        return path in self._writes or path in self._base

    def paths(self) -> Iterator[str]:
        """Every path visible in this working set, base plus overlay."""
        seen = set(self._base.files) | set(self._writes)
        yield from sorted(seen - self._deletes)

    # --- Writes ---------------------------------------------------------------

    def write(self, path: str, content: bytes) -> None:
        self._guard_open()
        self._deletes.discard(path)
        self._writes[path] = content

    def delete(self, path: str) -> None:
        self._guard_open()
        if not self.exists(path):
            raise CheckpointError(f"cannot delete {path!r}: it does not exist")
        self._writes.pop(path, None)
        if path in self._base:
            self._deletes.add(path)

    # --- Diff and commit ------------------------------------------------------

    def changes(self) -> tuple[FileChange, ...]:
        """What this working set changed relative to its base."""
        changes: list[FileChange] = []

        for path, content in sorted(self._writes.items()):
            if path not in self._base:
                changes.append(FileChange(path, "added"))
            else:
                if digest_of(content) != self._base.digest_for(path):
                    changes.append(FileChange(path, "modified"))

        changes.extend(FileChange(path, "deleted") for path in sorted(self._deletes))
        return tuple(changes)

    @property
    def is_dirty(self) -> bool:
        return bool(self.changes())

    def manifest(self) -> Mapping[str, str]:
        """The path → digest manifest this working set would commit.

        Unchanged files carry their existing digest straight through, so a commit
        stores only what actually changed.
        """
        manifest = {
            path: digest for path, digest in self._base.files.items() if path not in self._deletes
        }
        for path, content in self._writes.items():
            manifest[path] = self._store_blob(content)
        return manifest

    def commit(
        self,
        *,
        verified: bool = False,
        label: str | None = None,
        db_snapshot_id: str | None = None,
    ) -> Checkpoint:
        """Freeze this working set into a new immutable checkpoint.

        A working set commits once. Continuing to write after a commit would
        make the checkpoint a description of a moment that no longer exists, so
        further writes are refused.
        """
        self._guard_open()
        checkpoint = self._store.commit_manifest(
            project_id=self._base.project_id,
            tenant_id=self._base.tenant_id,
            files=self.manifest(),
            parent_id=self._base.checkpoint_id,
            db_snapshot_id=db_snapshot_id
            if db_snapshot_id is not None
            else self._base.db_snapshot_id,
            verified=verified,
            label=label,
        )
        self._committed = True
        return checkpoint

    def discard(self) -> None:
        """Throw the working set away and release its hold on the base."""
        self._writes.clear()
        self._deletes.clear()
        self._committed = True
        self._store.unpin(self._base.checkpoint_id, run_id=self._run_id)

    def _store_blob(self, content: bytes) -> str:
        return self._store.put_blob(content)

    def _guard_open(self) -> None:
        if self._committed:
            raise CheckpointError(
                "this working set is already committed or discarded; fork the resulting "
                "checkpoint to continue working"
            )
