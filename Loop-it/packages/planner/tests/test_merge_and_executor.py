from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import pytest
from loopit_checkpoint import Checkpoint, CheckpointStore, InMemoryBlobStore
from loopit_planner import (
    ForkLease,
    Invalidation,
    NodeAttempt,
    NodeRunResult,
    OfflineParallelDagExecutor,
    TaskDAG,
    TaskNode,
    detect_conflicts,
    preserve_completed_and_replan_remaining,
)
from loopit_policy import PlanLimits


def make_store() -> tuple[CheckpointStore, Checkpoint]:
    store = CheckpointStore(InMemoryBlobStore())
    base = store.snapshot(
        project_id="project",
        tenant_id="tenant",
        files={"README.md": b"base", "src/shared.ts": b"shared"},
        verified=True,
        label="green",
    )
    return store, base


def task(node_id: str, parents: tuple[str, ...] = ()) -> TaskNode:
    return TaskNode(
        id=node_id,
        kind="add_ui_component",
        goal=f"implement {node_id}",
        dag_parents=parents,
        fork_checkpoint_id="green",
        expected_verification=("L0_typecheck_lint", "L1_tests", "L2_browser_smoke"),
        destructive=False,
    )


def commit_change(
    store: CheckpointStore, base: Checkpoint, path: str, content: bytes
) -> Checkpoint:
    workset = store.fork(base, tenant_id="tenant", run_id=path)
    workset.write(path, content)
    return workset.commit(verified=True, label=path)


def test_conflict_detection_allows_disjoint_paths() -> None:
    store, base = make_store()
    left = commit_change(store, base, "src/a.ts", b"a")
    right = commit_change(store, base, "src/b.ts", b"b")
    assert detect_conflicts(base, left, right) == ()


def test_conflict_detection_flags_overlapping_different_digests() -> None:
    store, base = make_store()
    left = commit_change(store, base, "src/shared.ts", b"left")
    right = commit_change(store, base, "src/shared.ts", b"right")
    conflicts = detect_conflicts(base, left, right)
    assert len(conflicts) == 1
    assert conflicts[0].path == "src/shared.ts"


@dataclass(slots=True)
class RecordingLeaseBroker:
    active: int = 0
    max_active: int = 0

    async def acquire(self, node: TaskNode, *, base_checkpoint: Checkpoint) -> ForkLease:
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        return ForkLease(f"lease-{node.id}", f"sandbox-{node.id}", base_checkpoint.checkpoint_id)

    async def release(self, lease: ForkLease, *, reason: str) -> None:
        del lease, reason
        self.active -= 1


@dataclass(slots=True)
class ScriptedRunner:
    store: CheckpointStore
    writes: dict[str, dict[str, bytes]]
    delay: float = 0
    attempts: list[tuple[str, NodeAttempt, str]] = field(default_factory=list)

    async def run(
        self,
        node: TaskNode,
        *,
        base_checkpoint: Checkpoint,
        lease: ForkLease,
        attempt: NodeAttempt,
    ) -> NodeRunResult:
        del lease
        self.attempts.append((node.id, attempt, base_checkpoint.checkpoint_id))
        if self.delay:
            await asyncio.sleep(self.delay)
        workset = self.store.fork(
            base_checkpoint, tenant_id="tenant", run_id=f"{node.id}-{attempt}"
        )
        for path, content in self.writes[node.id].items():
            if attempt is NodeAttempt.RERUN_AFTER_CONFLICT:
                content += b"-rebased"
            workset.write(path, content)
        checkpoint = workset.commit(verified=True, label=node.id)
        return NodeRunResult(
            node.id,
            checkpoint,
            tuple(change.path for change in workset.changes()),
            f"{node.id} done",
        )


class PassingGate:
    async def verify_l0_to_l2(self, node: TaskNode, result: NodeRunResult) -> bool:
        del node, result
        return True


@pytest.mark.asyncio
async def test_parallel_scheduling_respects_quota_and_merges_independent_features() -> None:
    store, base = make_store()
    runner = ScriptedRunner(store, {"a": {"src/a.ts": b"a"}, "b": {"src/b.ts": b"b"}}, delay=0.01)
    broker = RecordingLeaseBroker()
    dag = TaskDAG("plan", "two features", (task("a"), task("b")), base.checkpoint_id)
    result = await OfflineParallelDagExecutor(
        store,
        runner,
        PassingGate(),
        PlanLimits(100, 100, 2, 100),
        broker,
    ).execute(dag, tenant_id="tenant")
    assert result.status == "succeeded"
    assert broker.max_active == 2
    assert result.checkpoint.files.keys() >= {"src/a.ts", "src/b.ts"}


@pytest.mark.asyncio
async def test_conflict_loser_reruns_on_winner_checkpoint_and_winner_is_deterministic() -> None:
    store, base = make_store()
    runner = ScriptedRunner(
        store,
        {"a": {"src/shared.ts": b"a"}, "b": {"src/shared.ts": b"b"}},
    )
    dag = TaskDAG("plan", "conflict", (task("b"), task("a")), base.checkpoint_id)
    result = await OfflineParallelDagExecutor(
        store,
        runner,
        PassingGate(),
        PlanLimits(100, 100, 2, 100),
    ).execute(dag, tenant_id="tenant")
    assert result.status == "succeeded"
    assert result.rerun_nodes == ("b",)
    assert ("a", NodeAttempt.FIRST, base.checkpoint_id) in runner.attempts
    rerun_attempt = next(item for item in runner.attempts if item[0] == "b" and item[1] != "first")
    assert rerun_attempt[2] != base.checkpoint_id


def test_replanning_preserves_completed_nodes() -> None:
    dag = TaskDAG("plan", "goal", (task("a"), task("b", ("a",))), "green")
    replacement = (task("b", ("a",)), task("c", ("a",)))
    revised = preserve_completed_and_replan_remaining(
        dag,
        completed={"a"},
        invalidation=Invalidation("b", "verification failed", "ckpt-a"),
        replacement_remaining=replacement,
    )
    assert [node.id for node in revised.nodes] == ["a", "b", "c"]
    assert revised.invalidations == ("b: verification failed",)
