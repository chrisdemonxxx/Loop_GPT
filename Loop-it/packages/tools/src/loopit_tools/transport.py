"""Workspace transports for concrete tool handlers.

Production code should use :class:`RemoteWorkspace`, which signs narrow
instructions for a leased sandbox. :class:`LocalWorkspace` exists for tests and
local single-user runs, and intentionally shares the same path and output caps.
"""

from __future__ import annotations

import fnmatch
import os
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from loopit_patch import PatchError, parse_patch
from loopit_patch import apply_patch as apply_unified_patch
from loopit_sandbox_sdk import (
    BrowserTool,
    Envelope,
    Flow,
    FlowDriver,
    Lease,
    PageResult,
    run_flow,
    sign,
)
from loopit_sandbox_sdk.browser import render

from .limits import clip_bytes


class WorkspaceError(Exception):
    """A workspace operation was rejected before producing a result."""


@dataclass(frozen=True, slots=True)
class CommandResult:
    """Structured shell execution result from a workspace transport."""

    exit_code: int | None
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    duration_seconds: float = 0.0
    truncated: bool = False

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out

    def render(self) -> str:
        status = "timed out" if self.timed_out else f"exit {self.exit_code}"
        parts = [f"run_shell finished with {status}"]
        if self.stdout:
            parts.append("stdout:\n" + self.stdout)
        if self.stderr:
            parts.append("stderr:\n" + self.stderr)
        if self.truncated:
            parts.append("[output truncated]")
        return "\n".join(parts)


@dataclass(frozen=True, slots=True)
class BrowserActionResult:
    """Structured browser result from a workspace transport."""

    ok: bool
    output: str
    detail: Mapping[str, Any] = field(default_factory=dict)


@runtime_checkable
class WorkspaceTransport(Protocol):
    """Least-privilege project workspace operations used by tool handlers."""

    def read_file(
        self,
        path: str,
        *,
        start_line: int | None = None,
        end_line: int | None = None,
        max_bytes: int,
    ) -> tuple[str, Mapping[str, Any]]: ...
    def list_files(
        self, path: str = ".", *, max_entries: int = 200
    ) -> tuple[str, Mapping[str, Any]]: ...
    def search_code(
        self, query: str, *, glob: str | None = None, max_results: int, max_file_bytes: int
    ) -> tuple[str, Mapping[str, Any]]: ...
    def apply_patch(self, patch: str) -> tuple[str, Mapping[str, Any]]: ...
    def run_shell(
        self, command: str, *, cwd: str | None, timeout_seconds: int, output_bytes: int
    ) -> CommandResult: ...
    def browser_action(self, args: Mapping[str, Any]) -> BrowserActionResult: ...


class LocalWorkspace:
    """Direct filesystem workspace for tests and trusted local development."""

    def __init__(
        self,
        root: str | os.PathLike[str],
        *,
        browser: BrowserTool | None = None,
        flow_driver_factory: Callable[[], FlowDriver] | None = None,
        flows: Mapping[str, Flow] | None = None,
    ) -> None:
        self.root = Path(root).resolve()
        self.browser = browser
        self.flow_driver_factory = flow_driver_factory
        self.flows = dict(flows or {})
        self._last_page: PageResult | None = None
        if not self.root.exists() or not self.root.is_dir():
            raise WorkspaceError(f"workspace root {self.root} is not a directory")

    def read_file(
        self,
        path: str,
        *,
        start_line: int | None = None,
        end_line: int | None = None,
        max_bytes: int,
    ) -> tuple[str, Mapping[str, Any]]:
        target = self._resolve(path)
        if not target.is_file():
            raise WorkspaceError(f"{path!r} is not a file")
        data = target.read_bytes()[: max_bytes + 1]
        truncated = len(data) > max_bytes
        text = data[:max_bytes].decode("utf-8", errors="replace")
        lines = text.splitlines()
        if start_line is not None or end_line is not None:
            start = (start_line or 1) - 1
            end = end_line if end_line is not None else len(lines)
            if end < start + 1:
                raise WorkspaceError("end_line must be greater than or equal to start_line")
            selected = lines[start:end]
            offset = start + 1
        else:
            selected = lines
            offset = 1
        numbered = "\n".join(f"{offset + index}: {line}" for index, line in enumerate(selected))
        if truncated:
            numbered += "\n[read_file truncated by byte cap]"
        return numbered, {"path": path, "bytes": min(len(data), max_bytes), "truncated": truncated}

    def list_files(
        self, path: str = ".", *, max_entries: int = 200
    ) -> tuple[str, Mapping[str, Any]]:
        base = self._resolve(path)
        if not base.is_dir():
            raise WorkspaceError(f"{path!r} is not a directory")
        entries: list[str] = []
        for child in sorted(base.rglob("*")):
            if len(entries) >= max_entries:
                break
            if any(
                part in {".git", "node_modules", ".venv", "__pycache__"} for part in child.parts
            ):
                continue
            rel = child.relative_to(self.root).as_posix()
            entries.append(rel + ("/" if child.is_dir() else ""))
        truncated = len(entries) >= max_entries
        return "\n".join(entries), {"path": path, "entries": len(entries), "truncated": truncated}

    def search_code(
        self, query: str, *, glob: str | None = None, max_results: int, max_file_bytes: int
    ) -> tuple[str, Mapping[str, Any]]:
        matches: list[str] = []
        searched = 0
        skipped_large = 0
        for path in sorted(self.root.rglob("*")):
            if len(matches) >= max_results:
                break
            if not path.is_file() or any(
                part in {".git", "node_modules", ".venv", "__pycache__"} for part in path.parts
            ):
                continue
            rel = path.relative_to(self.root).as_posix()
            if glob and not fnmatch.fnmatch(rel, glob):
                continue
            size = path.stat().st_size
            if size > max_file_bytes:
                skipped_large += 1
                continue
            searched += 1
            text = path.read_text(encoding="utf-8", errors="replace")
            for lineno, line in enumerate(text.splitlines(), start=1):
                if query in line:
                    matches.append(f"{rel}:{lineno}: {line}")
                    if len(matches) >= max_results:
                        break
        output = "\n".join(matches) if matches else f"No matches for {query!r}."
        return output, {
            "matches": len(matches),
            "searched_files": searched,
            "skipped_large_files": skipped_large,
            "truncated": len(matches) >= max_results,
        }

    def apply_patch(self, patch: str) -> tuple[str, Mapping[str, Any]]:
        try:
            parsed = parse_patch(patch)
            current: dict[str, str] = {}
            for file_patch in parsed:
                for path in (file_patch.old_path, file_patch.new_path):
                    if path is None or path in current:
                        continue
                    target = self._resolve(path)
                    if target.exists():
                        current[path] = target.read_text(encoding="utf-8")
            application = apply_unified_patch(current, patch)
        except PatchError as error:
            return error.observation, {"error": type(error).__name__}

        for rel, content in application.files.items():
            target = self._resolve(rel)
            if content is None:
                if target.exists():
                    target.unlink()
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8", newline="")
        return application.summary(), {
            "created": application.created,
            "modified": application.modified,
            "deleted": application.deleted,
            "hunks_applied": application.hunks_applied,
        }

    def run_shell(
        self, command: str, *, cwd: str | None, timeout_seconds: int, output_bytes: int
    ) -> CommandResult:
        workdir = self._resolve(cwd or ".")
        if not workdir.is_dir():
            raise WorkspaceError(f"cwd {cwd!r} is not a directory")
        import time

        started = time.monotonic()
        try:
            completed = subprocess.run(  # noqa: S602 - explicit LocalWorkspace shell transport.
                command,
                cwd=workdir,
                shell=True,
                text=True,
                capture_output=True,
                timeout=timeout_seconds,
                check=False,
            )
            stdout, out_truncated = clip_bytes(completed.stdout, output_bytes)
            stderr, err_truncated = clip_bytes(completed.stderr, output_bytes)
            return CommandResult(
                completed.returncode,
                stdout,
                stderr,
                duration_seconds=time.monotonic() - started,
                truncated=out_truncated or err_truncated,
            )
        except subprocess.TimeoutExpired as error:
            stdout = _decode_output(error.stdout)
            stderr = _decode_output(error.stderr)
            stdout, out_truncated = clip_bytes(stdout, output_bytes)
            stderr, err_truncated = clip_bytes(stderr, output_bytes)
            return CommandResult(
                None,
                stdout,
                stderr,
                timed_out=True,
                duration_seconds=time.monotonic() - started,
                truncated=out_truncated or err_truncated,
            )

    def browser_action(self, args: Mapping[str, Any]) -> BrowserActionResult:
        action = str(args.get("action"))
        if action == "goto":
            if self.browser is None:
                return BrowserActionResult(False, "browser REJECTED: no browser driver configured")
            result = self.browser.visit(str(args.get("path", "/")))
            self._last_page = result
            return BrowserActionResult(result.healthy, render(result), {"status": result.status})
        if action == "console_errors":
            if self._last_page is None:
                return BrowserActionResult(False, "browser REJECTED: no page has been visited yet")
            output = "\n".join(message.summary() for message in self._last_page.console_errors)
            return BrowserActionResult(
                not self._last_page.console_errors, output or "No console errors."
            )
        if action == "smoke":
            flow_name = str(args.get("flow", ""))
            flow = self.flows.get(flow_name)
            if flow is None or self.flow_driver_factory is None:
                return BrowserActionResult(
                    False, f"browser REJECTED: flow {flow_name!r} is not configured"
                )
            flow_result = run_flow(self.flow_driver_factory(), flow)
            return BrowserActionResult(
                flow_result.passed,
                flow_result.render(),
                {"flow": flow_result.flow},
            )
        return BrowserActionResult(
            False, f"browser REJECTED: action {action!r} needs an interactive driver"
        )

    def _resolve(self, path: str) -> Path:
        if not path:
            raise WorkspaceError("path is required")
        normalised = path.replace("\\", "/")
        if normalised.startswith("/") or normalised.startswith("//"):
            raise WorkspaceError("absolute paths are not allowed")
        if len(normalised) >= 2 and normalised[1] == ":":
            raise WorkspaceError("drive-qualified paths are not allowed")
        parts = tuple(part for part in normalised.split("/") if part not in {"", "."})
        if ".." in parts:
            raise WorkspaceError("parent traversal is not allowed")
        candidate = (self.root.joinpath(*parts) if parts else self.root).resolve()
        if not candidate.is_relative_to(self.root):
            raise WorkspaceError("path escapes the workspace")
        return candidate


def _decode_output(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


@runtime_checkable
class RemoteWorkspaceClient(Protocol):
    """Client implemented by the sandbox channel transport."""

    def send(self, envelope: Envelope) -> Mapping[str, Any]: ...


class RemoteWorkspace:
    """Workspace transport that sends signed sandbox-sdk envelopes."""

    def __init__(
        self,
        *,
        lease: Lease,
        tenant_id: str,
        run_id: str,
        signing_key: bytes,
        client: RemoteWorkspaceClient,
    ) -> None:
        self.lease = lease
        self.tenant_id = tenant_id
        self.run_id = run_id
        self.signing_key = signing_key
        self.client = client

    def read_file(
        self,
        path: str,
        *,
        start_line: int | None = None,
        end_line: int | None = None,
        max_bytes: int,
    ) -> tuple[str, Mapping[str, Any]]:
        return self._send(
            "read_file",
            {"path": path, "start_line": start_line, "end_line": end_line, "max_bytes": max_bytes},
        )

    def list_files(
        self, path: str = ".", *, max_entries: int = 200
    ) -> tuple[str, Mapping[str, Any]]:
        return self._send("list_files", {"path": path, "max_entries": max_entries})

    def search_code(
        self, query: str, *, glob: str | None = None, max_results: int, max_file_bytes: int
    ) -> tuple[str, Mapping[str, Any]]:
        return self._send(
            "search_code",
            {
                "query": query,
                "glob": glob,
                "max_results": max_results,
                "max_file_bytes": max_file_bytes,
            },
        )

    def apply_patch(self, patch: str) -> tuple[str, Mapping[str, Any]]:
        return self._send("apply_patch", {"patch": patch})

    def run_shell(
        self, command: str, *, cwd: str | None, timeout_seconds: int, output_bytes: int
    ) -> CommandResult:
        output, detail = self._send(
            "run_shell",
            {
                "command": command,
                "cwd": cwd,
                "timeout_seconds": timeout_seconds,
                "output_bytes": output_bytes,
            },
        )
        return CommandResult(
            int(detail["exit_code"]) if detail.get("exit_code") is not None else None,
            stdout=str(detail.get("stdout", output)),
            stderr=str(detail.get("stderr", "")),
            timed_out=bool(detail.get("timed_out", False)),
            duration_seconds=float(detail.get("duration_seconds", 0.0)),
            truncated=bool(detail.get("truncated", False)),
        )

    def browser_action(self, args: Mapping[str, Any]) -> BrowserActionResult:
        output, detail = self._send("browser", dict(args))
        return BrowserActionResult(bool(detail.get("ok", True)), output, detail)

    def _send(self, tool: str, args: Mapping[str, Any]) -> tuple[str, Mapping[str, Any]]:
        envelope = sign(
            Envelope(
                lease_id=self.lease.lease_id,
                tenant_id=self.tenant_id,
                run_id=self.run_id,
                tool=tool,
                args={key: value for key, value in args.items() if value is not None},
            ),
            self.signing_key,
        )
        response = self.client.send(envelope)
        detail = response.get("detail", {})
        if not isinstance(detail, Mapping):
            detail = {}
        return str(response.get("output", "")), dict(detail)
