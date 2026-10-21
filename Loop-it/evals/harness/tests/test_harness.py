"""Tests for the eval harness.

The harness is what every other quality claim rests on, so its own failure
modes — silently passing an unscored task, hiding a tier regression, reporting
zero cost when nothing ran — are tested explicitly.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import pytest
from loopit_evals import EvalRunner, Report, load_suite, score_task
from loopit_evals.cli import main
from loopit_evals.runner import Attempt
from loopit_evals.scoring import CheckResult
from loopit_evals.suite import TIERS, SuiteError, Task, Tier

SUITE_ROOT = Path(__file__).resolve().parents[2] / "suite"


def make_task(task_id: str = "t", tier: Tier = "T1", budget: float = 1.0) -> Task:
    return Task(
        task_id=task_id,
        tier=tier,
        prompt="build a thing",
        checks=("build_succeeds",),
        budget_credits=budget,
    )


class ScriptedExecutor:
    """Replays a fixed sequence of attempts, so runs are deterministic."""

    def __init__(self, *attempts: Attempt) -> None:
        self._attempts = list(attempts)
        self.calls = 0

    def execute(self, task: Task) -> Attempt:
        attempt = self._attempts[min(self.calls, len(self._attempts) - 1)]
        self.calls += 1
        return attempt


def passing(credits: float = 0.1) -> Attempt:
    return Attempt(
        checks=(CheckResult("build_succeeds", True),),
        credits_spent=credits,
        wall_clock_seconds=1.0,
    )


def failing(credits: float = 0.1) -> Attempt:
    return Attempt(
        checks=(CheckResult("build_succeeds", False, "compile error"),),
        credits_spent=credits,
        wall_clock_seconds=1.0,
    )


# --- Suite loading ------------------------------------------------------------


def test_the_shipped_suite_loads() -> None:
    tasks = load_suite(SUITE_ROOT)
    assert len(tasks) >= 13


def test_every_tier_has_at_least_one_task() -> None:
    tiers = {task.tier for task in load_suite(SUITE_ROOT)}
    assert tiers == set(TIERS)


def test_tasks_can_be_filtered_to_a_tier() -> None:
    tasks = load_suite(SUITE_ROOT, ["T0"])
    assert tasks and all(task.tier == "T0" for task in tasks)


def test_a_task_without_checks_is_refused() -> None:
    with pytest.raises(SuiteError, match="no checks"):
        Task(task_id="t", tier="T0", prompt="p", checks=(), budget_credits=1.0)


def test_a_task_without_a_budget_is_refused() -> None:
    with pytest.raises(SuiteError, match="positive budget"):
        Task(task_id="t", tier="T0", prompt="p", checks=("c",), budget_credits=0.0)


def test_an_unknown_tier_is_refused() -> None:
    with pytest.raises(SuiteError, match="unknown tier"):
        # Deliberately outside the Tier union: the check must hold at runtime for
        # task files loaded from disk, which the type system never sees.
        Task(
            task_id="t",
            tier=cast("Tier", "T9"),
            prompt="p",
            checks=("c",),
            budget_credits=1.0,
        )


def test_a_duplicate_task_id_is_fatal(tmp_path: Path) -> None:
    payload = {
        "task_id": "dupe",
        "tier": "T0",
        "prompt": "p",
        "checks": ["c"],
        "budget_credits": 1.0,
    }
    (tmp_path / "a.task.json").write_text(json.dumps(payload), encoding="utf-8")
    (tmp_path / "b.task.json").write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(SuiteError, match="duplicate task id"):
        load_suite(tmp_path)


def test_a_missing_suite_directory_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(SuiteError, match="does not exist"):
        load_suite(tmp_path / "nope")


# --- Scoring ------------------------------------------------------------------


def test_a_task_passes_only_when_every_check_passes() -> None:
    score = score_task(
        (CheckResult("a", True), CheckResult("b", False)),
        credits_spent=0.1,
        budget_credits=1.0,
    )
    assert not score.passed
    assert score.failed_checks == ("b",)


def test_there_is_no_partial_credit() -> None:
    checks = tuple(CheckResult(f"c{i}", i < 4) for i in range(5))
    score = score_task(checks, credits_spent=0.1, budget_credits=1.0)
    assert score.checks_passed == 4
    assert not score.passed


def test_an_unscored_task_fails_rather_than_silently_passing() -> None:
    score = score_task((), credits_spent=0.0, budget_credits=1.0)
    assert not score.passed
    assert "unscored" in score.reason


def test_passing_over_budget_is_still_a_failure() -> None:
    score = score_task((CheckResult("a", True),), credits_spent=5.0, budget_credits=1.0)
    assert not score.passed
    assert not score.within_budget


# --- Running ------------------------------------------------------------------


def test_a_passing_task_is_reported_as_passed() -> None:
    result = EvalRunner(ScriptedExecutor(passing())).run_task(make_task())
    assert result.outcome == "passed"
    assert result.passed_first


def test_pass_at_1_and_pass_at_k_differ_when_a_retry_saves_it() -> None:
    executor = ScriptedExecutor(failing(), passing())
    result = EvalRunner(executor, attempts=2).run_task(make_task())
    assert not result.passed_first
    assert result.passed_any


def test_retries_are_not_free() -> None:
    executor = ScriptedExecutor(failing(0.2), passing(0.3))
    result = EvalRunner(executor, attempts=2).run_task(make_task())
    assert result.credits_spent == pytest.approx(0.5)


def test_an_executor_crash_is_reported_as_errored_not_failed() -> None:
    class Broken:
        def execute(self, task: Task) -> Attempt:
            raise ConnectionError("sandbox provider unreachable")

    result = EvalRunner(Broken()).run_task(make_task())
    assert result.outcome == "errored"
    assert "ConnectionError" in result.errors[0]


def test_running_over_budget_is_reported_as_budget_exceeded() -> None:
    executor = ScriptedExecutor(passing(credits=99.0))
    result = EvalRunner(executor).run_task(make_task(budget=0.1))
    assert result.outcome == "budget_exceeded"


def test_attempts_must_be_at_least_one() -> None:
    with pytest.raises(ValueError, match="at least 1"):
        EvalRunner(ScriptedExecutor(passing()), attempts=0)


# --- Reporting ----------------------------------------------------------------


def test_the_report_breaks_results_down_by_tier() -> None:
    runner = EvalRunner(ScriptedExecutor(passing()))
    report = Report(runner.run([make_task("a", "T0"), make_task("b", "T2")]))
    assert {summary.tier for summary in report.tiers} == {"T0", "T2"}


def test_cost_per_successful_task_is_undefined_rather_than_zero_when_nothing_passes() -> None:
    runner = EvalRunner(ScriptedExecutor(failing()))
    report = Report(runner.run([make_task()]))
    assert report.cost_per_successful_task == float("inf")
    assert report.to_dict()["cost_per_successful_task"] is None


def test_cost_per_successful_task_divides_total_spend_by_successes() -> None:
    runner = EvalRunner(ScriptedExecutor(passing(credits=0.25)))
    report = Report(runner.run([make_task("a"), make_task("b")]))
    assert report.cost_per_successful_task == pytest.approx(0.25)


def test_a_tier_regression_is_detected() -> None:
    runner = EvalRunner(ScriptedExecutor(failing()))
    report = Report(runner.run([make_task("a", "T0")]))
    regressions = report.regressions_against({"T0": 1.0})
    assert regressions and "T0" in regressions[0]


def test_an_improvement_in_one_tier_cannot_mask_a_regression_in_another() -> None:
    class ByTier:
        def execute(self, task: Task) -> Attempt:
            return passing() if task.tier == "T3" else failing()

    report = Report(EvalRunner(ByTier()).run([make_task("a", "T0"), make_task("b", "T3")]))
    regressions = report.regressions_against({"T0": 1.0, "T3": 0.0})
    assert len(regressions) == 1
    assert regressions[0].startswith("T0")


def test_tolerance_absorbs_noise_below_the_threshold() -> None:
    class ByTask:
        def execute(self, task: Task) -> Attempt:
            return failing() if task.task_id == "a" else passing()

    tasks = [make_task(name, "T1") for name in ("a", "b", "c", "d")]
    report = Report(EvalRunner(ByTask()).run(tasks))
    assert report.pass_at_1_by_tier()["T1"] == pytest.approx(0.75)

    assert report.regressions_against({"T1": 1.0}, tolerance=0.30) == []
    assert report.regressions_against({"T1": 1.0}, tolerance=0.10) != []


def test_the_report_lists_failures_with_their_failed_checks() -> None:
    runner = EvalRunner(ScriptedExecutor(failing()))
    payload = Report(runner.run([make_task("broken")])).to_dict()
    assert payload["failures"][0]["task_id"] == "broken"
    assert payload["failures"][0]["failed_checks"] == ["build_succeeds"]


def test_the_text_report_renders() -> None:
    runner = EvalRunner(ScriptedExecutor(passing()))
    text = Report(runner.run([make_task()])).to_text()
    assert "pass@1" in text


# --- CLI ----------------------------------------------------------------------


def test_validate_accepts_the_shipped_suite(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["validate", "--suite", str(SUITE_ROOT)]) == 0
    assert "tasks loaded" in capsys.readouterr().out


def test_run_refuses_to_fabricate_results_without_a_configured_executor(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    exit_code = main(
        [
            "run",
            "--suite",
            str(SUITE_ROOT),
            "--tiers",
            "T0",
            "--out",
            str(tmp_path / "results.json"),
        ]
    )
    assert exit_code == 2, "an unconfigured harness must not report a model regression"
    assert "harness failure" in capsys.readouterr().err


def test_report_on_missing_results_is_a_harness_error(tmp_path: Path) -> None:
    assert main(["report", "--results", str(tmp_path / "none.json")]) == 2


def test_report_renders_markdown_for_the_ci_summary(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    results = tmp_path / "results.json"
    results.write_text(
        json.dumps(
            {
                "total_tasks": 2,
                "passed": 1,
                "pass_at_1": 0.5,
                "credits_spent": 1.0,
                "cost_per_successful_task": 1.0,
                "tiers": [
                    {
                        "tier": "T0",
                        "total": 2,
                        "passed_at_1": 1,
                        "passed_at_k": 1,
                        "credits_spent": 1.0,
                        "pass_at_1": 0.5,
                        "pass_at_k": 0.5,
                        "cost_per_successful_task": 1.0,
                    }
                ],
                "failures": [{"task_id": "x", "tier": "T0", "outcome": "failed"}],
            }
        ),
        encoding="utf-8",
    )

    assert main(["report", "--results", str(results), "--format", "markdown"]) == 0
    out = capsys.readouterr().out
    assert "## Eval results" in out
    assert "| T0 |" in out
    assert "`x`" in out
