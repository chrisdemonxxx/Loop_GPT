"""Typed registry that adapts workspace transports to agent-core executors."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from jsonschema import Draft202012Validator
from loopit_agent_core import AuditEvent, AuditSink, ToolExecutor, ToolRejected, ToolResult
from loopit_agent_core.tools import ToolCall, ToolHandler
from loopit_provision import MigrationRunner, provision

from .destructive import shell_requires_confirmation
from .limits import ToolLimits
from .schemas import TOOL_PARAM_SCHEMAS
from .transport import WorkspaceError, WorkspaceTransport

DeployRunner = Callable[[Mapping[str, Any]], ToolResult]
SecretRequester = Callable[[Mapping[str, Any]], ToolResult]


@dataclass(frozen=True, slots=True)
class AuditContext:
    """Identity fields used for optional per-handler audit events."""

    tenant_id: str
    project_id: str
    run_id: str
    task_id: str
    actor_id: str | None = None
    sandbox_lease_id: str | None = None
    trace_id: str | None = None


class ToolRegistry(ToolExecutor):
    """Concrete agent-core executor with schema validation and shell gates."""

    def __init__(
        self,
        handlers: Mapping[str, ToolHandler],
        *,
        limits: ToolLimits | None = None,
        audit: AuditSink | None = None,
        audit_context: AuditContext | None = None,
        approved_gates: frozenset[str] = frozenset(),
        run_id: str = "local",
    ) -> None:
        self.limits = limits or ToolLimits()
        self.audit = audit
        self.audit_context = audit_context
        super().__init__(handlers, approved_gates=approved_gates, run_id=run_id)

    @property
    def tool_names(self) -> tuple[str, ...]:
        return tuple(sorted(self._handlers))

    def _call_requires_confirmation(self, call: ToolCall) -> bool:
        if call.tool == "run_shell":
            return super()._call_requires_confirmation(call) or shell_requires_confirmation(
                str(call.args.get("command", ""))
            )
        if call.tool == "start_dev_server":
            return super()._call_requires_confirmation(call) or shell_requires_confirmation(
                str(call.args.get("command") or "npm run dev")
            )
        return super()._call_requires_confirmation(call)

    def execute(self, call: ToolCall) -> ToolResult:
        self._validate_args(call)
        if self.requires_gate(call):
            raise ToolRejected(
                f"{call.tool!r} requires an approved confirmation gate",
                observation=(
                    f"tool call BLOCKED: {call.tool!r} may be destructive or irreversible and "
                    "requires explicit human approval. The run is paused awaiting a decision."
                ),
            )
        self._emit("tool.handler.started", "pending", call, {})
        result = super().execute(call)
        self._emit(
            "tool.handler.finished", "success" if result.ok else "failure", call, result.detail
        )
        return result

    def _validate_args(self, call: ToolCall) -> None:
        schema = TOOL_PARAM_SCHEMAS.get(call.tool)
        if schema is None:
            return
        errors = sorted(
            Draft202012Validator(schema).iter_errors(dict(call.args)), key=lambda e: list(e.path)
        )
        if errors:
            detail = "; ".join(
                f"{'/'.join(str(p) for p in error.path) or '<root>'}: {error.message}"
                for error in errors[:3]
            )
            raise ToolRejected(f"{call.tool} args failed schema validation: {detail}")

    def _emit(
        self, event_type: str, outcome: str, call: ToolCall, detail: Mapping[str, Any]
    ) -> None:
        if self.audit is None or self.audit_context is None:
            return
        self.audit.emit(
            AuditEvent(
                type=event_type,
                tenant_id=self.audit_context.tenant_id,
                actor_kind="agent",
                actor_id=self.audit_context.actor_id or self.audit_context.task_id,
                project_id=self.audit_context.project_id,
                run_id=self.audit_context.run_id,
                task_id=self.audit_context.task_id,
                sandbox_lease_id=self.audit_context.sandbox_lease_id,
                trace_id=self.audit_context.trace_id,
                plane="data",
                outcome=outcome,  # type: ignore[arg-type]
                detail={
                    "tool": call.tool,
                    "call_id": call.call_id,
                    "args": dict(call.args),
                    **dict(detail),
                },
            )
        )


def default_registry(
    workspace: WorkspaceTransport,
    *,
    limits: ToolLimits | None = None,
    migration_runner: MigrationRunner | None = None,
    deploy_runner: DeployRunner | None = None,
    secret_requester: SecretRequester | None = None,
    audit: AuditSink | None = None,
    audit_context: AuditContext | None = None,
    approved_gates: frozenset[str] = frozenset(),
) -> ToolRegistry:
    """Assemble the standard toolset for an agent-core loop."""
    caps = limits or ToolLimits()

    def read_file(call: ToolCall) -> ToolResult:
        try:
            output, detail = workspace.read_file(
                str(call.args["path"]),
                start_line=_optional_int(call.args.get("start_line")),
                end_line=_optional_int(call.args.get("end_line")),
                max_bytes=caps.read_file_bytes,
            )
            return ToolResult(True, output, detail)
        except WorkspaceError as error:
            return ToolResult(
                False, f"read_file REJECTED: {error}", {"error": type(error).__name__}
            )

    def search_code(call: ToolCall) -> ToolResult:
        try:
            output, detail = workspace.search_code(
                str(call.args["query"]),
                glob=str(call.args["glob"]) if call.args.get("glob") is not None else None,
                max_results=min(
                    _optional_int(call.args.get("max_results")) or caps.search_results,
                    caps.search_results,
                ),
                max_file_bytes=caps.search_file_bytes,
            )
            return ToolResult(True, output, detail)
        except WorkspaceError as error:
            return ToolResult(
                False, f"search_code REJECTED: {error}", {"error": type(error).__name__}
            )

    def apply_patch(call: ToolCall) -> ToolResult:
        output, detail = workspace.apply_patch(str(call.args["patch"]))
        return ToolResult("error" not in detail, output, detail)

    def run_shell(call: ToolCall) -> ToolResult:
        try:
            timeout = min(
                _optional_int(call.args.get("timeout_seconds")) or caps.shell_timeout_seconds,
                caps.shell_timeout_seconds,
            )
            command = str(call.args["command"])
            result = workspace.run_shell(
                command,
                cwd=str(call.args["cwd"]) if call.args.get("cwd") is not None else None,
                timeout_seconds=timeout,
                output_bytes=caps.shell_output_bytes,
            )
            return ToolResult(
                result.ok,
                result.render(),
                {
                    "exit_code": result.exit_code,
                    "timed_out": result.timed_out,
                    "truncated": result.truncated,
                    "destructive": shell_requires_confirmation(command),
                },
            )
        except WorkspaceError as error:
            return ToolResult(
                False, f"run_shell REJECTED: {error}", {"error": type(error).__name__}
            )

    def install_package(call: ToolCall) -> ToolResult:
        package = str(call.args["package"]).strip()
        if not package or any(ch.isspace() for ch in package):
            return ToolResult(False, "install_package REJECTED: package must be a single token")
        manager = str(call.args.get("manager") or "npm")
        dev = bool(call.args.get("dev", False))
        command = _install_command(manager, package, dev=dev)
        return run_shell(
            ToolCall(
                tool="run_shell",
                args={"command": command, "timeout_seconds": caps.shell_timeout_seconds},
                call_id=call.call_id,
            )
        )

    def start_dev_server(call: ToolCall) -> ToolResult:
        command = str(call.args.get("command") or "npm run dev").strip()
        if not command:
            return ToolResult(False, "start_dev_server REJECTED: command is empty")
        log_path = str(call.args.get("log_path") or "/tmp/loopit-dev-server.log")
        cwd = str(call.args["cwd"]) if call.args.get("cwd") is not None else None
        # Detach so the lease stays usable; logs are tailed via read_logs.
        wrapped = (
            f"( {command} ) > {shlex_quote(log_path)} 2>&1 & echo $! > "
            f"{shlex_quote(log_path)}.pid; echo started pid=$(cat {shlex_quote(log_path)}.pid)"
        )
        return run_shell(
            ToolCall(
                tool="run_shell",
                args={
                    "command": wrapped,
                    "cwd": cwd,
                    "timeout_seconds": 30,
                },
                call_id=call.call_id,
            )
        )

    def read_logs(call: ToolCall) -> ToolResult:
        path = str(call.args.get("path") or "/tmp/loopit-dev-server.log")
        lines = _optional_int(call.args.get("lines")) or 200
        command = f"tail -n {lines} -- {shlex_quote(path)} 2>&1 || echo '(no log yet)'"
        return run_shell(
            ToolCall(
                tool="run_shell",
                args={"command": command, "timeout_seconds": 30},
                call_id=call.call_id,
            )
        )

    def browser(call: ToolCall) -> ToolResult:
        result = workspace.browser_action(call.args)
        return ToolResult(result.ok, result.output, result.detail)

    def provision_handler(call: ToolCall) -> ToolResult:
        if migration_runner is None:
            return ToolResult(
                False,
                "provision REJECTED: no migration runner configured",
                {"error": "NotConfigured"},
            )
        outcome = provision(call.args, run_migration=migration_runner)
        return ToolResult(outcome.ok, outcome.output, outcome.detail)

    def deploy(call: ToolCall) -> ToolResult:
        if deploy_runner is None:
            return ToolResult(
                False, "deploy REJECTED: no deploy runner configured", {"error": "NotConfigured"}
            )
        return deploy_runner(call.args)

    def request_secret(call: ToolCall) -> ToolResult:
        if secret_requester is None:
            return ToolResult(
                False,
                "request_secret REJECTED: secrets UI is not configured",
                {"error": "NotConfigured"},
            )
        return secret_requester(call.args)

    handlers: dict[str, ToolHandler] = {
        "read_file": read_file,
        "search_code": search_code,
        "apply_patch": apply_patch,
        "run_shell": run_shell,
        "install_package": install_package,
        "start_dev_server": start_dev_server,
        "read_logs": read_logs,
        "browser": browser,
        "provision": provision_handler,
        "deploy": deploy,
        "request_secret": request_secret,
    }
    return ToolRegistry(
        handlers,
        limits=caps,
        audit=audit,
        audit_context=audit_context,
        approved_gates=approved_gates,
        run_id=audit_context.run_id if audit_context is not None else "local",
    )


def shlex_quote(value: str) -> str:
    """Single-quote a shell token without importing shlex at module import time."""
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _install_command(manager: str, package: str, *, dev: bool) -> str:
    quoted = shlex_quote(package)
    if manager == "pnpm":
        flag = " --save-dev" if dev else ""
        return f"pnpm add{flag} {quoted}"
    if manager == "yarn":
        flag = " --dev" if dev else ""
        return f"yarn add{flag} {quoted}"
    if manager == "pip":
        return f"pip install {quoted}"
    if manager == "uv":
        return f"uv pip install {quoted}"
    flag = " --save-dev" if dev else ""
    return f"npm install{flag} {quoted}"


def _optional_int(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise TypeError("boolean is not a valid integer value")
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value)
    raise TypeError(f"expected integer-compatible value, got {type(value).__name__}")
