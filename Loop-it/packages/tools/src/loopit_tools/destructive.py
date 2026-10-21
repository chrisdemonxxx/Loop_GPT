"""Destructiveness detection for shell commands (invariant I7).

Delegates to ``loopit_policy.classify_action`` so the tools registry and the
orchestrator share one allowlist. Extend builder-safe writes in policy, not here.
"""

from __future__ import annotations

from loopit_policy import classify_action
from loopit_policy.actions import GateRequirement


def shell_requires_confirmation(command: str) -> bool:
    """Return True when the command still requires a human confirmation gate."""
    verdict = classify_action({"tool": "run_shell", "args": {"command": command}})
    return verdict.required_gate is GateRequirement.HUMAN_CONFIRM
