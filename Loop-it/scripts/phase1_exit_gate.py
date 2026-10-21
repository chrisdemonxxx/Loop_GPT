"""Run the Phase 1 exit gate honestly against live isolation.

This script exits 0 only when the CRUD self-correction eval passes on a real
provider (docker or e2b). In-memory runs are allowed for plumbing checks only
and can never print PASS.
"""

from __future__ import annotations

import argparse
import statistics
import sys
import tomllib
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_CONFIG = tomllib.loads((_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
for _entry in _CONFIG["tool"]["pytest"]["ini_options"]["pythonpath"]:
    sys.path.insert(0, str(_ROOT / _entry))

from loopit_evals.executors import InfrastructureUnavailable, RealTaskExecutor  # noqa: E402
from loopit_evals.runner import EvalRunner  # noqa: E402
from loopit_evals.suite import Task, load_suite  # noqa: E402

TASK_ID = "phase1-crud-self-correction"
REAL_PROVIDERS = {"docker", "e2b"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", default=None, help="docker or e2b; overrides env")
    parser.add_argument("--attempts", type=int, default=1)
    parser.add_argument("--suite", type=Path, default=_ROOT / "evals" / "suite")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    provider = (args.provider or "").lower()
    if provider in {"memory", "inmemory", "in-memory"}:
        print("RESULT: FAIL - in-memory provider is not real Phase 1 isolation")
        return 2

    task = _load_gate_task(args.suite)
    try:
        executor = RealTaskExecutor.from_env(provider=args.provider)
    except InfrastructureUnavailable as error:
        print(f"RESULT: SKIP - live gate infrastructure is unavailable: {error}")
        return 2

    if executor.provider not in REAL_PROVIDERS:
        print(f"RESULT: FAIL - provider {executor.provider!r} is not accepted for the exit gate")
        return 2

    runner = EvalRunner(executor, attempts=args.attempts)
    result = runner.run_task(task)
    metrics = [executor.last_metrics] if executor.last_metrics is not None else []
    if result.outcome == "errored" and not metrics:
        message = result.errors[0] if result.errors else "unknown infrastructure error"
        print(f"RESULT: SKIP - live gate infrastructure is unavailable: {message}")
        return 2
    cold_starts = [m.cold_start_seconds for m in metrics if m is not None]
    iterations = [m.iterations for m in metrics if m is not None]
    self_corrections = [m.self_corrected for m in metrics if m is not None]
    crud_successes = [m.crud_success for m in metrics if m is not None]

    print(f"task: {task.task_id}")
    print(f"provider: {executor.provider}")
    print(f"outcome: {result.outcome}")
    print(f"self-correction rate: {_rate(self_corrections):.1%}")
    print(f"CRUD success rate: {_rate(crud_successes):.1%}")
    print(f"sandbox cold-start p50: {_percentile(cold_starts, 50):.3f}s")
    print(f"sandbox cold-start p95: {_percentile(cold_starts, 95):.3f}s")
    print(f"iterations/build: {_mean(iterations):.2f}")
    print(f"credits spent: {result.credits_spent:.6f}")
    if result.errors:
        print("errors:")
        for run_error in result.errors:
            print(f"  - {run_error}")

    passed = result.passed_first and all(self_corrections) and all(crud_successes)
    print(f"RESULT: {'PASS' if passed else 'FAIL'}")
    return 0 if passed else 1


def _load_gate_task(root: Path) -> Task:
    for task in load_suite(root):
        if task.task_id == TASK_ID:
            return task
    raise SystemExit(f"gate task {TASK_ID!r} not found under {root}")


def _rate(values: list[bool]) -> float:
    return sum(1 for value in values if value) / len(values) if values else 0.0


def _mean(values: list[int]) -> float:
    return statistics.fmean(values) if values else 0.0


def _percentile(values: list[float], percentile: int) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((percentile / 100) * (len(ordered) - 1)))
    return ordered[index]


if __name__ == "__main__":
    raise SystemExit(main())
