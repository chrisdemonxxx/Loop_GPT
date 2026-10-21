from __future__ import annotations

import json
from pathlib import Path

import pytest
from loopit_evals.cli import main
from loopit_evals.model_compare import ComparisonRefusal, compare_model_reports


def _payload(model_id: str, *, coding: float = 1.0, reasoning: float = 1.0) -> dict[str, object]:
    return {
        "total_tasks": 2,
        "passed": 2,
        "pass_at_1": 1.0,
        "credits_spent": 1.0,
        "run": {"executor": "real", "model_id": model_id, "measured_at": "2026-09-03T00:00:00Z"},
        "tiers": [{"tier": "T3", "total": 2, "passed_at_1": 2, "pass_at_1": 1.0}],
        "capabilities": [
            {
                "tier": "T3",
                "capability": "coding",
                "total": 2,
                "passed_at_1": 2,
                "pass_at_1": coding,
            },
            {
                "tier": "T3",
                "capability": "reasoning",
                "total": 2,
                "passed_at_1": 2,
                "pass_at_1": reasoning,
            },
        ],
    }


def test_model_comparison_ships_when_modified_model_has_no_significant_regression() -> None:
    comparison = compare_model_reports(
        base_payload=_payload("base", coding=0.9, reasoning=0.8),
        modified_payload=_payload("modified", coding=0.9, reasoning=0.79),
        tolerance=0.02,
    )
    assert comparison.verdict == "ship"
    assert comparison.regressions == ()


def test_model_comparison_blocks_shipping_on_coding_or_reasoning_regression() -> None:
    comparison = compare_model_reports(
        base_payload=_payload("base", coding=0.9, reasoning=0.8),
        modified_payload=_payload("modified", coding=0.7, reasoning=0.8),
        tolerance=0.02,
    )
    assert comparison.verdict == "no_ship"
    assert comparison.regressions[0].capability == "coding"


def test_model_comparison_refuses_without_real_eval_evidence() -> None:
    base = _payload("base")
    base["run"] = {"executor": "unconfigured", "model_id": "base"}
    with pytest.raises(ComparisonRefusal, match="real eval run"):
        compare_model_reports(base_payload=base, modified_payload=_payload("modified"))


def test_compare_models_cli_exit_codes(tmp_path: Path) -> None:
    base = tmp_path / "base.json"
    modified = tmp_path / "modified.json"
    base.write_text(json.dumps(_payload("base", coding=1.0)), encoding="utf-8")
    modified.write_text(json.dumps(_payload("modified", coding=0.5)), encoding="utf-8")
    assert (
        main(["compare-models", "--base-results", str(base), "--modified-results", str(modified)])
        == 1
    )

    refused = tmp_path / "refused.json"
    refused.write_text(json.dumps({"total_tasks": 0}), encoding="utf-8")
    assert (
        main(
            ["compare-models", "--base-results", str(refused), "--modified-results", str(modified)]
        )
        == 2
    )
