"""HTTP client for workspace-dispatch (sandboxed tool execution).

Routes agent/operator shell into the leased sandbox (I1). Local static preview
never calls this; orchestrator mode and lease-aware ``/exec`` do.
"""

from __future__ import annotations

import json
import os
import shlex
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class DispatchResult:
    ok: bool
    output: str
    detail: dict[str, Any]
    checkpoint_id: str | None = None


class DispatchClient:
    def __init__(self, base_url: str, *, timeout_seconds: float = 420.0) -> None:
        # Accept either the service root or the /dispatch path.
        url = base_url.rstrip("/")
        self.dispatch_url = url if url.endswith("/dispatch") else f"{url}/dispatch"
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls) -> DispatchClient | None:
        url = (os.environ.get("LOOPIT_WORKSPACE_DISPATCH_URL") or "").strip()
        if not url:
            return None
        timeout = float(os.environ.get("LOOPIT_WORKSPACE_DISPATCH_HTTP_TIMEOUT_SECONDS") or "420")
        return cls(url, timeout_seconds=max(timeout, 30.0))

    def execute(
        self,
        *,
        lease_id: str,
        lease_token: str,
        tool: str,
        args: dict[str, Any],
    ) -> DispatchResult:
        body = {"lease_id": lease_id, "tool": tool, "args": args}
        request = urllib.request.Request(
            self.dispatch_url,
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {lease_token}",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise DispatchError(f"dispatch {tool} failed: {error.code} {detail}") from error
        except urllib.error.URLError as error:
            raise DispatchError(f"workspace-dispatch unreachable: {error}") from error
        parsed = json.loads(raw) if raw else {}
        if not isinstance(parsed, dict):
            raise DispatchError("dispatch returned a non-object payload")
        result = parsed.get("result") if isinstance(parsed.get("result"), dict) else parsed
        ok = bool(result.get("ok", parsed.get("ok", False)))
        output = str(result.get("output") or parsed.get("output") or "")
        detail = result.get("detail") if isinstance(result.get("detail"), dict) else {}
        checkpoint_id = parsed.get("checkpoint_id")
        return DispatchResult(
            ok=ok,
            output=output,
            detail=dict(detail) if isinstance(detail, dict) else {},
            checkpoint_id=str(checkpoint_id) if checkpoint_id else None,
        )


class DispatchError(RuntimeError):
    """workspace-dispatch HTTP call failed."""


class DispatchCommandRunner:
    """``CommandRunner`` that executes verify commands via workspace-dispatch.

    Used by :func:`loopit_api.verify_bridge.build_verifier` when the run has a
    live project lease (orchestrator + sandbox stacks). Offline local mode
    leaves ``runner=None`` and keeps parse-only verification.
    """

    def __init__(
        self,
        client: DispatchClient,
        *,
        lease_id: str,
        lease_token: str,
    ) -> None:
        self._client = client
        self._lease_id = lease_id
        self._lease_token = lease_token

    def run(self, command: tuple[str, ...], *, timeout_seconds: int) -> Any:
        from loopit_verify.runner import CommandOutput

        rendered = " ".join(shlex.quote(part) for part in command)
        started = time.monotonic()
        try:
            result = self._client.execute(
                lease_id=self._lease_id,
                lease_token=self._lease_token,
                tool="run_shell",
                args={"command": rendered, "timeout_seconds": int(timeout_seconds)},
            )
        except DispatchError as error:
            elapsed_ms = int((time.monotonic() - started) * 1000)
            return CommandOutput(
                exit_code=127,
                stderr=str(error),
                duration_ms=elapsed_ms,
            )
        detail = result.detail
        timed_out = bool(detail.get("timed_out") or detail.get("truncated"))
        exit_code = detail.get("exit_code")
        if exit_code is None:
            exit_code = 0 if result.ok and not timed_out else 1
        stdout = str(detail.get("stdout") or result.output or "")
        stderr = str(detail.get("stderr") or "")
        duration_raw = detail.get("duration_ms")
        if duration_raw is None and detail.get("duration_seconds") is not None:
            duration_raw = float(detail["duration_seconds"]) * 1000
        duration_ms = int(duration_raw or (time.monotonic() - started) * 1000)
        return CommandOutput(
            exit_code=int(exit_code),
            stdout=stdout,
            stderr=stderr,
            duration_ms=duration_ms,
            timed_out=timed_out,
        )


__all__ = [
    "DispatchClient",
    "DispatchCommandRunner",
    "DispatchError",
    "DispatchResult",
]
