"""Append-only audit emission (invariant I10, Doc 08 §6).

Every action, observation, tool call, model call, gate decision, and kill-switch
trip emits one record. This stream is simultaneously the debugging substrate,
the billing substrate, and the abuse-forensics substrate, so it must be complete
and immutable — corrections are new records, never edits.

Secrets never enter it. :func:`redact` is applied to every payload on the way
in; it is a backstop, not a licence to pass secrets around.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Protocol, runtime_checkable

Plane = Literal["control", "data", "deployment", "user_app"]
Outcome = Literal["allowed", "denied", "success", "failure", "pending"]

REDACTED = "[REDACTED]"

#: Key names whose values are always replaced, regardless of content.
_SENSITIVE_KEYS = re.compile(
    r"(secret|token|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|session)",
    re.IGNORECASE,
)

#: Value shapes that look like credentials even under an innocuous key.
_SENSITIVE_VALUES: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),  # OpenAI-style
    re.compile(r"\bhf_[A-Za-z0-9]{16,}\b"),  # Hugging Face
    re.compile(r"\bghp_[A-Za-z0-9]{20,}\b"),  # GitHub PAT
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),  # AWS access key id
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),  # Slack
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),  # JWT
)


def redact(value: Any) -> Any:
    """Recursively strip anything that looks like a credential."""
    if isinstance(value, Mapping):
        return {
            key: REDACTED if _SENSITIVE_KEYS.search(str(key)) else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, str):
        for pattern in _SENSITIVE_VALUES:
            value = pattern.sub(REDACTED, value)
        return value
    if isinstance(value, Sequence) and not isinstance(value, str | bytes):
        return [redact(item) for item in value]
    return value


@dataclass(frozen=True, slots=True)
class AuditEvent:
    """One immutable audit record. Matches ``audit-event.schema.json``."""

    type: str
    tenant_id: str
    actor_kind: Literal["user", "agent", "system", "service"]
    actor_id: str | None = None
    actor_service: str | None = None
    project_id: str | None = None
    run_id: str | None = None
    task_id: str | None = None
    sandbox_lease_id: str | None = None
    trace_id: str | None = None
    plane: Plane | None = None
    outcome: Outcome | None = None
    cost: Mapping[str, Any] | None = None
    detail: Mapping[str, Any] = field(default_factory=dict)
    event_id: str = field(default_factory=lambda: f"ev_{uuid.uuid4().hex}")
    occurred_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, Any]:
        """Serialise to the wire shape, with secrets redacted."""
        actor: dict[str, Any] = {"kind": self.actor_kind}
        if self.actor_id is not None:
            actor["id"] = self.actor_id
        if self.actor_service is not None:
            actor["service"] = self.actor_service

        payload: dict[str, Any] = {
            "event_id": self.event_id,
            "occurred_at": self.occurred_at.isoformat().replace("+00:00", "Z"),
            "type": self.type,
            "actor": actor,
            "tenant_id": self.tenant_id,
            "detail": redact(dict(self.detail)),
        }
        optional = {
            "project_id": self.project_id,
            "run_id": self.run_id,
            "task_id": self.task_id,
            "sandbox_lease_id": self.sandbox_lease_id,
            "trace_id": self.trace_id,
            "plane": self.plane,
            "outcome": self.outcome,
            "cost": dict(self.cost) if self.cost else None,
        }
        payload.update({key: value for key, value in optional.items() if value is not None})
        return payload


@runtime_checkable
class AuditSink(Protocol):
    """Where audit records go. Implementations must be append-only."""

    def emit(self, event: AuditEvent) -> None: ...


class InMemoryAuditSink:
    """An append-only sink for tests and local development.

    Deliberately exposes no mutation API beyond :meth:`emit`: the production
    sink is a partitioned Postgres table mirrored to write-once object storage,
    and test doubles should not model capabilities production does not have.
    """

    def __init__(self) -> None:
        self._events: list[AuditEvent] = []

    def emit(self, event: AuditEvent) -> None:
        self._events.append(event)

    @property
    def events(self) -> tuple[AuditEvent, ...]:
        return tuple(self._events)

    def of_type(self, event_type: str) -> tuple[AuditEvent, ...]:
        return tuple(event for event in self._events if event.type == event_type)

    def __len__(self) -> int:
        return len(self._events)
