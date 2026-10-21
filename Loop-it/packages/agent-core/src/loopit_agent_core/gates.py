"""Confirmation-gate binding helpers.

Approvals are scoped to a run and to the exact canonical tool invocation the
human reviewed. The model may supply a ``call_id`` for tracing, but it is never
part of the authority decision.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from typing import Any


def normalise_gate_value(value: Any) -> Any:
    """Return the exact JSON-stable value for approval binding.

    The binding intentionally does not sort object keys or normalise strings:
    a human approval covers the precise payload displayed for that gate, and
    semantically similar encodings must fail closed rather than share authority.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        return {key: normalise_gate_value(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, bytes | bytearray | str):
        return [normalise_gate_value(item) for item in value]
    return value


def canonical_gate_json(value: Any) -> str:
    """Serialise a value with exact key order, unicode and stable separators."""
    return json.dumps(
        normalise_gate_value(value),
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )


def approval_binding_hash(tool: str, args: Mapping[str, Any], run_id: str) -> str:
    """Hash the exact tool, canonical arguments and run scope."""
    payload = {"args": normalise_gate_value(dict(args)), "run_id": run_id, "tool": tool}
    return hashlib.sha256(canonical_gate_json(payload).encode("utf-8")).hexdigest()


def gate_id_for(tool: str, args: Mapping[str, Any], run_id: str) -> str:
    """Generate a server-side gate id from the run-scoped approval binding."""
    return f"gate_{approval_binding_hash(tool, args, run_id)[:32]}"


class ApprovalBindings:
    """Single-use approval binding set shared by all tool surfaces."""

    def __init__(self, approved_gates: frozenset[str] = frozenset()) -> None:
        self._approved = set(approved_gates)

    def approve(self, tool: str, args: Mapping[str, Any], run_id: str) -> str:
        binding = approval_binding_hash(tool, args, run_id)
        self._approved.add(binding)
        return binding

    def gate_id(self, tool: str, args: Mapping[str, Any], run_id: str) -> str:
        return gate_id_for(tool, args, run_id)

    def binding(self, tool: str, args: Mapping[str, Any], run_id: str) -> str:
        return approval_binding_hash(tool, args, run_id)

    def has(self, tool: str, args: Mapping[str, Any], run_id: str) -> bool:
        return self.binding(tool, args, run_id) in self._approved

    def requires_gate(
        self, tool: str, args: Mapping[str, Any], run_id: str, *, requires_confirmation: bool
    ) -> bool:
        return requires_confirmation and not self.has(tool, args, run_id)

    def consume(self, tool: str, args: Mapping[str, Any], run_id: str) -> None:
        self._approved.remove(self.binding(tool, args, run_id))
