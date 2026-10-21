"""Verification levels and checks (Doc 04 §4, P1-7).

Verification is layered so that cheap gates guard expensive ones. A typecheck
costs a second; a browser run costs a minute and a sandbox. Running the
expensive layer against code that does not compile spends both and learns
nothing that the cheap layer already said.

The order is fixed and the pipeline stops at the first level that fails:

* **L0 — static.** Typecheck, lint, format. Seconds. Catches most of what a
  model actually gets wrong.
* **L1 — tests.** Unit then integration. Catches behavioural regressions.
* **L2 — runtime.** The app boots and the browser reaches it. Catches wiring
  that compiles and passes tests but does not run.

Each level's failure output becomes the next planning observation, which is why
:class:`CheckResult` keeps the command's own words rather than a summary — the
compiler's message is more useful to the model than any paraphrase of it.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum

from .runner import MAX_CAPTURED_CHARS, CommandOutput, CommandRunner


class Level(IntEnum):
    """Verification tiers, ordered cheapest-first.

    An ``IntEnum`` so levels compare and sort naturally; the numeric order *is*
    the execution order, and nothing may reorder it at runtime.
    """

    L0_STATIC = 0
    L1_TESTS = 1
    L2_RUNTIME = 2


@dataclass(frozen=True, slots=True)
class Check:
    """One verification command.

    Attributes:
        blocking: whether a failure fails the level. A non-blocking check
            reports but does not stop the run — used for advisory signals that
            are not yet trustworthy enough to gate on.
        timeout_seconds: mandatory. An unbounded verification command is how a
            hung test suite consumes a sandbox's whole wall-clock budget.
    """

    name: str
    level: Level
    command: tuple[str, ...]
    timeout_seconds: int = 300
    blocking: bool = True

    def __post_init__(self) -> None:
        if not self.command:
            raise ValueError(f"check {self.name!r} has no command")
        if self.timeout_seconds <= 0:
            raise ValueError(f"check {self.name!r} needs a positive timeout")


@dataclass(frozen=True, slots=True)
class CheckResult:
    """The outcome of running one check."""

    check: Check
    output: CommandOutput

    @property
    def name(self) -> str:
        return self.check.name

    @property
    def level(self) -> Level:
        return self.check.level

    @property
    def passed(self) -> bool:
        return self.output.ok

    @property
    def blocking_failure(self) -> bool:
        return not self.passed and self.check.blocking

    def observation(self, limit: int = MAX_CAPTURED_CHARS) -> str:
        """What the agent is told about this check.

        Reports the tool's own output verbatim. A summarised failure loses the
        file, line and symbol that make the fix mechanical.
        """
        if self.passed:
            return f"{self.name}: passed"
        if self.output.timed_out:
            return (
                f"{self.name}: timed out after {self.check.timeout_seconds}s. "
                "The command did not finish; suspect an infinite loop, a watch mode, "
                "or a process waiting on input."
            )
        return (
            f"{self.name}: failed (exit {self.output.exit_code})\n"
            f"$ {' '.join(self.check.command)}\n"
            f"{self.output.combined(limit)}"
        )


def run_check(check: Check, runner: CommandRunner) -> CheckResult:
    """Execute one check through the runner."""
    return CheckResult(
        check=check, output=runner.run(check.command, timeout_seconds=check.timeout_seconds)
    )
