from __future__ import annotations

from datetime import UTC, datetime

import pytest
from loopit_orchestrator.decisions import (
    BudgetSnapshot,
    WorkflowBudgetExceeded,
    enforce_budget,
    gate_for_tool_call,
    retry_policy_for_failure,
)
from loopit_orchestrator.types import UsageDelta, WorkflowBudget
from loopit_policy import FailureClass


def test_budget_exhaustion_is_deterministic() -> None:
    with pytest.raises(WorkflowBudgetExceeded) as exc:
        enforce_budget(
            BudgetSnapshot(iterations=2, tokens=10, credits=1.0),
            WorkflowBudget(max_iterations=2),
            elapsed_seconds=0,
        )
    assert exc.value.axis == "iterations"


def test_gate_classification_uses_policy_taxonomy() -> None:
    gate = gate_for_tool_call(
        "run_shell",
        {"command": "git reset --hard HEAD", "call_id": "danger"},
        now=datetime(2026, 1, 1, tzinfo=UTC),
        run_id="run-a",
    )
    assert gate is not None
    assert gate.gate_id.startswith("gate_")
    assert gate.args_hash
    assert "destructive" in gate.reason.lower() or "fail closed" in gate.reason.lower()


def test_builder_preset_skips_gate_for_relative_heredoc_and_keeps_deploy() -> None:
    heredoc = gate_for_tool_call(
        "run_shell",
        {"command": "cat > spray.py <<'PY_EOF'\nprint(1)\nPY_EOF"},
        now=datetime(2026, 1, 1, tzinfo=UTC),
        run_id="run-a",
    )
    patch = gate_for_tool_call(
        "apply_patch",
        {"patch": "--- a/a\n+++ b/a\n"},
        now=datetime(2026, 1, 1, tzinfo=UTC),
        run_id="run-a",
    )
    deploy = gate_for_tool_call(
        "deploy",
        {"target": "managed", "environment": "preview"},
        now=datetime(2026, 1, 1, tzinfo=UTC),
        run_id="run-a",
    )

    assert heredoc is None
    assert patch is None
    assert deploy is not None


def test_gate_id_ignores_omitted_model_call_id_and_binds_arguments() -> None:
    first = gate_for_tool_call(
        "deploy",
        {"target": "managed", "environment": "preview"},
        now=datetime(2026, 1, 1, tzinfo=UTC),
        run_id="run-a",
    )
    second = gate_for_tool_call(
        "deploy",
        {"target": "managed", "environment": "prod"},
        now=datetime(2026, 1, 1, tzinfo=UTC),
        run_id="run-a",
    )

    assert first is not None
    assert second is not None
    assert first.gate_id != "gate-deploy"
    assert first.gate_id != second.gate_id
    assert first.args_hash != second.args_hash


def test_retry_classification_only_blind_retries_transient_failures() -> None:
    assert retry_policy_for_failure(FailureClass.TRANSIENT).maximum_attempts == 3
    assert retry_policy_for_failure(FailureClass.VERIFICATION).maximum_attempts == 1
    assert retry_policy_for_failure(FailureClass.BUDGET).maximum_attempts == 1
    assert retry_policy_for_failure(FailureClass.GATE_REJECTED).maximum_attempts == 1
    assert retry_policy_for_failure(FailureClass.HARD_ERROR).maximum_attempts == 1


def test_usage_delta_rejects_negative_values() -> None:
    from loopit_orchestrator.decisions import add_usage

    with pytest.raises(ValueError):
        add_usage(BudgetSnapshot(), UsageDelta(tokens=-1))
