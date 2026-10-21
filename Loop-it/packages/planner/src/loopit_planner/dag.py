"""Structural DAG validation and scheduling helpers."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from enum import StrEnum

from .models import TaskDAG, TaskNode
from .schema import validate_schema


class ValidationCode(StrEnum):
    SCHEMA = "schema"
    DUPLICATE_ID = "duplicate-id"
    UNKNOWN_PARENT = "unknown-parent"
    CYCLE = "cycle"
    UNREACHABLE = "unreachable"
    UNSATISFIABLE_PARENT = "unsatisfiable-parent"
    MISSING_DESTRUCTIVE_REASON = "missing-destructive-reason"


@dataclass(frozen=True, slots=True)
class DagValidationError:
    code: ValidationCode
    message: str
    node_id: str | None = None


def validate_dag(dag: TaskDAG) -> tuple[DagValidationError, ...]:
    errors: list[DagValidationError] = [
        DagValidationError(ValidationCode.SCHEMA, message) for message in validate_schema(dag)
    ]
    by_id: dict[str, TaskNode] = {}
    duplicates: set[str] = set()
    for node in dag.nodes:
        if node.id in by_id:
            duplicates.add(node.id)
            errors.append(
                DagValidationError(
                    ValidationCode.DUPLICATE_ID, f"duplicate node id {node.id!r}", node.id
                )
            )
        by_id[node.id] = node

    for node in dag.nodes:
        if node.destructive and not node.destructive_reason:
            errors.append(
                DagValidationError(
                    ValidationCode.MISSING_DESTRUCTIVE_REASON,
                    f"node {node.id!r} is destructive but has no gate reason",
                    node.id,
                )
            )
        for parent in node.dag_parents:
            if parent not in by_id:
                errors.append(
                    DagValidationError(
                        ValidationCode.UNKNOWN_PARENT,
                        f"node {node.id!r} depends on unknown parent {parent!r}",
                        node.id,
                    )
                )
            elif parent == node.id or parent in duplicates:
                errors.append(
                    DagValidationError(
                        ValidationCode.UNSATISFIABLE_PARENT,
                        f"node {node.id!r} has an unsatisfiable parent {parent!r}",
                        node.id,
                    )
                )

    ranks = topological_ranks(dag)
    unresolved = {node.id for node in dag.nodes if node.id not in ranks}
    for node_id in sorted(unresolved):
        errors.append(
            DagValidationError(
                ValidationCode.CYCLE,
                f"node {node_id!r} cannot be topologically ordered",
                node_id,
            )
        )

    reachable = _reachable_from_roots(dag, by_id)
    for node in dag.nodes:
        if node.id not in reachable and node.id not in unresolved:
            errors.append(
                DagValidationError(
                    ValidationCode.UNREACHABLE,
                    f"node {node.id!r} is not reachable from a root task",
                    node.id,
                )
            )
    return tuple(errors)


def topological_ranks(dag: TaskDAG) -> dict[str, int]:
    by_id = {node.id: node for node in dag.nodes}
    indegree = {node.id: 0 for node in dag.nodes}
    children: dict[str, list[str]] = {node.id: [] for node in dag.nodes}
    for node in dag.nodes:
        for parent in node.dag_parents:
            if parent not in by_id:
                continue
            indegree[node.id] += 1
            children[parent].append(node.id)

    ready = deque(sorted(node_id for node_id, degree in indegree.items() if degree == 0))
    ranks: dict[str, int] = {}
    rank = 0
    while ready:
        node_id = ready.popleft()
        ranks[node_id] = rank
        rank += 1
        for child in sorted(children[node_id]):
            indegree[child] -= 1
            if indegree[child] == 0:
                ready.append(child)
    return ranks


def ready_nodes(dag: TaskDAG, completed: set[str]) -> tuple[TaskNode, ...]:
    ranks = topological_ranks(dag)
    nodes = [
        node
        for node in dag.nodes
        if node.id not in completed and all(parent in completed for parent in node.dag_parents)
    ]
    return tuple(sorted(nodes, key=lambda node: (ranks.get(node.id, 10_000), node.id)))


def assert_valid_dag(dag: TaskDAG) -> None:
    errors = validate_dag(dag)
    if errors:
        rendered = "; ".join(f"{error.code}: {error.message}" for error in errors)
        raise ValueError(rendered)


def _reachable_from_roots(dag: TaskDAG, by_id: dict[str, TaskNode]) -> set[str]:
    roots = [node.id for node in dag.nodes if not node.dag_parents]
    children: dict[str, list[str]] = {node.id: [] for node in dag.nodes}
    for node in dag.nodes:
        for parent in node.dag_parents:
            if parent in by_id:
                children[parent].append(node.id)
    seen: set[str] = set()
    queue = deque(sorted(roots))
    while queue:
        node_id = queue.popleft()
        if node_id in seen:
            continue
        seen.add(node_id)
        queue.extend(sorted(children[node_id]))
    return seen
