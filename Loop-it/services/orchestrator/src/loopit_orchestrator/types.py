"""Serializable contracts shared by workflow, activities, and API clients."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    AWAITING_APPROVAL = "awaiting_approval"
    VERIFYING = "verifying"
    CHECKPOINTING = "checkpointing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class StepOutcome(StrEnum):
    CONTINUE = "continue"
    AWAITING_GATE = "awaiting_gate"
    VERIFIED = "verified"
    STALLED = "stalled"


@dataclass(frozen=True, slots=True)
class WorkflowBudget:
    """Run caps default from env so deployments can tune long-build budgets.

    The defaults target real 2-3 hour implementation builds with headroom rather
    than a one-hour demo loop: four hours wall clock and more iterations for
    slow model/tool cycles. The credit ceiling assumes measured
    implementation-tier calls are cheap enough that expected retries should not
    dominate cost, but still bounds runaway degraded traffic. The resolved
    values are serialized in ``RunWorkflowInput``, keeping Temporal replay
    deterministic even when worker environment variables later change.
    """

    max_iterations: int = 100
    max_tokens: int = 8_000_000
    max_wall_clock_seconds: int = 14_400
    max_credits: float = 10.0


@dataclass(frozen=True, slots=True)
class RunWorkflowInput:
    prompt: str
    tenant_id: str
    actor_id: str
    project_id: str
    run_id: str
    base_checkpoint_id: str = "root"
    difficulty: Literal["trivial", "implementation", "planning"] = "implementation"
    budget: WorkflowBudget = field(default_factory=WorkflowBudget)
    task_id: str = "task-1"
    stack: str = "react"


@dataclass(frozen=True, slots=True)
class ApprovalSignal:
    gate_id: str
    approved: bool
    actor_id: str
    reason: str = ""


@dataclass(frozen=True, slots=True)
class GateRequest:
    gate_id: str
    tool: str
    args: dict[str, Any]
    reason: str
    requested_at: str
    args_hash: str
    expires_at: str | None = None


@dataclass(frozen=True, slots=True)
class UsageDelta:
    iterations: int = 0
    tokens: int = 0
    credits: float = 0.0


@dataclass(frozen=True, slots=True)
class LeaseInfo:
    lease_id: str
    lease_token: str
    sandbox_id: str
    expires_at: str
    allowed_tools: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class AcquireLeaseInput:
    tenant_id: str
    run_id: str
    project_id: str
    base_checkpoint_id: str
    ttl_seconds: int = 3600
    allowed_tools: tuple[str, ...] = (
        "read_file",
        "search_code",
        "apply_patch",
        "run_shell",
        "install_package",
        "start_dev_server",
        "read_logs",
        "browser",
    )


@dataclass(frozen=True, slots=True)
class ReleaseLeaseInput:
    tenant_id: str
    lease_id: str
    reason: str = "completed"


@dataclass(frozen=True, slots=True)
class RenewLeaseInput:
    tenant_id: str
    lease_id: str
    ttl_seconds: int = 3600


@dataclass(frozen=True, slots=True)
class TranscriptMessage:
    role: Literal["assistant", "user", "tool"]
    content: str


@dataclass(frozen=True, slots=True)
class AgentStepInput:
    run: RunWorkflowInput
    lease: LeaseInfo
    approved_gate_bindings: tuple[str, ...] = ()
    previous_summary: str = ""
    transcript: tuple[TranscriptMessage, ...] = ()


@dataclass(frozen=True, slots=True)
class AgentStepResult:
    outcome: StepOutcome
    summary: str
    usage: UsageDelta = field(default_factory=UsageDelta)
    gate: GateRequest | None = None
    failure_class: str | None = None
    consumed_gate_binding: str | None = None
    transcript_delta: tuple[TranscriptMessage, ...] = ()


@dataclass(frozen=True, slots=True)
class VerificationInput:
    run: RunWorkflowInput
    lease: LeaseInfo
    previous_summary: str = ""


@dataclass(frozen=True, slots=True)
class VerificationResult:
    verified: bool
    summary: str
    usage: UsageDelta = field(default_factory=UsageDelta)
    failure_class: str | None = None
    checkpoint_id: str | None = None
    checkpoint_created: bool = False


@dataclass(frozen=True, slots=True)
class CheckpointInput:
    run: RunWorkflowInput
    lease: LeaseInfo
    summary: str


@dataclass(frozen=True, slots=True)
class CheckpointResult:
    checkpoint_id: str
    summary: str


@dataclass(frozen=True, slots=True)
class AuditEventInput:
    tenant_id: str
    project_id: str
    run_id: str
    event_type: str
    outcome: str
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class WorkflowStatus:
    run_id: str
    project_id: str
    status: RunStatus
    iterations: int = 0
    tokens: int = 0
    credits: float = 0.0
    summary: str = ""
    checkpoint_id: str | None = None
    gate: GateRequest | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None


class DagRunStatus(StrEnum):
    QUEUED = "queued"
    PLANNING = "planning"
    RUNNING = "running"
    VERIFYING = "verifying"
    MERGING = "merging"
    REPLANNING = "replanning"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class ParallelDagWorkflowInput:
    goal: str
    tenant_id: str
    actor_id: str
    project_id: str
    run_id: str
    base_checkpoint_id: str
    plan_id: str
    max_parallel_sandboxes: int = 2


@dataclass(frozen=True, slots=True)
class ParallelDagWorkflowStatus:
    status: DagRunStatus
    checkpoint_id: str
    completed_node_ids: tuple[str, ...] = ()
    summary: str = ""


@dataclass(frozen=True, slots=True)
class DagPlanInput:
    goal: str
    plan_id: str
    base_checkpoint_id: str


@dataclass(frozen=True, slots=True)
class DagNodeRunInput:
    run_id: str
    tenant_id: str
    project_id: str
    node_id: str
    node_kind: str
    node_goal: str
    base_checkpoint_id: str
    expected_verification: tuple[str, ...]
    destructive: bool
    lease: LeaseInfo


@dataclass(frozen=True, slots=True)
class DagNodeRunResult:
    node_id: str
    checkpoint_id: str | None
    checkpoint_created: bool
    changed_paths: tuple[str, ...]
    summary: str = ""


@dataclass(frozen=True, slots=True)
class DagVerificationInput:
    run_id: str
    tenant_id: str
    project_id: str
    node_id: str
    checkpoint_id: str
    expected_verification: tuple[str, ...]
    lease: LeaseInfo


@dataclass(frozen=True, slots=True)
class DagVerificationResult:
    passed: bool
    summary: str = ""


@dataclass(frozen=True, slots=True)
class DagMergeInput:
    run_id: str
    tenant_id: str
    project_id: str
    node_id: str
    common_ancestor_checkpoint_id: str
    current_checkpoint_id: str
    candidate_checkpoint_id: str


@dataclass(frozen=True, slots=True)
class DagMergeResult:
    merged: bool
    checkpoint_id: str
    winner_node_id: str
    conflicts: tuple[Any, ...] = ()


@dataclass(frozen=True, slots=True)
class DagReplanInput:
    dag_json: dict[str, Any]
    completed_node_ids: tuple[str, ...]
    invalidated_node_id: str
    reason: str
    checkpoint_id: str
