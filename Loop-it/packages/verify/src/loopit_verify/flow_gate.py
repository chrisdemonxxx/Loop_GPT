"""The L2 critical-flow gate (P2-7).

The verification pipeline runs *commands*. Browser flows are different: they
produce a structured per-step result, and the interesting question is not only
"did it pass" but "did the right flows actually run".

That second question is the whole reason this module exists. The Phase 2 exit
gate is a working multi-user app in which one user cannot read another's data,
and the only check that proves it is the tenant-isolation flow. If that flow is
absent from a report — because the harness crashed, the driver was unavailable,
or someone trimmed the suite — a naive "all reported flows passed" reads green.
That is a report of safety nobody verified.

So the gate is stated the other way round: it names the flows that **must** be
present, and a report missing one is a failure, never a pass. Skipping is an
explicit, audited decision (:class:`FlowGate.skipped_reason`), not the default
that falls out of an empty list.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from loopit_sandbox_sdk.flows import FlowResult

#: Flows every project must pass before it can be deployed.
#:
#: Isolation is here rather than in the optional set because a multi-tenant app
#: that leaks rows is not a partially working app, it is a breach.
REQUIRED_FLOWS: frozenset[str] = frozenset(
    {
        "signup-login-create-readback",
        "tenant-isolation",
    }
)


class FlowGateError(Exception):
    """The gate could not reach a verdict."""


@dataclass(frozen=True, slots=True)
class FlowGateReport:
    """The verdict over one run's flows."""

    results: tuple[FlowResult, ...]
    missing: tuple[str, ...]

    @property
    def failed_flows(self) -> tuple[FlowResult, ...]:
        return tuple(result for result in self.results if not result.passed)

    @property
    def passed(self) -> bool:
        return not self.missing and not self.failed_flows

    def observation(self) -> str:
        """What the agent is told.

        Missing flows are reported before failing ones. A missing isolation flow
        is a harness problem, and telling the model to "fix the failing test"
        would send it editing application code that was never the cause.
        """
        if self.passed:
            names = ", ".join(result.flow for result in self.results)
            return f"Critical flows passed: {names}."

        lines: list[str] = []
        if self.missing:
            lines.append(
                "Critical flows did not run: "
                + ", ".join(self.missing)
                + ". This is a harness failure, not an application failure — "
                "the app cannot be deployed until these flows actually execute."
            )
        for result in self.failed_flows:
            lines.append(result.render())
        return "\n\n".join(lines)


def evaluate(
    results: Sequence[FlowResult], *, required: frozenset[str] = REQUIRED_FLOWS
) -> FlowGateReport:
    """Judge a set of flow results against the required set.

    Duplicate flow names are refused rather than deduplicated: two results for
    one flow means one of them is stale, and silently picking either could turn
    a real failure into a pass.
    """
    names = [result.flow for result in results]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise FlowGateError(f"more than one result for flow(s): {', '.join(duplicates)}")

    missing = tuple(sorted(required - set(names)))
    return FlowGateReport(results=tuple(results), missing=missing)


__all__ = [
    "REQUIRED_FLOWS",
    "FlowGateError",
    "FlowGateReport",
    "evaluate",
]
