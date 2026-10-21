"""The tiered task suite (Doc 07 §2).

Tiers exist so a regression can be localised. A drop confined to T0 is a
harness or serving fault; a drop confined to T3 is a planning-capability fault.
A single blended score hides both.

Tasks are data, not code: adding one is writing a JSON file, which is what keeps
the suite growing. Every real production failure becomes a task here — that is
the mechanism by which the platform stops repeating its own mistakes.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

Tier = Literal["T0", "T1", "T2", "T3"]
TIERS: tuple[Tier, ...] = ("T0", "T1", "T2", "T3")

TIER_DESCRIPTIONS: dict[Tier, str] = {
    "T0": "Trivial single-file changes. A failure here means the loop is broken.",
    "T1": "Single-feature CRUD apps. The commodity case the platform must nail.",
    "T2": "Multi-feature apps with auth, relations, and state.",
    "T3": "Ambiguous briefs needing planning and clarifying questions.",
}


class SuiteError(ValueError):
    """The suite definition is invalid and must not be run."""


@dataclass(frozen=True, slots=True)
class Task:
    """One eval task.

    Attributes:
        checks: the functional gates. A task passes only when *all* of them do,
            because partial credit lets a half-working app count as a success
            and that is precisely the failure mode users notice.
        budget_credits: the ceiling for one attempt. A task that only passes by
            burning unbounded credits has not passed.
        origin: ``authored`` or ``production-failure``. Tasks derived from real
            incidents are the highest-value ones in the suite.
    """

    task_id: str
    tier: Tier
    prompt: str
    checks: Sequence[str]
    budget_credits: float
    max_wall_clock_seconds: int = 900
    tags: Sequence[str] = field(default_factory=tuple)
    origin: str = "authored"

    def __post_init__(self) -> None:
        if self.tier not in TIERS:
            raise SuiteError(f"task {self.task_id!r} has unknown tier {self.tier!r}")
        if not self.checks:
            raise SuiteError(
                f"task {self.task_id!r} has no checks; a task without functional "
                "checks cannot be scored and would silently always pass"
            )
        if self.budget_credits <= 0:
            raise SuiteError(f"task {self.task_id!r} must have a positive budget")

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> Task:
        try:
            return cls(
                task_id=payload["task_id"],
                tier=payload["tier"],
                prompt=payload["prompt"],
                checks=tuple(payload["checks"]),
                budget_credits=float(payload["budget_credits"]),
                max_wall_clock_seconds=int(payload.get("max_wall_clock_seconds", 900)),
                tags=tuple(payload.get("tags", ())),
                origin=payload.get("origin", "authored"),
            )
        except KeyError as missing:
            raise SuiteError(f"task definition is missing {missing}") from None


def load_suite(root: Path, tiers: Sequence[Tier] | None = None) -> tuple[Task, ...]:
    """Load every task under ``root``, optionally filtered to ``tiers``.

    Duplicate task ids are fatal: a silently shadowed task is a test that stops
    running without anyone noticing.
    """
    wanted = set(tiers or TIERS)
    tasks: list[Task] = []
    seen: set[str] = set()

    for path in sorted(_task_files(root)):
        payload = json.loads(path.read_text(encoding="utf-8"))
        task = Task.from_dict(payload)
        if task.task_id in seen:
            raise SuiteError(f"duplicate task id {task.task_id!r} at {path}")
        seen.add(task.task_id)
        if task.tier in wanted:
            tasks.append(task)

    return tuple(tasks)


def _task_files(root: Path) -> Iterator[Path]:
    if not root.exists():
        raise SuiteError(f"eval suite directory {root} does not exist")
    yield from root.rglob("*.task.json")
