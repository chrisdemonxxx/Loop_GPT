"""Tests for content-addressed blob storage."""

from __future__ import annotations

from pathlib import Path

import pytest
from loopit_checkpoint import (
    CheckpointError,
    FileSystemBlobStore,
    InMemoryBlobStore,
    digest_of,
)


def test_digest_is_stable_and_content_addressed() -> None:
    assert digest_of(b"hello") == digest_of(b"hello")
    assert digest_of(b"hello") != digest_of(b"hellp")
    assert len(digest_of(b"")) == 64


def test_identical_content_is_stored_once() -> None:
    """Deduplication is the whole economic argument for copy-on-write."""
    store = InMemoryBlobStore()
    first = store.put(b"import sys\n")
    second = store.put(b"import sys\n")

    assert first == second
    assert len(store) == 1


def test_roundtrip_in_memory() -> None:
    store = InMemoryBlobStore()
    digest = store.put(b"payload")
    assert store.get(digest) == b"payload"
    assert store.has(digest)


def test_missing_blob_is_an_error_not_empty_bytes() -> None:
    store = InMemoryBlobStore()
    with pytest.raises(CheckpointError, match="missing"):
        store.get(digest_of(b"never stored"))


def test_corrupt_blob_is_detected_on_read() -> None:
    """A silent restore from torn content produces a broken project."""
    store = InMemoryBlobStore()
    digest = store.put(b"good")
    store._blobs[digest] = b"tampered"

    with pytest.raises(CheckpointError, match="corrupt"):
        store.get(digest)


def test_filesystem_roundtrip_and_sharding(tmp_path: Path) -> None:
    store = FileSystemBlobStore(tmp_path)
    digest = store.put(b"on disk")

    assert store.get(digest) == b"on disk"
    assert (tmp_path / digest[:2] / digest[2:]).exists()


def test_filesystem_reput_is_a_noop(tmp_path: Path) -> None:
    store = FileSystemBlobStore(tmp_path)
    digest = store.put(b"same")
    written_at = (tmp_path / digest[:2] / digest[2:]).stat().st_mtime_ns

    assert store.put(b"same") == digest
    assert (tmp_path / digest[:2] / digest[2:]).stat().st_mtime_ns == written_at


def test_filesystem_leaves_no_partial_files(tmp_path: Path) -> None:
    store = FileSystemBlobStore(tmp_path)
    store.put(b"complete")

    assert not list(tmp_path.rglob("*.partial"))


def test_filesystem_detects_corruption(tmp_path: Path) -> None:
    store = FileSystemBlobStore(tmp_path)
    digest = store.put(b"original")
    (tmp_path / digest[:2] / digest[2:]).write_bytes(b"swapped")

    with pytest.raises(CheckpointError, match="corrupt"):
        store.get(digest)


def test_two_stores_agree_on_addresses(tmp_path: Path) -> None:
    """Digests must not depend on the backend, or migration rewrites every manifest."""
    memory = InMemoryBlobStore()
    disk = FileSystemBlobStore(tmp_path)

    assert memory.put(b"portable") == disk.put(b"portable")
