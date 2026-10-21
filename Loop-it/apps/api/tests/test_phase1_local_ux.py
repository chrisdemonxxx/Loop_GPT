"""Phase 1 local-mode UX: file_change events, LOOP.md, chat mode."""

from __future__ import annotations

from pathlib import Path

from loopit_agent_core.tools import ToolCall
from loopit_api.runs import StreamingAuditSink, _goal_for, _plan_stub_dag
from loopit_api.workspace import Workspace, describe_file_changes
from loopit_agent_core.audit import AuditEvent
from loopit_patch import apply_patch as engine_apply_patch
import queue


def test_apply_patch_emits_file_change_detail(tmp_path: Path) -> None:
    ws = Workspace(root=tmp_path)
    ws.write("hello.txt", "one\n")
    patch = """--- a/hello.txt
+++ b/hello.txt
@@ -1 +1,2 @@
-one
+one
+two
"""
    result = ws.apply_patch(ToolCall(tool="apply_patch", args={"patch": patch}))
    assert result.ok
    changes = result.detail.get("file_changes")
    assert isinstance(changes, list) and len(changes) == 1
    change = changes[0]
    assert change["path"] == "hello.txt"
    assert change["op"] == "modify"
    assert change["additions"] >= 1
    assert "two" in change["diff"] or "+two" in change["diff"]


def test_streaming_audit_sink_emits_file_change_events() -> None:
    stream: queue.Queue = queue.Queue()
    sink = StreamingAuditSink(stream)
    sink.emit(
        AuditEvent(
            type="tool.called",
            tenant_id="t1",
            actor_kind="agent",
            outcome="success",
            detail={
                "tool": "apply_patch",
                "file_changes": [
                    {
                        "path": "App.js",
                        "op": "modify",
                        "diff": "--- a/App.js\n+++ b/App.js\n",
                        "additions": 2,
                        "deletions": 1,
                    }
                ],
            },
        )
    )
    first = stream.get_nowait()
    assert first["kind"] == "audit"
    second = stream.get_nowait()
    assert second["kind"] == "file_change"
    assert second["path"] == "App.js"
    assert second["additions"] == 2


def test_goal_injects_loop_md(tmp_path: Path) -> None:
    ws = Workspace(root=tmp_path)
    ws.write("LOOP.md", "Always use blue buttons.\n")
    goal = _goal_for("Add a form", "notes", ws)
    assert "THE USER'S REQUEST" in goal
    assert "PROJECT KNOWLEDGE (LOOP.md" in goal
    assert "Always use blue buttons." in goal
    assert goal.index("THE USER'S REQUEST") < goal.index("PROJECT KNOWLEDGE")


def test_goal_appends_attachment_urls(tmp_path: Path) -> None:
    ws = Workspace(root=tmp_path)
    goal = _goal_for(
        "Match this screenshot",
        "notes",
        ws,
        attachment_urls=("https://example.com/shot.png",),
    )
    assert "ATTACHMENTS" in goal
    assert "https://example.com/shot.png" in goal


def test_chat_mode_refuses_patch(tmp_path: Path) -> None:
    ws = Workspace(root=tmp_path)
    executor = ws.executor(mode="chat")
    result = executor.execute(ToolCall(tool="apply_patch", args={"patch": "x"}))
    assert not result.ok
    assert "chat mode" in result.output.lower() or "unavailable" in result.output.lower()


def test_plan_stub_dag_has_multiple_nodes() -> None:
    dag = _plan_stub_dag(
        prompt="Build a form",
        summary="A signup form",
        run_id="run_abc",
    )
    assert len(dag["nodes"]) >= 3
    assert dag["nodes"][1]["dag_parents"] == ["survey"]


def test_describe_file_changes_create(tmp_path: Path) -> None:
    before: dict[str, str] = {}
    patch = """--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hi
"""
    application = engine_apply_patch(before, patch)
    changes = describe_file_changes(before, application, patch)
    assert changes[0]["op"] == "create"
    assert changes[0]["path"] == "new.txt"
