from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest
from loopit_planner import (
    StructuredOutputModel,
    StructuredPlanner,
    TaskDAG,
    TaskNode,
    ValidationCode,
    validate_dag,
)
from loopit_planner.schema import task_dag_validator


def node(node_id: str, parents: tuple[str, ...] = ()) -> TaskNode:
    return TaskNode(
        id=node_id,
        kind="add_ui_component",
        goal=f"build {node_id}",
        dag_parents=parents,
        fork_checkpoint_id="green",
        expected_verification=("L0_typecheck_lint", "L1_tests"),
        destructive=False,
    )


def codes(dag: TaskDAG) -> set[ValidationCode]:
    return {error.code for error in validate_dag(dag)}


def test_schema_conformant_dag_validates() -> None:
    dag = TaskDAG("plan", "goal", (node("a"), node("b"), node("c", ("a", "b"))), "green")
    assert validate_dag(dag) == ()
    assert task_dag_validator().is_valid(dag.to_json())


def test_rejects_cycles() -> None:
    dag = TaskDAG("plan", "goal", (node("a", ("b",)), node("b", ("a",))), "green")
    assert ValidationCode.CYCLE in codes(dag)


def test_rejects_bad_and_unsatisfiable_parents() -> None:
    unknown = TaskDAG("plan", "goal", (node("a", ("ghost",)),), "green")
    self_parent = TaskDAG("plan", "goal", (node("a", ("a",)),), "green")
    assert ValidationCode.UNKNOWN_PARENT in codes(unknown)
    assert ValidationCode.UNSATISFIABLE_PARENT in codes(self_parent)


class FakePlannerModel(StructuredOutputModel):
    async def complete_json(
        self,
        *,
        schema: Mapping[str, Any],
        system: str,
        prompt: str,
    ) -> dict[str, object]:
        del schema, system, prompt
        return {
            "plan_id": "plan",
            "goal": "ship",
            "base_checkpoint_id": "green",
            "nodes": [
                {
                    "id": "api",
                    "kind": "add_api_route",
                    "goal": "add route",
                    "dag_parents": [],
                    "fork_checkpoint_id": "green",
                    "expected_verification": ["L0_typecheck_lint"],
                    "destructive": False,
                },
                {
                    "id": "deploy",
                    "kind": "deploy",
                    "goal": "deploy it",
                    "dag_parents": ["api"],
                    "fork_checkpoint_id": "green",
                    "expected_verification": ["L0_typecheck_lint"],
                    "destructive": False,
                },
            ],
        }


@pytest.mark.asyncio
async def test_structured_planner_normalises_policy_and_verification_floor() -> None:
    dag = await StructuredPlanner(FakePlannerModel()).plan(
        goal="ship",
        base_checkpoint_id="green",
        plan_id="plan",
    )
    api = dag.nodes[0]
    deploy = dag.nodes[1]
    assert "L2_browser_smoke" in api.expected_verification
    assert api.destructive is False
    assert deploy.destructive is True
    assert deploy.destructive_reason is not None
    assert validate_dag(dag) == ()
