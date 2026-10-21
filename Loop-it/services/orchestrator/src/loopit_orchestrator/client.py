"""Typed client seam used by apps/api to migrate away from RunManager."""

from __future__ import annotations

import os
from dataclasses import dataclass

from temporalio.client import Client

from .dag_workflow import ParallelDagWorkflow
from .types import (
    ApprovalSignal,
    ParallelDagWorkflowInput,
    ParallelDagWorkflowStatus,
    RunWorkflowInput,
    WorkflowStatus,
)
from .workflow import RunWorkflow


@dataclass(frozen=True, slots=True)
class OrchestratorSettings:
    temporal_address: str = "localhost:7233"
    temporal_namespace: str = "default"
    task_queue: str = "loopit-runs"

    @classmethod
    def from_env(cls) -> OrchestratorSettings:
        return cls(
            temporal_address=os.environ.get("LOOPIT_TEMPORAL_ADDRESS", "localhost:7233"),
            temporal_namespace=os.environ.get("LOOPIT_TEMPORAL_NAMESPACE", "default"),
            task_queue=os.environ.get("LOOPIT_TEMPORAL_TASK_QUEUE", "loopit-runs"),
        )


class OrchestratorClient:
    def __init__(self, client: Client, *, task_queue: str = "loopit-runs") -> None:
        self._client = client
        self._task_queue = task_queue

    @classmethod
    async def connect(cls, settings: OrchestratorSettings | None = None) -> OrchestratorClient:
        resolved = settings or OrchestratorSettings.from_env()
        client = await Client.connect(
            resolved.temporal_address,
            namespace=resolved.temporal_namespace,
        )
        return cls(client, task_queue=resolved.task_queue)

    async def start(self, request: RunWorkflowInput) -> WorkflowStatus:
        handle = await self._client.start_workflow(
            RunWorkflow.run,
            request,
            id=self.workflow_id(request.run_id),
            task_queue=self._task_queue,
        )
        return await handle.query(RunWorkflow.status)

    async def get(self, run_id: str) -> WorkflowStatus:
        handle = self._client.get_workflow_handle(self.workflow_id(run_id))
        return await handle.query(RunWorkflow.status)

    async def approve(self, run_id: str, signal: ApprovalSignal) -> None:
        handle = self._client.get_workflow_handle(self.workflow_id(run_id))
        await handle.signal(RunWorkflow.approve_gate, signal)

    async def reject(self, run_id: str, gate_id: str, *, actor_id: str, reason: str = "") -> None:
        await self.approve(run_id, ApprovalSignal(gate_id, False, actor_id, reason))

    async def progress(self, run_id: str) -> dict[str, object]:
        handle = self._client.get_workflow_handle(self.workflow_id(run_id))
        result = await handle.query(RunWorkflow.progress)
        return dict(result)

    async def start_parallel_dag(
        self, request: ParallelDagWorkflowInput
    ) -> ParallelDagWorkflowStatus:
        handle = await self._client.start_workflow(
            ParallelDagWorkflow.run,
            request,
            id=self.dag_workflow_id(request.run_id),
            task_queue=self._task_queue,
        )
        return await handle.query(ParallelDagWorkflow.status)

    @staticmethod
    def workflow_id(run_id: str) -> str:
        return f"loopit-run-{run_id}"

    @staticmethod
    def dag_workflow_id(run_id: str) -> str:
        return f"loopit-dag-{run_id}"
