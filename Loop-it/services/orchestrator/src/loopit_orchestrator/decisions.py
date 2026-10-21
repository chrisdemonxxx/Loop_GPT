"""Pure deterministic helpers for workflow decisions and retry policy."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from loopit_agent_core.gates import approval_binding_hash, gate_id_for
from loopit_policy import FailureClass, classify_action, classify_failure
from loopit_policy.actions import GateRequirement
from temporalio.common import RetryPolicy

from .types import GateRequest, StepOutcome, UsageDelta, WorkflowBudget

NON_RETRYABLE_FAILURES = frozenset(
    {
        FailureClass.VERIFICATION,
        FailureClass.BUDGET,
        FailureClass.GATE_REJECTED,
        FailureClass.HARD_ERROR,
        FailureClass.MERGE_CONFLICT,
    }
)


@dataclass(frozen=True, slots=True)
class BudgetSnapshot:
    iterations: int = 0
    tokens: int = 0
    credits: float = 0.0


class WorkflowBudgetExceeded(RuntimeError):
    def __init__(self, axis: str, limit: int | float, used: int | float) -> None:
        super().__init__(f"budget exceeded on {axis}: used {used} of {limit}")
        self.axis = axis
        self.limit = limit
        self.used = used


def add_usage(snapshot: BudgetSnapshot, delta: UsageDelta) -> BudgetSnapshot:
    if delta.iterations < 0 or delta.tokens < 0 or delta.credits < 0:
        raise ValueError("usage deltas must be non-negative")
    return BudgetSnapshot(
        iterations=snapshot.iterations + delta.iterations,
        tokens=snapshot.tokens + delta.tokens,
        credits=snapshot.credits + delta.credits,
    )


def enforce_budget(
    snapshot: BudgetSnapshot,
    budget: WorkflowBudget,
    *,
    elapsed_seconds: int,
) -> None:
    if snapshot.iterations >= budget.max_iterations:
        raise WorkflowBudgetExceeded("iterations", budget.max_iterations, snapshot.iterations)
    if snapshot.tokens > budget.max_tokens:
        raise WorkflowBudgetExceeded("tokens", budget.max_tokens, snapshot.tokens)
    if snapshot.credits > budget.max_credits:
        raise WorkflowBudgetExceeded("credits", budget.max_credits, snapshot.credits)
    if elapsed_seconds > budget.max_wall_clock_seconds:
        raise WorkflowBudgetExceeded(
            "wall_clock_seconds", budget.max_wall_clock_seconds, elapsed_seconds
        )


def retry_policy_for_failure(failure: FailureClass | BaseException | str) -> RetryPolicy:
    failure_class = failure if isinstance(failure, FailureClass) else classify_failure(failure)
    if failure_class is FailureClass.TRANSIENT:
        return RetryPolicy(maximum_attempts=3)
    return RetryPolicy(maximum_attempts=1, non_retryable_error_types=[failure_class.value])


def default_activity_retry_policy() -> RetryPolicy:
    return RetryPolicy(
        maximum_attempts=3,
        non_retryable_error_types=sorted(item.value for item in NON_RETRYABLE_FAILURES),
    )


def gate_for_tool_call(
    tool: str,
    args: dict[str, object],
    *,
    now: datetime,
    run_id: str = "local",
    ttl: timedelta = timedelta(minutes=30),
) -> GateRequest | None:
    verdict = classify_action({"tool": tool, "args": args})
    if verdict.required_gate is not GateRequirement.HUMAN_CONFIRM:
        return None
    args_hash = approval_binding_hash(tool, args, run_id)
    return GateRequest(
        gate_id=gate_id_for(tool, args, run_id),
        tool=tool,
        args=dict(args),
        reason=verdict.reason,
        requested_at=now.isoformat(),
        args_hash=args_hash,
        expires_at=(now + ttl).isoformat(),
    )


def terminal_status_for_step(outcome: StepOutcome) -> str | None:
    if outcome is StepOutcome.VERIFIED:
        return "succeeded"
    if outcome is StepOutcome.STALLED:
        return "failed"
    return None
