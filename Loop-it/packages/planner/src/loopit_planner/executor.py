"""Offline deterministic executor for Phase 3 DAG semantics."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Protocol

from loopit_checkpoint import Checkpoint, CheckpointStore
from loopit_policy import PlanLimits

from .dag import assert_valid_dag, ready_nodes, topological_ranks
from .merge import choose_winner, detect_conflicts
from .models import TaskDAG, TaskNode
from .replan import Invalidation, preserve_completed_and_replan_remaining


class NodeAttempt(StrEnum):
    FIRST = "first"
    RERUN_AFTER_CONFLICT = "rerun_after_conflict"
    RERUN_AFTER_VERIFICATION = "rerun_after_verification"


@dataclass(frozen=True, slots=True)
class ForkLease:
    lease_id: str
    sandbox_id: str
    base_checkpoint_id: str


@dataclass(frozen=True, slots=True)
class NodeRunResult:
    node_id: str
    checkpoint: Checkpoint
    changed_paths: tuple[str, ...]
    summary: str = ""


class SandboxLeaseBroker(Protocol):
    async def acquire(self, node: TaskNode, *, base_checkpoint: Checkpoint) -> ForkLease:
        """Acquire one sandbox lease for one CoW fork."""

    async def release(self, lease: ForkLease, *, reason: str) -> None:
        """Release the sandbox lease."""


class TaskNodeRunner(Protocol):
    async def run(
        self,
        node: TaskNode,
        *,
        base_checkpoint: Checkpoint,
        lease: ForkLease,
        attempt: NodeAttempt,
    ) -> NodeRunResult:
        """Run a node in a leased sandbox and return a candidate checkpoint."""


class VerificationGate(Protocol):
    async def verify_l0_to_l2(self, node: TaskNode, result: NodeRunResult) -> bool:
        """A verification sub-agent must pass L0→L2 before merge."""


@dataclass(slots=True)
class DagExecutionResult:
    status: str
    checkpoint: Checkpoint
    completed: tuple[str, ...]
    rerun_nodes: tuple[str, ...] = ()
    max_observed_parallelism: int = 0
    revised_dag: TaskDAG | None = None
    summaries: tuple[str, ...] = ()


@dataclass(slots=True)
class _MemoryLeaseBroker:
    active: int = 0
    max_active: int = 0
    sequence: int = 0

    async def acquire(self, node: TaskNode, *, base_checkpoint: Checkpoint) -> ForkLease:
        self.sequence += 1
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        return ForkLease(
            f"lease-{node.id}-{self.sequence}", f"sandbox-{node.id}", base_checkpoint.checkpoint_id
        )

    async def release(self, lease: ForkLease, *, reason: str) -> None:
        self.active -= 1


@dataclass(slots=True)
class OfflineParallelDagExecutor:
    """Execute a validated DAG using fakes or in-memory adapters for tests/evals."""

    store: CheckpointStore
    runner: TaskNodeRunner
    verifier: VerificationGate
    limits: PlanLimits
    lease_broker: SandboxLeaseBroker = field(default_factory=_MemoryLeaseBroker)

    async def execute(self, dag: TaskDAG, *, tenant_id: str) -> DagExecutionResult:
        assert_valid_dag(dag)
        base = self.store.get(_required_base(dag), tenant_id=tenant_id)
        current = base
        completed: set[str] = set()
        rerun_nodes: list[str] = []
        summaries: list[str] = []
        revised: TaskDAG | None = None
        ranks = topological_ranks(dag)
        max_parallelism = max(1, self.limits.max_sandbox_leases)

        while len(completed) < len(dag.nodes):
            batch = ready_nodes(dag, completed)
            if not batch:
                return DagExecutionResult("blocked", current, tuple(sorted(completed)))

            results = await self._run_batch(
                batch,
                base_checkpoint=current,
                tenant_id=tenant_id,
                max_parallelism=max_parallelism,
                attempt=NodeAttempt.FIRST,
            )
            verified = []
            for node, result in results:
                if not await self.verifier.verify_l0_to_l2(node, result):
                    remaining = tuple(item for item in dag.nodes if item.id not in completed)
                    dag = preserve_completed_and_replan_remaining(
                        dag,
                        completed=completed,
                        invalidation=Invalidation(
                            node.id, "verification failed", current.checkpoint_id
                        ),
                        replacement_remaining=remaining,
                    )
                    revised = dag
                    rerun_nodes.append(node.id)
                    break
                verified.append((node, result))
            if len(verified) != len(results):
                continue

            current, rerun = await self._merge_verified_batch(
                verified,
                base_checkpoint=current,
                ranks=ranks,
                tenant_id=tenant_id,
                max_parallelism=max_parallelism,
            )
            for node, result in verified:
                completed.add(node.id)
                summaries.append(result.summary)
            rerun_nodes.extend(sorted(rerun))

        lease_broker = self.lease_broker
        observed = lease_broker.max_active if isinstance(lease_broker, _MemoryLeaseBroker) else 0
        return DagExecutionResult(
            "succeeded",
            current,
            tuple(sorted(completed, key=lambda node_id: (ranks.get(node_id, 10_000), node_id))),
            tuple(rerun_nodes),
            observed,
            revised,
            tuple(summaries),
        )

    async def _run_batch(
        self,
        nodes: Iterable[TaskNode],
        *,
        base_checkpoint: Checkpoint,
        tenant_id: str,
        max_parallelism: int,
        attempt: NodeAttempt,
    ) -> tuple[tuple[TaskNode, NodeRunResult], ...]:
        del tenant_id
        semaphore = asyncio.Semaphore(max_parallelism)

        async def run_one(node: TaskNode) -> tuple[TaskNode, NodeRunResult]:
            async with semaphore:
                lease = await self.lease_broker.acquire(node, base_checkpoint=base_checkpoint)
                try:
                    result = await self.runner.run(
                        node,
                        base_checkpoint=base_checkpoint,
                        lease=lease,
                        attempt=attempt,
                    )
                    return node, result
                finally:
                    await self.lease_broker.release(lease, reason="completed")

        return tuple(await asyncio.gather(*(run_one(node) for node in nodes)))

    async def _merge_verified_batch(
        self,
        verified: list[tuple[TaskNode, NodeRunResult]],
        *,
        base_checkpoint: Checkpoint,
        ranks: dict[str, int],
        tenant_id: str,
        max_parallelism: int,
    ) -> tuple[Checkpoint, set[str]]:
        current = base_checkpoint
        pending = dict(verified)
        rerun: set[str] = set()
        while pending:
            winner_id = choose_winner(tuple(node.id for node in pending), ranks=ranks)
            winner = next(node for node in pending if node.id == winner_id)
            result = pending.pop(winner)
            current = (
                result.checkpoint
                if current.checkpoint_id == base_checkpoint.checkpoint_id
                else self._merge_disjoint(base_checkpoint, current, result.checkpoint)
            )
            conflicted = {
                node
                for node, other in pending.items()
                if detect_conflicts(base_checkpoint, current, other.checkpoint)
            }
            for node in sorted(conflicted, key=lambda item: (ranks.get(item.id, 10_000), item.id)):
                rerun.add(node.id)
                pending.pop(node)
                replacement = await self._run_batch(
                    (node,),
                    base_checkpoint=current,
                    tenant_id=tenant_id,
                    max_parallelism=max_parallelism,
                    attempt=NodeAttempt.RERUN_AFTER_CONFLICT,
                )
                rerun_result = replacement[0][1]
                if not await self.verifier.verify_l0_to_l2(node, rerun_result):
                    continue
                current = rerun_result.checkpoint
        return current, rerun

    def _merge_disjoint(
        self,
        base_checkpoint: Checkpoint,
        current: Checkpoint,
        candidate: Checkpoint,
    ) -> Checkpoint:
        manifest = dict(current.files)
        for path in sorted(set(base_checkpoint.files) | set(candidate.files)):
            before = base_checkpoint.files.get(path)
            after = candidate.files.get(path)
            if before == after:
                continue
            if after is None:
                manifest.pop(path, None)
            else:
                manifest[path] = after
        return self.store.commit_manifest(
            project_id=current.project_id,
            tenant_id=current.tenant_id,
            files=manifest,
            parent_id=current.checkpoint_id,
            db_snapshot_id=current.db_snapshot_id,
            verified=True,
            label="parallel-merge",
        )


def _required_base(dag: TaskDAG) -> str:
    if dag.base_checkpoint_id is None:
        raise ValueError("task DAG requires base_checkpoint_id before execution")
    return dag.base_checkpoint_id


AsyncReplanner = Callable[[TaskDAG, Invalidation], Awaitable[TaskDAG]]
