"""Worker entrypoint: ``python -m loopit_orchestrator.worker``."""

from __future__ import annotations

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor

from temporalio.client import Client
from temporalio.worker import Worker

from .activities import (
    ActivitySettings,
    acquire_sandbox_lease,
    emit_audit_event,
    execute_agent_step,
    release_sandbox_lease,
    renew_sandbox_lease,
    run_verification,
    write_checkpoint,
)
from .client import OrchestratorSettings
from .dag_activities import (
    execute_dag_node,
    merge_dag_checkpoint,
    plan_task_dag,
    replan_remaining_dag,
    verify_dag_node,
)
from .dag_workflow import DagNodeWorkflow, ParallelDagWorkflow
from .workflow import RunWorkflow

LOG = logging.getLogger("loopit.orchestrator")
DEFAULT_ACTIVITY_THREAD_POOL_WORKERS = 32


async def main_async() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    settings = OrchestratorSettings.from_env()
    ActivitySettings()
    client = await Client.connect(settings.temporal_address, namespace=settings.temporal_namespace)
    with ThreadPoolExecutor(max_workers=_activity_thread_pool_workers()) as activity_executor:
        worker = Worker(
            client,
            task_queue=settings.task_queue,
            workflows=[RunWorkflow, ParallelDagWorkflow, DagNodeWorkflow],
            activities=[
                acquire_sandbox_lease,
                renew_sandbox_lease,
                release_sandbox_lease,
                execute_agent_step,
                run_verification,
                write_checkpoint,
                emit_audit_event,
                plan_task_dag,
                execute_dag_node,
                verify_dag_node,
                merge_dag_checkpoint,
                replan_remaining_dag,
            ],
            activity_executor=activity_executor,
        )
        LOG.info(
            "starting loopit-orchestrator worker address=%s namespace=%s task_queue=%s",
            settings.temporal_address,
            settings.temporal_namespace,
            settings.task_queue,
        )
        await worker.run()


def _activity_thread_pool_workers() -> int:
    raw = os.environ.get("LOOPIT_ACTIVITY_THREAD_POOL_WORKERS")
    if raw is None:
        return DEFAULT_ACTIVITY_THREAD_POOL_WORKERS
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_ACTIVITY_THREAD_POOL_WORKERS


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
