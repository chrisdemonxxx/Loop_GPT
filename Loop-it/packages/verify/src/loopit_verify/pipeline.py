"""The verification pipeline (P1-7) and its feedback into planning (P1-8).

Runs checks level by level, cheapest first, and stops at the first level with a
blocking failure. Stopping matters twice over: it saves the cost of the
expensive layers, and it keeps the feedback focused. An agent handed a
typecheck error, forty test failures and a browser trace at once will usually
chase the wrong one; handed just the typecheck error, it fixes it.

The report is the reflection loop's input. :meth:`VerificationReport.observation`
produces the text that becomes the next planning step's observation, which is
the whole mechanism by which a failed build turns into a corrected one.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from loopit_agent_core.audit import AuditEvent, AuditSink, redact

from .checks import Check, CheckResult, Level, run_check
from .runner import MAX_CAPTURED_CHARS, CommandRunner

SERVICE_NAME = "verify"


@dataclass(frozen=True, slots=True)
class VerificationReport:
    """Everything one verification pass learned."""

    results: tuple[CheckResult, ...]
    levels_run: tuple[Level, ...]
    stopped_at: Level | None = None

    @property
    def passed(self) -> bool:
        """Whether every blocking check that ran passed.

        Truncating the run with ``max_level`` still yields a pass, because that
        is a deliberate request for a fast inner loop. ``stopped_at`` being set
        means a *failure* cut the run short, which is never a pass.
        """
        return self.stopped_at is None and not any(r.blocking_failure for r in self.results)

    @property
    def failures(self) -> tuple[CheckResult, ...]:
        return tuple(r for r in self.results if not r.passed)

    @property
    def blocking_failures(self) -> tuple[CheckResult, ...]:
        return tuple(r for r in self.results if r.blocking_failure)

    def at_level(self, level: Level) -> tuple[CheckResult, ...]:
        return tuple(r for r in self.results if r.level is level)

    def observation(self, limit: int = MAX_CAPTURED_CHARS) -> str:
        """The agent-facing account of this pass.

        Reports only the level that failed. Everything downstream was never run,
        and inventing an opinion about it would be a fabricated observation.
        """
        if self.passed:
            names = ", ".join(r.name for r in self.results)
            return f"Verification passed. Checks run: {names or 'none'}."

        blocking = self.blocking_failures
        if not blocking:
            return "Verification passed with advisory warnings."

        level = blocking[0].level
        header = (
            f"Verification failed at {level.name}. "
            f"Later levels were not run, so fix this before looking further."
        )
        budget = max(limit // len(blocking), 500)
        body = "\n\n".join(redact(r.observation(budget)) for r in blocking)
        return f"{header}\n\n{body}"


@dataclass(slots=True)
class VerificationPipeline:
    """Runs checks in level order and stops at the first blocking failure.

    Args:
        checks: the full set. Order within a level is preserved; order between
            levels is imposed by :class:`Level`, not by the caller, so a
            misordered config cannot make an expensive check run first.
        runner: executes commands in the sandbox.
        audit: optional sink. Verification outcomes are audited because "the
            tests were green" is a claim the platform later has to stand behind.
        max_level: the highest level to attempt. Lets a fast inner loop run L0
            only, without maintaining a second pipeline definition.
    """

    checks: Sequence[Check]
    runner: CommandRunner
    audit: AuditSink | None = None
    max_level: Level = Level.L2_RUNTIME
    _by_level: dict[Level, list[Check]] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        names = [c.name for c in self.checks]
        duplicates = {n for n in names if names.count(n) > 1}
        if duplicates:
            raise ValueError(f"duplicate check names: {sorted(duplicates)}")

        grouped: dict[Level, list[Check]] = {}
        for check in self.checks:
            grouped.setdefault(check.level, []).append(check)
        self._by_level = grouped

    def run(
        self,
        *,
        tenant_id: str | None = None,
        run_id: str | None = None,
        project_id: str | None = None,
    ) -> VerificationReport:
        """Execute the pipeline."""
        results: list[CheckResult] = []
        levels_run: list[Level] = []
        stopped_at: Level | None = None

        for level in sorted(self._by_level):
            if level > self.max_level:
                break

            levels_run.append(level)
            level_results = [run_check(check, self.runner) for check in self._by_level[level]]
            results.extend(level_results)

            if any(r.blocking_failure for r in level_results):
                stopped_at = _next_level(sorted(self._by_level), level)
                break

        report = VerificationReport(
            results=tuple(results),
            levels_run=tuple(levels_run),
            stopped_at=stopped_at,
        )
        if self.audit is not None and tenant_id is not None:
            self._emit(report, tenant_id=tenant_id, run_id=run_id, project_id=project_id)
        return report

    def _emit(
        self,
        report: VerificationReport,
        *,
        tenant_id: str,
        run_id: str | None,
        project_id: str | None,
    ) -> None:
        assert self.audit is not None
        self.audit.emit(
            AuditEvent(
                type="verification.completed",
                tenant_id=tenant_id,
                actor_kind="service",
                actor_service=SERVICE_NAME,
                run_id=run_id,
                project_id=project_id,
                plane="control",
                outcome="success" if report.passed else "failure",
                detail={
                    "levels_run": [level.name for level in report.levels_run],
                    "stopped_at": report.stopped_at.name if report.stopped_at else None,
                    "checks": [
                        {
                            "name": r.name,
                            "level": r.level.name,
                            "passed": r.passed,
                            "exit_code": r.output.exit_code,
                            "duration_ms": r.output.duration_ms,
                        }
                        for r in report.results
                    ],
                },
            )
        )


def _next_level(levels: Iterable[Level], current: Level) -> Level | None:
    """The level that would have run next, or ``None`` if this was the last."""
    for level in levels:
        if level > current:
            return level
    return None
