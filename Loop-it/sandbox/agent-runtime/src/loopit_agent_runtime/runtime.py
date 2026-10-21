"""Signed RPC server that runs inside a leased sandbox.

This is data-plane code: it may execute project commands, but every instruction
must verify against the lease-bound signed channel before dispatch.
"""

from __future__ import annotations

import fnmatch
import json
import os
import subprocess
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, TextIO

from loopit_agent_core.audit import AuditEvent, AuditSink
from loopit_patch import PatchError, parse_patch
from loopit_patch import apply_patch as engine_apply_patch
from loopit_sandbox_sdk import BrowserTool, ChannelError, Envelope, Lease, sign, verify

from .serde import envelope_from_dict, envelope_to_dict

IGNORED_DIRECTORIES = frozenset({".git", "node_modules", "__pycache__", ".venv", "dist", "build"})
SAFE_ENV_KEYS = frozenset(
    {
        "CI",
        "HOME",
        "LANG",
        "LC_ALL",
        "LOGNAME",
        "PATH",
        "PWD",
        "SHELL",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USER",
        "USERPROFILE",
        "WINDIR",
    }
)
SENSITIVE_ENV_PARTS = (
    "SECRET",
    "TOKEN",
    "PASSWORD",
    "PASSWD",
    "API_KEY",
    "APIKEY",
    "AUTH",
    "CREDENTIAL",
    "PRIVATE_KEY",
    "SESSION",
)

RuntimeErrorCode = Literal[
    "bad_envelope",
    "channel_rejected",
    "invalid_args",
    "path_rejected",
    "not_found",
    "limit_exceeded",
    "tool_failed",
    "unsupported_tool",
]


class RuntimeToolError(Exception):
    def __init__(
        self, code: RuntimeErrorCode, message: str, detail: Mapping[str, Any] | None = None
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = dict(detail or {})


@dataclass(frozen=True, slots=True)
class RuntimeLimits:
    max_file_read_bytes: int = 1_000_000
    max_search_file_bytes: int = 1_000_000
    max_search_results: int = 100
    max_shell_seconds: int = 300
    max_shell_output_bytes: int = 64_000


@dataclass(frozen=True, slots=True)
class ToolResponse:
    ok: bool
    result: Mapping[str, Any] = field(default_factory=dict)
    error: Mapping[str, Any] | None = None
    audit_event: Mapping[str, Any] | None = None

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"ok": self.ok, "result": dict(self.result)}
        if self.error is not None:
            payload["error"] = dict(self.error)
        if self.audit_event is not None:
            payload["audit_event"] = dict(self.audit_event)
        return payload


@dataclass(slots=True)
class RuntimeConfig:
    workspace: Path
    lease: Lease
    signing_key: bytes
    audit_sink: AuditSink
    limits: RuntimeLimits = RuntimeLimits()
    browser_tool: BrowserTool | None = None


class SandboxRuntime:
    def __init__(self, config: RuntimeConfig) -> None:
        if not config.signing_key:
            raise ValueError("signing key is required")
        self.config = config
        self.workspace = config.workspace.resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        self._seen_nonces: set[str] = set()
        self._handlers: dict[str, Callable[[Mapping[str, Any]], Mapping[str, Any]]] = {
            "read_file": self._read_file,
            "list_files": self._list_files,
            "search_files": self._search_files,
            "search_code": self._search_files,
            "apply_patch": self._apply_patch,
            "run_shell": self._run_shell,
            "browser": self._browser,
        }

    def handle(self, envelope: Envelope) -> Envelope:
        try:
            verify(
                envelope,
                self.config.signing_key,
                self.config.lease,
                seen_nonces=self._seen_nonces,
            )
            response = self._dispatch(envelope)
        except ChannelError as error:
            response = self._failure(
                envelope.tool,
                "channel_rejected",
                str(error),
                requested_args=envelope.args,
            )
        except RuntimeToolError as error:
            response = self._failure(
                envelope.tool,
                error.code,
                error.message,
                detail=error.detail,
                requested_args=envelope.args,
            )
        except Exception as error:
            response = self._failure(
                envelope.tool,
                "tool_failed",
                f"{type(error).__name__}: {error}",
                requested_args=envelope.args,
            )

        return sign(
            Envelope(
                lease_id=self.config.lease.lease_id,
                tenant_id=self.config.lease.tenant_id,
                run_id=self.config.lease.run_id,
                tool=envelope.tool if self.config.lease.permits(envelope.tool) else "read_file",
                args=response.to_payload(),
            ),
            self.config.signing_key,
        )

    def _dispatch(self, envelope: Envelope) -> ToolResponse:
        handler = self._handlers.get(envelope.tool)
        if handler is None:
            raise RuntimeToolError("unsupported_tool", f"unsupported tool {envelope.tool!r}")
        result = handler(envelope.args)
        event = self._audit(envelope.tool, "success", envelope.args, result)
        return ToolResponse(ok=True, result=result, audit_event=event.to_dict())

    def _failure(
        self,
        tool: str,
        code: RuntimeErrorCode,
        message: str,
        *,
        detail: Mapping[str, Any] | None = None,
        requested_args: Mapping[str, Any] | None = None,
    ) -> ToolResponse:
        event = self._audit(
            tool,
            "denied"
            if code in {"channel_rejected", "path_rejected", "unsupported_tool"}
            else "failure",
            requested_args or {},
            {"error": code, **dict(detail or {})},
            event_type="tool.rejected"
            if code in {"channel_rejected", "unsupported_tool"}
            else "tool.called",
        )
        return ToolResponse(
            ok=False,
            error={"code": code, "message": message, "detail": dict(detail or {})},
            audit_event=event.to_dict(),
        )

    def _audit(
        self,
        tool: str,
        outcome: Literal["denied", "success", "failure"],
        args: Mapping[str, Any],
        result: Mapping[str, Any],
        *,
        event_type: str = "tool.called",
    ) -> AuditEvent:
        event = AuditEvent(
            type=event_type,
            tenant_id=self.config.lease.tenant_id,
            actor_kind="agent",
            actor_id=self.config.lease.run_id,
            run_id=self.config.lease.run_id,
            sandbox_lease_id=self.config.lease.lease_id,
            plane="data",
            outcome=outcome,
            detail={"tool": tool, "args": dict(args), "result": dict(result)},
        )
        self.config.audit_sink.emit(event)
        return event

    def _read_file(self, args: Mapping[str, Any]) -> Mapping[str, Any]:
        relative = _string_arg(args, "path")
        target = self._resolve(relative, must_exist=True)
        size = target.stat().st_size
        if size > self.config.limits.max_file_read_bytes:
            raise RuntimeToolError(
                "limit_exceeded",
                f"{relative!r} is {size} bytes, over the read limit",
                {"limit": self.config.limits.max_file_read_bytes, "size": size},
            )
        text = target.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        start = _optional_int_arg(args, "start_line") or 1
        end = _optional_int_arg(args, "end_line") or len(lines)
        if start < 1 or end < start:
            raise RuntimeToolError("invalid_args", "invalid line range")
        selected = "\n".join(lines[start - 1 : end])
        if selected and text.endswith("\n") and end >= len(lines):
            selected += "\n"
        return {"path": relative, "content": selected, "bytes": size, "truncated": False}

    def _list_files(self, args: Mapping[str, Any]) -> Mapping[str, Any]:
        pattern = str(args.get("glob", "*"))
        limit = min(
            _optional_int_arg(args, "max_results") or self.config.limits.max_search_results, 500
        )
        files = [path for path in self._iter_files() if fnmatch.fnmatch(path, pattern)]
        return {"files": files[:limit], "truncated": len(files) > limit}

    def _search_files(self, args: Mapping[str, Any]) -> Mapping[str, Any]:
        query = _string_arg(args, "query")
        pattern = str(args.get("glob", "*"))
        limit = min(
            _optional_int_arg(args, "max_results") or self.config.limits.max_search_results,
            self.config.limits.max_search_results,
        )
        hits: list[dict[str, Any]] = []
        for relative in self._iter_files():
            if not fnmatch.fnmatch(relative, pattern):
                continue
            target = self._resolve(relative, must_exist=True)
            if target.stat().st_size > self.config.limits.max_search_file_bytes:
                continue
            text = target.read_text(encoding="utf-8", errors="replace")
            for number, line in enumerate(text.splitlines(), 1):
                if query in line:
                    hits.append({"path": relative, "line": number, "text": line})
                    if len(hits) >= limit:
                        return {"matches": hits, "truncated": True}
        return {"matches": hits, "truncated": False}

    def _apply_patch(self, args: Mapping[str, Any]) -> Mapping[str, Any]:
        patch = _string_arg(args, "patch")
        try:
            file_patches = parse_patch(patch)
            current: dict[str, str] = {}
            for file_patch in file_patches:
                for relative in (file_patch.old_path, file_patch.new_path):
                    if relative is None or relative in current:
                        continue
                    target = self._resolve(relative, must_exist=False)
                    if target.is_file():
                        current[relative] = target.read_text(encoding="utf-8", errors="replace")
            application = engine_apply_patch(current, patch)
        except PatchError as error:
            raise RuntimeToolError("tool_failed", str(error.observation or error)) from error

        for relative, content in application.files.items():
            target = self._resolve(relative, must_exist=False)
            if content is None:
                if target.exists():
                    target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
        return {
            "summary": application.summary(),
            "created": application.created,
            "modified": application.modified,
            "deleted": application.deleted,
            "hunks_applied": application.hunks_applied,
        }

    def _run_shell(self, args: Mapping[str, Any]) -> Mapping[str, Any]:
        command = _string_arg(args, "command")
        relative_cwd = str(args.get("cwd", "."))
        cwd = self._resolve(relative_cwd, must_exist=True)
        if not cwd.is_dir():
            raise RuntimeToolError("invalid_args", "cwd must be a directory")
        requested_timeout = _optional_int_arg(args, "timeout_seconds")
        timeout = min(
            requested_timeout or self.config.limits.max_shell_seconds,
            self.config.limits.max_shell_seconds,
        )
        started = time.monotonic()
        output, timed_out, returncode = self._communicate(command, cwd, timeout)
        duration = time.monotonic() - started
        capped = len(output) > self.config.limits.max_shell_output_bytes
        if capped:
            output = output[: self.config.limits.max_shell_output_bytes] + (
                f"\n... [output capped at {self.config.limits.max_shell_output_bytes} bytes]"
            )
        return {
            "command": command,
            "exit_code": returncode,
            "stdout": output,
            "timed_out": timed_out,
            "duration_seconds": round(duration, 3),
            "output_truncated": capped,
        }

    def _communicate(self, command: str, cwd: Path, timeout: int) -> tuple[str, bool, int]:
        env = _scrub_env(os.environ)
        process = subprocess.Popen(  # noqa: S602 - data-plane runtime intentionally executes tool commands.
            command,
            cwd=str(cwd),
            env=env,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=False,
        )
        buffer = bytearray()

        def reader() -> None:
            assert process.stdout is not None
            stdout = process.stdout
            for chunk in iter(lambda: stdout.read(4096), b""):
                if len(buffer) <= self.config.limits.max_shell_output_bytes:
                    buffer.extend(chunk)

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()
        timed_out = False
        try:
            returncode = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.kill()
            returncode = process.wait(timeout=5)
        thread.join(timeout=5)
        return bytes(buffer).decode("utf-8", errors="replace"), timed_out, returncode

    def _browser(self, args: Mapping[str, Any]) -> Mapping[str, Any]:
        if self.config.browser_tool is None:
            raise RuntimeToolError("unsupported_tool", "no browser driver is configured")
        action = _string_arg(args, "action")
        if action != "goto":
            raise RuntimeToolError(
                "unsupported_tool", f"browser action {action!r} is not wired yet"
            )
        result = self.config.browser_tool.visit(str(args.get("path", "/")))
        return {
            "url": result.url,
            "status": result.status,
            "title": result.title,
            "healthy": result.healthy,
            "duration_seconds": result.duration_seconds,
        }

    def _iter_files(self) -> list[str]:
        found: list[str] = []
        for path in sorted(self.workspace.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(self.workspace)
            if IGNORED_DIRECTORIES & set(relative.parts):
                continue
            found.append(relative.as_posix())
        return found

    def _resolve(self, candidate: str, *, must_exist: bool) -> Path:
        if not candidate or candidate.strip() != candidate:
            raise RuntimeToolError(
                "path_rejected", "path must be a non-empty project-relative path"
            )
        candidate_path = Path(candidate)
        if candidate_path.is_absolute() or candidate.startswith("~"):
            raise RuntimeToolError("path_rejected", "path must be project-relative")
        target = (self.workspace / candidate_path).resolve()
        if target != self.workspace and self.workspace not in target.parents:
            raise RuntimeToolError("path_rejected", f"{candidate!r} resolves outside the workspace")
        if must_exist and not target.exists():
            raise RuntimeToolError("not_found", f"{candidate!r} does not exist")
        return target


class JsonLineRuntime:
    def __init__(self, runtime: SandboxRuntime) -> None:
        self.runtime = runtime

    def serve(self, stdin: TextIO, stdout: TextIO) -> None:
        for line in stdin:
            if not line.strip():
                continue
            try:
                envelope = envelope_from_dict(json.loads(line))
                response = self.runtime.handle(envelope)
                payload = envelope_to_dict(response)
            except Exception as error:
                payload = {"ok": False, "error": f"bad_envelope: {type(error).__name__}: {error}"}
            stdout.write(json.dumps(payload, sort_keys=True) + "\n")
            stdout.flush()


def _string_arg(args: Mapping[str, Any], name: str) -> str:
    value = args.get(name)
    if not isinstance(value, str) or not value:
        raise RuntimeToolError("invalid_args", f"{name} must be a non-empty string")
    return value


def _optional_int_arg(args: Mapping[str, Any], name: str) -> int | None:
    value = args.get(name)
    if value is None:
        return None
    if not isinstance(value, int):
        raise RuntimeToolError("invalid_args", f"{name} must be an integer")
    return value


def _scrub_env(env: Mapping[str, str]) -> dict[str, str]:
    scrubbed: dict[str, str] = {}
    for key, value in env.items():
        upper = key.upper()
        if upper not in SAFE_ENV_KEYS:
            continue
        if any(part in upper for part in SENSITIVE_ENV_PARTS):
            continue
        scrubbed[key] = value
    return scrubbed
