from __future__ import annotations

import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_agent_runtime import RuntimeConfig, RuntimeLimits, SandboxRuntime
from loopit_sandbox_sdk import Envelope, Lease, ReplayError, SignatureError, sign, verify

KEY = b"runtime-test-key"
OTHER_KEY = b"not-the-key"


def make_lease(**overrides: object) -> Lease:
    defaults: dict[str, object] = {
        "lease_id": "lease_1",
        "tenant_id": "tenant_a",
        "run_id": "run_1",
        "base_checkpoint_id": "ckpt_0",
        "ttl_seconds": 600,
        "allowed_tools": frozenset(
            {
                "read_file",
                "list_files",
                "search_files",
                "search_code",
                "apply_patch",
                "run_shell",
                "browser",
            }
        ),
    }
    return Lease.issue(**{**defaults, **overrides})  # type: ignore[arg-type]


@pytest.fixture
def audit() -> InMemoryAuditSink:
    return InMemoryAuditSink()


@pytest.fixture
def runtime(tmp_path: Path, audit: InMemoryAuditSink) -> SandboxRuntime:
    return SandboxRuntime(
        RuntimeConfig(
            workspace=tmp_path,
            lease=make_lease(),
            signing_key=KEY,
            audit_sink=audit,
            limits=RuntimeLimits(max_shell_seconds=2, max_shell_output_bytes=80),
        )
    )


def request(
    runtime: SandboxRuntime, tool: str, args: dict[str, object], *, key: bytes = KEY
) -> Envelope:
    return sign(
        Envelope(
            lease_id=runtime.config.lease.lease_id,
            tenant_id=runtime.config.lease.tenant_id,
            run_id=runtime.config.lease.run_id,
            tool=tool,
            args=args,
        ),
        key,
    )


def response_args(runtime: SandboxRuntime, envelope: Envelope) -> dict[str, object]:
    response = runtime.handle(envelope)
    verify(response, KEY, runtime.config.lease)
    return dict(response.args)


def object_mapping(value: object) -> dict[str, object]:
    assert isinstance(value, dict)
    return value


def test_signature_rejection(runtime: SandboxRuntime, audit: InMemoryAuditSink) -> None:
    payload = response_args(
        runtime, request(runtime, "read_file", {"path": "x.txt"}, key=OTHER_KEY)
    )
    assert payload["ok"] is False
    assert object_mapping(payload["error"])["code"] == "channel_rejected"
    assert isinstance(audit.events[-1].detail["result"], dict)
    assert audit.events[-1].type == "tool.rejected"


def test_replay_rejection(runtime: SandboxRuntime) -> None:
    envelope = request(runtime, "list_files", {})
    assert response_args(runtime, envelope)["ok"] is True
    rejected = response_args(runtime, envelope)
    assert rejected["ok"] is False
    assert "already used" in str(object_mapping(rejected["error"])["message"])
    with pytest.raises(ReplayError):
        verify(envelope, KEY, runtime.config.lease, seen_nonces={envelope.nonce})


def test_path_traversal_blocked(runtime: SandboxRuntime) -> None:
    payload = response_args(runtime, request(runtime, "read_file", {"path": "..\\secret.txt"}))
    assert payload["ok"] is False
    assert object_mapping(payload["error"])["code"] == "path_rejected"


def test_apply_patch_happy_path(runtime: SandboxRuntime, tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("print('old')\n", encoding="utf-8")
    patch = """--- a/app.py
+++ b/app.py
@@ -1 +1 @@
-print('old')
+print('new')
"""
    payload = response_args(runtime, request(runtime, "apply_patch", {"patch": patch}))
    assert payload["ok"] is True
    assert (tmp_path / "app.py").read_text(encoding="utf-8") == "print('new')\n"


def test_apply_patch_stale_context_rejected(runtime: SandboxRuntime, tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("print('current')\n", encoding="utf-8")
    patch = """--- a/app.py
+++ b/app.py
@@ -1 +1 @@
-print('old')
+print('new')
"""
    payload = response_args(runtime, request(runtime, "apply_patch", {"patch": patch}))
    assert payload["ok"] is False
    assert "does not match" in str(object_mapping(payload["error"])["message"])
    assert (tmp_path / "app.py").read_text(encoding="utf-8") == "print('current')\n"


def test_shell_timeout(runtime: SandboxRuntime) -> None:
    command = f'{sys.executable} -c "import time; time.sleep(5)"'
    payload = response_args(
        runtime, request(runtime, "run_shell", {"command": command, "timeout_seconds": 5})
    )
    assert payload["ok"] is True
    result = object_mapping(payload["result"])
    assert result["timed_out"] is True
    assert result["exit_code"] != 0


def test_shell_output_cap(runtime: SandboxRuntime) -> None:
    command = f"{sys.executable} -c \"print('x' * 1000)\""
    payload = response_args(runtime, request(runtime, "run_shell", {"command": command}))
    result = object_mapping(payload["result"])
    assert result["output_truncated"] is True
    assert "output capped" in str(result["stdout"])


def test_shell_env_scrubbing(runtime: SandboxRuntime, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_TEST_TOKEN", "super-secret")
    command = (
        f"{sys.executable} -c \"import os; print(os.environ.get('LOOPIT_TEST_TOKEN', 'missing'))\""
    )
    payload = response_args(runtime, request(runtime, "run_shell", {"command": command}))
    result = object_mapping(payload["result"])
    assert "super-secret" not in str(result["stdout"])
    assert "missing" in str(result["stdout"])


def test_expired_envelope_is_rejected(runtime: SandboxRuntime) -> None:
    envelope = sign(
        Envelope(
            lease_id=runtime.config.lease.lease_id,
            tenant_id=runtime.config.lease.tenant_id,
            run_id=runtime.config.lease.run_id,
            tool="list_files",
            args={},
            expires_at=datetime.now(UTC) - timedelta(seconds=1),
        ),
        KEY,
    )
    payload = response_args(runtime, envelope)
    assert payload["ok"] is False
    assert object_mapping(payload["error"])["code"] == "channel_rejected"


def test_unsigned_envelope_would_fail_sdk_verification(runtime: SandboxRuntime) -> None:
    envelope = Envelope(
        lease_id=runtime.config.lease.lease_id,
        tenant_id=runtime.config.lease.tenant_id,
        run_id=runtime.config.lease.run_id,
        tool="list_files",
        args={},
    )
    with pytest.raises(SignatureError):
        verify(envelope, KEY, runtime.config.lease)
    payload = response_args(runtime, envelope)
    assert payload["ok"] is False
