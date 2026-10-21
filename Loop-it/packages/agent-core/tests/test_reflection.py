"""Tests for the reflection loop (P1-8).

Two behaviours are load-bearing: a failed verification comes back as the next
input rather than being swallowed, and an agent that keeps hitting the same wall
is stopped while there is still budget left to re-plan with.
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest
from loopit_agent_core import (
    AgentLoop,
    Budget,
    InMemoryAuditSink,
    LoopOutcome,
    ToolExecutor,
    ToolResult,
)
from loopit_agent_core.model import ModelResponse, ScriptedModelClient
from loopit_agent_core.observation import Observation
from loopit_agent_core.reflection import (
    FailureTracker,
    VerificationVerdict,
    failure_signature,
    stall_message,
)
from loopit_agent_core.tools import ToolCall

SYSTEM = "You are a task agent."


# --- Signatures ---------------------------------------------------------------


def test_identical_failures_share_a_signature() -> None:
    text = "src/app.ts(4,10): error TS2551: Property 'nme' does not exist"

    assert failure_signature(text) == failure_signature(text)


def test_different_failures_differ() -> None:
    a = failure_signature("error TS2551: Property 'nme' does not exist")
    b = failure_signature("error TS2304: Cannot find name 'foo'")

    assert a != b


@pytest.mark.parametrize(
    ("first", "second"),
    [
        ("failed at 2026-01-01T10:00:00Z: TS2551", "failed at 2026-02-02T11:30:00Z: TS2551"),
        ("suite failed in 12.4s: TS2551", "suite failed in 9.1s: TS2551"),
        ("/tmp/build-abc/app.ts: TS2551", "/tmp/build-xyz/app.ts: TS2551"),
        ("trace 0xdeadbeef12: TS2551", "trace 0xcafebabe99: TS2551"),
    ],
)
def test_volatile_detail_does_not_make_a_repeat_look_novel(first: str, second: str) -> None:
    """If timestamps defeat the comparison, thrash detection never fires — and
    that is the failure mode that actually burns the budget."""
    assert failure_signature(first) == failure_signature(second)


def test_whitespace_and_case_are_normalised() -> None:
    assert failure_signature("Error TS2551\n\n  x") == failure_signature("error ts2551 x")


# --- Thrash detection ---------------------------------------------------------


def test_three_identical_failures_are_a_stall() -> None:
    tracker = FailureTracker()

    assert not tracker.record("TS2551")
    assert not tracker.record("TS2551")
    assert tracker.record("TS2551")


def test_a_different_failure_is_progress_not_thrashing() -> None:
    """Failing differently each time is messy, but it is movement."""
    tracker = FailureTracker()
    tracker.record("TS2551")
    tracker.record("TS2304")

    assert not tracker.record("TS2551")


def test_only_consecutive_repeats_count() -> None:
    tracker = FailureTracker()
    tracker.record("A")
    tracker.record("A")
    tracker.record("B")

    assert not tracker.is_stuck


def test_a_green_result_resets_the_tracker() -> None:
    tracker = FailureTracker()
    tracker.record("A")
    tracker.record("A")
    tracker.reset()

    assert not tracker.record("A")
    assert tracker.repeat_count == 1


def test_the_repeat_limit_is_configurable() -> None:
    tracker = FailureTracker(repeat_limit=2)

    assert not tracker.record("A")
    assert tracker.record("A")


def test_a_limit_below_two_is_refused() -> None:
    """One failure is not a pattern; stopping on it would abort real work."""
    with pytest.raises(ValueError, match="at least 2"):
        FailureTracker(repeat_limit=1)


def test_repeat_count_reports_the_current_streak() -> None:
    tracker = FailureTracker()
    tracker.record("A")
    tracker.record("A")

    assert tracker.repeat_count == 2


def test_repeat_count_is_zero_before_any_failure() -> None:
    assert FailureTracker().repeat_count == 0


def test_the_stall_message_tells_the_planner_to_re_plan() -> None:
    message = stall_message(3)

    assert "3 times" in message
    assert "re-plan" in message.lower()


# --- Verdicts -----------------------------------------------------------------


def test_a_green_verdict_carries_a_summary() -> None:
    verdict = VerificationVerdict.green("all checks passed")

    assert verdict.verified
    assert verdict.summary == "all checks passed"
    assert verdict.observation is None


def test_a_red_verdict_carries_the_next_input() -> None:
    verdict = VerificationVerdict.red("typecheck failed: TS2551")

    assert not verdict.verified
    assert verdict.observation == "typecheck failed: TS2551"


# --- The loop's use of them ---------------------------------------------------


def _response(tool_call: dict[str, object] | None) -> ModelResponse:
    return ModelResponse(
        content="working",
        model="test-model",
        input_tokens=100,
        output_tokens=20,
        credits=0.01,
        tool_call=tool_call,
    )


def _patch_call() -> dict[str, object]:
    return {"tool": "apply_patch", "args": {"patch": "--- a\n+++ b\n"}}


def _build(
    verdicts: Sequence[VerificationVerdict],
    *,
    iterations: int = 10,
    repeat_limit: int = 3,
) -> tuple[AgentLoop, InMemoryAuditSink]:
    script = [_response(_patch_call()) for _ in range(iterations)]
    audit = InMemoryAuditSink()
    pending = list(verdicts)

    def verify(call: ToolCall, observation: Observation) -> VerificationVerdict | None:
        return pending.pop(0) if pending else None

    loop = AgentLoop(
        model=ScriptedModelClient(script),
        executor=ToolExecutor({"apply_patch": lambda call: ToolResult(True, "patch applied")}),
        audit=audit,
        tenant_id="t_1",
        project_id="p_1",
        run_id="r_1",
        task_id="task-1",
        budget=Budget(max_iterations=iterations),
        verify=verify,
        repeat_limit=repeat_limit,
    )
    return loop, audit


def test_a_failure_observation_is_fed_back_verbatim() -> None:
    """The compiler's own words are a better prompt than any paraphrase."""
    loop, _ = _build(
        [
            VerificationVerdict.red("src/app.ts(4,10): error TS2551"),
            VerificationVerdict.green("tests green"),
        ]
    )

    result = loop.run(SYSTEM, "fix the type error")

    assert result.outcome is LoopOutcome.VERIFIED
    assert any("src/app.ts(4,10)" in m.content for m in result.transcript)


def test_repeating_the_same_failure_stops_the_loop() -> None:
    """A stall caught at turn three is recoverable; one caught at the budget
    ceiling is just an expensive failure. The patches all executed, so every
    turn was refunded — the stall detector, not the budget, ends this loop."""
    loop, _ = _build([VerificationVerdict.red("error TS2551")] * 6)

    result = loop.run(SYSTEM, "fix it")

    assert result.outcome is LoopOutcome.STALLED
    assert result.iterations == 0
    assert "re-plan" in result.summary.lower()


def test_differing_failures_do_not_trip_the_stall_detector() -> None:
    loop, _ = _build(
        [
            VerificationVerdict.red("error TS2551"),
            VerificationVerdict.red("error TS2304"),
            VerificationVerdict.red("error TS7006"),
            VerificationVerdict.green("tests green"),
        ]
    )

    assert loop.run(SYSTEM, "fix it").outcome is LoopOutcome.VERIFIED


def test_a_green_result_after_failures_resets_the_streak() -> None:
    loop, _ = _build(
        [
            VerificationVerdict.red("error TS2551"),
            VerificationVerdict.red("error TS2551"),
            VerificationVerdict.green("fixed"),
        ]
    )

    assert loop.run(SYSTEM, "fix it").outcome is LoopOutcome.VERIFIED


def test_each_failed_verification_is_audited() -> None:
    loop, audit = _build(
        [VerificationVerdict.red("error TS2551"), VerificationVerdict.green("fixed")]
    )
    loop.run(SYSTEM, "fix it")

    failures = audit.of_type("verification.failed")
    assert len(failures) == 1
    assert failures[0].detail["repeat_count"] == 1


def test_a_verdict_with_nothing_to_say_leaves_the_transcript_alone() -> None:
    """An empty 'nothing happened' turn costs tokens and teaches nothing."""
    loop, _ = _build([VerificationVerdict(verified=False), VerificationVerdict.green("done")])

    result = loop.run(SYSTEM, "go")

    assert result.outcome is LoopOutcome.VERIFIED
    assert sum(1 for m in result.transcript if m.role == "tool") == 2


def test_a_bare_string_still_means_verified() -> None:
    """Hooks that only ever report success should not need a verdict object."""
    audit = InMemoryAuditSink()
    loop = AgentLoop(
        model=ScriptedModelClient([_response(_patch_call())]),
        executor=ToolExecutor({"apply_patch": lambda call: ToolResult(True, "ok")}),
        audit=audit,
        tenant_id="t_1",
        project_id="p_1",
        run_id="r_1",
        task_id="task-1",
        verify=lambda call, observation: "all good",
    )

    result = loop.run(SYSTEM, "go")

    assert result.outcome is LoopOutcome.VERIFIED
    assert result.summary == "all good"


def test_the_stall_limit_is_configurable_per_loop() -> None:
    loop, audit = _build([VerificationVerdict.red("error TS2551")] * 6, repeat_limit=2)

    result = loop.run(SYSTEM, "fix it")

    assert result.outcome is LoopOutcome.STALLED
    # Two identical reds (the configurable limit), not the default three.
    assert len(audit.of_type("verification.failed")) == 2
