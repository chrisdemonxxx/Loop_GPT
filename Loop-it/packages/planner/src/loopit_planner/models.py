"""Typed Python mirror for the task-DAG contract."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

TaskKindName = Literal[
    "scaffold_project",
    "add_table",
    "add_api_route",
    "add_ui_page",
    "add_ui_component",
    "wire_auth",
    "add_dependency",
    "write_tests",
    "fix_verification_failure",
    "deploy",
]
VerificationLayer = Literal[
    "L0_typecheck_lint",
    "L1_tests",
    "L2_browser_smoke",
    "L2_5_sast",
    "L3_visual_diff",
]


@dataclass(frozen=True, slots=True)
class Budget:
    max_iterations: int | None = None
    max_tokens: int | None = None
    max_wall_clock_seconds: int | None = None
    max_credits: float | None = None

    @classmethod
    def from_mapping(cls, raw: dict[str, Any] | None) -> Budget | None:
        if raw is None:
            return None
        return cls(
            max_iterations=_optional_int(raw.get("max_iterations")),
            max_tokens=_optional_int(raw.get("max_tokens")),
            max_wall_clock_seconds=_optional_int(raw.get("max_wall_clock_seconds")),
            max_credits=_optional_float(raw.get("max_credits")),
        )

    def to_json(self) -> dict[str, int | float]:
        result: dict[str, int | float] = {}
        if self.max_iterations is not None:
            result["max_iterations"] = self.max_iterations
        if self.max_tokens is not None:
            result["max_tokens"] = self.max_tokens
        if self.max_wall_clock_seconds is not None:
            result["max_wall_clock_seconds"] = self.max_wall_clock_seconds
        if self.max_credits is not None:
            result["max_credits"] = self.max_credits
        return result


@dataclass(frozen=True, slots=True)
class TaskNode:
    id: str
    kind: TaskKindName
    goal: str
    dag_parents: tuple[str, ...]
    expected_verification: tuple[VerificationLayer, ...]
    destructive: bool
    fork_checkpoint_id: str | None = None
    destructive_reason: str | None = None
    budget: Budget | None = None

    @classmethod
    def from_mapping(cls, raw: dict[str, Any]) -> TaskNode:
        budget = raw.get("budget")
        return cls(
            id=str(raw["id"]),
            kind=_task_kind(raw["kind"]),
            goal=str(raw["goal"]),
            dag_parents=tuple(str(parent) for parent in raw["dag_parents"]),
            expected_verification=tuple(
                _verification_layer(layer) for layer in raw["expected_verification"]
            ),
            destructive=bool(raw["destructive"]),
            fork_checkpoint_id=str(raw["fork_checkpoint_id"])
            if raw.get("fork_checkpoint_id") is not None
            else None,
            destructive_reason=str(raw["destructive_reason"])
            if raw.get("destructive_reason") is not None
            else None,
            budget=Budget.from_mapping(budget if isinstance(budget, dict) else None),
        )

    def to_json(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "goal": self.goal,
            "dag_parents": list(self.dag_parents),
            "expected_verification": list(self.expected_verification),
            "destructive": self.destructive,
        }
        if self.fork_checkpoint_id is not None:
            result["fork_checkpoint_id"] = self.fork_checkpoint_id
        if self.destructive_reason is not None:
            result["destructive_reason"] = self.destructive_reason
        if self.budget is not None:
            result["budget"] = self.budget.to_json()
        return result


@dataclass(frozen=True, slots=True)
class TaskDAG:
    plan_id: str
    goal: str
    nodes: tuple[TaskNode, ...]
    base_checkpoint_id: str | None = None
    revision: int = 0
    invalidations: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def from_mapping(cls, raw: dict[str, Any]) -> TaskDAG:
        return cls(
            plan_id=str(raw["plan_id"]),
            goal=str(raw["goal"]),
            base_checkpoint_id=str(raw["base_checkpoint_id"])
            if raw.get("base_checkpoint_id") is not None
            else None,
            nodes=tuple(TaskNode.from_mapping(dict(node)) for node in raw["nodes"]),
        )

    def to_json(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "plan_id": self.plan_id,
            "goal": self.goal,
            "nodes": [node.to_json() for node in self.nodes],
        }
        if self.base_checkpoint_id is not None:
            result["base_checkpoint_id"] = self.base_checkpoint_id
        return result

    def replace_nodes(
        self,
        nodes: tuple[TaskNode, ...],
        *,
        revision: int | None = None,
        invalidations: tuple[str, ...] | None = None,
    ) -> TaskDAG:
        return TaskDAG(
            plan_id=self.plan_id,
            goal=self.goal,
            nodes=nodes,
            base_checkpoint_id=self.base_checkpoint_id,
            revision=self.revision + 1 if revision is None else revision,
            invalidations=self.invalidations if invalidations is None else invalidations,
        )


def _optional_int(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value)
    raise TypeError(f"expected int-compatible value, got {type(value).__name__}")


def _optional_float(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, int | float | str):
        return float(value)
    raise TypeError(f"expected float-compatible value, got {type(value).__name__}")


def _task_kind(value: object) -> TaskKindName:
    return str(value)  # type: ignore[return-value]


def _verification_layer(value: object) -> VerificationLayer:
    return str(value)  # type: ignore[return-value]
