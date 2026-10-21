"""Verification layer L2.5 — the security pass on generated apps (Doc 08 §4).

The model writes the app; the platform must not ship its vulnerabilities to real
end users. This layer is the automated security gate that stands between a build
that passes its tests and a build that is allowed to be shown as green or
deployed (ADR-0015).

Three things here are not obvious.

**Severity alone does not decide the action — the gate does.** The findings
policy is deliberately asymmetric: a High finding *warns* during iteration but
*blocks* at deploy. Blocking a build on every High would stall the loop on
findings the agent could fix on its next pass anyway; letting one reach
production would not. So :func:`action_for` takes both a severity and the gate
being evaluated, and there is no single "is this blocking?" answer.

**A secret finding is Critical regardless of what the scanner called it.** Doc 08
stage 1 says block on any hit. Scanners rank secrets by confidence, which is a
useful signal for triage and a terrible one for a gate.

**Findings are redacted before they become observations.** A finding travels into
the model's context and into the audit log. Echoing the matched secret there
would copy the leaked credential into two more places, which is the opposite of
what the scan is for.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from enum import Enum, IntEnum
from typing import Any, Final

from .checks import Check, Level


class Severity(IntEnum):
    """Finding severity, ordered so comparisons read naturally."""

    LOW = 0
    MEDIUM = 1
    HIGH = 2
    CRITICAL = 3


class Gate(Enum):
    """Where a findings policy is being applied.

    The same finding is treated differently at each: iteration tolerates risk
    that shipping does not.
    """

    BUILD = "build"
    DEPLOY = "deploy"


class Action(Enum):
    """What a finding does to the gate it is evaluated at."""

    BLOCK = "block"
    WARN = "warn"


class Stage(IntEnum):
    """Analyzer stages, in the order Doc 08 §4 runs them (cheapest first)."""

    SECRETS = 0
    DEPENDENCIES = 1
    SAST = 2
    CONFIG = 3
    CLIENT_SECRETS = 4


#: Stages whose findings are always Critical. Doc 08 stage 1 and stage 5 both say
#: block on any hit, so the scanner's own confidence ranking is not consulted.
_ALWAYS_CRITICAL: Final[frozenset[Stage]] = frozenset({Stage.SECRETS, Stage.CLIENT_SECRETS})

#: Rule-id fragments that promote a finding to Critical whatever the scanner said.
#: These are the classes Doc 08 names as hard blocks; a scanner that rates SQL
#: injection as a warning is still describing a hard block.
_CRITICAL_RULE_FRAGMENTS: Final[tuple[str, ...]] = (
    "sql-injection",
    "sqli",
    "tainted-sql",
    "sql_injection",
    "auth-bypass",
    "authz-bypass",
    "missing-auth",
    "hardcoded-secret",
    "hardcoded-credential",
    "jwt-none-alg",
    "jwt-decode-without-verify",
    "rls-disabled",
    "row-level-security",
)

#: Placeholder substituted for any matched secret before a finding is rendered.
REDACTED: Final = "[redacted]"


@dataclass(frozen=True, slots=True)
class Finding:
    """One security finding, normalised across scanners."""

    rule_id: str
    severity: Severity
    stage: Stage
    message: str
    path: str | None = None
    line: int | None = None

    def action(self, gate: Gate) -> Action:
        return action_for(self.severity, gate)

    def render(self) -> str:
        location = self.path or "<project>"
        if self.line is not None:
            location = f"{location}:{self.line}"
        return f"[{self.severity.name}] {location} {self.rule_id}: {self.message}"


def action_for(severity: Severity, gate: Gate) -> Action:
    """Apply the Doc 08 §4 findings policy.

    Critical always blocks. High blocks at deploy and warns during build, which
    is the asymmetry the policy table encodes. Medium and Low never block.
    """
    if severity is Severity.CRITICAL:
        return Action.BLOCK
    if severity is Severity.HIGH and gate is Gate.DEPLOY:
        return Action.BLOCK
    return Action.WARN


def classify(rule_id: str, reported: Severity, stage: Stage) -> Severity:
    """Decide a finding's real severity from its stage and rule."""
    if stage in _ALWAYS_CRITICAL:
        return Severity.CRITICAL
    lowered = rule_id.lower()
    if any(fragment in lowered for fragment in _CRITICAL_RULE_FRAGMENTS):
        return Severity.CRITICAL
    return reported


@dataclass(frozen=True, slots=True)
class SastReport:
    """The outcome of the L2.5 pass."""

    findings: tuple[Finding, ...]

    def blocking(self, gate: Gate) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.action(gate) is Action.BLOCK)

    def warnings(self, gate: Gate) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.action(gate) is Action.WARN)

    def passed(self, gate: Gate) -> bool:
        return not self.blocking(gate)

    def observation(self, gate: Gate, *, limit: int = 40) -> str:
        """What the agent is told. Blocking findings first, and never truncated
        away — a Critical finding hidden behind forty Medium ones is a Critical
        finding nobody fixes.
        """
        blocking = self.blocking(gate)
        warnings = self.warnings(gate)
        if not blocking and not warnings:
            return f"security scan ({gate.value}): passed, no findings"

        lines = [
            f"security scan ({gate.value}): {len(blocking)} blocking, {len(warnings)} advisory"
        ]
        if blocking:
            lines.append("\nMUST FIX before this change is accepted:")
            lines.extend(f"  {f.render()}" for f in blocking)
        if warnings:
            remaining = max(limit - len(blocking), 0)
            shown = warnings[:remaining]
            if shown:
                lines.append("\nAdvisory (not blocking):")
                lines.extend(f"  {f.render()}" for f in shown)
            if len(warnings) > len(shown):
                lines.append(f"  ... and {len(warnings) - len(shown)} more advisory findings")
        return "\n".join(lines)


def _as_mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _loads(payload: str) -> Any:
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        # A scanner that crashed or printed a banner must not be read as
        # "no findings" — that would turn a broken gate into a passing one.
        raise SastParseError("scanner output was not valid JSON") from None


class SastParseError(ValueError):
    """A scanner's output could not be read.

    Raised rather than returning an empty report, because an unreadable scan and
    a clean scan must never be indistinguishable.
    """


_SEMGREP_SEVERITY: Final[Mapping[str, Severity]] = {
    "ERROR": Severity.HIGH,
    "WARNING": Severity.MEDIUM,
    "INFO": Severity.LOW,
}


def parse_semgrep(payload: str) -> tuple[Finding, ...]:
    """Parse ``semgrep --json`` output."""
    document = _as_mapping(_loads(payload))
    findings: list[Finding] = []
    for raw in document.get("results", []):
        result = _as_mapping(raw)
        extra = _as_mapping(result.get("extra"))
        rule_id = str(result.get("check_id", "semgrep.unknown"))
        reported = _SEMGREP_SEVERITY.get(str(extra.get("severity", "WARNING")), Severity.MEDIUM)
        start = _as_mapping(result.get("start"))
        line = start.get("line")
        findings.append(
            Finding(
                rule_id=rule_id,
                severity=classify(rule_id, reported, Stage.SAST),
                stage=Stage.SAST,
                message=str(extra.get("message", "")).strip() or "no message",
                path=str(result.get("path")) if result.get("path") else None,
                line=int(line) if isinstance(line, int) else None,
            )
        )
    return tuple(findings)


def parse_gitleaks(payload: str) -> tuple[Finding, ...]:
    """Parse ``gitleaks detect --report-format json`` output.

    The matched secret is dropped, never rendered. A finding ends up in the
    model's context and the audit log; copying the credential into both is the
    opposite of what the scan is for.
    """
    document = _loads(payload)
    if document is None:
        return ()
    if not isinstance(document, list):
        raise SastParseError("gitleaks report was not a JSON array")

    findings: list[Finding] = []
    for raw in document:
        entry = _as_mapping(raw)
        rule_id = str(entry.get("RuleID", "gitleaks.unknown"))
        line = entry.get("StartLine")
        findings.append(
            Finding(
                rule_id=rule_id,
                # Stage.SECRETS is always Critical: block on any hit.
                severity=classify(rule_id, Severity.CRITICAL, Stage.SECRETS),
                stage=Stage.SECRETS,
                message=f"{entry.get('Description', 'secret detected')} ({REDACTED})",
                path=str(entry.get("File")) if entry.get("File") else None,
                line=int(line) if isinstance(line, int) else None,
            )
        )
    return tuple(findings)


_NPM_SEVERITY: Final[Mapping[str, Severity]] = {
    "critical": Severity.HIGH,
    "high": Severity.HIGH,
    "moderate": Severity.MEDIUM,
    "low": Severity.LOW,
    "info": Severity.LOW,
}


def parse_npm_audit(payload: str) -> tuple[Finding, ...]:
    """Parse ``npm audit --json`` output.

    npm's "critical" is mapped to :attr:`Severity.HIGH`, not Critical. Doc 08
    reserves Critical for findings in the code the agent just wrote; a
    vulnerable transitive dependency is serious but blocks deploy rather than
    every build, and treating it as Critical would let any upstream CVE
    disclosure freeze every project on the platform mid-iteration.
    """
    document = _as_mapping(_loads(payload))
    vulnerabilities = _as_mapping(document.get("vulnerabilities"))

    findings: list[Finding] = []
    for name, raw in vulnerabilities.items():
        entry = _as_mapping(raw)
        reported = _NPM_SEVERITY.get(str(entry.get("severity", "low")), Severity.LOW)
        rule_id = f"npm-audit/{name}"
        findings.append(
            Finding(
                rule_id=rule_id,
                severity=classify(rule_id, reported, Stage.DEPENDENCIES),
                stage=Stage.DEPENDENCIES,
                message=(
                    f"{name} {entry.get('range', '')}".strip()
                    + f" has a known {entry.get('severity', 'low')} vulnerability"
                ),
                path="package.json",
            )
        )
    return tuple(findings)


def collect(*groups: Iterable[Finding]) -> SastReport:
    """Merge findings from every stage into one report, worst first."""
    findings: list[Finding] = []
    for group in groups:
        findings.extend(group)
    findings.sort(key=lambda f: (-int(f.severity), int(f.stage), f.rule_id))
    return SastReport(findings=tuple(findings))


def security_checks(*, package_manager: str = "pnpm") -> tuple[Check, ...]:
    """The L2.5 commands, in Doc 08 §4 order.

    Ordered cheapest-first within the layer: the secret scan is seconds and
    blocks unconditionally, so it runs before the dependency audit and the
    full SAST pass.

    These are ``Level.L2_RUNTIME`` in the pipeline's terms because the pipeline
    stops at the first failing level and L2.5 is the gate immediately before
    deploy (ADR-0015).
    """
    pm = package_manager
    return (
        Check(
            name="secret-scan",
            level=Level.L2_RUNTIME,
            command=("gitleaks", "detect", "--no-git", "--report-format", "json", "--redact"),
            timeout_seconds=120,
        ),
        Check(
            name="dependency-audit",
            level=Level.L2_RUNTIME,
            command=(pm, "audit", "--json"),
            timeout_seconds=180,
            # Advisory at build time: an upstream CVE disclosure must not freeze
            # every project mid-iteration. The deploy gate re-evaluates it.
            blocking=False,
        ),
        Check(
            name="sast",
            level=Level.L2_RUNTIME,
            command=("semgrep", "--config", "p/owasp-top-ten", "--json", "--quiet"),
            timeout_seconds=300,
        ),
    )


__all__ = [
    "REDACTED",
    "Action",
    "Finding",
    "Gate",
    "SastParseError",
    "SastReport",
    "Severity",
    "Stage",
    "action_for",
    "classify",
    "collect",
    "parse_gitleaks",
    "parse_npm_audit",
    "parse_semgrep",
    "security_checks",
]
