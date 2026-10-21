"""Reporting (Doc 07 §5, Doc 09 §1).

The report is what a release decision is made from, so it deliberately refuses
to produce a single headline number. Pass rate alone hides cost; cost alone
hides capability. The pair, broken down by tier, is the smallest honest summary.

``cost_per_successful_task`` is the harness-side proxy for the platform's
north-star KPI, ``cost_per_successful_deploy``. Note the denominator: dividing
by *successful* tasks means a cheap run that fails everything looks as bad as it
is.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any

from .runner import TaskResult
from .suite import TIERS, Tier


@dataclass(frozen=True, slots=True)
class TierSummary:
    """Aggregates for one tier."""

    tier: Tier
    total: int
    passed_at_1: int
    passed_at_k: int
    credits_spent: float

    @property
    def pass_at_1(self) -> float:
        return self.passed_at_1 / self.total if self.total else 0.0

    @property
    def pass_at_k(self) -> float:
        return self.passed_at_k / self.total if self.total else 0.0

    @property
    def cost_per_successful_task(self) -> float:
        """Infinite when nothing passed — a zero here would read as free, not broken."""
        if self.passed_at_k == 0:
            return float("inf")
        return self.credits_spent / self.passed_at_k

    def to_dict(self) -> dict[str, Any]:
        cost = self.cost_per_successful_task
        return {
            **asdict(self),
            "pass_at_1": round(self.pass_at_1, 4),
            "pass_at_k": round(self.pass_at_k, 4),
            "cost_per_successful_task": None if cost == float("inf") else round(cost, 6),
        }


@dataclass(frozen=True, slots=True)
class CapabilitySummary:
    """Pass rate for one capability inside one tier."""

    tier: Tier
    capability: str
    total: int
    passed_at_1: int

    @property
    def pass_at_1(self) -> float:
        return self.passed_at_1 / self.total if self.total else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "tier": self.tier,
            "capability": self.capability,
            "total": self.total,
            "passed_at_1": self.passed_at_1,
            "pass_at_1": round(self.pass_at_1, 4),
        }


@dataclass(frozen=True, slots=True)
class Report:
    """A full run's results, per tier and overall."""

    results: Sequence[TaskResult]

    @property
    def tiers(self) -> tuple[TierSummary, ...]:
        summaries = []
        for tier in TIERS:
            in_tier = [result for result in self.results if result.task.tier == tier]
            if not in_tier:
                continue
            summaries.append(
                TierSummary(
                    tier=tier,
                    total=len(in_tier),
                    passed_at_1=sum(1 for r in in_tier if r.passed_first),
                    passed_at_k=sum(1 for r in in_tier if r.passed_any),
                    credits_spent=sum(r.credits_spent for r in in_tier),
                )
            )
        return tuple(summaries)

    @property
    def capabilities(self) -> tuple[CapabilitySummary, ...]:
        summaries: list[CapabilitySummary] = []
        for tier in TIERS:
            in_tier = [result for result in self.results if result.task.tier == tier]
            capabilities = sorted({cap for result in in_tier for cap in _capabilities(result)})
            for capability in capabilities:
                matching = [result for result in in_tier if capability in _capabilities(result)]
                summaries.append(
                    CapabilitySummary(
                        tier=tier,
                        capability=capability,
                        total=len(matching),
                        passed_at_1=sum(1 for result in matching if result.passed_first),
                    )
                )
        return tuple(summaries)

    @property
    def total(self) -> int:
        return len(self.results)

    @property
    def passed(self) -> int:
        return sum(1 for result in self.results if result.passed_any)

    @property
    def pass_at_1(self) -> float:
        if not self.results:
            return 0.0
        return sum(1 for r in self.results if r.passed_first) / len(self.results)

    @property
    def credits_spent(self) -> float:
        return sum(result.credits_spent for result in self.results)

    @property
    def cost_per_successful_task(self) -> float:
        if self.passed == 0:
            return float("inf")
        return self.credits_spent / self.passed

    def pass_at_1_by_tier(self) -> dict[str, float]:
        """The comparable shape a baseline is stored and compared as."""
        return {summary.tier: summary.pass_at_1 for summary in self.tiers}

    def regressions_against(
        self, baseline: Mapping[str, float], tolerance: float = 0.0
    ) -> list[str]:
        """Tiers whose pass@1 dropped by more than ``tolerance``.

        Takes a plain tier → pass@1 mapping so a baseline can be read straight
        from a stored results file without reconstructing a whole run.

        Compared per tier rather than overall so a T3 improvement cannot mask a
        T0 breakage — the exact substitution that lets a broken loop ship.
        """
        regressed = []
        for summary in self.tiers:
            before = baseline.get(summary.tier)
            if before is not None and summary.pass_at_1 < before - tolerance:
                regressed.append(f"{summary.tier}: pass@1 {before:.2%} -> {summary.pass_at_1:.2%}")
        return regressed

    def to_dict(self) -> dict[str, Any]:
        cost = self.cost_per_successful_task
        return {
            "total_tasks": self.total,
            "passed": self.passed,
            "pass_at_1": round(self.pass_at_1, 4),
            "credits_spent": round(self.credits_spent, 6),
            "cost_per_successful_task": None if cost == float("inf") else round(cost, 6),
            "tiers": [summary.to_dict() for summary in self.tiers],
            "capabilities": [summary.to_dict() for summary in self.capabilities],
            "failures": [
                {
                    "task_id": result.task.task_id,
                    "tier": result.task.tier,
                    "outcome": result.outcome,
                    "failed_checks": list(result.scores[0].failed_checks if result.scores else ()),
                    "errors": list(result.errors),
                }
                for result in self.results
                if not result.passed_any
            ],
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)

    def to_text(self) -> str:
        lines = [
            f"tasks: {self.total}   pass@1: {self.pass_at_1:.1%}   "
            f"pass@k: {self.passed}/{self.total}",
            f"credits: {self.credits_spent:.4f}",
        ]
        cost = self.cost_per_successful_task
        lines.append(
            "cost per successful task: "
            + ("n/a (nothing passed)" if cost == float("inf") else f"{cost:.4f}")
        )
        lines.append("")
        for summary in self.tiers:
            lines.append(
                f"  {summary.tier}  {summary.passed_at_1}/{summary.total} pass@1"
                f"   {summary.passed_at_k}/{summary.total} pass@k"
                f"   {summary.credits_spent:.4f} credits"
            )
        failures = [result for result in self.results if not result.passed_any]
        if failures:
            lines.append("")
            lines.append("failures:")
            for result in failures:
                lines.append(f"  {result.task.task_id} [{result.outcome}]")
        return "\n".join(lines)


def _capabilities(result: TaskResult) -> tuple[str, ...]:
    explicit = tuple(tag for tag in result.task.tags if tag in {"coding", "reasoning"})
    if explicit:
        return explicit
    return ("coding", "reasoning") if result.task.tier == "T3" else ("coding",)
