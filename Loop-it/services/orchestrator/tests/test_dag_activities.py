from __future__ import annotations

import json
from typing import Any

import pytest
from loopit_orchestrator import dag_activities
from loopit_orchestrator.dag_activities import (
    execute_dag_node,
    verify_dag_node,
)
from loopit_orchestrator.types import (
    DagNodeRunInput,
    DagVerificationInput,
    LeaseInfo,
)
from loopit_policy import FailureClass
from temporalio.exceptions import ApplicationError

SERVICE_TOKEN = "orchestrator-service-token-with-at-least-thirty-two-bytes"


@pytest.fixture(autouse=True)
def service_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_SERVICE_TOKEN", SERVICE_TOKEN)
    monkeypatch.setenv("LOOPIT_WORKSPACE_DISPATCH_URL", "http://workspace/dispatch")


def _node_payload(lease: LeaseInfo | None = None) -> DagNodeRunInput:
    return DagNodeRunInput(
        run_id="run",
        tenant_id="tenant",
        project_id="project",
        node_id="node-a",
        node_kind="add_ui_component",
        node_goal="add a button",
        base_checkpoint_id="base",
        expected_verification=("L0_typecheck_lint", "L1_tests"),
        destructive=False,
        lease=lease or LeaseInfo("lease-a", "token-a", "sandbox-a", "later", ("read_file",)),
    )


@pytest.mark.asyncio
async def test_execute_dag_node_dispatches_with_lease_bearer_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen_dispatch: dict[str, Any] = {}

    def fake_post(url: str, payload: dict[str, object], **kwargs: object) -> dict[str, object]:
        if url.endswith("/v1/chat/completions"):
            return {
                "model": "fake",
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "credits": 0},
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(
                                {"tool": "read_file", "args": {"path": "src/App.tsx"}}
                            )
                        },
                    }
                ],
            }
        seen_dispatch["payload"] = payload
        seen_dispatch["headers"] = kwargs.get("headers")
        return {
            "ok": True,
            "checkpoint_id": "ckpt_node_a",
            "checkpoint_created": True,
            "changed_paths": ["src/App.tsx"],
            "summary": "read component",
        }

    monkeypatch.setattr(dag_activities, "_post_json", fake_post)

    result = execute_dag_node(_node_payload())

    assert result.checkpoint_id == "ckpt_node_a"
    assert result.checkpoint_created is True
    assert seen_dispatch["payload"] == {
        "lease_id": "lease-a",
        "tool": "read_file",
        "args": {"path": "src/App.tsx"},
        "run_id": "run",
        "tenant_id": "tenant",
        "project_id": "project",
        "node_id": "node-a",
        "node_goal": "add a button",
        "base_checkpoint_id": "base",
        "expected_verification": ("L0_typecheck_lint", "L1_tests"),
        "destructive": False,
    }
    assert seen_dispatch["headers"] == {"Authorization": "Bearer token-a"}


@pytest.mark.asyncio
async def test_verify_dag_node_dispatches_with_lease_bearer_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, object] = {}
    lease = LeaseInfo("verify-lease", "verify-token", "sandbox-v", "later", ("run_shell",))

    def fake_post(url: str, payload: dict[str, object], **kwargs: object) -> dict[str, object]:
        seen["payload"] = payload
        seen["headers"] = kwargs.get("headers")
        seen["timeout_seconds"] = kwargs.get("timeout_seconds")
        return {"passed": True, "summary": "Verification passed"}

    monkeypatch.setattr(dag_activities, "_post_json", fake_post)

    result = verify_dag_node(
        DagVerificationInput(
            "run",
            "tenant",
            "project",
            "node-a",
            "ckpt_node_a",
            ("L0_typecheck_lint",),
            lease,
        )
    )

    assert result.passed is True
    assert seen["payload"] == {"lease_id": "verify-lease", "tool": "verify", "args": {}}
    assert seen["headers"] == {"Authorization": "Bearer verify-token"}
    assert seen["timeout_seconds"] == 540.0


@pytest.mark.asyncio
async def test_execute_dag_node_accepts_read_only_result_without_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_post(url: str, payload: dict[str, object], **kwargs: object) -> dict[str, object]:
        if url.endswith("/v1/chat/completions"):
            return {
                "model": "fake",
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "credits": 0},
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(
                                {"tool": "read_file", "args": {"path": "src/App.tsx"}}
                            )
                        },
                    }
                ],
            }
        return {
            "ok": True,
            "checkpoint_id": None,
            "checkpoint_created": False,
            "summary": "read-only result",
        }

    monkeypatch.setattr(dag_activities, "_post_json", fake_post)

    result = execute_dag_node(_node_payload())

    assert result.checkpoint_id is None
    assert result.checkpoint_created is False


@pytest.mark.asyncio
async def test_execute_dag_node_allows_known_read_only_shell_without_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_post(url: str, payload: dict[str, object], **kwargs: object) -> dict[str, object]:
        if url.endswith("/v1/chat/completions"):
            return {
                "model": "fake",
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "credits": 0},
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(
                                {"tool": "run_shell", "args": {"command": "uv run pytest -q"}}
                            )
                        },
                    }
                ],
            }
        return {
            "ok": True,
            "checkpoint_id": None,
            "checkpoint_created": False,
            "summary": "tests passed",
        }

    monkeypatch.setattr(dag_activities, "_post_json", fake_post)

    result = execute_dag_node(_node_payload())

    assert result.checkpoint_id is None
    assert result.checkpoint_created is False
    assert result.summary == "tests passed"


@pytest.mark.asyncio
async def test_execute_dag_node_accepts_mutating_shell_with_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen_dispatch: dict[str, object] = {}

    def fake_post(url: str, payload: dict[str, object], **kwargs: object) -> dict[str, object]:
        if url.endswith("/v1/chat/completions"):
            return {
                "model": "fake",
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "credits": 0},
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(
                                {"tool": "run_shell", "args": {"command": "npm install"}}
                            )
                        },
                    }
                ],
            }
        assert kwargs["timeout_seconds"] == 420.0
        seen_dispatch.update(payload)
        return {
            "ok": True,
            "checkpoint_id": "ckpt_node_a_after_npm_install",
            "checkpoint_created": True,
            "changed_paths": ["package-lock.json", "node_modules/.package-lock.json"],
            "summary": "installed dependencies",
        }

    monkeypatch.setattr(dag_activities, "_post_json", fake_post)

    result = execute_dag_node(_node_payload())

    assert seen_dispatch["tool"] == "run_shell"
    assert seen_dispatch["args"] == {"command": "npm install"}
    assert result.checkpoint_created is True
    assert result.checkpoint_id == "ckpt_node_a_after_npm_install"
    assert result.changed_paths == ("package-lock.json", "node_modules/.package-lock.json")


@pytest.mark.asyncio
async def test_execute_dag_node_rejects_shell_requiring_human_approval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_post(url: str, payload: dict[str, object], **kwargs: object) -> dict[str, object]:
        if url.endswith("/v1/chat/completions"):
            return {
                "model": "fake",
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "credits": 0},
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(
                                {"tool": "run_shell", "args": {"command": "git push --force"}}
                            )
                        },
                    }
                ],
            }
        raise AssertionError("approval-gated shell must be rejected before dispatch")

    monkeypatch.setattr(dag_activities, "_post_json", fake_post)

    with pytest.raises(ApplicationError) as exc:
        execute_dag_node(_node_payload())

    assert exc.value.non_retryable
    assert exc.value.type == FailureClass.HARD_ERROR.value
    assert "requires human approval" in str(exc.value)


@pytest.mark.asyncio
async def test_execute_dag_node_propagates_changed_uncheckpointed_dispatch_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_post(url: str, payload: dict[str, object], **kwargs: object) -> dict[str, object]:
        if url.endswith("/v1/chat/completions"):
            return {
                "model": "fake",
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "credits": 0},
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(
                                {"tool": "run_shell", "args": {"command": "npm install"}}
                            )
                        },
                    }
                ],
            }
        raise ApplicationError("HTTP 503 calling workspace dispatch", type="transient")

    monkeypatch.setattr(dag_activities, "_post_json", fake_post)

    with pytest.raises(ApplicationError) as exc:
        execute_dag_node(_node_payload())

    assert exc.value.type == "transient"
    assert "503" in str(exc.value)


@pytest.mark.asyncio
async def test_execute_dag_node_fails_loudly_when_dispatcher_omits_checkpoint_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_post(url: str, payload: dict[str, object], **kwargs: object) -> dict[str, object]:
        if url.endswith("/v1/chat/completions"):
            return {
                "model": "fake",
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "credits": 0},
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(
                                {"tool": "read_file", "args": {"path": "src/App.tsx"}}
                            )
                        },
                    }
                ],
            }
        return {"ok": True, "summary": "dispatcher did not send checkpoint_created"}

    monkeypatch.setattr(dag_activities, "_post_json", fake_post)

    with pytest.raises(ApplicationError) as exc:
        execute_dag_node(_node_payload())

    assert exc.value.non_retryable
    assert exc.value.type == FailureClass.HARD_ERROR.value
    assert "checkpoint_created" in str(exc.value)


@pytest.mark.asyncio
async def test_execute_dag_node_accepts_noop_patch_without_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_post(url: str, payload: dict[str, object], **kwargs: object) -> dict[str, object]:
        if url.endswith("/v1/chat/completions"):
            return {
                "model": "fake",
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "credits": 0},
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(
                                {"tool": "apply_patch", "args": {"patch": "*** Begin Patch"}}
                            )
                        },
                    }
                ],
            }
        return {
            "ok": True,
            "checkpoint_id": None,
            "checkpoint_created": False,
            "changed_paths": [],
            "summary": "patch was a no-op",
        }

    monkeypatch.setattr(dag_activities, "_post_json", fake_post)

    result = execute_dag_node(_node_payload())

    assert result.checkpoint_created is False
    assert result.checkpoint_id is None
    assert result.changed_paths == ()


@pytest.mark.asyncio
async def test_execute_dag_node_propagates_dispatcher_lease_refusal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_post(url: str, payload: dict[str, object], **kwargs: object) -> dict[str, object]:
        if url.endswith("/v1/chat/completions"):
            return {
                "model": "fake",
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "credits": 0},
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(
                                {"tool": "read_file", "args": {"path": "src/App.tsx"}}
                            )
                        },
                    }
                ],
            }
        raise ApplicationError(
            "lease not found", type=FailureClass.HARD_ERROR.value, non_retryable=True
        )

    monkeypatch.setattr(dag_activities, "_post_json", fake_post)

    with pytest.raises(ApplicationError, match="lease not found"):
        execute_dag_node(_node_payload(LeaseInfo("expired", "bad", "sandbox", "past")))
