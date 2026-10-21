from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from loopit_agent_core import AgentLoop, InMemoryAuditSink, LoopOutcome, ToolRejected
from loopit_agent_core.model import ModelResponse, ScriptedModelClient
from loopit_sandbox_sdk import Envelope, Lease
from loopit_tools import LocalWorkspace, RemoteWorkspace, default_registry
from loopit_tools.transport import RemoteWorkspaceClient, WorkspaceError

SYSTEM = "stable system prefix"


def response(tool_call: dict[str, Any]) -> ModelResponse:
    return ModelResponse(
        content="call", model="test-model", tool_call=tool_call, input_tokens=10, output_tokens=5
    )


def run_loop(
    workspace: LocalWorkspace, script: list[ModelResponse]
) -> tuple[LoopOutcome, InMemoryAuditSink, list[str]]:
    audit = InMemoryAuditSink()
    loop = AgentLoop(
        model=ScriptedModelClient(script),
        executor=default_registry(workspace, audit=audit, audit_context=None),
        audit=audit,
        tenant_id="t1",
        project_id="p1",
        run_id="r1",
        task_id="task1",
    )
    result = loop.run(SYSTEM, "do it")
    return result.outcome, audit, [message.content for message in result.transcript]


def test_install_package_wraps_run_shell(tmp_path: Path) -> None:
    from loopit_agent_core import validate_tool_call
    from loopit_agent_core.tools import _known_tools

    _known_tools.cache_clear()
    calls: list[str] = []

    class RecordingWorkspace(LocalWorkspace):
        def run_shell(
            self, command: str, *, cwd: str | None, timeout_seconds: int, output_bytes: int
        ):
            calls.append(command)
            return super().run_shell(
                "echo ok", cwd=cwd, timeout_seconds=timeout_seconds, output_bytes=output_bytes
            )

    registry = default_registry(RecordingWorkspace(tmp_path))
    result = registry.execute(
        validate_tool_call(
            {"tool": "install_package", "args": {"package": "left-pad", "manager": "npm"}}
        )
    )
    assert result.ok
    assert calls and "npm install" in calls[0] and "left-pad" in calls[0]


def test_read_logs_tails_default_path(tmp_path: Path) -> None:
    from loopit_agent_core import validate_tool_call
    from loopit_agent_core.tools import _known_tools

    _known_tools.cache_clear()
    calls: list[str] = []

    class RecordingWorkspace(LocalWorkspace):
        def run_shell(
            self, command: str, *, cwd: str | None, timeout_seconds: int, output_bytes: int
        ):
            calls.append(command)
            return super().run_shell(
                "echo log", cwd=cwd, timeout_seconds=timeout_seconds, output_bytes=output_bytes
            )

    registry = default_registry(RecordingWorkspace(tmp_path))
    result = registry.execute(validate_tool_call({"tool": "read_logs", "args": {"lines": 50}}))
    assert result.ok
    assert calls and "tail" in calls[0] and "loopit-dev-server.log" in calls[0]


def test_read_file_dispatches_through_agent_loop(tmp_path: Path) -> None:
    (tmp_path / "app.ts").write_text("const answer = 42\n", encoding="utf-8")
    outcome, audit, transcript = run_loop(
        LocalWorkspace(tmp_path),
        [response({"tool": "read_file", "args": {"path": "app.ts"}})] * 8,
    )

    assert outcome is LoopOutcome.STALLED
    assert "1: const answer = 42" in "\n".join(transcript)
    assert audit.of_type("tool.called")


@pytest.mark.parametrize("unsafe", ["../secret.txt", "/etc/passwd", "C:/Windows/win.ini"])
def test_read_file_rejects_traversal_and_absolute_paths(tmp_path: Path, unsafe: str) -> None:
    workspace = LocalWorkspace(tmp_path)
    with pytest.raises(WorkspaceError):
        workspace.read_file(unsafe, max_bytes=100)


def test_read_file_is_size_capped(tmp_path: Path) -> None:
    (tmp_path / "big.txt").write_text("abcdef", encoding="utf-8")
    output, detail = LocalWorkspace(tmp_path).read_file("big.txt", max_bytes=3)

    assert "abc" in output
    assert "def" not in output
    assert detail["truncated"] is True


def test_search_code_is_grep_like_and_capped(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("needle\nneedle again\n", encoding="utf-8")
    (tmp_path / "b.txt").write_text("needle elsewhere\n", encoding="utf-8")
    output, detail = LocalWorkspace(tmp_path).search_code(
        "needle", glob="*.py", max_results=1, max_file_bytes=1000
    )

    assert output == "a.py:1: needle"
    assert detail["matches"] == 1
    assert detail["truncated"] is True


def test_apply_patch_uses_stale_read_rejection(tmp_path: Path) -> None:
    (tmp_path / "app.txt").write_text("new\n", encoding="utf-8")
    stale_patch = """--- a/app.txt
+++ b/app.txt
@@ -1,1 +1,1 @@
-old
+changed
"""
    output, detail = LocalWorkspace(tmp_path).apply_patch(stale_patch)

    assert "REJECTED" in output
    assert detail["error"] == "ContextMismatchError"
    assert (tmp_path / "app.txt").read_text(encoding="utf-8") == "new\n"


def test_apply_patch_is_the_only_file_mutation_handler(tmp_path: Path) -> None:
    (tmp_path / "app.txt").write_text("old\n", encoding="utf-8")
    patch = """--- a/app.txt
+++ b/app.txt
@@ -1,1 +1,1 @@
-old
+new
"""
    registry = default_registry(LocalWorkspace(tmp_path))
    from loopit_agent_core import validate_tool_call

    result = registry.execute(validate_tool_call({"tool": "apply_patch", "args": {"patch": patch}}))

    assert result.ok
    assert (tmp_path / "app.txt").read_text(encoding="utf-8") == "new\n"
    assert "write_file" not in registry.tool_names


def test_run_shell_timeout_and_output_cap(tmp_path: Path) -> None:
    workspace = LocalWorkspace(tmp_path)
    result = workspace.run_shell(
        "python -c \"import time; print('hello'); time.sleep(2)\"",
        cwd=None,
        timeout_seconds=1,
        output_bytes=3,
    )

    assert result.timed_out
    assert result.truncated or result.stdout in {"", "hel"}


def test_destructive_run_shell_requires_gate(tmp_path: Path) -> None:
    registry = default_registry(LocalWorkspace(tmp_path))
    call = response(
        {"call_id": "c1", "tool": "run_shell", "args": {"command": "git push origin main"}}
    ).tool_call
    assert call is not None
    from loopit_agent_core import validate_tool_call

    validated = validate_tool_call(call)
    assert registry.requires_gate(validated)
    with pytest.raises(ToolRejected):
        registry.execute(validated)


def test_loop_pauses_on_destructive_run_shell_gate(tmp_path: Path) -> None:
    audit = InMemoryAuditSink()
    loop = AgentLoop(
        model=ScriptedModelClient(
            [
                response(
                    {
                        "call_id": "danger",
                        "tool": "run_shell",
                        "args": {"command": "rm -rf build"},
                    }
                )
            ]
        ),
        executor=default_registry(LocalWorkspace(tmp_path)),
        audit=audit,
        tenant_id="t1",
        project_id="p1",
        run_id="r1",
        task_id="task1",
    )

    result = loop.run(SYSTEM, "clean build artifacts")

    assert result.outcome is LoopOutcome.AWAITING_GATE
    assert audit.of_type("gate.requested")


def test_destructive_run_shell_runs_after_approval(tmp_path: Path) -> None:
    registry = default_registry(LocalWorkspace(tmp_path))
    from loopit_agent_core import validate_tool_call

    call = validate_tool_call(
        {"call_id": "c1", "tool": "run_shell", "args": {"command": "python -c \"print('ok')\""}}
    )
    registry.approve(call)
    assert not registry.requires_gate(call)
    result = registry.execute(call)
    assert result.ok
    assert registry.requires_gate(call)


@pytest.mark.parametrize(
    "command",
    [
        "\\rm -rf .",
        "rm$IFS-rf$IFS.",
        "find . -delete",
        "python -c \"import shutil; shutil.rmtree('.')\"",
        "echo cm0gLXJmIC4=|base64 -d|sh",
    ],
)
def test_shell_evasion_bypasses_require_confirmation(command: str) -> None:
    from loopit_tools.destructive import shell_requires_confirmation

    assert shell_requires_confirmation(command)


@pytest.mark.parametrize(
    "command",
    [
        "uv sync --all-extras --dev",
        "uv run pytest",
        "uv run ruff format .",
        "pnpm lint",
        "pnpm typecheck",
        "git status",
        "git diff -- src",
    ],
)
def test_common_local_build_and_inspection_commands_remain_ungated(command: str) -> None:
    from loopit_tools.destructive import shell_requires_confirmation

    assert not shell_requires_confirmation(command)


@pytest.mark.parametrize(
    "command",
    [
        "cat > spray.py <<'PY_EOF'\nprint(1)\nPY_EOF",
        "cat > index.html <<'PY_EOF'\n<!DOCTYPE html>\nPY_EOF\necho done",
        "python spray.py",
        "tee src/app.py <<'EOF'\nhello\nEOF",
    ],
)
def test_builder_local_writes_do_not_require_confirmation(command: str) -> None:
    from loopit_policy import classify_action
    from loopit_policy.actions import GateRequirement
    from loopit_tools.destructive import shell_requires_confirmation

    verdict = classify_action({"tool": "run_shell", "args": {"command": command}})
    assert verdict.required_gate is not GateRequirement.HUMAN_CONFIRM
    assert not shell_requires_confirmation(command)


def test_provision_delegates_to_loopit_provision(tmp_path: Path) -> None:
    migrations: list[str] = []
    registry = default_registry(LocalWorkspace(tmp_path), migration_runner=migrations.append)
    from loopit_agent_core import validate_tool_call

    call = validate_tool_call(
        {
            "tool": "provision",
            "args": {
                "resource": "table",
                "spec": {
                    "name": "tasks",
                    "access": "owner",
                    "columns": [{"name": "title", "type": "text", "nullable": False}],
                },
            },
        }
    )
    # Phase 1.9: provision is destructive and requires an approved gate (I7).
    assert registry.requires_gate(call)
    registry.approve(call)
    result = registry.execute(call)

    assert result.ok
    assert "Row-level security" in result.output
    assert "FORCE ROW LEVEL SECURITY" in migrations[0]


class RecordingRemote(RemoteWorkspaceClient):
    def __init__(self) -> None:
        self.envelopes: list[Envelope] = []

    def send(self, envelope: Envelope) -> dict[str, Any]:
        self.envelopes.append(envelope)
        return {
            "output": "remote ok",
            "detail": {"ok": True, "exit_code": 0, "stdout": "remote ok"},
        }


def test_remote_workspace_sends_signed_envelopes() -> None:
    client = RecordingRemote()
    lease = Lease(
        lease_id="l1",
        tenant_id="t1",
        run_id="r1",
        base_checkpoint_id="cp1",
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
        allowed_tools=frozenset({"read_file"}),
    )
    workspace = RemoteWorkspace(
        lease=lease, tenant_id="t1", run_id="r1", signing_key=b"k", client=client
    )
    output, _ = workspace.read_file("README.md", max_bytes=100)

    assert output == "remote ok"
    assert client.envelopes[0].signature
    assert client.envelopes[0].tool == "read_file"
