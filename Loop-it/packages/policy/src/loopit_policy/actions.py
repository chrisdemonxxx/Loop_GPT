"""Destructiveness and reversibility classification for proposed actions."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, assert_never

from .rules import PatternRule, RuleSet, rule_set_for_preset


class ActionKind(StrEnum):
    TOOL_CALL = "tool_call"
    SHELL_COMMAND = "shell_command"
    FILE_OP = "file_op"
    DEPLOY = "deploy"
    PROVISION = "provision"
    SECRET_OP = "secret_op"  # noqa: S105 - action kind, not a credential.
    EXTERNAL_WRITE = "external_write"
    PACKAGE_PUBLISH = "package_publish"


class Reversibility(StrEnum):
    REVERSIBLE = "reversible"
    IRREVERSIBLE = "irreversible"


class Destructiveness(StrEnum):
    BENIGN = "benign"
    DESTRUCTIVE = "destructive"


class GateRequirement(StrEnum):
    NONE = "none"
    AUTO_APPROVE = "auto_approve"
    HUMAN_CONFIRM = "human_confirm"


@dataclass(frozen=True, slots=True)
class ProposedAction:
    """Normalised action description consumed by policy evaluators."""

    kind: ActionKind
    command: str | None = None
    tool: str | None = None
    args: Mapping[str, Any] = field(default_factory=dict)
    host: str | None = None
    method: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ActionVerdict:
    reversibility: Reversibility
    destructiveness: Destructiveness
    required_gate: GateRequirement
    reason: str
    rule: str | None = None


_READ_ONLY_TOOLS = frozenset({"read_file", "search_code", "browser"})
_WRITE_BUT_REVERSIBLE_TOOLS = frozenset({"apply_patch"})

# Relative workspace path: no leading /, ~, or `..` components.
_RELATIVE_PATH = r"(?:\./)?(?:[A-Za-z_][\w.\-]*)(?:/[A-Za-z_][\w.\-]*)*"
_HEREDOC_HEAD = re.compile(
    rf"""
    ^\s*
    (?P<tool>cat|tee)
    (?:
        \s+(?P<redir>>{{1,2}})\s+(?P<path1>{_RELATIVE_PATH})
        |
        \s+(?P<path2>{_RELATIVE_PATH})
    )
    \s+<<\s*-?\s*
    (?:
        '(?P<delim_sq>[A-Za-z_]\w*)'
        | \"(?P<delim_dq>[A-Za-z_]\w*)\"
        | (?P<delim_bare>[A-Za-z_]\w*)
    )
    \s*$
    """,
    re.VERBOSE,
)
_ANY_HEREDOC_HEAD = re.compile(r"^\s*(?:cat|tee)\b.*<<", re.IGNORECASE)
_PYTHON_RELATIVE_FILE = re.compile(rf"^\s*python3?\s+({_RELATIVE_PATH})(?:\s+[\w.\-/=]+)*\s*$")
# Models often append a success marker after a heredoc closer. That is not a
# second command with side effects; treating it as unknown was gating every
# `cat > index.html` write in the builder preset.
_HEREDOC_TRAILING_NOOP = re.compile(r"^\s*(?:echo\s+(?:done|ok|success)|true|:)\s*$")


def classify_action(
    action: ProposedAction | Mapping[str, Any],
    *,
    rule_set: RuleSet | None = None,
) -> ActionVerdict:
    """Classify an action before execution.

    Shell commands fail closed: if no destructive rule and no known-safe pattern
    matches, the command requires human confirmation. The builder gate preset
    auto-approves relative workspace file writes (cat/tee heredoc, python file)
    so live runs are not one-approval-per-iteration.
    """
    rules = rule_set_for_preset() if rule_set is None else rule_set
    proposed = normalise_action(action)

    if proposed.kind is ActionKind.TOOL_CALL:
        return _classify_tool_call(proposed, rules)
    if proposed.kind in {
        ActionKind.DEPLOY,
        ActionKind.PROVISION,
        ActionKind.SECRET_OP,
        ActionKind.EXTERNAL_WRITE,
        ActionKind.PACKAGE_PUBLISH,
    }:
        return _classify_explicit_effect(proposed)

    if proposed.kind is ActionKind.SHELL_COMMAND:
        command = proposed.command or ""
        if not command.strip():
            return _fail_closed("empty or unparseable action")
        return _classify_shell(command, rules)

    text = _action_text(proposed)
    if not text:
        return _fail_closed("empty or unparseable action")

    for rule in rules.action_rules:
        if re.search(rule.pattern, text, re.IGNORECASE):
            return _verdict_from_rule(rule)

    if proposed.kind is ActionKind.FILE_OP:
        operation = str(proposed.args.get("operation", "")).lower()
        if operation in {"delete", "unlink", "rmdir"}:
            return ActionVerdict(
                Reversibility.IRREVERSIBLE,
                Destructiveness.DESTRUCTIVE,
                GateRequirement.HUMAN_CONFIRM,
                "file deletion is destructive",
                "file-delete",
            )
        return ActionVerdict(
            Reversibility.REVERSIBLE,
            Destructiveness.BENIGN,
            GateRequirement.NONE,
            "local file operation can be reviewed as a patch",
            "file-op",
        )

    assert_never(proposed.kind)


def _classify_shell(command: str, rule_set: RuleSet) -> ActionVerdict:
    # Scan the invocation line only for heredocs so file *contents* (which may
    # mention deploy/secret/rm) do not trip destructive action rules.
    invocation = _shell_invocation_text(command)
    for rule in rule_set.action_rules:
        if re.search(rule.pattern, invocation, re.IGNORECASE):
            return _verdict_from_rule(rule)

    if _known_safe_shell(command, rule_set):
        return ActionVerdict(
            Reversibility.REVERSIBLE,
            Destructiveness.BENIGN,
            GateRequirement.NONE,
            "known read-only or local verification shell command",
            "safe-shell",
        )
    if rule_set.allow_builder_local_writes and _is_builder_local_write(command):
        return ActionVerdict(
            Reversibility.REVERSIBLE,
            Destructiveness.BENIGN,
            GateRequirement.AUTO_APPROVE,
            "relative workspace write is reviewable and reversible before deploy",
            "builder-local-write",
        )
    return _fail_closed("unknown shell command")


def _shell_invocation_text(command: str) -> str:
    first = command.splitlines()[0] if command else command
    if first and _ANY_HEREDOC_HEAD.search(first):
        return first
    return command


def _is_builder_local_write(command: str) -> bool:
    return _is_relative_python_file(command) or _is_relative_heredoc_write(command)


def _is_relative_python_file(command: str) -> bool:
    stripped = command.strip()
    if not stripped or "\n" in stripped:
        return False
    return _PYTHON_RELATIVE_FILE.fullmatch(stripped) is not None


def _is_relative_heredoc_write(command: str) -> bool:
    lines = command.splitlines()
    if not lines:
        return False
    match = _HEREDOC_HEAD.match(lines[0])
    if match is None:
        return False
    tool = match.group("tool")
    redir = match.group("redir")
    if tool == "cat" and redir not in {">", ">>"}:
        return False
    if tool == "tee" and redir:
        return False
    delim = match.group("delim_sq") or match.group("delim_dq") or match.group("delim_bare")
    if not delim:
        return False
    rest = lines[1:]
    closer_at: int | None = None
    for index, line in enumerate(rest):
        if line == delim or line.strip() == delim:
            closer_at = index
            break
    if closer_at is None:
        return False
    return all(_is_heredoc_trailing_noop(line) for line in rest[closer_at + 1 :])


def _is_heredoc_trailing_noop(line: str) -> bool:
    stripped = line.strip()
    return not stripped or _HEREDOC_TRAILING_NOOP.fullmatch(stripped) is not None


def _classify_explicit_effect(proposed: ProposedAction) -> ActionVerdict:
    reasons = {
        ActionKind.DEPLOY: "deploy changes a live environment",
        ActionKind.PROVISION: "provisioning can spend money or alter durable state",
        ActionKind.SECRET_OP: "secret mutation or rotation needs an approval gate",
        ActionKind.EXTERNAL_WRITE: "external write mutates a system outside the sandbox",
        ActionKind.PACKAGE_PUBLISH: "package publish is externally visible and hard to undo",
    }
    return ActionVerdict(
        Reversibility.IRREVERSIBLE,
        Destructiveness.DESTRUCTIVE,
        GateRequirement.HUMAN_CONFIRM,
        reasons[proposed.kind],
        proposed.kind.value,
    )


def normalise_action(action: ProposedAction | Mapping[str, Any]) -> ProposedAction:
    """Convert mapping/tool-call shaped input into :class:`ProposedAction`."""
    if isinstance(action, ProposedAction):
        return action

    kind_value = action.get("kind") or action.get("type")
    tool = action.get("tool")
    args_raw = action.get("args", {})
    args: Mapping[str, Any] = args_raw if isinstance(args_raw, Mapping) else {}

    if kind_value is None and tool is not None:
        kind_value = ActionKind.TOOL_CALL.value
    if kind_value is None and "command" in action:
        kind_value = ActionKind.SHELL_COMMAND.value

    try:
        kind = ActionKind(str(kind_value))
    except ValueError:
        kind = ActionKind.TOOL_CALL if tool is not None else ActionKind.SHELL_COMMAND

    command = action.get("command")
    if command is None and tool == "run_shell":
        command = args.get("command")

    return ProposedAction(
        kind=kind,
        command=str(command) if command is not None else None,
        tool=str(tool) if tool is not None else None,
        args=args,
        host=str(action["host"]) if action.get("host") is not None else None,
        method=str(action["method"]) if action.get("method") is not None else None,
        metadata=action.get("metadata", {})
        if isinstance(action.get("metadata", {}), Mapping)
        else {},
    )


def _classify_tool_call(proposed: ProposedAction, rule_set: RuleSet) -> ActionVerdict:
    if proposed.tool in _READ_ONLY_TOOLS:
        return ActionVerdict(
            Reversibility.REVERSIBLE,
            Destructiveness.BENIGN,
            GateRequirement.NONE,
            "read-only tool",
            "read-only-tool",
        )
    if proposed.tool in _WRITE_BUT_REVERSIBLE_TOOLS:
        return ActionVerdict(
            Reversibility.REVERSIBLE,
            Destructiveness.BENIGN,
            GateRequirement.AUTO_APPROVE,
            "local patch is reviewable and reversible before deploy",
            "local-patch",
        )
    if proposed.tool == "deploy":
        return ActionVerdict(
            Reversibility.IRREVERSIBLE,
            Destructiveness.DESTRUCTIVE,
            GateRequirement.HUMAN_CONFIRM,
            "deploy changes a live environment",
            "deploy-tool",
        )
    if proposed.tool == "provision":
        resource = str(proposed.args.get("resource", "resource"))
        return ActionVerdict(
            Reversibility.IRREVERSIBLE,
            Destructiveness.DESTRUCTIVE,
            GateRequirement.HUMAN_CONFIRM,
            f"provisioning {resource} can spend money or alter durable state",
            "provision-tool",
        )
    if proposed.tool == "run_shell":
        return classify_action(
            ProposedAction(ActionKind.SHELL_COMMAND, command=proposed.command),
            rule_set=rule_set,
        )
    return _fail_closed(f"unknown tool {proposed.tool!r}")


def _action_text(proposed: ProposedAction) -> str:
    parts = [
        proposed.command or "",
        proposed.tool or "",
        proposed.method or "",
        proposed.host or "",
        " ".join(f"{key}={value}" for key, value in proposed.args.items()),
        " ".join(f"{key}={value}" for key, value in proposed.metadata.items()),
    ]
    return " ".join(parts).strip()


def _verdict_from_rule(rule: PatternRule) -> ActionVerdict:
    return ActionVerdict(
        Reversibility(rule.reversibility),
        Destructiveness(rule.destructiveness),
        GateRequirement(rule.gate),
        rule.reason,
        rule.name,
    )


def _known_safe_shell(command: str, rule_set: RuleSet) -> bool:
    return any(
        re.search(pattern, command, re.IGNORECASE) for pattern in rule_set.shell_safe_patterns
    )


def _fail_closed(reason: str) -> ActionVerdict:
    return ActionVerdict(
        Reversibility.IRREVERSIBLE,
        Destructiveness.DESTRUCTIVE,
        GateRequirement.HUMAN_CONFIRM,
        f"fail closed: {reason}",
        "fail-closed",
    )
