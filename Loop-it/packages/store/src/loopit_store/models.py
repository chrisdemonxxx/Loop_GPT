"""Typed records stored by the control-plane repositories."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Literal

RunStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
LeaseStatus = Literal["active", "released", "expired"]
QuotaKind = Literal["credit", "debit", "reservation", "release", "settlement"]


def now_utc() -> datetime:
    return datetime.now(UTC)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


@dataclass(frozen=True, slots=True)
class RunBudget:
    """The bounded budget every run must carry (I12)."""

    max_iterations: int
    max_tokens: int | None = None
    max_wall_clock_seconds: int | None = None
    max_credits: Decimal | None = None

    def __post_init__(self) -> None:
        if self.max_iterations < 1:
            raise ValueError("max_iterations must be positive")
        for name in ("max_tokens", "max_wall_clock_seconds"):
            value = getattr(self, name)
            if value is not None and value < 1:
                raise ValueError(f"{name} must be positive when set")
        if self.max_credits is not None and self.max_credits < 0:
            raise ValueError("max_credits cannot be negative")


@dataclass(frozen=True, slots=True)
class ProjectRecord:
    project_id: str
    tenant_id: str
    owner_user_id: str | None
    name: str
    stack: str
    current_checkpoint_id: str | None = None
    created_at: datetime = field(default_factory=now_utc)
    updated_at: datetime = field(default_factory=now_utc)
    archived_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class RunRecord:
    run_id: str
    tenant_id: str
    project_id: str
    prompt: str
    status: RunStatus
    budget: RunBudget
    difficulty: str = "implementation"
    iterations: int = 0
    cost_credits: Decimal = Decimal("0")
    summary: str = ""
    created_at: datetime = field(default_factory=now_utc)
    started_at: datetime | None = None
    finished_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class RunEvent:
    event_id: str
    run_id: str
    event_type: str
    detail: dict[str, Any] = field(default_factory=dict)
    occurred_at: datetime = field(default_factory=now_utc)


@dataclass(frozen=True, slots=True)
class CheckpointRecord:
    checkpoint_id: str
    tenant_id: str
    project_id: str
    manifest: dict[str, str]
    parent_id: str | None = None
    db_snapshot_id: str | None = None
    verified: bool = False
    label: str | None = None
    created_by_run_id: str | None = None
    created_at: datetime = field(default_factory=now_utc)


@dataclass(frozen=True, slots=True)
class LeaseRecord:
    lease_id: str
    tenant_id: str
    run_id: str
    project_id: str
    sandbox_id: str
    base_checkpoint_id: str
    expires_at: datetime
    caps: dict[str, int]
    allowed_tools: tuple[str, ...]
    status: LeaseStatus = "active"
    released_at: datetime | None = None
    created_at: datetime = field(default_factory=now_utc)


@dataclass(frozen=True, slots=True)
class QuotaEntry:
    entry_id: str
    tenant_id: str
    amount: Decimal
    kind: QuotaKind
    source: str
    run_id: str | None = None
    description: str = ""
    created_at: datetime = field(default_factory=now_utc)


@dataclass(frozen=True, slots=True)
class AuditRecord:
    audit_id: int
    event_id: str
    tenant_id: str
    event_type: str
    payload: dict[str, Any]
    prev_row_hash: str | None
    row_hash: str
    occurred_at: datetime


def audit_row_hash(
    *,
    event_id: str,
    tenant_id: str,
    event_type: str,
    payload: dict[str, Any],
    occurred_at: datetime,
    prev_row_hash: str | None,
) -> str:
    """Hash the canonical row payload and previous row hash for tamper evidence."""

    body = canonical_json(
        {
            "event_id": event_id,
            "tenant_id": tenant_id,
            "event_type": event_type,
            "payload": payload,
            "occurred_at": occurred_at.isoformat(),
            "prev_row_hash": prev_row_hash,
        }
    )
    return hashlib.sha256(body.encode("utf-8")).hexdigest()
