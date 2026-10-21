"""Tests for copy-on-write working sets.

The load-bearing property is fork independence: two agents working the same base
in parallel must be unable to see or corrupt each other's in-progress writes.
"""

from __future__ import annotations

import pytest
from loopit_checkpoint import (
    Checkpoint,
    CheckpointError,
    CheckpointStore,
    FileChange,
    InMemoryBlobStore,
    WorkingSet,
)

TENANT = "tenant_acme"
PROJECT = "proj_shop"

BASE_FILES = {
    "app.py": b"def main():\n    pass\n",
    "README.md": b"# Shop\n",
}


@pytest.fixture
def store() -> CheckpointStore:
    return CheckpointStore(InMemoryBlobStore())


@pytest.fixture
def base(store: CheckpointStore) -> Checkpoint:
    return store.snapshot(
        project_id=PROJECT, tenant_id=TENANT, files=dict(BASE_FILES), verified=True
    )


@pytest.fixture
def workset(store: CheckpointStore, base: Checkpoint) -> WorkingSet:
    return store.fork(base, tenant_id=TENANT, run_id="run_1")


# --- Reads fall through -------------------------------------------------------


def test_reads_fall_through_to_the_base(workset: WorkingSet) -> None:
    assert workset.read("app.py") == BASE_FILES["app.py"]


def test_a_fork_copies_no_data() -> None:
    blobs = InMemoryBlobStore()
    store = CheckpointStore(blobs)
    base = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files=dict(BASE_FILES))
    blobs_before = len(blobs)

    store.fork(base, tenant_id=TENANT, run_id="run_x")

    assert len(blobs) == blobs_before


def test_writes_shadow_the_base(workset: WorkingSet) -> None:
    workset.write("app.py", b"def main():\n    return 1\n")

    assert workset.read("app.py") == b"def main():\n    return 1\n"


def test_base_checkpoint_is_untouched_by_writes(
    store: CheckpointStore, base: Checkpoint, workset: WorkingSet
) -> None:
    workset.write("app.py", b"mutated")

    assert store.read_file(base, "app.py") == BASE_FILES["app.py"]


def test_paths_merge_base_and_overlay(workset: WorkingSet) -> None:
    workset.write("new.py", b"x")

    assert list(workset.paths()) == ["README.md", "app.py", "new.py"]


def test_forking_pins_the_base(store: CheckpointStore, base: Checkpoint) -> None:
    """Retention must not collect what an open run is diffing against."""
    store.fork(base, tenant_id=TENANT, run_id="run_1")

    assert store.is_pinned(base.checkpoint_id)


# --- Fork independence --------------------------------------------------------


def test_sibling_forks_cannot_see_each_others_writes(
    store: CheckpointStore, base: Checkpoint
) -> None:
    left = store.fork(base, tenant_id=TENANT, run_id="run_left")
    right = store.fork(base, tenant_id=TENANT, run_id="run_right")

    left.write("app.py", b"left version")

    assert right.read("app.py") == BASE_FILES["app.py"]
    assert not right.is_dirty


def test_a_discarded_fork_leaves_no_trace(store: CheckpointStore, base: Checkpoint) -> None:
    doomed = store.fork(base, tenant_id=TENANT, run_id="run_doomed")
    doomed.write("app.py", b"garbage")
    doomed.discard()

    assert store.current(PROJECT, tenant_id=TENANT).checkpoint_id == base.checkpoint_id
    assert not store.is_pinned(base.checkpoint_id)


def test_committed_forks_are_siblings_not_a_chain(store: CheckpointStore, base: Checkpoint) -> None:
    left = store.fork(base, tenant_id=TENANT, run_id="run_left")
    right = store.fork(base, tenant_id=TENANT, run_id="run_right")

    left_ck = left.commit(label="left")
    right_ck = right.commit(label="right")

    assert left_ck.parent_id == base.checkpoint_id
    assert right_ck.parent_id == base.checkpoint_id


# --- Deletes ------------------------------------------------------------------


def test_delete_hides_a_base_file(workset: WorkingSet) -> None:
    workset.delete("README.md")

    assert not workset.exists("README.md")
    with pytest.raises(CheckpointError, match="deleted"):
        workset.read("README.md")


def test_deleting_a_missing_file_is_refused(workset: WorkingSet) -> None:
    with pytest.raises(CheckpointError, match="does not exist"):
        workset.delete("nope.py")


def test_rewriting_a_deleted_path_resurrects_it(workset: WorkingSet) -> None:
    workset.delete("README.md")
    workset.write("README.md", b"# Shop v2\n")

    assert workset.read("README.md") == b"# Shop v2\n"
    assert workset.changes() == (FileChange("README.md", "modified"),)


def test_delete_of_a_local_only_file_removes_it_entirely(workset: WorkingSet) -> None:
    workset.write("scratch.py", b"tmp")
    workset.delete("scratch.py")

    assert not workset.exists("scratch.py")
    assert workset.changes() == ()


# --- Diff ---------------------------------------------------------------------


def test_changes_classify_add_modify_delete(workset: WorkingSet) -> None:
    workset.write("new.py", b"fresh")
    workset.write("app.py", b"changed")
    workset.delete("README.md")

    assert workset.changes() == (
        FileChange("app.py", "modified"),
        FileChange("new.py", "added"),
        FileChange("README.md", "deleted"),
    )


def test_rewriting_identical_content_is_not_a_change(workset: WorkingSet) -> None:
    """Content addressing means a no-op write is invisible, not a phantom diff."""
    workset.write("app.py", BASE_FILES["app.py"])

    assert workset.changes() == ()
    assert not workset.is_dirty


# --- Commit -------------------------------------------------------------------


def test_commit_produces_a_child_checkpoint(
    store: CheckpointStore, base: Checkpoint, workset: WorkingSet
) -> None:
    workset.write("app.py", b"def main():\n    return 1\n")
    child = workset.commit(verified=True, label="add return")

    assert child.parent_id == base.checkpoint_id
    assert child.verified
    assert store.read_file(child, "app.py") == b"def main():\n    return 1\n"


def test_commit_carries_unchanged_files_forward_by_digest(
    base: Checkpoint, workset: WorkingSet
) -> None:
    workset.write("app.py", b"changed")
    child = workset.commit()

    assert child.files["README.md"] == base.files["README.md"]


def test_commit_drops_deleted_paths(workset: WorkingSet) -> None:
    workset.delete("README.md")
    child = workset.commit()

    assert "README.md" not in child.files


def test_commit_inherits_the_database_snapshot(
    store: CheckpointStore,
) -> None:
    """Files and schema must stay bound together across every commit."""
    base = store.snapshot(
        project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"}, db_snapshot_id="snap_7"
    )
    workset = store.fork(base, tenant_id=TENANT, run_id="run_1")
    workset.write("a.py", b"2")

    assert workset.commit().db_snapshot_id == "snap_7"


def test_commit_can_take_a_new_database_snapshot(store: CheckpointStore) -> None:
    base = store.snapshot(
        project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"}, db_snapshot_id="snap_7"
    )
    workset = store.fork(base, tenant_id=TENANT, run_id="run_1")
    workset.write("a.py", b"2")

    assert workset.commit(db_snapshot_id="snap_8").db_snapshot_id == "snap_8"


def test_a_working_set_commits_once(workset: WorkingSet) -> None:
    workset.write("app.py", b"changed")
    workset.commit()

    with pytest.raises(CheckpointError, match="already committed"):
        workset.write("app.py", b"changed again")
    with pytest.raises(CheckpointError, match="already committed"):
        workset.commit()


def test_a_discarded_working_set_refuses_further_writes(workset: WorkingSet) -> None:
    workset.discard()

    with pytest.raises(CheckpointError, match="already committed"):
        workset.write("app.py", b"too late")


def test_working_set_exposes_its_tenant(workset: WorkingSet) -> None:
    assert workset.tenant_id == TENANT
    assert workset.run_id == "run_1"


def test_fork_refuses_a_foreign_tenant(store: CheckpointStore, base: Checkpoint) -> None:
    from loopit_checkpoint import CrossTenantAccess

    with pytest.raises(CrossTenantAccess):
        store.fork(base, tenant_id="tenant_intruder", run_id="run_evil")
