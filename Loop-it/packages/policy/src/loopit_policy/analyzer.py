"""Security analyzer for proposed actions before execution."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any
from urllib.parse import urlparse

from .actions import ProposedAction, normalise_action
from .egress import EgressPolicy
from .rules import DEFAULT_RULE_SET, AnalyzerRule, RuleSet


class FindingSeverity(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass(frozen=True, slots=True)
class Finding:
    rule_id: str
    severity: FindingSeverity
    message: str
    action_index: int
    evidence: str


def analyze_proposed_actions(
    actions: Iterable[ProposedAction | Mapping[str, Any]],
    *,
    egress_policy: EgressPolicy | None = None,
    rule_set: RuleSet = DEFAULT_RULE_SET,
) -> list[Finding]:
    """Flag risky proposed actions without executing them."""
    findings: list[Finding] = []
    policy = egress_policy or EgressPolicy()

    for index, raw_action in enumerate(actions):
        action = normalise_action(raw_action)
        text = _action_text(action)
        lower = text.lower()

        for rule in rule_set.analyzer_rules:
            if re.search(rule.pattern, text, re.IGNORECASE):
                findings.append(_finding(rule, index, text))

        if _writes_secret_to_client_code(lower):
            findings.append(
                Finding(
                    "secret-in-client-code",
                    FindingSeverity.CRITICAL,
                    "secret-like value is written into generated client code",
                    index,
                    _clip(text),
                )
            )

        if _credential_exfil_host(text, policy):
            findings.append(
                Finding(
                    "credential-exfil",
                    FindingSeverity.CRITICAL,
                    "credential-like data is sent to a non-allowlisted host",
                    index,
                    _clip(text),
                )
            )

    return findings


def _finding(rule: AnalyzerRule, index: int, text: str) -> Finding:
    return Finding(rule.name, FindingSeverity(rule.severity), rule.reason, index, _clip(text))


def _action_text(action: ProposedAction) -> str:
    parts = [
        action.command or "",
        action.tool or "",
        action.host or "",
        action.method or "",
        " ".join(f"{key}={value}" for key, value in action.args.items()),
        " ".join(f"{key}={value}" for key, value in action.metadata.items()),
    ]
    return " ".join(parts).strip()


def _writes_secret_to_client_code(text: str) -> bool:
    client_path = re.search(
        r"\b(src|app|pages|components|public|client)[/\\][^\s]*\.(tsx?|jsx?)\b", text
    )
    secret_value = re.search(
        r"\b(secret|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[:=]",
        text,
        re.IGNORECASE,
    )
    public_env_secret = re.search(
        r"\b(VITE|NEXT_PUBLIC|PUBLIC)_[A-Z0-9_]*(SECRET|TOKEN|KEY)\b", text
    )
    return bool(client_path and (secret_value or public_env_secret))


def _credential_exfil_host(text: str, policy: EgressPolicy) -> bool:
    if not re.search(r"(?i)(secret|token|api[_-]?key|authorization|credential)", text):
        return False
    for host in _hosts_in_text(text):
        if not policy.evaluate(host).allowed:
            return True
    return False


def _hosts_in_text(text: str) -> list[str]:
    hosts: list[str] = []
    for match in re.finditer(r"https?://[^\s'\"<>]+", text):
        parsed = urlparse(match.group(0))
        if parsed.hostname is not None:
            hosts.append(parsed.hostname)
    return hosts


def _clip(value: str, limit: int = 240) -> str:
    return value if len(value) <= limit else f"{value[: limit - 1]}…"
