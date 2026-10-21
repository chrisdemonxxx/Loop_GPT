"""Temporal workflows for Phase 3 task-DAG parallelism."""

from __future__ import annotations

import asyncio
from datetime import timedelta

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from loopit_agent_core.vocabulary import allowed_tools
    from loopit_planner import ready_nodes, topological_ranks
    from loopit_planner.models import TaskDAG

    from .activities import acquire_sandbox_lease, release_sandbox_lease
    from .dag_activities import (
        execute_dag_node,
        merge_dag_checkpoint,
        plan_task_dag,
        replan_remaining_dag,
        verify_dag_node,
    )
    from .decisions import default_activity_retry_policy
    from .types import (
        AcquireLeaseInput,
        DagMergeInput,
        DagNodeRunInput,
        DagNodeRunResult,
        DagPlanInput,
        DagReplanInput,
        DagRunStatus,
        DagVerificationInput,
        LeaseInfo,
        ParallelDagWorkflowInput,
        ParallelDagWorkflowStatus,
        ReleaseLeaseInput,
    )

ACTIVITY_RETRY = default_activity_retry_policy()
PLAN_TIMEOUT = timedelta(minutes=3)
NODE_TIMEOUT = timedelta(minutes=30)
VERIFY_TIMEOUT = timedelta(minutes=10)
MERGE_TIMEOUT = timedelta(minutes=5)
REPLAN_TIMEOUT = timedelta(minutes=5)
LONG_ACTIVITY_HEARTBEAT_TIMEOUT = timedelta(seconds=30)


@workflow.defn
class DagNodeWorkflow:
    """One durable task-agent child workflow over one sandbox CoW fork."""

    @workflow.run
    async def run(self, payload: DagNodeRunInput) -> DagNodeRunResult:
        return await workflow.execute_activity(
            execute_dag_node,
            payload,
            start_to_close_timeout=NODE_TIMEOUT,
            heartbeat_timeout=LONG_ACTIVITY_HEARTBEAT_TIMEOUT,
            retry_policy=ACTIVITY_RETRY,
        )


@workflow.defn
class ParallelDagWorkflow:
    """Plan, run independent DAG nodes in parallel, verify, and gate merges."""

    def __init__(self) -> None:
        self._status = DagRunStatus.QUEUED
        self._completed: set[str] = set()
        self._checkpoint_id = ""
        self._summary = ""

    @workflow.run
    async def run(self, payload: ParallelDagWorkflowInput) -> ParallelDagWorkflowStatus:
        self._status = DagRunStatus.PLANNING
        self._checkpoint_id = payload.base_checkpoint_id
        dag = await workflow.execute_activity(
            plan_task_dag,
            DagPlanInput(payload.goal, payload.plan_id, payload.base_checkpoint_id),
            start_to_close_timeout=PLAN_TIMEOUT,
            retry_policy=ACTIVITY_RETRY,
        )
        ranks = topological_ranks(dag)
        self._status = DagRunStatus.RUNNING
        quota = max(1, payload.max_parallel_sandboxes)

        while len(self._completed) < len(dag.nodes):
            ready = ready_nodes(dag, self._completed)
            if not ready:
                self._status = DagRunStatus.FAILED
                self._summary = "no reachable DAG nodes remain"
                break
            batch = ready[:quota]
            batch_base_checkpoint_id = self._checkpoint_id
            batch_leases: dict[str, LeaseInfo] = {}
            try:
                for node in batch:
                    batch_leases[node.id] = await _acquire_dag_lease(
                        payload,
                        base_checkpoint_id=batch_base_checkpoint_id,
                        allowed=tuple(sorted(allowed_tools(str(node.kind)))),
                    )

                results = await asyncio.gather(
                    *(
                        workflow.execute_child_workflow(
                            DagNodeWorkflow.run,
                            DagNodeRunInput(
                                run_id=payload.run_id,
                                tenant_id=payload.tenant_id,
                                project_id=payload.project_id,
                                node_id=node.id,
                                node_kind=str(node.kind),
                                node_goal=node.goal,
                                base_checkpoint_id=batch_base_checkpoint_id,
                                expected_verification=node.expected_verification,
                                destructive=node.destructive,
                                lease=batch_leases[node.id],
                            ),
                            id=f"{payload.run_id}-{node.id}-{workflow.uuid4()}",
                        )
                        for node in batch
                    )
                )
            finally:
                for lease in batch_leases.values():
                    await _release_dag_lease(payload, lease, "node-executed")

            verified: list[tuple[str, DagNodeRunResult]] = []
            for node, result in zip(batch, results, strict=True):
                self._status = DagRunStatus.VERIFYING
                verification_base_checkpoint_id = result.checkpoint_id or batch_base_checkpoint_id
                verification_lease = await _acquire_dag_lease(
                    payload,
                    base_checkpoint_id=verification_base_checkpoint_id,
                    allowed=("run_shell",),
                )
                try:
                    verification = await workflow.execute_activity(
                        verify_dag_node,
                        DagVerificationInput(
                            payload.run_id,
                            payload.tenant_id,
                            payload.project_id,
                            node.id,
                            verification_base_checkpoint_id,
                            node.expected_verification,
                            verification_lease,
                        ),
                        start_to_close_timeout=VERIFY_TIMEOUT,
                        heartbeat_timeout=LONG_ACTIVITY_HEARTBEAT_TIMEOUT,
                        retry_policy=ACTIVITY_RETRY,
                    )
                finally:
                    await _release_dag_lease(payload, verification_lease, "verification-completed")
                if not verification.passed:
                    self._status = DagRunStatus.REPLANNING
                    dag = await _revise_remaining(
                        payload,
                        dag,
                        self._completed,
                        node.id,
                        verification.summary,
                        self._checkpoint_id,
                    )
                    ranks = topological_ranks(dag)
                    self._status = DagRunStatus.RUNNING
                    break
                verified.append((node.id, result))
            if len(verified) != len(results):
                continue

            self._status = DagRunStatus.MERGING
            for node_id, result in sorted(
                verified,
                key=lambda item: (ranks.get(item[0], 10_000), item[0]),
            ):
                if not result.checkpoint_created:
                    self._completed.add(node_id)
                    self._summary = result.summary
                    continue
                if result.checkpoint_id is None:
                    self._status = DagRunStatus.FAILED
                    self._summary = f"DAG node {node_id} reported a checkpoint without an id"
                    break
                merge = await workflow.execute_activity(
                    merge_dag_checkpoint,
                    DagMergeInput(
                        payload.run_id,
                        payload.tenant_id,
                        payload.project_id,
                        node_id,
                        batch_base_checkpoint_id,
                        self._checkpoint_id,
                        result.checkpoint_id,
                    ),
                    start_to_close_timeout=MERGE_TIMEOUT,
                    retry_policy=ACTIVITY_RETRY,
                )
                if merge.conflicts:
                    self._status = DagRunStatus.REPLANNING
                    dag = await _revise_remaining(
                        payload,
                        dag,
                        self._completed,
                        node_id,
                        "merge conflict; loser reruns on winner checkpoint",
                        self._checkpoint_id,
                    )
                    ranks = topological_ranks(dag)
                    self._status = DagRunStatus.RUNNING
                    break
                self._checkpoint_id = merge.checkpoint_id
                self._completed.add(node_id)
            if self._status is DagRunStatus.FAILED:
                break
            self._status = DagRunStatus.RUNNING

        if len(self._completed) == len(dag.nodes):
            self._status = DagRunStatus.SUCCEEDED
            self._summary = "task DAG completed"
        return self.status()

    @workflow.query
    def status(self) -> ParallelDagWorkflowStatus:
        return ParallelDagWorkflowStatus(
            status=self._status,
            checkpoint_id=self._checkpoint_id,
            completed_node_ids=tuple(sorted(self._completed)),
            summary=self._summary,
        )


async def _revise_remaining(
    payload: ParallelDagWorkflowInput,
    dag: TaskDAG,
    completed: set[str],
    node_id: str,
    reason: str,
    checkpoint_id: str,
) -> TaskDAG:
    return await workflow.execute_activity(
        replan_remaining_dag,
        DagReplanInput(
            dag_json=dag.to_json(),
            completed_node_ids=tuple(sorted(completed)),
            invalidated_node_id=node_id,
            reason=reason,
            checkpoint_id=checkpoint_id,
        ),
        start_to_close_timeout=REPLAN_TIMEOUT,
        retry_policy=ACTIVITY_RETRY,
    )


async def _acquire_dag_lease(
    payload: ParallelDagWorkflowInput,
    *,
    base_checkpoint_id: str,
    allowed: tuple[str, ...],
) -> LeaseInfo:
    """Acquire one isolated sandbox lease for one DAG fork or verifier.

    DAG execution cannot share a lease across ready nodes: parallel children
    operate on separate checkpoint forks and sharing would allow one task to
    address a sibling's workspace. The allowlist comes from the task vocabulary
    for execution leases; verification leases intentionally contain only
    ``run_shell`` because the dispatcher verification pipeline requires shell
    execution but should not inherit the task's broader write/deploy tools.
    """

    return await workflow.execute_activity(
        acquire_sandbox_lease,
        AcquireLeaseInput(
            payload.tenant_id,
            payload.run_id,
            payload.project_id,
            base_checkpoint_id,
            allowed_tools=allowed,
        ),
        start_to_close_timeout=timedelta(seconds=30),
        retry_policy=ACTIVITY_RETRY,
    )


async def _release_dag_lease(
    payload: ParallelDagWorkflowInput, lease: LeaseInfo, reason: str
) -> None:
    await workflow.execute_activity(
        release_sandbox_lease,
        ReleaseLeaseInput(payload.tenant_id, lease.lease_id, reason),
        start_to_close_timeout=timedelta(seconds=30),
        retry_policy=ACTIVITY_RETRY,
    )
