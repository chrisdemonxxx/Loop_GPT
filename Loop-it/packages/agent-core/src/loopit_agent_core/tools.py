"""Tool-call validation and dispatch (Doc 04 §3).

Tools are least-privilege: each does exactly one narrow thing. Calls arrive from
the model under constrained decoding and are **validated against the contract
schema on receipt** — never free-form parsed.

Two rules are enforced here rather than left to convention:

* Tool output can never silently escalate permissions (OWASP GenAI 2026,
  Excessive Agency). A tool marked destructive requires an approved confirmation
  gate before :class:`ToolExecutor` will dispatch it (invariant I7).
* Execution happens in the data plane. :class:`ToolExecutor` dispatches to a
  handler that talks to a leased sandbox; it never runs anything locally (I1).
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from .gates import ApprovalBindings
from .observation import Observation, clip

#: Tools whose effects are irreversible. These always require an approved gate.
DESTRUCTIVE_TOOLS: frozenset[str] = frozenset({"deploy", "provision", "request_secret"})

#: Tools that only read. Never gated, never charged against a write quota.
READ_ONLY_TOOLS: frozenset[str] = frozenset({"read_file", "search_code", "browser"})


def _find_schema(name: str) -> Path:
    """Locate a contract schema.

    ``LOOPIT_CONTRACTS_DIR`` wins when set (containers mount the contracts at a
    fixed path). Otherwise walk up from this file looking for the in-repo
    ``packages/contracts/schemas`` directory, so the package works both from a
    source checkout and from an installed wheel beside a mounted contracts dir.
    """
    override = os.environ.get("LOOPIT_CONTRACTS_DIR")
    if override:
        candidate = Path(override) / name
        if candidate.is_file():
            return candidate
        raise FileNotFoundError(f"LOOPIT_CONTRACTS_DIR is set but {candidate} does not exist")

    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "packages" / "contracts" / "schemas" / name
        if candidate.is_file():
            return candidate
        candidate = parent / "contracts" / "schemas" / name
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"could not locate contract schema {name!r}; set LOOPIT_CONTRACTS_DIR")


class ToolRejected(Exception):
    """A tool call was refused before it could execute.

    Carries an agent-readable observation, because a rejection is the loop's
    next input rather than a fatal error.
    """

    def __init__(self, message: str, *, observation: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.observation = observation or f"tool call REJECTED: {message}"


@dataclass(frozen=True, slots=True)
class ToolCall:
    """A validated tool invocation."""

    tool: str
    args: Mapping[str, Any]
    call_id: str | None = None
    reason: str | None = None

    @property
    def is_destructive(self) -> bool:
        return self.tool in DESTRUCTIVE_TOOLS

    @property
    def is_read_only(self) -> bool:
        return self.tool in READ_ONLY_TOOLS


@dataclass(frozen=True, slots=True)
class ToolResult:
    """What a tool handler returns."""

    ok: bool
    output: str
    detail: Mapping[str, Any] = field(default_factory=dict)

    def as_observation(self, tool: str) -> Observation:
        content, truncated = clip(self.output)
        return Observation(source=tool, content=content, truncated=truncated)


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    schema = json.loads(_find_schema("tool-call.schema.json").read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


def validate_tool_call(payload: Mapping[str, Any]) -> ToolCall:
    """Validate a raw tool call against the contract schema.

    Raises:
        ToolRejected: the payload does not conform. The message names the exact
            violation so the agent can correct it on the next iteration.
    """
    errors = sorted(_validator().iter_errors(dict(payload)), key=lambda e: list(e.path))
    if errors:
        detail = "; ".join(
            f"{'/'.join(str(p) for p in error.path) or '<root>'}: {error.message}"
            for error in errors[:3]
        )
        raise ToolRejected(
            f"tool call failed schema validation: {detail}",
            observation=(
                f"tool call REJECTED: {detail}. Re-emit the call conforming to the tool's schema."
            ),
        )

    return ToolCall(
        tool=str(payload["tool"]),
        args=dict(payload["args"]),
        call_id=payload.get("call_id"),
        reason=payload.get("reason"),
    )


ToolHandler = Callable[[ToolCall], ToolResult]


class ToolExecutor:
    """Dispatches validated tool calls to data-plane handlers.

    Args:
        handlers: tool name → handler. A handler issues an instruction to the
            leased sandbox; it must not execute generated code in-process (I1).
        approved_gates: run-scoped approval binding hashes for exact tool
            arguments a human has approved. A destructive tool with no matching
            unused binding is refused (I7).
    """

    def __init__(
        self,
        handlers: Mapping[str, ToolHandler],
        *,
        approved_gates: frozenset[str] = frozenset(),
        run_id: str = "local",
    ) -> None:
        unknown = set(handlers) - _known_tools()
        if unknown:
            raise ValueError(f"handlers registered for unknown tools: {sorted(unknown)}")
        self._handlers = dict(handlers)
        self._approval_bindings = ApprovalBindings(approved_gates)
        self._run_id = run_id

    def approve(self, call: ToolCall) -> str:
        """Record a single-use approval for the exact run-scoped ``call``."""
        return self._approval_bindings.approve(call.tool, call.args, self._run_id)

    def gate_id(self, call: ToolCall) -> str:
        """Return the server-side id for ``call`` without trusting model fields."""
        return self._approval_bindings.gate_id(call.tool, call.args, self._run_id)

    def approval_binding(self, call: ToolCall) -> str:
        """Return the run-scoped hash that an approval must match."""
        return self._approval_bindings.binding(call.tool, call.args, self._run_id)

    def _call_requires_confirmation(self, call: ToolCall) -> bool:
        return call.is_destructive

    def requires_gate(self, call: ToolCall) -> bool:
        """Whether ``call`` needs human confirmation before it may run."""
        return self._approval_bindings.requires_gate(
            call.tool,
            call.args,
            self._run_id,
            requires_confirmation=self._call_requires_confirmation(call),
        )

    def execute(self, call: ToolCall) -> ToolResult:
        """Run a validated call, enforcing the confirmation gate.

        Raises:
            ToolRejected: no handler is registered, or a required gate is not
                approved.
        """
        if self.requires_gate(call):
            raise ToolRejected(
                f"{call.tool!r} is destructive and has no approved confirmation gate",
                observation=(
                    f"tool call BLOCKED: {call.tool!r} is irreversible and requires explicit "
                    "human approval. The run is paused awaiting a decision; do not retry."
                ),
            )

        if self._call_requires_confirmation(call):
            self._approval_bindings.consume(call.tool, call.args, self._run_id)

        handler = self._handlers.get(call.tool)
        if handler is None:
            raise ToolRejected(
                f"no handler registered for tool {call.tool!r}",
                observation=(
                    f"tool call REJECTED: {call.tool!r} is not available in this task. "
                    f"Available tools: {', '.join(sorted(self._handlers))}."
                ),
            )
        return handler(call)


@lru_cache(maxsize=1)
def _known_tools() -> frozenset[str]:
    schema = json.loads(_find_schema("tool-call.schema.json").read_text(encoding="utf-8"))
    return frozenset(schema["properties"]["tool"]["enum"])
