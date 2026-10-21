"""Activities for Phase 3 planner DAG orchestration."""

from __future__ import annotations

import json
import os
from dataclasses import asdict
from typing import Any, cast

from loopit_planner import Conflict, TaskDAG
from loopit_policy import FailureClass, classify_action
from loopit_policy.actions import GateRequirement
from temporalio import activity
from temporalio.exceptions import ApplicationError

from .activities import (
    ROUTER_HTTP_TIMEOUT_SECONDS,
    TOOL_CALL_RESPONSE_FORMAT,
    WORKSPACE_DISPATCH_HTTP_TIMEOUT_SECONDS,
    _env_float_at_least,
    _extract_tool_call,
    _http_status_from_application_error,
    _max_output_tokens,
    _model_response,
    _post_json,
    _raise_non_retryable,
)
from .types import (
    DagMergeInput,
    DagMergeResult,
    DagNodeRunInput,
    DagNodeRunResult,
    DagPlanInput,
    DagReplanInput,
    DagVerificationInput,
    DagVerificationResult,
)

DAG_VERIFY_HTTP_TIMEOUT_SECONDS = 9 * 60


class DagActivitySettings:
    def __init__(self) -> None:
        self.planner_url = os.environ.get("LOOPIT_PLANNER_URL", "")
        self.router_url = os.environ.get("LOOPIT_ROUTER_URL", "http://router-svc:8001")
        self.workspace_dispatch_url = os.environ.get("LOOPIT_WORKSPACE_DISPATCH_URL", "")
        self.checkpoint_merge_url = os.environ.get("LOOPIT_CHECKPOINT_MERGE_URL", "")
        self.workspace_dispatch_timeout_seconds = _env_float_at_least(
            "LOOPIT_WORKSPACE_DISPATCH_HTTP_TIMEOUT_SECONDS",
            WORKSPACE_DISPATCH_HTTP_TIMEOUT_SECONDS,
        )
        self.verify_timeout_seconds = DAG_VERIFY_HTTP_TIMEOUT_SECONDS


@activity.defn
def plan_task_dag(payload: DagPlanInput) -> TaskDAG:
    settings = DagActivitySettings()
    if not settings.planner_url:
        _raise_non_retryable(
            FailureClass.HARD_ERROR,
            "LOOPIT_PLANNER_URL is not set; refusing to fabricate a live plan",
        )
    response = _post_json(
        settings.planner_url,
        {
            "goal": payload.goal,
            "plan_id": payload.plan_id,
            "base_checkpoint_id": payload.base_checkpoint_id,
        },
    )
    return TaskDAG.from_mapping(response)


@activity.defn
def execute_dag_node(payload: DagNodeRunInput) -> DagNodeRunResult:
    settings = DagActivitySettings()
    if not settings.workspace_dispatch_url:
        _raise_non_retryable(
            FailureClass.HARD_ERROR,
            "LOOPIT_WORKSPACE_DISPATCH_URL is not set; DAG nodes execute only in sandboxes",
        )
    try:
        tool_call = _dag_node_tool_call(payload, settings)
        response = _post_json(
            settings.workspace_dispatch_url,
            {
                "lease_id": payload.lease.lease_id,
                "tool": tool_call["tool"],
                "args": tool_call["args"],
                "run_id": payload.run_id,
                "tenant_id": payload.tenant_id,
                "project_id": payload.project_id,
                "node_id": payload.node_id,
                "node_goal": payload.node_goal,
                "base_checkpoint_id": payload.base_checkpoint_id,
                "expected_verification": payload.expected_verification,
                "destructive": payload.destructive,
            },
            headers={"Authorization": f"Bearer {payload.lease.lease_token}"},
            timeout_seconds=settings.workspace_dispatch_timeout_seconds,
        )
    except ApplicationError as exc:
        if _http_status_from_application_error(exc) in (422, 403):
            # Schema-rejected tool call or lease-denied tool: report a failed
            # node with the rejection reason instead of aborting the DAG run.
            return DagNodeRunResult(
                node_id=payload.node_id,
                checkpoint_id=None,
                checkpoint_created=False,
                changed_paths=(),
                summary=str(exc),
            )
        raise
    checkpoint_created = response.get("checkpoint_created")
    if not isinstance(checkpoint_created, bool):
        _raise_non_retryable(
            FailureClass.HARD_ERROR,
            "workspace dispatch response missing boolean checkpoint_created for DAG node",
        )
    checkpoint_created = cast(bool, checkpoint_created)
    checkpoint_id = response.get("checkpoint_id")
    changed_paths = tuple(str(path) for path in response.get("changed_paths", ()))
    if checkpoint_created and (
        not isinstance(checkpoint_id, str) or not checkpoint_id.startswith("ckpt_")
    ):
        _raise_non_retryable(
            FailureClass.HARD_ERROR,
            "workspace dispatch response missing or malformed checkpoint_id for DAG node",
        )
    if not checkpoint_created and checkpoint_id is not None:
        _raise_non_retryable(
            FailureClass.HARD_ERROR,
            "workspace dispatch returned checkpoint_id without checkpoint_created",
        )
    if not checkpoint_created and changed_paths:
        _raise_non_retryable(
            FailureClass.HARD_ERROR,
            "DAG node reported changed paths without a checkpoint",
        )
    return DagNodeRunResult(
        node_id=payload.node_id,
        checkpoint_id=cast(str | None, checkpoint_id),
        checkpoint_created=checkpoint_created,
        changed_paths=changed_paths,
        summary=str(response.get("summary", "dag node completed")),
    )


@activity.defn
def verify_dag_node(payload: DagVerificationInput) -> DagVerificationResult:
    settings = DagActivitySettings()
    if not settings.workspace_dispatch_url:
        return DagVerificationResult(False, "verification sub-agent dispatch is not configured")
    response = _post_json(
        settings.workspace_dispatch_url,
        {"lease_id": payload.lease.lease_id, "tool": "verify", "args": {}},
        headers={"Authorization": f"Bearer {payload.lease.lease_token}"},
        timeout_seconds=settings.verify_timeout_seconds,
    )
    return DagVerificationResult(
        passed=bool(response.get("passed", False)),
        summary=str(response.get("summary", "verification completed")),
    )


@activity.defn
def merge_dag_checkpoint(payload: DagMergeInput) -> DagMergeResult:
    settings = DagActivitySettings()
    if not settings.checkpoint_merge_url:
        _raise_non_retryable(
            FailureClass.MERGE_CONFLICT,
            "LOOPIT_CHECKPOINT_MERGE_URL is not set; refusing a blind merge",
        )
    response = _post_json(settings.checkpoint_merge_url, asdict(payload))
    conflicts_raw = cast(list[dict[str, Any]], response.get("conflicts", []))
    return DagMergeResult(
        merged=bool(response.get("merged", False)),
        checkpoint_id=str(response.get("checkpoint_id") or payload.current_checkpoint_id),
        winner_node_id=str(response.get("winner_node_id") or payload.node_id),
        conflicts=tuple(
            Conflict(
                str(item["path"]),
                str(item["left_after"]) if item.get("left_after") is not None else None,
                str(item["right_after"]) if item.get("right_after") is not None else None,
            )
            for item in conflicts_raw
        ),
    )


@activity.defn
def replan_remaining_dag(payload: DagReplanInput) -> TaskDAG:
    settings = DagActivitySettings()
    if not settings.planner_url:
        _raise_non_retryable(
            FailureClass.HARD_ERROR,
            "LOOPIT_PLANNER_URL is not set; cannot revise remaining DAG",
        )
    response = _post_json(
        settings.planner_url,
        {
            "mode": "revise_remaining",
            "dag": payload.dag_json,
            "completed_node_ids": list(payload.completed_node_ids),
            "invalidated_node_id": payload.invalidated_node_id,
            "reason": payload.reason,
            "checkpoint_id": payload.checkpoint_id,
        },
    )
    if isinstance(response.get("dag"), str):
        decoded = json.loads(str(response["dag"]))
        return TaskDAG.from_mapping(cast(dict[str, Any], decoded))
    return TaskDAG.from_mapping(cast(dict[str, Any], response.get("dag", response)))


def _dag_node_tool_call(payload: DagNodeRunInput, settings: DagActivitySettings) -> dict[str, Any]:
    """Ask the router for the first concrete tool call for a DAG task.

    DAG planning produces isolated task goals, not executable workspace API
    calls. The dispatcher now exposes the same lease-authenticated tool surface
    as the single-run path, so the orchestrator has to translate a node goal
    through the router before entering the sandbox instead of POSTing the whole
    node as an unauthenticated pseudo-command.
    """

    if not settings.router_url:
        _raise_non_retryable(FailureClass.HARD_ERROR, "LOOPIT_ROUTER_URL is not set")
    messages = [
        {"role": "system", "content": "You are Loop-it's DAG node app-building agent."},
        {
            "role": "user",
            "content": (
                f"Task kind: {payload.node_kind}\n"
                f"Task goal: {payload.node_goal}\n"
                f"Allowed tools for this lease: {sorted(payload.lease.allowed_tools)}\n"
                "Emit exactly one JSON tool call."
            ),
        },
    ]
    response = _post_json(
        f"{settings.router_url}/v1/chat/completions",
        {
            "messages": messages,
            "difficulty": "implementation",
            "max_tokens": _max_output_tokens(),
            "response_format": TOOL_CALL_RESPONSE_FORMAT,
        },
        timeout_seconds=ROUTER_HTTP_TIMEOUT_SECONDS,
    )
    model = _model_response(response)
    tool_call = _extract_tool_call(model.content, response)
    if tool_call is None:
        _raise_non_retryable(FailureClass.HARD_ERROR, "DAG node router produced no tool call")
    assert tool_call is not None
    _validate_dag_tool_call(tool_call)
    return tool_call


def _validate_dag_tool_call(tool_call: dict[str, Any]) -> None:
    """Reject DAG tool calls that need a human approval turn.

    Checkpointing is owned by workspace-dispatch: a successful mutating response
    must include a real checkpoint id, while checkpoint_created=False means
    nothing changed. The orchestrator only blocks unattended actions whose risk
    policy requires a gate the parallel DAG runner cannot present.
    """

    verdict = classify_action(tool_call)
    tool = str(tool_call.get("tool", ""))
    if verdict.required_gate is GateRequirement.HUMAN_CONFIRM:
        if tool == "run_shell":
            _raise_non_retryable(
                FailureClass.HARD_ERROR,
                f"DAG run_shell command requires human approval and cannot run unattended: "
                f"{verdict.reason}",
            )
        _raise_non_retryable(
            FailureClass.HARD_ERROR,
            f"DAG tool {tool!r} requires approval and cannot run unattended",
        )
