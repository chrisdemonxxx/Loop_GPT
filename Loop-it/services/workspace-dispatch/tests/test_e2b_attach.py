from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta

import pytest
from loopit_sandbox_sdk import Envelope, Lease, ResourceCaps


@pytest.fixture(autouse=True)
def _dispatch_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_SERVICE_TOKEN", "svc-" + "x" * 40)
    monkeypatch.setenv("LOOPIT_LEASE_TOKEN_SECRET", "lease-" + "x" * 40)
    monkeypatch.setenv("LOOPIT_SANDBOX_SIGNING_KEY", "sandbox-" + "x" * 40)
    monkeypatch.setenv("LOOPIT_ENV", "local")
    monkeypatch.setenv("LOOPIT_SANDBOX_PROVIDER", "memory")


class FakeE2BSession:
    sandbox_id = "e2b_abc"

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, str], str]] = []

    def run(self, command: str, *, env: Mapping[str, str], stdin: str = "") -> str:
        self.calls.append((command, dict(env), stdin))
        if "loopit_agent_runtime" in command:
            return json.dumps(
                {
                    "lease_id": "lease_1",
                    "tenant_id": "tenant",
                    "run_id": "run-1",
                    "tool": "read_file",
                    "args": {"ok": True, "result": {"content": "from-e2b"}},
                    "nonce": "n1",
                    "issued_at": "2026-01-01T00:00:00+00:00",
                    "expires_at": "2099-01-01T00:00:00+00:00",
                    "signature": None,
                }
            )
        return "{}"


def _lease() -> Lease:
    now = datetime.now(UTC)
    return Lease(
        lease_id="lease_1",
        tenant_id="tenant",
        run_id="run-1",
        base_checkpoint_id="ckpt-1",
        expires_at=now + timedelta(minutes=10),
        caps=ResourceCaps(),
        allowed_tools=frozenset({"read_file"}),
    )


def test_e2b_factory_sends_signed_runtime_envelope() -> None:
    from loopit_workspace_dispatch.e2b_runtime import E2BRuntimeWorkspaceFactory

    session = FakeE2BSession()
    factory = E2BRuntimeWorkspaceFactory(
        root_signing_key=b"sandbox-signing-key-with-thirty-two-b",
        connect=lambda sandbox_id: session,
    )
    workspace = factory.create(lease=_lease(), sandbox_id="e2b_abc")
    result = workspace.client.send(
        Envelope(
            lease_id="lease_1",
            tenant_id="tenant",
            run_id="run-1",
            tool="read_file",
            args={"path": "README.md"},
        )
    )
    assert result["output"] == "from-e2b"
    assert session.calls
    command, env, stdin = session.calls[0]
    assert "loopit_agent_runtime" in command
    assert "LOOPIT_SANDBOX_SIGNING_KEY" in env
    payload = json.loads(stdin)
    assert payload["tool"] == "read_file"
    assert payload["signature"]


def test_e2b_workspace_can_checkpoint_selected_files() -> None:
    import base64

    from loopit_workspace_dispatch.e2b_runtime import E2BRuntimeWorkspaceFactory
    from loopit_workspace_dispatch.workspace import CheckpointableWorkspace

    class ContentsSession(FakeE2BSession):
        def run(self, command: str, *, env: Mapping[str, str], stdin: str = "") -> str:
            self.calls.append((command, dict(env), stdin))
            return json.dumps({"index.html": base64.b64encode(b"Hello from the sandbox").decode()})

    session = ContentsSession()
    workspace = E2BRuntimeWorkspaceFactory(
        root_signing_key=b"sandbox-signing-key-with-thirty-two-b",
        connect=lambda sandbox_id: session,
    ).create(lease=_lease(), sandbox_id="e2b_abc")
    assert isinstance(workspace, CheckpointableWorkspace)
    stored: dict[str, bytes] = {}

    class Writer:
        def put(self, content: bytes) -> str:
            stored["index.html"] = content
            return "sha"

    manifest = workspace.store_blobs_for_paths(Writer(), ["index.html"])
    assert stored["index.html"] == b"Hello from the sandbox"
    assert manifest["index.html"] == "sha"
    command, _env, stdin = session.calls[0]
    assert command.startswith("python - ")
    compile(stdin, "<checkpoint>", "exec")


def test_workspace_factory_selects_e2b(monkeypatch: pytest.MonkeyPatch) -> None:
    from loopit_workspace_dispatch.e2b_runtime import E2BRuntimeWorkspaceFactory
    from loopit_workspace_dispatch.server import DispatchSettings, _workspace_factory

    monkeypatch.setattr(
        "loopit_workspace_dispatch.e2b_runtime._load_e2b_sandbox_class",
        lambda: object(),
    )
    factory = _workspace_factory(
        DispatchSettings(
            lease_token_secret="lease-" + "x" * 40,
            service_token="svc-" + "x" * 40,
            sandbox_signing_key="sandbox-" + "x" * 40,
            sandbox_provider="e2b",
        )
    )
    assert isinstance(factory, E2BRuntimeWorkspaceFactory)


def test_unknown_provider_still_refuses() -> None:
    from loopit_workspace_dispatch.server import DispatchSettings, _workspace_factory
    from loopit_workspace_dispatch.workspace import RefusingWorkspaceFactory

    factory = _workspace_factory(
        DispatchSettings(
            lease_token_secret="lease-" + "x" * 40,
            service_token="svc-" + "x" * 40,
            sandbox_signing_key="sandbox-" + "x" * 40,
            sandbox_provider="firecracker",
        )
    )
    assert isinstance(factory, RefusingWorkspaceFactory)
