"""Tests for the real eval executor wiring using offline fakes."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_agent_core.model import ModelResponse, ScriptedModelClient
from loopit_evals.executors import (
    InfrastructureUnavailable,
    RealTaskExecutor,
    seed_phase1_crud_task,
)
from loopit_evals.suite import Task, load_suite
from loopit_scheduler.pool import WarmPool
from loopit_scheduler.provider import InMemoryProvider
from loopit_scheduler.scheduler import Scheduler
from loopit_tools import BrowserActionResult, CommandResult, WorkspaceTransport


class FakeWorkspace(WorkspaceTransport):
    def __init__(self) -> None:
        self.patched = False
        self.commands: list[str] = []
        self.patches: list[str] = []

    def read_file(
        self,
        path: str,
        *,
        start_line: int | None = None,
        end_line: int | None = None,
        max_bytes: int,
    ) -> tuple[str, Mapping[str, Any]]:
        return (
            "const onCreate = async () => {\n"
            "  await createTask(token, title);\n"
            "  setTitle('');\n"
            "  // BUG: create succeeds but the read-back list is not refreshed.\n"
            "};\n",
            {"path": path},
        )

    def list_files(
        self, path: str = ".", *, max_entries: int = 200
    ) -> tuple[str, Mapping[str, Any]]:
        return "src/client/App.tsx\ntests/e2e/create-read-back.spec.ts", {"entries": 2}

    def search_code(
        self, query: str, *, glob: str | None = None, max_results: int, max_file_bytes: int
    ) -> tuple[str, Mapping[str, Any]]:
        return "src/client/App.tsx:4: // BUG", {"matches": 1}

    def apply_patch(self, patch: str) -> tuple[str, Mapping[str, Any]]:
        self.patches.append(patch)
        if "await refresh()" in patch:
            self.patched = True
            return "applied 1 hunk to src/client/App.tsx", {"modified": ["src/client/App.tsx"]}
        return "patch failed", {"error": "PatchError"}

    def run_shell(
        self, command: str, *, cwd: str | None, timeout_seconds: int, output_bytes: int
    ) -> CommandResult:
        self.commands.append(command)
        if "playwright" in command and not self.patched:
            return CommandResult(1, stdout="expected buy milk to be visible", duration_seconds=0.1)
        return CommandResult(0, stdout="ok", duration_seconds=0.1)

    def browser_action(self, args: Mapping[str, Any]) -> BrowserActionResult:
        return BrowserActionResult(self.patched, "browser ok" if self.patched else "browser fail")


class MissingTemplateWorkspace(FakeWorkspace):
    def run_shell(
        self, command: str, *, cwd: str | None, timeout_seconds: int, output_bytes: int
    ) -> CommandResult:
        if "/opt/loopit/stack-templates/react-postgres" in command:
            return CommandResult(1, stderr="template missing")
        return CommandResult(0, stdout="ok")


def make_scheduler() -> Scheduler:
    provider = InMemoryProvider()
    return Scheduler(pool=WarmPool(provider, target_size=0, max_live=4), audit=InMemoryAuditSink())


def phase1_task() -> Task:
    return Task(
        task_id="phase1-crud-self-correction",
        tier="T1",
        prompt="fix the create/read-back flow",
        checks=("typecheck", "tests", "build", "browser:create-read-back"),
        budget_credits=1.0,
        tags=("phase1-exit-gate", "self-correction"),
    )


def test_real_executor_self_corrects_with_fake_model_and_sandbox() -> None:
    workspace = FakeWorkspace()
    model = ScriptedModelClient(
        [
            ModelResponse(
                content="{}",
                model="fake",
                input_tokens=10,
                output_tokens=3,
                credits=0.01,
                tool_call={"tool": "run_shell", "args": {"command": "pnpm run test"}},
            ),
            ModelResponse(
                content="{}",
                model="fake",
                input_tokens=20,
                output_tokens=4,
                credits=0.02,
                tool_call={"tool": "read_file", "args": {"path": "src/client/App.tsx"}},
            ),
            ModelResponse(
                content="{}",
                model="fake",
                input_tokens=30,
                output_tokens=5,
                credits=0.03,
                tool_call={
                    "tool": "apply_patch",
                    "args": {
                        "patch": (
                            "--- a/src/client/App.tsx\n"
                            "+++ b/src/client/App.tsx\n"
                            "@@\n"
                            "-  // BUG: create succeeds but the read-back list is not refreshed.\n"
                            "+  await refresh();\n"
                        )
                    },
                },
            ),
        ]
    )
    executor = RealTaskExecutor(
        scheduler=make_scheduler(),
        model_factory=lambda _tenant, _run, _task: model,
        workspace_factory=lambda _assignment, tenant_id, run_id: workspace,
        provider="fake-microvm",
        seeder=None,
    )

    attempt = executor.execute(phase1_task())

    assert not attempt.error
    assert all(check.passed for check in attempt.checks)
    assert workspace.patched
    assert executor.last_metrics is not None
    assert executor.last_metrics.self_corrected is True
    assert executor.last_metrics.crud_success is True
    assert executor.last_metrics.iterations == 3
    assert executor.last_metrics.checkpoint_id is not None


def test_real_executor_refuses_without_live_model_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HF_TOKEN", raising=False)
    executor = RealTaskExecutor(
        scheduler=make_scheduler(),
        model_factory=lambda _tenant, _run, _task: (_ for _ in ()).throw(
            InfrastructureUnavailable("HF_TOKEN is not set")
        ),
        workspace_factory=lambda _assignment, tenant_id, run_id: FakeWorkspace(),
        provider="fake-microvm",
        seeder=None,
    )

    with pytest.raises(InfrastructureUnavailable, match="HF_TOKEN"):
        executor.execute(phase1_task())


def test_phase1_task_is_in_shipped_suite() -> None:
    suite_root = Path(__file__).resolve().parents[2] / "suite"
    tasks = {task.task_id: task for task in load_suite(suite_root)}
    task = tasks["phase1-crud-self-correction"]
    assert "phase1-exit-gate" in task.tags
    assert "browser:create-read-back" in task.checks


def test_seeder_refuses_when_template_is_absent_from_live_sandbox() -> None:
    with pytest.raises(InfrastructureUnavailable, match="template missing"):
        seed_phase1_crud_task(phase1_task(), MissingTemplateWorkspace())
