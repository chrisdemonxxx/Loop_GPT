"""Structured task-DAG planning, parallel fork execution, and merge gates."""

from .dag import DagValidationError, ValidationCode, ready_nodes, topological_ranks, validate_dag
from .executor import (
    DagExecutionResult,
    ForkLease,
    NodeAttempt,
    NodeRunResult,
    OfflineParallelDagExecutor,
    SandboxLeaseBroker,
    TaskNodeRunner,
    VerificationGate,
)
from .merge import ChangeDigest, Conflict, MergeDecision, changed_digests, detect_conflicts
from .models import Budget, TaskDAG, TaskNode
from .planner import StructuredOutputModel, StructuredPlanner
from .replan import Invalidation, preserve_completed_and_replan_remaining

__all__ = [
    "Budget",
    "ChangeDigest",
    "Conflict",
    "DagExecutionResult",
    "DagValidationError",
    "ForkLease",
    "Invalidation",
    "MergeDecision",
    "NodeAttempt",
    "NodeRunResult",
    "OfflineParallelDagExecutor",
    "SandboxLeaseBroker",
    "StructuredOutputModel",
    "StructuredPlanner",
    "TaskDAG",
    "TaskNode",
    "TaskNodeRunner",
    "ValidationCode",
    "VerificationGate",
    "changed_digests",
    "detect_conflicts",
    "preserve_completed_and_replan_remaining",
    "ready_nodes",
    "topological_ranks",
    "validate_dag",
]
