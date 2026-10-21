"""Bridge PreviewVerifier + packages/verify pipeline (Phase 1.6).

Offline / local mode keeps the parse-only PreviewVerifier. When a sandbox
CommandRunner is available (orchestrator), layered L0–L2 checks run after a
successful patch. Runtime console errors collected from the preview bridge
fail verification when present.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from loopit_agent_core.reflection import VerificationVerdict
from loopit_agent_core.tools import ToolCall

from .stacks import REACT_POSTGRES_STACK, VITE_REACT_STACK, uses_sandbox_runtime
from .workspace import Workspace

try:
    from loopit_verify import (
        Check,
        CommandRunner,
        Level,
        VerificationPipeline,
        node_typescript_checks,
        security_checks,
        smoke_check,
        verdict_from_report,
    )

    _VERIFY_AVAILABLE = True
except ImportError:  # pragma: no cover - api image without verify wheel
    _VERIFY_AVAILABLE = False
    CommandRunner = Any  # type: ignore[misc, assignment]
    Check = Any  # type: ignore[misc, assignment]
    Level = Any  # type: ignore[misc, assignment]


#: Errors posted from the preview iframe bridge (and optional API ingest).
_CONSOLE_ERRORS: dict[str, list[str]] = {}


def record_console_error(project_id: str, message: str, *, limit: int = 50) -> None:
    """Remember a runtime console/network error for the next verification pass."""
    text = (message or "").strip()
    if not text or not project_id:
        return
    bucket = _CONSOLE_ERRORS.setdefault(project_id, [])
    bucket.append(text[:2000])
    del bucket[:-limit]


def drain_console_errors(project_id: str) -> list[str]:
    """Return and clear pending console errors for a project."""
    return list(_CONSOLE_ERRORS.pop(project_id, []))


def peek_console_errors(project_id: str) -> list[str]:
    return list(_CONSOLE_ERRORS.get(project_id, []))


def clear_console_errors(project_id: str) -> None:
    _CONSOLE_ERRORS.pop(project_id, None)


def checks_for_stack(stack: str, *, preview_url: str = "http://127.0.0.1:5173") -> tuple[Any, ...]:
    """L0/L1/L2(+SAST) checks tuned to the frozen templates (npm)."""
    if not _VERIFY_AVAILABLE:
        return ()
    if stack == VITE_REACT_STACK:
        base = list(node_typescript_checks(package_manager="npm"))
        # vite-react has no separate build script beyond `build`; keep pipeline.
        return tuple(base) + (smoke_check(preview_url),) + tuple(
            security_checks(package_manager="npm")
        )
    if stack == REACT_POSTGRES_STACK:
        return (
            Check(
                name="typecheck",
                level=Level.L0_STATIC,
                command=("npm", "run", "typecheck"),
                timeout_seconds=180,
            ),
            Check(
                name="unit-tests",
                level=Level.L1_TESTS,
                command=("npm", "run", "test"),
                timeout_seconds=600,
            ),
            smoke_check(preview_url),
            *security_checks(package_manager="npm"),
        )
    return ()


@dataclass
class PipelineVerifier:
    """Augments PreviewVerifier with pipeline levels + console errors.

    Flow after a patch has been applied and the agent re-reads:
    1. Static parse / reference checks (PreviewVerifier) — always, offline-safe.
    2. If a CommandRunner is set, run VerificationPipeline (stops at first fail).
    3. Pending console errors from the preview bridge fail the pass.
    """

    workspace: Workspace
    project_id: str
    stack: str
    preview_verifier: Any
    runner: CommandRunner | None = None
    max_level: Any = None
    _patched: bool = field(default=False, init=False)

    def __call__(self, call: ToolCall, observation: Any) -> VerificationVerdict | str | None:
        if call.tool == "apply_patch":
            # Keep the inner PreviewVerifier's patch latch in sync.
            self.preview_verifier(call, observation)
            content = getattr(observation, "content", "")
            if "apply_patch OK" in content:
                self._patched = True
            return None

        if call.tool == "run_shell":
            content = getattr(observation, "content", "")
            if "passed" in content and "failed" not in content:
                return "the test command reported a pass"
            return None

        if call.tool not in {"read_file", "search_code"} or not self._patched:
            return None

        # 1) Static / parse gate (always available offline).
        static = self.preview_verifier(call, observation)
        if isinstance(static, VerificationVerdict) and not static.verified:
            return static

        # 2) Real pipeline when a sandbox runner exists.
        if self.runner is not None and _VERIFY_AVAILABLE and uses_sandbox_runtime(self.stack):
            checks = checks_for_stack(self.stack)
            if checks:
                level = self.max_level if self.max_level is not None else Level.L2_RUNTIME
                pipeline = VerificationPipeline(
                    checks=checks, runner=self.runner, max_level=level
                )
                report = pipeline.run(project_id=self.project_id)
                if not report.passed:
                    return verdict_from_report(report)

        # 3) Runtime console / failed-fetch bridge.
        console = drain_console_errors(self.project_id)
        if console:
            body = "\n".join(f"- {line}" for line in console[:20])
            return VerificationVerdict(
                verified=False,
                summary="runtime console errors",
                observation=(
                    "Verification failed: the preview reported console/runtime errors.\n"
                    f"{body}\n"
                    "Fix these errors before declaring the app finished."
                ),
            )

        if isinstance(static, str):
            return static
        if isinstance(static, VerificationVerdict) and static.verified:
            return static
        return "the project parses and its files resolve"


def build_verifier(
    workspace: Workspace,
    *,
    project_id: str,
    stack: str,
    preview_verifier_factory: Callable[..., Any],
    runner: CommandRunner | None = None,
) -> Any:
    """Construct the verify hook for a run."""
    htm_rules = not uses_sandbox_runtime(stack)
    preview = preview_verifier_factory(workspace, htm_rules=htm_rules)
    # Always wrap so console errors from the preview bridge can fail a pass.
    return PipelineVerifier(
        workspace=workspace,
        project_id=project_id,
        stack=stack,
        preview_verifier=preview,
        runner=runner,
    )


__all__ = [
    "PipelineVerifier",
    "build_verifier",
    "checks_for_stack",
    "clear_console_errors",
    "drain_console_errors",
    "peek_console_errors",
    "record_console_error",
]
