"""Declarative rule set used by the pure-Python evaluator.

The data structures here are deliberately simple and JSON-exportable so the same
rules can later be emitted as Rego without changing callers.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, replace
from typing import Any


@dataclass(frozen=True, slots=True)
class PatternRule:
    name: str
    pattern: str
    reversibility: str
    destructiveness: str
    gate: str
    reason: str


@dataclass(frozen=True, slots=True)
class DomainCategory:
    name: str
    domains: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AnalyzerRule:
    name: str
    pattern: str
    severity: str
    reason: str


@dataclass(frozen=True, slots=True)
class RuleSet:
    action_rules: tuple[PatternRule, ...]
    shell_safe_patterns: tuple[str, ...]
    domain_categories: tuple[DomainCategory, ...]
    analyzer_rules: tuple[AnalyzerRule, ...]
    failure_markers: dict[str, tuple[str, ...]]
    # Builder preset: relative cat/tee heredoc writes and `python file.py` are
    # auto-approved. Strict keeps the read-only/verify allowlist only.
    allow_builder_local_writes: bool = False


DEFAULT_RULE_SET = RuleSet(
    action_rules=(
        PatternRule(
            "recursive-delete",
            r"(^|[;&|()\s])rm\s+[^\n;&|]*-[^\n;&|]*r|(^|[;&|()\s])Remove-Item\b[^\n;&|]*(-Recurse|-Force)",
            "irreversible",
            "destructive",
            "human_confirm",
            "recursive delete can remove project or production data",
        ),
        PatternRule(
            "force-push",
            r"(^|[;&|()\s])git\s+push\b[^\n;&|]*(--force|-f|--mirror|\+)",
            "irreversible",
            "destructive",
            "human_confirm",
            "force push rewrites remote history",
        ),
        PatternRule(
            "external-git-push",
            r"(^|[;&|()\s])git\s+push\b",
            "irreversible",
            "destructive",
            "human_confirm",
            "git push writes to an external system",
        ),
        PatternRule(
            "drop-or-truncate-sql",
            r"\b(drop\s+(database|schema|table)|truncate\s+(table\s+)?)\b",
            "irreversible",
            "destructive",
            "human_confirm",
            "DROP/TRUNCATE can destroy persisted data",
        ),
        PatternRule(
            "migration",
            r"\b(alembic\s+upgrade|prisma\s+migrate\s+deploy|supabase\s+db\s+push|migrate\s+(deploy|up|apply))\b",
            "irreversible",
            "destructive",
            "human_confirm",
            "migration can alter live schema or data",
        ),
        PatternRule(
            "deploy-or-promote",
            r"\b(deploy|promote|terraform\s+apply|kubectl\s+apply)\b",
            "irreversible",
            "destructive",
            "human_confirm",
            "deploy/promote changes a live environment",
        ),
        PatternRule(
            "secret-operation",
            r"\b(secret|credential|token|key)\b.*\b(rotate|revoke|delete|destroy|set|put|write)\b|\b(rotate|revoke|delete|destroy|set|put|write)\b.*\b(secret|credential|token|key)\b",
            "irreversible",
            "destructive",
            "human_confirm",
            "secret mutation or rotation needs an approval gate",
        ),
        PatternRule(
            "spend",
            r"\b(stripe|charge|purchase|buy|spend|provision|create\s+(gpu|instance|cluster|database|bucket|volume))\b",
            "irreversible",
            "destructive",
            "human_confirm",
            "action can spend money or allocate billable resources",
        ),
        PatternRule(
            "external-http-write",
            r"\b(curl|http|wget)\b[^\n]*(\s-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|--data|-d\s)",
            "irreversible",
            "destructive",
            "human_confirm",
            "HTTP write mutates an external service",
        ),
        PatternRule(
            "package-publish",
            r"\b(npm|pnpm|yarn)\s+publish\b|\b(twine|uv)\s+publish\b|\bcargo\s+publish\b",
            "irreversible",
            "destructive",
            "human_confirm",
            "package publish is externally visible and hard to undo",
        ),
    ),
    # Allowlist posture for ungated shell execution: local build/test/install
    # and read-only inspection shapes only. The builder preset additionally
    # auto-approves relative cat/tee heredoc writes and `python file.py`.
    # Unknown shells fail closed to a human confirmation gate instead of
    # trying to blacklist every evasion.
    shell_safe_patterns=(
        r"^\s*(uv|pnpm|npm|yarn)\s+((run\s+)?(test|pytest|ruff|mypy|lint|typecheck|build|check|format)(\s+[\w.:\-*/\\=]+)*|(install|sync)(\s+[\w.\-*/\\=]+)*)\s*$",
        r"^\s*uv\s+run\s+python\s+(scripts/check_invariants\.py|packages/contracts/validate_schemas\.py)\s*$",
        r"^\s*(pytest|ruff|mypy)(\s+[\w.:\-*/\\=]+)*\s*$",
        r"^\s*python\s+(-m\s+(pytest|ruff|mypy|compileall)(\s+[\w.:\-*/\\=]+)*|--version|-V)\s*$",
        r"^\s*(node|go)\s+(--version|version|test(\s+[\w.:\-*/\\=]+)*)\s*$",
        r"^\s*git\s+(status|diff|show|log)(\s+[\w.:\-*/\\=]+)*\s*$",
        r"^\s*(Get-ChildItem|Select-String)(\s+[\w.:\-*/\\=]+)*\s*$",
    ),
    domain_categories=(
        DomainCategory(
            "package_registries",
            (
                "registry.npmjs.org",
                "registry.yarnpkg.com",
                "pypi.org",
                "files.pythonhosted.org",
                "crates.io",
                "static.crates.io",
                "proxy.golang.org",
                "sum.golang.org",
                "deb.debian.org",
                "security.debian.org",
                "archive.ubuntu.com",
                "ports.ubuntu.com",
                "registry-1.docker.io",
                "auth.docker.io",
                "production.cloudflare.docker.com",
                "playwright.azureedge.net",
                "cdn.playwright.dev",
            ),
        ),
        DomainCategory(
            "deploy_targets",
            (
                "github.com",
                "api.github.com",
                "gitlab.com",
                "api.vercel.com",
                "api.fly.io",
                "backboard.railway.app",
                "api.cloudflare.com",
            ),
        ),
        DomainCategory("model_router", ()),
        DomainCategory("app_apis", ()),
    ),
    analyzer_rules=(
        AnalyzerRule(
            "chmod-777",
            r"\bchmod\s+777\b",
            "high",
            "world-writable permissions are unsafe",
        ),
        AnalyzerRule(
            "curl-pipe-shell",
            r"\b(curl|wget)\b[^\n|;]*[|]\s*(sh|bash|zsh|pwsh|powershell)\b",
            "high",
            "downloaded script is piped directly to a shell",
        ),
        AnalyzerRule(
            "base64-exec",
            r"\bbase64\b[^\n|;]*(-d|--decode)[^\n|;]*[|]\s*(sh|bash|python|node|pwsh|powershell)\b|\b(eval|exec)\b[^\n]*(base64|frombase64string)",
            "critical",
            "base64-decoded content is executed",
        ),
        AnalyzerRule(
            "disable-rls",
            r"\balter\s+table\b[^\n;]*\bdisable\s+row\s+level\s+security\b|\bdisable\s+rls\b",
            "critical",
            "disabling RLS violates generated-app tenant isolation",
        ),
    ),
    failure_markers={
        "transient": ("timeout", "temporarily unavailable", "connection reset", "rate limit"),
        "verification": ("assertionerror", "test failed", "typecheck", "lint failed"),
        "budget": ("budget", "quota", "credits exhausted", "insufficient funds"),
        "merge_conflict": ("merge conflict", "conflict marker", "non-fast-forward"),
        "gate_rejected": ("gate rejected", "approval denied", "human rejected"),
    },
    allow_builder_local_writes=True,
)

STRICT_RULE_SET = replace(DEFAULT_RULE_SET, allow_builder_local_writes=False)
BUILDER_RULE_SET = DEFAULT_RULE_SET

_PRESET_ALIASES = {
    "builder": BUILDER_RULE_SET,
    "default": BUILDER_RULE_SET,
    "strict": STRICT_RULE_SET,
    "fail-closed": STRICT_RULE_SET,
}


def rule_set_for_preset(name: str | None = None) -> RuleSet:
    """Return the rule set for ``LOOPIT_GATE_PRESET`` (default ``builder``).

    Unknown names fail closed to the strict allowlist rather than opening extra
    auto-approvals.
    """
    raw = name if name is not None else os.environ.get("LOOPIT_GATE_PRESET")
    key = (raw or "builder").strip().lower()
    return _PRESET_ALIASES.get(key, STRICT_RULE_SET)


def rule_set_as_dict(rule_set: RuleSet = DEFAULT_RULE_SET) -> dict[str, Any]:
    """Return a JSON-serialisable representation of ``rule_set``."""
    return asdict(rule_set)
