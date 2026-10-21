"""The eval harness (Doc 07).

The harness is the platform's steering wheel. Without it, every model swap,
prompt edit, and loop change is a guess. With it, "is this better?" is a
measurement.

Two rules make the numbers trustworthy:

* **Scoring is functional, never a similarity score.** A task passes when its
  tests pass and its checks hold. Nothing is scored by resemblance to a
  reference solution.
* **Cost is scored alongside correctness.** A change that raises pass rate by a
  point and triples spend is a regression, so every run reports
  ``cost_per_successful_task`` next to the pass rate.
"""

from .executors import ExecutionMetrics, InfrastructureUnavailable, RealTaskExecutor
from .report import Report, TierSummary
from .runner import EvalRunner, RunOutcome, TaskResult
from .scoring import CheckResult, Score, score_task
from .security_metrics import (
    PROVISIONING_TIERS,
    RlsCoverage,
    SecurityGateResult,
    dashboard,
    gate,
    measure_live_rls,
    measure_rls,
)
from .suite import Task, Tier, load_suite

__all__ = [
    "PROVISIONING_TIERS",
    "CheckResult",
    "EvalRunner",
    "ExecutionMetrics",
    "InfrastructureUnavailable",
    "RealTaskExecutor",
    "Report",
    "RlsCoverage",
    "RunOutcome",
    "Score",
    "SecurityGateResult",
    "Task",
    "TaskResult",
    "Tier",
    "TierSummary",
    "dashboard",
    "gate",
    "load_suite",
    "measure_live_rls",
    "measure_rls",
    "score_task",
]
