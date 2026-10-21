"""Tests for the layered verification pipeline."""

from __future__ import annotations

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_verify import (
    Check,
    CommandOutput,
    Level,
    ScriptedRunner,
    VerificationPipeline,
    node_typescript_checks,
    python_checks,
    smoke_check,
)

PASS = CommandOutput(exit_code=0, stdout="ok", duration_ms=120)


def _fail(stderr: str, exit_code: int = 1) -> CommandOutput:
    return CommandOutput(exit_code=exit_code, stderr=stderr, duration_ms=90)


TYPECHECK = Check("typecheck", Level.L0_STATIC, ("tsc", "--noEmit"))
LINT = Check("lint", Level.L0_STATIC, ("eslint", "."))
UNIT = Check("unit", Level.L1_TESTS, ("vitest", "run"))
SMOKE = Check("smoke", Level.L2_RUNTIME, ("curl", "localhost:3000"))
ALL = (UNIT, SMOKE, TYPECHECK, LINT)  # deliberately out of order


def _runner(**results: CommandOutput) -> ScriptedRunner:
    commands = {
        "typecheck": "tsc --noEmit",
        "lint": "eslint .",
        "unit": "vitest run",
        "smoke": "curl localhost:3000",
    }
    return ScriptedRunner({commands[name]: output for name, output in results.items()})


# --- Check definitions --------------------------------------------------------


def test_a_check_needs_a_command() -> None:
    with pytest.raises(ValueError, match="no command"):
        Check("empty", Level.L0_STATIC, ())


def test_a_check_needs_a_timeout() -> None:
    """An unbounded command eats the sandbox's whole wall-clock budget."""
    with pytest.raises(ValueError, match="positive timeout"):
        Check("forever", Level.L0_STATIC, ("sleep", "inf"), timeout_seconds=0)


def test_levels_are_ordered_cheapest_first() -> None:
    assert Level.L0_STATIC < Level.L1_TESTS < Level.L2_RUNTIME


def test_duplicate_check_names_are_refused() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        VerificationPipeline(
            checks=(TYPECHECK, Check("typecheck", Level.L1_TESTS, ("x",))),
            runner=_runner(),
        )


# --- Ordering and short-circuiting -------------------------------------------


def test_levels_run_in_order_regardless_of_declaration_order() -> None:
    runner = _runner(typecheck=PASS, lint=PASS, unit=PASS, smoke=PASS)
    VerificationPipeline(checks=ALL, runner=runner).run()

    assert runner.calls == [
        ("tsc", "--noEmit"),
        ("eslint", "."),
        ("vitest", "run"),
        ("curl", "localhost:3000"),
    ]


def test_a_failing_cheap_gate_stops_the_expensive_ones() -> None:
    """Running a browser against code that does not compile spends a minute to
    learn what the typechecker already said."""
    runner = _runner(typecheck=_fail("app.ts(4,10): error TS2551"), lint=PASS)

    report = VerificationPipeline(checks=ALL, runner=runner).run()

    assert not report.passed
    assert report.stopped_at is Level.L1_TESTS
    assert ("vitest", "run") not in runner.calls
    assert ("curl", "localhost:3000") not in runner.calls


def test_every_check_in_a_failing_level_still_runs() -> None:
    """Two lint errors and a type error are one round-trip, not three."""
    runner = _runner(typecheck=_fail("TS2551"), lint=_fail("no-unused-vars"))

    report = VerificationPipeline(checks=ALL, runner=runner).run()

    assert len(report.at_level(Level.L0_STATIC)) == 2
    assert len(report.blocking_failures) == 2


def test_a_failure_at_the_last_level_is_still_a_failure() -> None:
    runner = _runner(typecheck=PASS, lint=PASS, unit=PASS, smoke=_fail("connection refused"))

    report = VerificationPipeline(checks=ALL, runner=runner).run()

    assert not report.passed
    assert report.stopped_at is None


def test_a_clean_run_passes() -> None:
    runner = _runner(typecheck=PASS, lint=PASS, unit=PASS, smoke=PASS)

    assert VerificationPipeline(checks=ALL, runner=runner).run().passed


def test_max_level_truncates_without_failing() -> None:
    """A fast inner loop asks for L0 only; that is a pass, not an omission."""
    runner = _runner(typecheck=PASS, lint=PASS)

    report = VerificationPipeline(checks=ALL, runner=runner, max_level=Level.L0_STATIC).run()

    assert report.passed
    assert report.levels_run == (Level.L0_STATIC,)
    assert runner.calls == [("tsc", "--noEmit"), ("eslint", ".")]


def test_a_nonblocking_check_reports_without_gating() -> None:
    advisory = Check("audit", Level.L0_STATIC, ("npm", "audit"), blocking=False)
    runner = ScriptedRunner(
        {"tsc --noEmit": PASS, "eslint .": PASS, "npm audit": _fail("3 moderate")}
    )

    report = VerificationPipeline(checks=(TYPECHECK, LINT, advisory), runner=runner).run()

    assert report.passed
    assert len(report.failures) == 1
    assert report.blocking_failures == ()


# --- Observations for the reflection loop ------------------------------------


def test_a_failure_observation_quotes_the_tool_verbatim() -> None:
    """A paraphrase drops the file, line and symbol that make the fix mechanical."""
    runner = _runner(typecheck=_fail("src/app.ts(4,10): error TS2551: Did you mean 'name'?"))

    observation = VerificationPipeline(checks=ALL, runner=runner).run().observation()

    assert "src/app.ts(4,10)" in observation
    assert "TS2551" in observation
    assert "tsc --noEmit" in observation


def test_the_observation_names_the_level_and_says_later_levels_were_skipped() -> None:
    runner = _runner(typecheck=_fail("boom"), lint=PASS)

    observation = VerificationPipeline(checks=ALL, runner=runner).run().observation()

    assert "L0_STATIC" in observation
    assert "not run" in observation


def test_the_observation_omits_checks_that_never_ran() -> None:
    """Reporting on a level that was skipped would be a fabricated observation."""
    runner = _runner(typecheck=_fail("boom"), lint=PASS)

    observation = VerificationPipeline(checks=ALL, runner=runner).run().observation()

    assert "smoke" not in observation
    assert "unit" not in observation


def test_a_passing_observation_lists_what_was_checked() -> None:
    runner = _runner(typecheck=PASS, lint=PASS, unit=PASS, smoke=PASS)

    observation = VerificationPipeline(checks=ALL, runner=runner).run().observation()

    assert observation.startswith("Verification passed")
    assert "typecheck" in observation


def test_huge_output_is_truncated_from_the_head() -> None:
    """Runners print the summary last; the tail is the part that says what broke."""
    noise = "warning: something\n" * 5000
    runner = _runner(typecheck=_fail(noise + "FINAL ERROR: TS9999"))

    observation = VerificationPipeline(checks=ALL, runner=runner).run().observation(limit=1000)

    assert "FINAL ERROR: TS9999" in observation
    assert "characters omitted" in observation
    assert len(observation) < 2000


def test_a_timeout_reads_as_a_timeout_not_a_test_failure() -> None:
    runner = _runner(typecheck=CommandOutput(exit_code=-1, timed_out=True))

    observation = VerificationPipeline(checks=ALL, runner=runner).run().observation()

    assert "timed out" in observation
    assert "watch mode" in observation


def test_secrets_in_build_output_never_reach_the_observation() -> None:
    """Build logs echo environment variables; the observation goes into a prompt."""
    leaked = "Error: auth failed with key sk-live-AAAAAAAAAAAAAAAAAAAA"
    runner = _runner(typecheck=_fail(leaked))

    observation = VerificationPipeline(checks=ALL, runner=runner).run().observation()

    assert "sk-live-AAAAAAAAAAAAAAAAAAAA" not in observation
    assert "[REDACTED]" in observation


def test_an_unscripted_command_fails_loudly() -> None:
    """A verification double that silently passes makes green meaningless."""
    report = VerificationPipeline(checks=(TYPECHECK,), runner=ScriptedRunner()).run()

    assert not report.passed
    assert "no result" in report.observation()


# --- Audit --------------------------------------------------------------------


def test_verification_outcomes_are_audited() -> None:
    """'The tests were green' is a claim the platform later has to stand behind."""
    audit = InMemoryAuditSink()
    runner = _runner(typecheck=PASS, lint=PASS, unit=PASS, smoke=PASS)

    VerificationPipeline(checks=ALL, runner=runner, audit=audit).run(
        tenant_id="tenant_acme", run_id="run_1", project_id="proj_shop"
    )

    event = audit.of_type("verification.completed")[0]
    assert event.outcome == "success"
    assert event.detail["levels_run"] == ["L0_STATIC", "L1_TESTS", "L2_RUNTIME"]
    assert len(event.detail["checks"]) == 4


def test_a_failed_verification_is_audited_with_where_it_stopped() -> None:
    audit = InMemoryAuditSink()
    runner = _runner(typecheck=_fail("boom"), lint=PASS)

    VerificationPipeline(checks=ALL, runner=runner, audit=audit).run(tenant_id="tenant_acme")

    event = audit.of_type("verification.completed")[0]
    assert event.outcome == "failure"
    assert event.detail["stopped_at"] == "L1_TESTS"


def test_no_audit_is_emitted_without_a_tenant() -> None:
    audit = InMemoryAuditSink()
    runner = _runner(typecheck=PASS, lint=PASS, unit=PASS, smoke=PASS)

    VerificationPipeline(checks=ALL, runner=runner, audit=audit).run()

    assert len(audit) == 0


# --- Presets ------------------------------------------------------------------


def test_presets_cover_the_cheap_and_the_behavioural_layers() -> None:
    levels = {check.level for check in node_typescript_checks()}

    assert Level.L0_STATIC in levels
    assert Level.L1_TESTS in levels


def test_presets_never_use_watch_mode() -> None:
    """A watch command passes its timeout and eats the whole wall-clock budget."""
    for check in (*node_typescript_checks(), *python_checks(), smoke_check()):
        assert "--watch" not in check.command
        assert "watch" not in check.name


def test_every_preset_check_has_a_bounded_timeout() -> None:
    for check in (*node_typescript_checks(), *python_checks(), smoke_check()):
        assert 0 < check.timeout_seconds <= 600


def test_the_package_manager_is_configurable() -> None:
    assert node_typescript_checks(package_manager="npm")[0].command[0] == "npm"


def test_the_smoke_check_is_a_runtime_check() -> None:
    """Compiling and passing tests is not the same as running."""
    assert smoke_check().level is Level.L2_RUNTIME
