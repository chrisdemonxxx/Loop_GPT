"""The file-backed checkpoint tree must come back identical after a restart."""

from __future__ import annotations

from pathlib import Path

import pytest
from loopit_checkpoint import CrossTenantAccess, FileCheckpointStore

TENANT = "tenant_acme"
PROJECT = "proj_shop"


def test_tree_current_pointer_and_bytes_survive_a_restart(tmp_path: Path) -> None:
    store = FileCheckpointStore(tmp_path)
    first = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files={"index.html": b"v1", "logo.png": b"\x89PNG\x00"},
    )
    second = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files={"index.html": b"v2"},
        parent_id=first.checkpoint_id,
        verified=True,
        label="green",
    )
    store.rollback(PROJECT, first.checkpoint_id, tenant_id=TENANT)

    reopened = FileCheckpointStore(tmp_path)

    listed = reopened.list_for_project(PROJECT, tenant_id=TENANT)
    assert [c.checkpoint_id for c in listed] == [first.checkpoint_id, second.checkpoint_id]
    restored = reopened.get(second.checkpoint_id, tenant_id=TENANT)
    assert restored.parent_id == first.checkpoint_id
    assert restored.verified is True
    assert restored.label == "green"
    assert restored.created_at == second.created_at
    assert reopened.current(PROJECT, tenant_id=TENANT).checkpoint_id == first.checkpoint_id
    assert reopened.read_file(restored, "index.html") == b"v2"
    assert reopened.read_file(first, "logo.png") == b"\x89PNG\x00"


def test_reloaded_tree_still_refuses_cross_tenant_reads(tmp_path: Path) -> None:
    checkpoint = FileCheckpointStore(tmp_path).snapshot(
        project_id=PROJECT, tenant_id=TENANT, files={"a.txt": b"a"}
    )

    with pytest.raises(CrossTenantAccess):
        FileCheckpointStore(tmp_path).get(checkpoint.checkpoint_id, tenant_id="tenant_other")


def test_prune_is_persisted(tmp_path: Path) -> None:
    store = FileCheckpointStore(tmp_path)
    old = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.txt": b"a"})
    store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.txt": b"b"})
    store.prune(old.checkpoint_id, tenant_id=TENANT)

    assert len(FileCheckpointStore(tmp_path)) == 1


def test_unusual_ids_are_stored_under_safe_names(tmp_path: Path) -> None:
    store = FileCheckpointStore(tmp_path)
    store.snapshot(project_id="proj_1", tenant_id="org/../evil", files={"a.txt": b"a"})

    assert all(path.is_relative_to(tmp_path / "index") for path in tmp_path.rglob("*.json"))
    assert FileCheckpointStore(tmp_path).current("proj_1", tenant_id="org/../evil")


def test_a_corrupt_index_skips_only_that_project(tmp_path: Path) -> None:
    store = FileCheckpointStore(tmp_path)
    store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.txt": b"a"})
    store.snapshot(project_id="proj_other", tenant_id=TENANT, files={"b.txt": b"b"})
    (tmp_path / "index" / TENANT / "proj_other.json").write_text("{not json", encoding="utf-8")

    reopened = FileCheckpointStore(tmp_path)

    assert reopened.list_for_project(PROJECT, tenant_id=TENANT)
    assert reopened.list_for_project("proj_other", tenant_id=TENANT) == ()
