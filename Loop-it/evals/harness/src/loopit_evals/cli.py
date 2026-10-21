"""``python -m loopit_evals.cli`` — run the suite, print the KPI report.

Exit codes are meaningful because CI depends on them: ``0`` clean, ``1`` a
regression or gate failure, ``2`` the harness itself could not run. The third
case is separate on purpose — a broken harness must never be reported as a
model regression.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from .report import Report
from .runner import Attempt, EvalRunner
from .suite import SuiteError, Tier, load_suite

EXIT_OK = 0
EXIT_REGRESSION = 1
EXIT_HARNESS_ERROR = 2

DEFAULT_SUITE = Path("evals/suite")


class UnconfiguredExecutor:
    """Stands in until a real sandbox and model endpoint are configured.

    It raises rather than returning fabricated passes: an eval harness that
    silently reports green without running anything is worse than no harness,
    because it actively licenses bad releases.
    """

    def execute(self, task: Any) -> Attempt:
        raise RuntimeError(
            "no eval executor is configured. Set LOOPIT_ROUTER_URL and a sandbox "
            "provider, then pass --executor to select a real executor. The harness "
            "refuses to emit results it did not measure."
        )


def _parse_tiers(value: str | None) -> tuple[Tier, ...] | None:
    if not value:
        return None
    tiers = tuple(part.strip() for part in value.split(",") if part.strip())
    return cast("tuple[Tier, ...]", tiers)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="loopit-evals", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run the suite and write results")
    run.add_argument("--tiers", help="comma-separated tiers, e.g. T0,T1")
    run.add_argument("--suite", type=Path, default=DEFAULT_SUITE)
    run.add_argument("--attempts", type=int, default=1)
    run.add_argument(
        "--executor",
        choices=("unconfigured", "real"),
        default="unconfigured",
        help="executor backend. 'real' requires HF_TOKEN and LOOPIT_SANDBOX_PROVIDER=docker/e2b.",
    )
    run.add_argument("--provider", help="override LOOPIT_SANDBOX_PROVIDER for --executor real")
    run.add_argument("--out", type=Path, default=Path("evals/results/latest.json"))
    run.add_argument("--model-id", help="model id measured by this run; required for comparisons")
    run.add_argument("--baseline", type=Path, help="previous results, for regression gating")
    run.add_argument(
        "--tolerance",
        type=float,
        default=0.0,
        help="allowed pass@1 drop per tier before the run fails",
    )

    report = sub.add_parser("report", help="render a previous run's results")
    report.add_argument("--results", type=Path, default=Path("evals/results/latest.json"))
    report.add_argument("--format", choices=("text", "json", "markdown"), default="text")

    validate = sub.add_parser("validate", help="check the suite loads and is well-formed")
    validate.add_argument("--suite", type=Path, default=DEFAULT_SUITE)

    compare = sub.add_parser("compare-models", help="compare modified model evals against base")
    compare.add_argument("--base-results", type=Path, required=True)
    compare.add_argument("--modified-results", type=Path, required=True)
    compare.add_argument("--tolerance", type=float, default=0.0)
    compare.add_argument("--format", choices=("text", "json"), default="text")

    return parser


def _cmd_run(args: argparse.Namespace) -> int:
    tasks = load_suite(args.suite, _parse_tiers(args.tiers))
    if not tasks:
        print("no tasks matched the requested tiers", file=sys.stderr)
        return EXIT_HARNESS_ERROR

    executor: Any
    if args.executor == "real":
        from .executors import RealTaskExecutor

        executor = RealTaskExecutor.from_env(provider=args.provider)
    else:
        executor = UnconfiguredExecutor()

    runner = EvalRunner(executor, attempts=args.attempts)
    report = Report(runner.run(tasks))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = report.to_dict()
    payload["run"] = {
        "executor": args.executor,
        "model_id": args.model_id,
        "measured_at": datetime.now(UTC).isoformat(),
    }
    args.out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(report.to_text())

    # Every task erroring means the harness or its infrastructure is broken, not
    # the model. Reporting that as a regression sends the team hunting a
    # capability drop that never happened.
    if report.total and all(result.outcome == "errored" for result in report.results):
        print(
            "\nevery task errored before it could be scored — treating this as a "
            "harness failure, not a regression:\n  "
            + (report.results[0].errors[0] if report.results[0].errors else "unknown"),
            file=sys.stderr,
        )
        return EXIT_HARNESS_ERROR

    if args.baseline and args.baseline.exists():
        regressions = report.regressions_against(
            _load_baseline(args.baseline), tolerance=args.tolerance
        )
        if regressions:
            print("\nregressions:", file=sys.stderr)
            for line in regressions:
                print(f"  {line}", file=sys.stderr)
            return EXIT_REGRESSION

    return EXIT_OK if report.passed == report.total else EXIT_REGRESSION


def _cmd_report(args: argparse.Namespace) -> int:
    if not args.results.exists():
        print(f"no results at {args.results}", file=sys.stderr)
        return EXIT_HARNESS_ERROR

    payload = json.loads(args.results.read_text(encoding="utf-8"))
    if args.format == "json":
        print(json.dumps(payload, indent=2))
    elif args.format == "markdown":
        print(_markdown(payload))
    else:
        print(_plain(payload))
    return EXIT_OK


def _cmd_validate(args: argparse.Namespace) -> int:
    tasks = load_suite(args.suite)
    by_tier: dict[str, int] = {}
    for task in tasks:
        by_tier[task.tier] = by_tier.get(task.tier, 0) + 1
    counts = ", ".join(f"{tier}={count}" for tier, count in sorted(by_tier.items()))
    print(f"{len(tasks)} tasks loaded: {counts}")
    return EXIT_OK


def _cmd_compare_models(args: argparse.Namespace) -> int:
    from .model_compare import ComparisonRefusal, compare_model_reports

    try:
        comparison = compare_model_reports(
            base_payload=json.loads(args.base_results.read_text(encoding="utf-8")),
            modified_payload=json.loads(args.modified_results.read_text(encoding="utf-8")),
            tolerance=args.tolerance,
        )
    except (OSError, json.JSONDecodeError, ComparisonRefusal) as error:
        print(f"comparison refused: {error}", file=sys.stderr)
        return EXIT_HARNESS_ERROR

    if args.format == "json":
        print(json.dumps(comparison.to_dict(), indent=2))
    else:
        print(comparison.to_text())
    return EXIT_OK if comparison.verdict == "ship" else EXIT_REGRESSION


def _load_baseline(path: Path) -> dict[str, float]:
    """Read tier → pass@1 from a stored results file."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {entry["tier"]: float(entry["pass_at_1"]) for entry in payload.get("tiers", [])}


def _markdown(payload: dict[str, Any]) -> str:
    cost = payload.get("cost_per_successful_task")
    lines = [
        "## Eval results",
        "",
        f"**pass@1:** {payload['pass_at_1']:.1%} &nbsp;&nbsp; "
        f"**passed:** {payload['passed']}/{payload['total_tasks']} &nbsp;&nbsp; "
        f"**cost per successful task:** {cost if cost is not None else 'n/a'}",
        "",
        "| Tier | pass@1 | pass@k | credits | cost/success |",
        "| --- | --- | --- | --- | --- |",
    ]
    for tier in payload.get("tiers", []):
        tier_cost = tier.get("cost_per_successful_task")
        lines.append(
            f"| {tier['tier']} | {tier['pass_at_1']:.1%} | "
            f"{tier['passed_at_k']}/{tier['total']} | {tier['credits_spent']:.4f} | "
            f"{tier_cost if tier_cost is not None else 'n/a'} |"
        )
    failures = payload.get("failures", [])
    if failures:
        lines += ["", "### Failures", ""]
        lines += [f"- `{f['task_id']}` ({f['tier']}, {f['outcome']})" for f in failures]
    return "\n".join(lines)


def _plain(payload: dict[str, Any]) -> str:
    return json.dumps(payload, indent=2)


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    handlers = {
        "run": _cmd_run,
        "report": _cmd_report,
        "validate": _cmd_validate,
        "compare-models": _cmd_compare_models,
    }
    try:
        return handlers[args.command](args)
    except SuiteError as error:
        print(f"suite error: {error}", file=sys.stderr)
        return EXIT_HARNESS_ERROR
    except RuntimeError as error:
        print(f"harness error: {error}", file=sys.stderr)
        return EXIT_HARNESS_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
