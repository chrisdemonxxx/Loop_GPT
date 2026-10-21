"""Running the suite (Doc 07 §3).

The runner owns repetition and isolation; the executor owns actually building
the app. Keeping them apart is what lets the same suite run against a local
loop, a hosted model, or a competitor's product for comparison.

Every task runs ``attempts`` times because a single sample of a stochastic
system is not a measurement. ``pass@k`` and ``pass@1`` are both reported:
``pass@1`` is what a user experiences, ``pass@k`` is what the system is capable
of, and the gap between them is the reliability problem.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

from .scoring import CheckResult, Score, score_task
from .suite import Task

RunOutcome = Literal["passed", "failed", "errored", "budget_exceeded", "timed_out"]


@dataclass(frozen=True, slots=True)
class Attempt:
    """One execution of one task."""

    checks: Sequence[CheckResult]
    credits_spent: float
    wall_clock_seconds: float
    error: str | None = None


@runtime_checkable
class TaskExecutor(Protocol):
    """Builds the app for a task and reports its check results.

    Implementations drive the real agent loop against a real sandbox. The
    harness never inspects how that happens, which is what keeps the suite
    reusable across loop rewrites.
    """

    def execute(self, task: Task) -> Attempt: ...


@dataclass(frozen=True, slots=True)
class TaskResult:
    """Every attempt at one task, plus the derived verdict."""

    task: Task
    scores: Sequence[Score]
    outcome: RunOutcome
    wall_clock_seconds: float = 0.0
    errors: Sequence[str] = field(default_factory=tuple)

    @property
    def passed_any(self) -> bool:
        """pass@k — did the system solve it at all?"""
        return any(score.passed for score in self.scores)

    @property
    def passed_first(self) -> bool:
        """pass@1 — did the *user's* first attempt work?"""
        return bool(self.scores) and self.scores[0].passed

    @property
    def credits_spent(self) -> float:
        """Total spend across all attempts. Retries are not free."""
        return sum(score.credits_spent for score in self.scores)


class EvalRunner:
    """Runs a suite and produces per-task results."""

    def __init__(self, executor: TaskExecutor, attempts: int = 1) -> None:
        if attempts < 1:
            raise ValueError("attempts must be at least 1")
        self._executor = executor
        self._attempts = attempts

    def run(self, tasks: Sequence[Task]) -> tuple[TaskResult, ...]:
        return tuple(self.run_task(task) for task in tasks)

    def run_task(self, task: Task) -> TaskResult:
        scores: list[Score] = []
        errors: list[str] = []
        started = time.monotonic()

        for _ in range(self._attempts):
            try:
                attempt = self._executor.execute(task)
            except Exception as error:
                errors.append(f"{type(error).__name__}: {error}")
                scores.append(score_task((), credits_spent=0.0, budget_credits=task.budget_credits))
                continue

            if attempt.error:
                errors.append(attempt.error)
            scores.append(
                score_task(
                    attempt.checks,
                    credits_spent=attempt.credits_spent,
                    budget_credits=task.budget_credits,
                )
            )

        elapsed = time.monotonic() - started
        return TaskResult(
            task=task,
            scores=tuple(scores),
            outcome=_outcome(task, scores, errors),
            wall_clock_seconds=elapsed,
            errors=tuple(errors),
        )


def _outcome(task: Task, scores: Sequence[Score], errors: Sequence[str]) -> RunOutcome:
    """Classify a task run.

    Distinguishing ``errored`` and ``budget_exceeded`` from ``failed`` matters:
    an infrastructure fault and a capability gap have different owners, and
    conflating them sends the team chasing the wrong regression.
    """
    if any(score.passed for score in scores):
        return "passed"
    if errors and not any(score.checks for score in scores):
        return "errored"
    if scores and all(score.checks and not score.within_budget for score in scores):
        return "budget_exceeded"
    return "failed"
