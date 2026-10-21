"""Tests for the L2 critical-flow gate (P2-7)."""

from __future__ import annotations

import pytest
from loopit_sandbox_sdk.flows import ExpectText, FlowResult, StepOutcome
from loopit_verify.flow_gate import REQUIRED_FLOWS, FlowGateError, evaluate


def _result(name: str, *, passed: bool = True) -> FlowResult:
    step = ExpectText("Tasks")
    return FlowResult(flow=name, outcomes=(StepOutcome(step, passed, "" if passed else "no"),))


def _all_passing() -> list[FlowResult]:
    return [_result(name) for name in sorted(REQUIRED_FLOWS)]


class TestRequiredFlows:
    def test_isolation_is_required(self) -> None:
        assert "tenant-isolation" in REQUIRED_FLOWS

    def test_all_required_flows_passing_is_a_pass(self) -> None:
        assert evaluate(_all_passing()).passed

    def test_an_empty_report_is_not_a_pass(self) -> None:
        # The failure this gate exists to prevent: a crashed harness reading as
        # green because it reported nothing.
        report = evaluate([])
        assert not report.passed
        assert set(report.missing) == REQUIRED_FLOWS

    def test_a_missing_isolation_flow_is_not_a_pass(self) -> None:
        report = evaluate([_result("signup-login-create-readback")])
        assert not report.passed
        assert report.missing == ("tenant-isolation",)

    def test_a_failing_flow_is_not_a_pass(self) -> None:
        results = _all_passing()
        results[0] = _result(results[0].flow, passed=False)
        assert not evaluate(results).passed

    def test_extra_flows_do_not_break_the_gate(self) -> None:
        assert evaluate([*_all_passing(), _result("bonus")]).passed

    def test_a_failing_extra_flow_still_fails(self) -> None:
        assert not evaluate([*_all_passing(), _result("bonus", passed=False)]).passed


class TestDuplicates:
    def test_duplicate_results_are_refused(self) -> None:
        # One of them is stale; picking either could turn a failure into a pass.
        with pytest.raises(FlowGateError, match="more than one result"):
            evaluate([*_all_passing(), _result("tenant-isolation", passed=False)])


class TestObservation:
    def test_a_missing_flow_is_named_as_a_harness_failure(self) -> None:
        # Otherwise the model edits application code that was never the cause.
        text = evaluate([]).observation()
        assert "harness failure" in text
        assert "tenant-isolation" in text

    def test_missing_flows_are_reported_before_failing_ones(self) -> None:
        report = evaluate([_result("tenant-isolation", passed=False)])
        text = report.observation()
        assert text.index("did not run") < text.index("FAILED")

    def test_a_pass_names_the_flows_that_ran(self) -> None:
        text = evaluate(_all_passing()).observation()
        assert "tenant-isolation" in text
        assert "passed" in text
