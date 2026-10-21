"""Run and task budgets (invariant I12, Doc 04 §8).

Every loop is bounded on four axes — iterations, tokens, wall-clock, and credits.
An agent that retries indefinitely on a failing approach is not persistent, it
is expensive: the correct behaviour is to stop, surface an explicit status, and
ask for human input.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field


class BudgetExceeded(RuntimeError):
    """A budget axis was exhausted.

    This is a normal control-flow outcome, not a bug. The run stops with an
    explicit status rather than looping forever.
    """

    def __init__(self, axis: str, limit: float, used: float) -> None:
        super().__init__(f"budget exceeded on {axis}: used {used:g} of {limit:g}")
        self.axis = axis
        self.limit = limit
        self.used = used


@dataclass(frozen=True, slots=True)
class Budget:
    """Hard limits for one run or task. Every axis must be set."""

    max_iterations: int = 25
    max_tokens: int = 2_000_000
    max_wall_clock_seconds: float = 3600.0
    max_credits: float = 50.0

    def __post_init__(self) -> None:
        for axis, value in (
            ("max_iterations", self.max_iterations),
            ("max_tokens", self.max_tokens),
            ("max_wall_clock_seconds", self.max_wall_clock_seconds),
            ("max_credits", self.max_credits),
        ):
            if value <= 0:
                raise ValueError(f"{axis} must be positive, got {value!r}")

    def narrowed_by(self, other: Budget | None) -> Budget:
        """Combine with a task-level budget, taking the stricter limit on each axis.

        A task can never widen its run's budget — only tighten it.
        """
        if other is None:
            return self
        return Budget(
            max_iterations=min(self.max_iterations, other.max_iterations),
            max_tokens=min(self.max_tokens, other.max_tokens),
            max_wall_clock_seconds=min(self.max_wall_clock_seconds, other.max_wall_clock_seconds),
            max_credits=min(self.max_credits, other.max_credits),
        )


#: Upper bound on how many iterations a run may earn back through refunds.
#: A run can therefore never exceed roughly (1 + REFUND_CAP_FACTOR)x its base
#: iteration count, no matter how well each individual turn goes. The tokens,
#: credits and wall-clock axes bound real cost underneath this.
REFUND_CAP_FACTOR = 2


@dataclass(slots=True)
class BudgetLedger:
    """Tracks consumption against a :class:`Budget`.

    Charges are recorded *before* the next iteration is allowed to start, so a
    run cannot overshoot by one expensive step.

    The iteration axis prices *recovery*, not work. A turn whose tool call
    executed is the loop operating as intended — orientation reads, patches,
    and the verification reflection cycle are what a build IS — so the loop
    refunds those turns via :meth:`refund_iteration` and only genuinely
    non-progress turns (tool failures, rejected calls, truncations) spend the
    budget. A "standard" build was dying at turn 14 with the app half-
    assembled when every turn counted; now 14 means fourteen turns of
    getting nowhere. What keeps a refunded loop from running forever: read
    orbiting has its own consecutive cap in the loop, truncations their retry
    limit, repeated identical verification failures the stall detector, and
    the pool itself is capped at REFUND_CAP_FACTOR times the budget.
    """

    budget: Budget
    iterations: int = 0
    tokens: int = 0
    credits: float = 0.0
    refunded_iterations: int = 0
    _started_at: float = field(default_factory=time.monotonic)

    @property
    def elapsed_seconds(self) -> float:
        return time.monotonic() - self._started_at

    @property
    def remaining_iterations(self) -> int:
        return max(0, self.budget.max_iterations - self.iterations)

    def charge(self, *, tokens: int = 0, credits: float = 0.0) -> None:
        """Record consumption. Does not raise; call :meth:`check` to enforce."""
        if tokens < 0 or credits < 0:
            raise ValueError("charges must be non-negative")
        self.tokens += tokens
        self.credits += credits

    def start_iteration(self) -> int:
        """Enforce all axes, then begin an iteration.

        Raises:
            BudgetExceeded: any axis is exhausted.
        """
        self.check()
        if self.iterations >= self.budget.max_iterations:
            raise BudgetExceeded("iterations", self.budget.max_iterations, self.iterations)
        self.iterations += 1
        return self.iterations

    def check(self) -> None:
        """Raise if any non-iteration axis is exhausted."""
        if self.tokens > self.budget.max_tokens:
            raise BudgetExceeded("tokens", self.budget.max_tokens, self.tokens)
        if self.credits > self.budget.max_credits:
            raise BudgetExceeded("credits", self.budget.max_credits, self.credits)
        elapsed = self.elapsed_seconds
        if elapsed > self.budget.max_wall_clock_seconds:
            raise BudgetExceeded("wall_clock_seconds", self.budget.max_wall_clock_seconds, elapsed)

    def refund_iteration(self) -> bool:
        """Return one iteration to the pool after a turn that did real work.

        Returns False when the turn cannot be refunded (nothing to refund, or
        the refund pool is exhausted) — the caller never branches on it, the
        bound is internal.
        """
        if self.iterations <= 0:
            return False
        if self.refunded_iterations >= self.budget.max_iterations * REFUND_CAP_FACTOR:
            return False
        self.iterations -= 1
        self.refunded_iterations += 1
        return True

    def snapshot(self) -> dict[str, float | int]:
        """A compact record for the audit log."""
        return {
            "iterations": self.iterations,
            "refunded_iterations": self.refunded_iterations,
            "tokens": self.tokens,
            "credits": round(self.credits, 6),
            "elapsed_seconds": round(self.elapsed_seconds, 3),
        }
