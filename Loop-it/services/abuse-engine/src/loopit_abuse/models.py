from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

SignalKind = Literal[
    "egress_denial",
    "policy_violation",
    "cpu_saturation_without_build_progress",
    "sandbox_creation_spike",
    "unexpected_gpu_usage",
    "port_scan",
    "auth_brute_force",
]
Tier = Literal["T0", "T1", "T2", "T3"]
IncidentState = Literal["open", "dismissed", "resolved"]


class AbuseTaxon(StrEnum):
    EGRESS_DENIAL = "egress_denial"
    POLICY_VIOLATION = "policy_violation"
    MINER = "miner"
    FAN_OUT = "sandbox_fan_out"
    GPU_MISUSE = "unexpected_gpu_usage"
    PORT_SCAN = "port_scan"
    AUTH_BRUTE_FORCE = "auth_brute_force"


@dataclass(frozen=True, slots=True)
class AbuseSignal:
    signal_id: str
    tenant_id: str
    kind: SignalKind
    project_id: str | None = None
    sandbox_id: str | None = None
    lease_id: str | None = None
    run_id: str | None = None
    occurred_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    detail: dict[str, Any] = field(default_factory=dict)

    def scope_key(self) -> tuple[str, str | None, str | None]:
        return (self.tenant_id, self.project_id, self.sandbox_id)


@dataclass(frozen=True, slots=True)
class Score:
    points: int
    tier: Tier
    taxon: AbuseTaxon
    window_seconds: int
    reason: str


@dataclass(slots=True)
class Incident:
    incident_id: str
    tenant_id: str
    taxon: AbuseTaxon
    tier: Tier
    state: IncidentState
    score: int
    signal_ids: tuple[str, ...]
    project_id: str | None = None
    sandbox_id: str | None = None
    lease_id: str | None = None
    dry_run: bool = False
    action: str = "warn"
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    detail: dict[str, Any] = field(default_factory=dict)
