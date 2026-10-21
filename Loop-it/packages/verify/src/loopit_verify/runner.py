"""Running verification commands inside a sandbox.

The pipeline never shells out itself. It hands commands to a runner, so the same
pipeline drives a real sandbox in production and a scripted double in tests —
and, more importantly, so verification cannot become a second, unaudited path
for executing agent-influenced commands.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

#: How much of a command's output is kept. Build logs run to megabytes; feeding
#: one to a model burns the context window that the fix itself needs.
MAX_CAPTURED_CHARS = 8000


@dataclass(frozen=True, slots=True)
class CommandOutput:
    """What one verification command produced."""

    exit_code: int
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out

    def combined(self, limit: int = MAX_CAPTURED_CHARS) -> str:
        """stdout and stderr, tail-truncated to ``limit`` characters.

        Truncation keeps the *tail*: compilers and test runners print the
        summary last, and the summary is the part that says what broke.
        """
        text = "\n".join(part for part in (self.stdout, self.stderr) if part).strip()
        if len(text) <= limit:
            return text
        omitted = len(text) - limit
        return f"[... {omitted} characters omitted ...]\n{text[-limit:]}"


@runtime_checkable
class CommandRunner(Protocol):
    """Executes a verification command in the project's sandbox."""

    def run(self, command: tuple[str, ...], *, timeout_seconds: int) -> CommandOutput: ...


class ScriptedRunner:
    """A runner driven by a fixed script, for tests and dry runs.

    Any command without a scripted result fails loudly rather than defaulting to
    success. A verification double that silently passes is how a green pipeline
    stops meaning anything.
    """

    def __init__(self, results: dict[str, CommandOutput] | None = None) -> None:
        self._results = results or {}
        self.calls: list[tuple[str, ...]] = []

    def run(self, command: tuple[str, ...], *, timeout_seconds: int) -> CommandOutput:
        self.calls.append(command)
        key = " ".join(command)
        if key not in self._results:
            return CommandOutput(
                exit_code=127,
                stderr=f"ScriptedRunner has no result for {key!r}",
            )
        return self._results[key]

    def set(self, command: str, output: CommandOutput) -> None:
        self._results[command] = output
