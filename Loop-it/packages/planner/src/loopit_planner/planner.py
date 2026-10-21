"""Structured-output planner entrypoint."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

from loopit_agent_core.vocabulary import describe_vocabulary, is_destructive, resolve_verification
from loopit_policy import Destructiveness, classify_action

from .dag import assert_valid_dag
from .models import TaskDAG, TaskNode, VerificationLayer
from .schema import task_dag_schema


class StructuredOutputModel(Protocol):
    """Model seam for JSON-schema constrained planning."""

    async def complete_json(
        self,
        *,
        schema: Mapping[str, Any],
        system: str,
        prompt: str,
    ) -> Mapping[str, Any]:
        """Return one object already constrained to the supplied JSON Schema."""


class StructuredPlanner:
    """Produce a normalised, schema-valid task DAG from a user goal."""

    def __init__(self, model: StructuredOutputModel) -> None:
        self._model = model

    async def plan(
        self,
        *,
        goal: str,
        base_checkpoint_id: str,
        plan_id: str,
    ) -> TaskDAG:
        raw = await self._model.complete_json(
            schema=task_dag_schema(),
            system=_SYSTEM_PROMPT,
            prompt=_prompt(goal, base_checkpoint_id, plan_id),
        )
        dag = TaskDAG.from_mapping(dict(raw))
        normalised = _normalise_dag(dag, base_checkpoint_id=base_checkpoint_id, plan_id=plan_id)
        assert_valid_dag(normalised)
        return normalised


def _normalise_dag(dag: TaskDAG, *, base_checkpoint_id: str, plan_id: str) -> TaskDAG:
    nodes = tuple(
        _normalise_node(node, base_checkpoint_id=base_checkpoint_id) for node in dag.nodes
    )
    return TaskDAG(
        plan_id=dag.plan_id or plan_id,
        goal=dag.goal,
        base_checkpoint_id=dag.base_checkpoint_id or base_checkpoint_id,
        nodes=nodes,
    )


def _normalise_node(node: TaskNode, *, base_checkpoint_id: str) -> TaskNode:
    verification = tuple(
        sorted(
            resolve_verification(node.kind, set(node.expected_verification)),
            key=_verification_rank,
        )
    )
    declared_destructive = node.destructive or _policy_says_destructive(node)
    destructive = is_destructive(node.kind, declared=declared_destructive)
    reason = node.destructive_reason
    if destructive and not reason:
        reason = f"{node.kind} requires a human confirmation gate"
    return TaskNode(
        id=node.id,
        kind=node.kind,
        goal=node.goal,
        dag_parents=node.dag_parents,
        fork_checkpoint_id=node.fork_checkpoint_id or base_checkpoint_id,
        expected_verification=cast_verification_layers(verification),
        destructive=destructive,
        destructive_reason=reason,
        budget=node.budget,
    )


def _policy_says_destructive(node: TaskNode) -> bool:
    action = (
        {"tool": "deploy", "args": {"goal": node.goal}}
        if node.kind == "deploy"
        else {"tool": "provision", "args": {"resource": "table", "goal": node.goal}}
        if node.kind == "add_table"
        else {"tool": "apply_patch", "args": {"goal": node.goal}}
    )
    verdict = classify_action(action)
    return verdict.destructiveness is Destructiveness.DESTRUCTIVE


def _verification_rank(layer: str) -> int:
    order = {
        "L0_typecheck_lint": 0,
        "L1_tests": 1,
        "L2_browser_smoke": 2,
        "L2_5_sast": 3,
        "L3_visual_diff": 4,
    }
    return order[layer]


def _prompt(goal: str, base_checkpoint_id: str, plan_id: str) -> str:
    return "\n".join(
        [
            f"Plan id: {plan_id}",
            f"Base green checkpoint id: {base_checkpoint_id}",
            "",
            describe_vocabulary(),
            "",
            "Emit only a task DAG JSON object. Independent nodes should share the base checkpoint.",
            f"Goal: {goal}",
        ]
    )


_SYSTEM_PROMPT = (
    "You are Loop-it's planner. Produce a valid task DAG with explicit dependencies, "
    "verification levels, fork checkpoints, and destructiveness flags."
)


def cast_verification_layers(layers: tuple[str, ...]) -> tuple[VerificationLayer, ...]:
    return layers  # type: ignore[return-value]
