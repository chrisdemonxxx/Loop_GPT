"""Layered verification (Doc 04 §4, P1-7).

Verification is what separates an agent that produces plausible code from one
that produces working code. It is organised in levels so that cheap gates guard
expensive ones — typecheck before tests, tests before a browser run — and the
pipeline stops at the first level that fails.

Stopping early is not just a cost optimisation. The failure output becomes the
agent's next observation, and one typecheck error is a far better prompt than a
typecheck error buried under forty cascading test failures.
"""

from .checks import Check, CheckResult, Level, run_check
from .flow_gate import REQUIRED_FLOWS, FlowGateError, FlowGateReport
from .flow_gate import evaluate as evaluate_flows
from .pipeline import VerificationPipeline, VerificationReport
from .presets import node_typescript_checks, python_checks, smoke_check
from .reflection import DEFAULT_TRIGGER_TOOLS, verdict_from_report, verification_hook
from .runner import MAX_CAPTURED_CHARS, CommandOutput, CommandRunner, ScriptedRunner
from .sast import (
    REDACTED,
    Action,
    Finding,
    Gate,
    SastParseError,
    SastReport,
    Severity,
    Stage,
    action_for,
    classify,
    collect,
    parse_gitleaks,
    parse_npm_audit,
    parse_semgrep,
    security_checks,
)

__all__ = [
    "DEFAULT_TRIGGER_TOOLS",
    "MAX_CAPTURED_CHARS",
    "REDACTED",
    "REQUIRED_FLOWS",
    "Action",
    "Check",
    "CheckResult",
    "CommandOutput",
    "CommandRunner",
    "Finding",
    "FlowGateError",
    "FlowGateReport",
    "Gate",
    "Level",
    "SastParseError",
    "SastReport",
    "ScriptedRunner",
    "Severity",
    "Stage",
    "VerificationPipeline",
    "VerificationReport",
    "action_for",
    "classify",
    "collect",
    "evaluate_flows",
    "node_typescript_checks",
    "parse_gitleaks",
    "parse_npm_audit",
    "parse_semgrep",
    "python_checks",
    "run_check",
    "security_checks",
    "smoke_check",
    "verdict_from_report",
    "verification_hook",
]
