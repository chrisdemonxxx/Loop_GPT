"""Phase 1.6: pipeline verifier + console errors."""

from __future__ import annotations

from pathlib import Path

from loopit_agent_core.observation import Observation
from loopit_agent_core.tools import ToolCall
from loopit_api.runs import PreviewVerifier
from loopit_api.verify_bridge import (
    PipelineVerifier,
    build_verifier,
    clear_console_errors,
    record_console_error,
)
from loopit_api.workspace import Workspace


def test_console_errors_fail_verification(tmp_path: Path) -> None:
    ws = Workspace(root=tmp_path)
    ws.write("index.html", "<!doctype html><html></html>\n")
    project_id = "proj_console"
    clear_console_errors(project_id)
    record_console_error(project_id, "[error] ReferenceError: x is not defined")

    verifier = build_verifier(
        ws,
        project_id=project_id,
        stack="react",
        preview_verifier_factory=lambda w, htm_rules=True: PreviewVerifier(
            w, htm_rules=htm_rules
        ),
    )
    assert isinstance(verifier, PipelineVerifier)

    verifier(
        ToolCall(tool="apply_patch", args={"patch": "x"}),
        Observation(source="apply_patch", content="apply_patch OK"),
    )
    verdict = verifier(
        ToolCall(tool="read_file", args={"path": "index.html"}),
        Observation(source="read_file", content="<html>"),
    )
    assert verdict is not None
    assert getattr(verdict, "verified", True) is False
    assert "console" in (getattr(verdict, "observation", "") or "").lower()


def test_htm_rules_disabled_for_vite_stack(tmp_path: Path) -> None:
    ws = Workspace(root=tmp_path)
    ws.write("src/App.tsx", "export function App() { return <div className='x' /> }\n")
    verifier = PreviewVerifier(ws, htm_rules=False)
    verifier(
        ToolCall(tool="apply_patch", args={}),
        Observation(source="apply_patch", content="apply_patch OK"),
    )
    # Without htm rules, JSX-looking content in .tsx must not be rejected here
    # (parse of .tsx is skipped by the JS-only checker).
    result = verifier(
        ToolCall(tool="read_file", args={"path": "src/App.tsx"}),
        Observation(source="read_file", content="ok"),
    )
    assert result == "the project parses and its files resolve" or result is None or (
        isinstance(result, str) and "parses" in result
    )
