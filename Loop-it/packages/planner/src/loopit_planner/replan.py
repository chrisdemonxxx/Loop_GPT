"""Revise only unfinished DAG nodes after invalidated assumptions."""

from __future__ import annotations

from dataclasses import dataclass

from .dag import assert_valid_dag
from .models import TaskDAG, TaskNode


@dataclass(frozen=True, slots=True)
class Invalidation:
    node_id: str
    reason: str
    checkpoint_id: str | None = None


def preserve_completed_and_replan_remaining(
    dag: TaskDAG,
    *,
    completed: set[str],
    invalidation: Invalidation,
    replacement_remaining: tuple[TaskNode, ...],
) -> TaskDAG:
    """Keep completed nodes immutable and replace only the unfinished suffix."""
    completed_nodes = tuple(node for node in dag.nodes if node.id in completed)
    completed_ids = {node.id for node in completed_nodes}
    remaining: list[TaskNode] = []
    for node in replacement_remaining:
        if node.id in completed_ids:
            continue
        parents = tuple(
            parent for parent in node.dag_parents if parent in completed_ids or parent != node.id
        )
        remaining.append(_with_parents(node, parents))
    revised = dag.replace_nodes(
        completed_nodes + tuple(remaining),
        invalidations=(*dag.invalidations, f"{invalidation.node_id}: {invalidation.reason}"),
    )
    assert_valid_dag(revised)
    return revised


def _with_parents(node: TaskNode, parents: tuple[str, ...]) -> TaskNode:
    return TaskNode(
        id=node.id,
        kind=node.kind,
        goal=node.goal,
        dag_parents=parents,
        expected_verification=node.expected_verification,
        destructive=node.destructive,
        fork_checkpoint_id=node.fork_checkpoint_id,
        destructive_reason=node.destructive_reason,
        budget=node.budget,
    )
