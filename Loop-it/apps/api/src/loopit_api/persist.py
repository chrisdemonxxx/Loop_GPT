"""Persist runs and projects through ``packages/store``.

The in-process ``RunManager`` still owns workspaces and live SSE. This module
is the control-plane catalog: a run that only exists in a process-local dict
cannot be listed after restart and cannot satisfy checkpoint FKs for Temporal
dispatch. Callers always go through ``ProjectStore`` / ``RunStore`` so tests
can inject the in-memory implementations.

Title and stack are not columns on ``runs`` yet, so a small sidecar next to the
event journal (``<projects>/.runs/<run_id>.meta.json``) keeps them across
restarts. Summary is written both to the store (via ``finish``) and the
sidecar so ``get_run`` can rehydrate a full board row.
"""

from __future__ import annotations

import json
import logging
from decimal import Decimal
from pathlib import Path
from typing import Any

from loopit_store import ProjectRecord, ProjectStore, RunBudget, RunRecord, RunStore
from loopit_store.models import RunStatus

from .runs import RunState

LOGGER = logging.getLogger(__name__)


def catalog_status(loop_status: str) -> RunStatus:
    """Map live loop labels onto the store's closed status set."""
    if loop_status in {"queued"}:
        return "queued"
    if loop_status in {"running", "awaiting_approval", "awaiting_gate"}:
        return "running"
    if loop_status in {"verified", "succeeded"}:
        return "succeeded"
    if loop_status == "cancelled":
        return "cancelled"
    return "failed"


def run_meta_path(projects_root: Path, run_id: str) -> Path:
    return Path(projects_root) / ".runs" / f"{run_id}.meta.json"


def write_run_meta(projects_root: Path, state: RunState) -> None:
    """Persist title/summary/stack beside the journal so restarts keep them."""
    path = run_meta_path(projects_root, state.run_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "run_id": state.run_id,
                    "project_id": state.project_id,
                    "title": state.title,
                    "summary": state.summary,
                    "stack": state.stack,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    except OSError:
        LOGGER.warning("could not persist run meta for %s", state.run_id)


def load_run_meta(projects_root: Path, run_id: str) -> dict[str, Any]:
    path = run_meta_path(projects_root, run_id)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def write_run_meta_fields(
    projects_root: Path, run_id: str, fields: dict[str, Any]
) -> None:
    """Merge ``fields`` into the run meta sidecar (orchestrator metadata, DAG, …)."""
    path = run_meta_path(projects_root, run_id)
    current = load_run_meta(projects_root, run_id)
    current.update(fields)
    current["run_id"] = run_id
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(current, indent=2), encoding="utf-8")
    except OSError:
        LOGGER.warning("could not persist run meta fields for %s", run_id)


def record_to_dict(
    record: RunRecord,
    *,
    projects_root: Path | None = None,
    project: ProjectRecord | None = None,
) -> dict[str, Any]:
    meta = load_run_meta(projects_root, record.run_id) if projects_root is not None else {}
    title = str(meta.get("title") or "")
    stack = meta.get("stack")
    if stack is None and project is not None:
        stack = project.stack
    summary = record.summary or str(meta.get("summary") or "")
    return {
        "run_id": record.run_id,
        "project_id": record.project_id,
        "prompt": record.prompt,
        "title": title,
        "status": record.status,
        "started_at": record.started_at.isoformat() if record.started_at else None,
        "finished_at": record.finished_at.isoformat() if record.finished_at else None,
        "iterations": record.iterations,
        "summary": summary,
        "credits_spent": float(record.cost_credits),
        "stack": stack,
        "dag": None,
        "task_dag": None,
        "gates": [],
        "gate": None,
        "checkpoints": [],
        "cost": {
            "iterations": record.iterations,
            "credits_spent": float(record.cost_credits),
            "total_tokens": 0,
        },
        "tenant_id": record.tenant_id,
    }


def persist_run_started(
    *,
    projects: ProjectStore,
    runs: RunStore,
    tenant_id: str,
    owner_user_id: str | None,
    project_id: str,
    run_id: str,
    prompt: str,
    stack: str,
    max_iterations: int,
    difficulty: str,
) -> RunRecord:
    if projects.get(project_id, tenant_id=tenant_id) is None:
        projects.create(
            ProjectRecord(
                project_id=project_id,
                tenant_id=tenant_id,
                owner_user_id=owner_user_id,
                name=project_id,
                stack=stack,
            )
        )
    if runs.get(run_id, tenant_id=tenant_id) is None:
        runs.create(
            RunRecord(
                run_id=run_id,
                tenant_id=tenant_id,
                project_id=project_id,
                prompt=prompt,
                status="queued",
                budget=RunBudget(max_iterations=max_iterations),
                difficulty=difficulty,
            )
        )
    return runs.start(run_id, tenant_id=tenant_id)


def persist_run_finished(
    runs: RunStore,
    state: RunState,
    *,
    projects_root: Path | None = None,
) -> RunRecord | None:
    if projects_root is not None:
        write_run_meta(projects_root, state)
    if runs.get(state.run_id, tenant_id=state.tenant_id) is None:
        return None
    return runs.finish(
        state.run_id,
        tenant_id=state.tenant_id,
        status=catalog_status(state.status),
        summary=state.summary,
        cost_credits=Decimal(str(state.credits_spent)),
    )
