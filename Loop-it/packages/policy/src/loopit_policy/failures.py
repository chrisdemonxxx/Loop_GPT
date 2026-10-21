"""Failure taxonomy for orchestrator retry decisions."""

from __future__ import annotations

from enum import StrEnum

from .rules import DEFAULT_RULE_SET, RuleSet


class FailureClass(StrEnum):
    TRANSIENT = "transient"
    VERIFICATION = "verification"
    BUDGET = "budget"
    MERGE_CONFLICT = "merge-conflict"
    GATE_REJECTED = "gate-rejected"
    HARD_ERROR = "hard-error"


_RETRYABLE = frozenset(
    {FailureClass.TRANSIENT, FailureClass.VERIFICATION, FailureClass.MERGE_CONFLICT}
)


def classify_failure(
    error: BaseException | str, *, rule_set: RuleSet = DEFAULT_RULE_SET
) -> FailureClass:
    text = _error_text(error)
    for key, markers in rule_set.failure_markers.items():
        if any(marker in text for marker in markers):
            if key == "merge_conflict":
                return FailureClass.MERGE_CONFLICT
            if key == "gate_rejected":
                return FailureClass.GATE_REJECTED
            return FailureClass(key)
    return FailureClass.HARD_ERROR


def is_retryable(failure: FailureClass | BaseException | str) -> bool:
    """Return whether retrying may make progress."""
    if isinstance(failure, FailureClass):
        failure_class = failure
    else:
        failure_class = classify_failure(failure)
    return failure_class in _RETRYABLE


def _error_text(error: BaseException | str) -> str:
    if isinstance(error, BaseException):
        return f"{type(error).__name__}: {error}".lower()
    return error.lower()
