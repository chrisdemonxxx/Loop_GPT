"""Content-addressed blob storage — the mechanism behind copy-on-write.

Files are stored under the SHA-256 of their contents. Two checkpoints that share
an unchanged file therefore share one blob automatically, with no diffing and no
reference bookkeeping: taking a checkpoint copies no data, and a thousand
checkpoints of a project that changed one file cost one file.

Content addressing also makes corruption detectable — a blob that no longer
hashes to its own key is torn, and a restore that silently proceeds from a torn
blob is how a "successful" restore produces a broken project.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from pathlib import Path
from typing import Protocol, runtime_checkable

from .errors import CheckpointError


def digest_of(content: bytes) -> str:
    """The content address of ``content``."""
    return hashlib.sha256(content).hexdigest()


@runtime_checkable
class BlobStore(Protocol):
    """Where file contents live. Data-plane storage, never the sandbox VM."""

    def put(self, content: bytes) -> str:
        """Store ``content`` and return its digest. Idempotent by construction."""
        ...

    def get(self, digest: str) -> bytes:
        """Fetch content by digest, verifying it still hashes to that digest."""
        ...

    def has(self, digest: str) -> bool: ...


def ensure_blobs_present(blobs: BlobStore, files: Mapping[str, str]) -> None:
    missing = [digest for digest in files.values() if not blobs.has(digest)]
    if missing:
        raise CheckpointError(
            f"manifest references {len(missing)} blob(s) that are not stored; "
            "a checkpoint must never point at content that does not exist"
        )


class InMemoryBlobStore:
    """A blob store for tests and local development."""

    def __init__(self) -> None:
        self._blobs: dict[str, bytes] = {}

    def put(self, content: bytes) -> str:
        digest = digest_of(content)
        self._blobs[digest] = content
        return digest

    def get(self, digest: str) -> bytes:
        try:
            content = self._blobs[digest]
        except KeyError:
            raise CheckpointError(f"blob {digest[:12]}... is missing") from None
        _verify(digest, content)
        return content

    def has(self, digest: str) -> bool:
        return digest in self._blobs

    def __len__(self) -> int:
        return len(self._blobs)


class FileSystemBlobStore:
    """A blob store backed by a directory tree.

    Blobs are sharded by the first two hex characters because a single directory
    holding a million entries is pathological on most filesystems, and a busy
    project produces blobs at exactly that rate.

    Writes go to a temporary file and are then renamed, so a crash mid-write
    leaves no partial blob that later reads would treat as real.
    """

    def __init__(self, root: Path) -> None:
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True)

    def _path(self, digest: str) -> Path:
        return self._root / digest[:2] / digest[2:]

    def put(self, content: bytes) -> str:
        digest = digest_of(content)
        path = self._path(digest)
        if path.exists():
            return digest

        path.parent.mkdir(parents=True, exist_ok=True)
        staging = path.with_suffix(".partial")
        staging.write_bytes(content)
        staging.replace(path)
        return digest

    def get(self, digest: str) -> bytes:
        path = self._path(digest)
        if not path.exists():
            raise CheckpointError(f"blob {digest[:12]}... is missing")
        content = path.read_bytes()
        _verify(digest, content)
        return content

    def has(self, digest: str) -> bool:
        return self._path(digest).exists()


def _verify(digest: str, content: bytes) -> None:
    actual = digest_of(content)
    if actual != digest:
        raise CheckpointError(
            f"blob {digest[:12]}... is corrupt: content hashes to {actual[:12]}...; "
            "restoring from it would produce a project that looks recovered but is not"
        )
