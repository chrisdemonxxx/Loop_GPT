"""Functional scoring (Doc 07 §3).

A task's score is the conjunction of its checks. There is no partial credit and
no similarity metric: an app where four of five checks pass is a broken app, and
recording it as 80% teaches the platform the wrong lesson.

Checks are opaque strings interpreted by the executor (a shell command, a
Playwright spec, an HTTP assertion). The harness's job is to decide pass/fail
from their results, not to know how they run.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class CheckResult:
    """The outcome of one functional check."""

    name: str
    passed: bool
    detail: str = ""


@dataclass(frozen=True, slots=True)
class Score:
    """A task's score.

    ``passed`` requires every check to pass *and* the run to stay inside budget.
    Budget is part of correctness, not a separate report: a task that only
    succeeds by burning ten times its allowance has not solved the problem the
    platform needs solved.
    """

    passed: bool
    checks: Sequence[CheckResult]
    credits_spent: float
    within_budget: bool
    reason: str = ""

    @property
    def checks_passed(self) -> int:
        return sum(1 for check in self.checks if check.passed)

    @property
    def failed_checks(self) -> tuple[str, ...]:
        return tuple(check.name for check in self.checks if not check.passed)


def score_task(
    checks: Sequence[CheckResult],
    credits_spent: float,
    budget_credits: float,
) -> Score:
    """Combine check results and spend into a single pass/fail verdict."""
    if not checks:
        return Score(
            passed=False,
            checks=(),
            credits_spent=credits_spent,
            within_budget=credits_spent <= budget_credits,
            reason="no checks ran; an unscored task is a failed task",
        )

    within_budget = credits_spent <= budget_credits
    all_passed = all(check.passed for check in checks)

    if not all_passed:
        failed = ", ".join(check.name for check in checks if not check.passed)
        reason = f"failed checks: {failed}"
    elif not within_budget:
        reason = (
            f"all checks passed but spent {credits_spent:.4f} credits against a "
            f"budget of {budget_credits:.4f}"
        )
    else:
        reason = "all checks passed within budget"

    return Score(
        passed=all_passed and within_budget,
        checks=tuple(checks),
        credits_spent=credits_spent,
        within_budget=within_budget,
        reason=reason,
    )
