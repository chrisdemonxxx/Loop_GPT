"""Fleet-level security metrics for the eval suite (P2-9, Doc 07 §5).

The Phase 2 exit gate is stated as a percentage: row-level security must be on
in **100% of generated schemas**. That is a measurement, and measurements can
lie in two specific ways that this module is built to prevent.

**An empty denominator is not 100%.** A run that provisioned no schemas at all
would compute ``0/0`` and, on any naive reading, report perfect coverage. It
would be a green dashboard describing a run that never exercised the thing being
measured. :class:`RlsCoverage` therefore distinguishes *measured and clean* from
*never measured*, and :func:`gate` fails on the latter whenever the tiers under
test are supposed to provision.

**Trusting the provisioner measures the guard, not the outcome.** If coverage
were computed from a flag the provisioning tool sets, the metric would only ever
confirm that a code path which structurally cannot omit RLS did not omit it.
That is circular. Coverage is computed by reading the emitted SQL, so a schema
that reached the database by any other route — a hand-written migration, a
future second provisioning path, an agent that found a way to run DDL — is
counted and fails the metric.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .suite import Tier

try:
    from loopit_provision import RlsCatalogVerifier
except ImportError:  # pragma: no cover - only for partial installs of the eval package
    RlsCatalogVerifier = object  # type: ignore[misc,assignment]

#: Tiers whose tasks are expected to create persistent, owned data.
#:
#: T0 edits existing code and T1 may be client-only, so neither is required to
#: produce a schema. T2 upward is where multi-user data appears, which is
#: exactly where an unmeasured run is dangerous.
PROVISIONING_TIERS: frozenset[Tier] = frozenset(("T2", "T3"))

_FORCE_RLS = re.compile(
    r"alter\s+table\s+([\"\w.]+)\s+force\s+row\s+level\s+security",
    re.IGNORECASE,
)
_TABLE_NAME = re.compile(
    r"create\s+table\s+(?:if\s+not\s+exists\s+)?([\"\w.]+)",
    re.IGNORECASE,
)


def _normalise(identifier: str) -> str:
    """Strip quoting and schema qualification so ``"public"."x"`` matches ``x``."""
    return identifier.replace('"', "").rsplit(".", 1)[-1].lower()


@dataclass(frozen=True, slots=True)
class RlsCoverage:
    """How many generated tables are actually protected.

    ``unprotected`` names the tables rather than counting them: a percentage
    tells an operator something is wrong, and a name tells them where.
    """

    tables: tuple[str, ...]
    unprotected: tuple[str, ...]

    @property
    def measured(self) -> bool:
        """Whether any schema was generated at all.

        The distinction :func:`gate` turns on. Without it, "no schemas" and
        "every schema protected" are the same number.
        """
        return bool(self.tables)

    @property
    def protected(self) -> int:
        return len(self.tables) - len(self.unprotected)

    @property
    def percentage(self) -> float | None:
        """``None`` when nothing was measured, never ``100.0``."""
        if not self.tables:
            return None
        return 100.0 * self.protected / len(self.tables)

    def to_dict(self) -> dict[str, Any]:
        return {
            "tables_generated": len(self.tables),
            "tables_protected": self.protected,
            "rls_coverage_percent": None if self.percentage is None else round(self.percentage, 2),
            "unprotected_tables": list(self.unprotected),
            "measured": self.measured,
        }


def measure_rls(migrations: Iterable[str]) -> RlsCoverage:
    """Read the SQL a run emitted and report coverage.

    Args:
        migrations: the SQL text of every migration the run applied.

    A table counts as protected only when ``FORCE ROW LEVEL SECURITY`` is
    present for it. Plain ``ENABLE`` is not enough: it exempts the table owner,
    and generated apps routinely connect as the role that owns their tables, so
    an ``ENABLE``-only table is unprotected in exactly the deployment shape the
    platform produces.
    """
    tables: list[str] = []
    forced: set[str] = set()

    for sql in migrations:
        for match in _TABLE_NAME.finditer(sql):
            tables.append(_normalise(match.group(1)))
        for match in _FORCE_RLS.finditer(sql):
            forced.add(_normalise(match.group(1)))

    seen: list[str] = []
    for table in tables:
        if table not in seen:
            seen.append(table)

    unprotected = tuple(table for table in seen if table not in forced)
    return RlsCoverage(tables=tuple(seen), unprotected=unprotected)


def measure_live_rls(verifier: RlsCatalogVerifier, *, schema: str) -> RlsCoverage:
    """Compute the exit metric from a post-provision catalog verifier.

    This is the non-circular P2 metric for live runs: the denominator and
    failures come from ``pg_class``/``pg_policies`` via the provision verifier,
    not from trusting the emitted migration text.
    """

    result = verifier.verify_schema(schema)
    return RlsCoverage(tables=result.tables, unprotected=result.unprotected)


@dataclass(frozen=True, slots=True)
class SecurityGateResult:
    """Whether a run's security metrics clear the Phase 2 exit gate."""

    coverage: RlsCoverage
    failures: tuple[str, ...]

    @property
    def passed(self) -> bool:
        return not self.failures

    def render(self) -> str:
        if self.passed:
            percent = self.coverage.percentage
            return f"Security metrics passed: RLS coverage {percent:.1f}% of generated tables."
        return "Security metrics FAILED:\n" + "\n".join(f"  - {f}" for f in self.failures)


def gate(coverage: RlsCoverage, *, tiers: Sequence[Tier]) -> SecurityGateResult:
    """Apply the Phase 2 exit gate to a coverage measurement.

    Args:
        coverage: what :func:`measure_rls` found.
        tiers: the tiers the run covered. Used to decide whether an unmeasured
            run is acceptable — for a T0-only run it is, because those tasks
            never provision.
    """
    failures: list[str] = []
    expects_schemas = bool(PROVISIONING_TIERS & set(tiers))

    if not coverage.measured:
        if expects_schemas:
            failures.append(
                "no schemas were generated, but the run covered "
                f"{', '.join(sorted(PROVISIONING_TIERS & set(tiers)))}, which provision data. "
                "RLS coverage is unmeasured, not clean."
            )
        return SecurityGateResult(coverage=coverage, failures=tuple(failures))

    if coverage.unprotected:
        failures.append(
            "tables generated without FORCE ROW LEVEL SECURITY: " + ", ".join(coverage.unprotected)
        )
    return SecurityGateResult(coverage=coverage, failures=tuple(failures))


def dashboard(coverage: RlsCoverage, *, tiers: Sequence[Tier]) -> Mapping[str, Any]:
    """The security block of the run's dashboard payload."""
    result = gate(coverage, tiers=tiers)
    return {
        "rls": coverage.to_dict(),
        "gate_passed": result.passed,
        "gate_failures": list(result.failures),
        "tiers": list(tiers),
    }


__all__ = [
    "PROVISIONING_TIERS",
    "RlsCoverage",
    "SecurityGateResult",
    "dashboard",
    "gate",
    "measure_live_rls",
    "measure_rls",
]
