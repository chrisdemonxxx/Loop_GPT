"""Tests for the immutable checkpoint tree.

The properties under test are the ones a user's work depends on: rollback loses
nothing, tenants cannot read each other's code, and retention never collects a
checkpoint something is still standing on.
"""

from __future__ import annotations

import pytest
from loopit_checkpoint import (
    CheckpointError,
    CheckpointNotFound,
    CheckpointStore,
    CrossTenantAccess,
    ImmutabilityViolation,
    InconsistentSnapshot,
    InMemoryBlobStore,
    PruneRefused,
)

TENANT = "tenant_acme"
PROJECT = "proj_shop"


@pytest.fixture
def store() -> CheckpointStore:
    return CheckpointStore(InMemoryBlobStore())


def test_checkpoint_fields_cannot_be_reassigned(store: CheckpointStore) -> None:
    checkpoint = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"app.py": b"x = 1\n"})

    with pytest.raises(ImmutabilityViolation):
        checkpoint.verified = True


def test_checkpoint_manifest_cannot_be_edited_through_a_reference(
    store: CheckpointStore,
) -> None:
    checkpoint = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"app.py": b"x = 1\n"})

    with pytest.raises(TypeError):
        checkpoint.files["app.py"] = "deadbeef"  # type: ignore[index]


def test_checkpoint_requires_a_tenant(store: CheckpointStore) -> None:
    with pytest.raises(CheckpointError, match="project and a tenant"):
        store.snapshot(project_id=PROJECT, tenant_id="", files={})


# --- Structure ----------------------------------------------------------------


def test_snapshot_records_parent_and_becomes_current(store: CheckpointStore) -> None:
    first = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})
    second = store.snapshot(
        project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"2"}, parent_id=first.checkpoint_id
    )

    assert second.parent_id == first.checkpoint_id
    assert store.current(PROJECT, tenant_id=TENANT).checkpoint_id == second.checkpoint_id


def test_ancestors_walk_to_the_root(store: CheckpointStore) -> None:
    a = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})
    b = store.snapshot(
        project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"2"}, parent_id=a.checkpoint_id
    )
    c = store.snapshot(
        project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"3"}, parent_id=b.checkpoint_id
    )

    assert [ck.checkpoint_id for ck in store.ancestors(c)] == [
        b.checkpoint_id,
        a.checkpoint_id,
    ]


def test_unchanged_files_share_one_blob() -> None:
    blobs = InMemoryBlobStore()
    store = CheckpointStore(blobs)
    first = store.snapshot(
        project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"same", "b.py": b"one"}
    )
    store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files={"a.py": b"same", "b.py": b"two"},
        parent_id=first.checkpoint_id,
    )

    assert len(blobs) == 3


def test_parent_must_belong_to_the_same_project(store: CheckpointStore) -> None:
    other = store.snapshot(project_id="proj_other", tenant_id=TENANT, files={"a.py": b"1"})

    with pytest.raises(CheckpointError, match="belongs to project"):
        store.snapshot(
            project_id=PROJECT,
            tenant_id=TENANT,
            files={"a.py": b"2"},
            parent_id=other.checkpoint_id,
        )


def test_commit_manifest_refuses_dangling_digests(store: CheckpointStore) -> None:
    with pytest.raises(CheckpointError, match="not stored"):
        store.commit_manifest(project_id=PROJECT, tenant_id=TENANT, files={"a.py": "0" * 64})


# --- Tenant isolation ---------------------------------------------------------


def test_another_tenant_cannot_read_a_checkpoint(store: CheckpointStore) -> None:
    checkpoint = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"secret.py": b"KEY"})

    with pytest.raises(CrossTenantAccess):
        store.get(checkpoint.checkpoint_id, tenant_id="tenant_intruder")


def test_cross_tenant_access_is_loud_not_a_silent_miss(store: CheckpointStore) -> None:
    """A probe must be distinguishable from an ordinary miss in the audit log."""
    checkpoint = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})

    with pytest.raises(CrossTenantAccess):
        store.get(checkpoint.checkpoint_id, tenant_id="tenant_intruder")
    with pytest.raises(CheckpointNotFound):
        store.get("ckpt_does_not_exist", tenant_id=TENANT)


def test_current_is_tenant_scoped(store: CheckpointStore) -> None:
    store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})

    with pytest.raises(CrossTenantAccess):
        store.current(PROJECT, tenant_id="tenant_intruder")


def test_current_for_unknown_project(store: CheckpointStore) -> None:
    with pytest.raises(CheckpointNotFound, match="no checkpoints"):
        store.current("proj_nothing", tenant_id=TENANT)


# --- Rollback -----------------------------------------------------------------


def test_rollback_moves_a_pointer_and_destroys_nothing(store: CheckpointStore) -> None:
    first = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})
    second = store.snapshot(
        project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"2"}, parent_id=first.checkpoint_id
    )

    store.rollback(PROJECT, first.checkpoint_id, tenant_id=TENANT)

    assert store.current(PROJECT, tenant_id=TENANT).checkpoint_id == first.checkpoint_id
    assert store.get(second.checkpoint_id, tenant_id=TENANT) is second


def test_rollback_is_itself_reversible(store: CheckpointStore) -> None:
    first = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})
    second = store.snapshot(
        project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"2"}, parent_id=first.checkpoint_id
    )

    store.rollback(PROJECT, first.checkpoint_id, tenant_id=TENANT)
    store.rollback(PROJECT, second.checkpoint_id, tenant_id=TENANT)

    assert store.read_file(store.current(PROJECT, tenant_id=TENANT), "a.py") == b"2"


def test_rollback_refuses_to_split_files_from_their_database(store: CheckpointStore) -> None:
    """Files restored without their schema look recovered and are not."""
    before_db = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})
    store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files={"a.py": b"2"},
        parent_id=before_db.checkpoint_id,
        db_snapshot_id="snap_001",
    )

    with pytest.raises(InconsistentSnapshot):
        store.rollback(PROJECT, before_db.checkpoint_id, tenant_id=TENANT)


def test_rollback_rejects_a_checkpoint_from_another_project(store: CheckpointStore) -> None:
    other = store.snapshot(project_id="proj_other", tenant_id=TENANT, files={"a.py": b"1"})
    store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})

    with pytest.raises(CheckpointError, match="belongs to project"):
        store.rollback(PROJECT, other.checkpoint_id, tenant_id=TENANT)


def test_latest_green_skips_broken_states(store: CheckpointStore) -> None:
    good = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"}, verified=True)
    broken = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files={"a.py": b"syntax error"},
        parent_id=good.checkpoint_id,
    )
    store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files={"a.py": b"still broken"},
        parent_id=broken.checkpoint_id,
    )

    assert store.latest_green(PROJECT, tenant_id=TENANT).checkpoint_id == good.checkpoint_id


def test_latest_green_without_any_verified_checkpoint(store: CheckpointStore) -> None:
    store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})

    with pytest.raises(CheckpointNotFound, match="no verified checkpoint"):
        store.latest_green(PROJECT, tenant_id=TENANT)


# --- Retention ----------------------------------------------------------------


def test_prune_refuses_a_checkpoint_an_open_run_holds(store: CheckpointStore) -> None:
    base = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})
    store.snapshot(
        project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"2"}, parent_id=base.checkpoint_id
    )
    store.pin(base.checkpoint_id, run_id="run_42")

    with pytest.raises(PruneRefused, match="run_42"):
        store.prune(base.checkpoint_id, tenant_id=TENANT)


def test_prune_refuses_the_current_state(store: CheckpointStore) -> None:
    current = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})

    with pytest.raises(PruneRefused, match="current state"):
        store.prune(current.checkpoint_id, tenant_id=TENANT)


def test_prune_refuses_to_orphan_descendants(store: CheckpointStore) -> None:
    parent = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})
    store.snapshot(
        project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"2"}, parent_id=parent.checkpoint_id
    )

    with pytest.raises(PruneRefused, match="descendant"):
        store.prune(parent.checkpoint_id, tenant_id=TENANT)


def test_prune_succeeds_once_nothing_references_it(store: CheckpointStore) -> None:
    root = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})
    leaf = store.snapshot(
        project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"2"}, parent_id=root.checkpoint_id
    )
    store.rollback(PROJECT, root.checkpoint_id, tenant_id=TENANT)
    store.pin(leaf.checkpoint_id, run_id="run_1")
    store.unpin(leaf.checkpoint_id, run_id="run_1")

    store.prune(leaf.checkpoint_id, tenant_id=TENANT)

    assert not store.is_pinned(leaf.checkpoint_id)
    with pytest.raises(CheckpointNotFound):
        store.get(leaf.checkpoint_id, tenant_id=TENANT)


def test_pin_survives_one_of_several_runs_finishing(store: CheckpointStore) -> None:
    base = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})
    store.pin(base.checkpoint_id, run_id="run_a")
    store.pin(base.checkpoint_id, run_id="run_b")

    store.unpin(base.checkpoint_id, run_id="run_a")

    assert store.is_pinned(base.checkpoint_id)


def test_prune_is_tenant_scoped(store: CheckpointStore) -> None:
    checkpoint = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})

    with pytest.raises(CrossTenantAccess):
        store.prune(checkpoint.checkpoint_id, tenant_id="tenant_intruder")
