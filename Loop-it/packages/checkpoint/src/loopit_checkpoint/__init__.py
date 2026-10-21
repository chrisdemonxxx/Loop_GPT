"""Copy-on-write checkpoints (Doc 02 §4, Doc 06 §3, ADR-0010).

Copy-on-write is what makes forks, parallel task agents, and "undo the last
hour" affordable. Three properties carry that weight:

* **Checkpoints are immutable and form a tree.** Rolling back moves a pointer;
  it destroys nothing. Undo is therefore itself undoable, which is the only
  version of undo a user will trust with an hour of work.
* **They live off the VM.** Sandboxes are cattle — destroyed after every run —
  so durable state cannot sit on one (ADR-0010).
* **Files and DB snapshot move together.** A rollback that restores files
  without their matching schema produces a broken app that looks restored,
  which is worse than a failed restore.
"""

from .blobs import BlobStore, FileSystemBlobStore, InMemoryBlobStore, digest_of
from .durable import FileCheckpointStore
from .errors import (
    CheckpointError,
    CheckpointNotFound,
    CrossTenantAccess,
    ImmutabilityViolation,
    InconsistentSnapshot,
    PruneRefused,
)
from .records import ContentAddressedCheckpointStore
from .tree import Checkpoint, CheckpointStore
from .workset import FileChange, WorkingSet

__all__ = [
    "BlobStore",
    "Checkpoint",
    "CheckpointError",
    "CheckpointNotFound",
    "CheckpointStore",
    "ContentAddressedCheckpointStore",
    "CrossTenantAccess",
    "FileChange",
    "FileCheckpointStore",
    "FileSystemBlobStore",
    "ImmutabilityViolation",
    "InMemoryBlobStore",
    "InconsistentSnapshot",
    "PruneRefused",
    "WorkingSet",
    "digest_of",
]
