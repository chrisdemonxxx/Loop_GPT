from __future__ import annotations

import uuid
from collections import defaultdict, deque
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from loopit_agent_core.audit import AuditEvent, AuditSink, InMemoryAuditSink

from .actions import SandboxKiller, TenantSuspender, Throttler
from .models import AbuseSignal, AbuseTaxon, Incident, Score, Tier

WEIGHTS: dict[str, int] = {
    "egress_denial": 10,
    "policy_violation": 12,
    "cpu_saturation_without_build_progress": 55,
    "sandbox_creation_spike": 30,
    "unexpected_gpu_usage": 70,
    "port_scan": 60,
    "auth_brute_force": 45,
}
TIER_POINTS: tuple[tuple[int, Tier], ...] = ((100, "T3"), (70, "T2"), (35, "T1"), (1, "T0"))
TIER_ACTION: dict[Tier, str] = {
    "T0": "warn",
    "T1": "throttle",
    "T2": "kill_sandbox",
    "T3": "suspend_tenant",
}


@dataclass(slots=True)
class IncidentStore:
    incidents: dict[str, Incident] = field(default_factory=dict)
    by_scope: dict[tuple[str, str | None, str | None, AbuseTaxon], str] = field(
        default_factory=dict
    )
    allowlist: set[tuple[str, AbuseTaxon | None, str | None, str | None]] = field(
        default_factory=set
    )

    def list(self, tenant_id: str | None = None) -> tuple[Incident, ...]:
        items = list(self.incidents.values())
        if tenant_id is not None:
            items = [incident for incident in items if incident.tenant_id == tenant_id]
        return tuple(sorted(items, key=lambda item: item.updated_at, reverse=True))

    def get(self, incident_id: str) -> Incident | None:
        return self.incidents.get(incident_id)


class AbuseEngine:
    """Infrastructure-abuse scoring and response ladder.

    This engine is deliberately independent of model-content policy enforcement
    (I11). Its inputs are operational signals, and its outputs are infrastructure
    controls: throttle, lease release, or tenant suspension.
    """

    def __init__(
        self,
        *,
        killer: SandboxKiller,
        throttler: Throttler,
        suspender: TenantSuspender,
        audit: AuditSink | None = None,
        store: IncidentStore | None = None,
        dry_run: bool = False,
        window_seconds: int = 300,
    ) -> None:
        self._killer = killer
        self._throttler = throttler
        self._suspender = suspender
        self._audit = audit if audit is not None else InMemoryAuditSink()
        self._store = store if store is not None else IncidentStore()
        self._dry_run = dry_run
        self._window_seconds = window_seconds
        self._signals: dict[tuple[str, str | None, str | None, AbuseTaxon], deque[AbuseSignal]] = (
            defaultdict(deque)
        )
        self._seen_signals: set[str] = set()
        self._enforced: set[tuple[str, Tier]] = set()

    @property
    def store(self) -> IncidentStore:
        return self._store

    def ingest(self, signal: AbuseSignal) -> Incident | None:
        if self._is_allowlisted(signal):
            self._emit_signal(signal, "allowed", {"suppressed": True})
            return None
        if signal.signal_id in self._seen_signals:
            self._emit_signal(signal, "allowed", {"duplicate": True})
            return self._find_existing(signal)
        self._seen_signals.add(signal.signal_id)
        key = (*signal.scope_key(), self._taxon(signal))
        window = self._signals[key]
        window.append(signal)
        self._trim(window, signal.occurred_at)
        score = self.score(window, signal.occurred_at)
        self._emit_signal(signal, "success", {"score": score.points, "tier": score.tier})
        incident = self._upsert_incident(signal, window, score)
        self._enforce(incident, score.reason)
        return incident

    def score(self, signals: Iterable[AbuseSignal], now: datetime | None = None) -> Score:
        moment = now or datetime.now(UTC)
        recent = [
            s for s in signals if moment - s.occurred_at <= timedelta(seconds=self._window_seconds)
        ]
        points = sum(self._points(signal) for signal in recent)
        taxon = self._taxon(recent[-1]) if recent else AbuseTaxon.EGRESS_DENIAL
        if self._miner_heuristic(recent):
            points = max(points, 70)
            taxon = AbuseTaxon.MINER
        if self._fanout_heuristic(recent):
            points = max(points, 70)
            taxon = AbuseTaxon.FAN_OUT
        if self._brute_force_heuristic(recent):
            points = max(points, 70)
            taxon = AbuseTaxon.AUTH_BRUTE_FORCE
        for threshold, tier in TIER_POINTS:
            if points >= threshold:
                return Score(points, tier, taxon, self._window_seconds, f"{taxon.value}:{points}")
        return Score(0, "T0", taxon, self._window_seconds, "no_signal")

    def dismiss(self, incident_id: str, *, actor_id: str, reason: str) -> Incident:
        incident = self._require(incident_id)
        incident.state = "dismissed"
        incident.updated_at = datetime.now(UTC)
        self._emit_action(
            incident, actor_id=actor_id, action="dismiss", outcome="success", reason=reason
        )
        return incident

    def add_allowlist(
        self,
        *,
        tenant_id: str,
        taxon: AbuseTaxon | None,
        project_id: str | None,
        sandbox_id: str | None,
        actor_id: str,
        reason: str,
    ) -> None:
        self._store.allowlist.add((tenant_id, taxon, project_id, sandbox_id))
        self._audit.emit(
            AuditEvent(
                type="abuse.allowlisted",
                tenant_id=tenant_id,
                actor_kind="user",
                actor_id=actor_id,
                project_id=project_id,
                plane="control",
                outcome="success",
                detail={
                    "taxon": taxon.value if taxon else None,
                    "sandbox_id": sandbox_id,
                    "reason": reason,
                },
            )
        )

    def suspend(self, tenant_id: str, *, actor_id: str, reason: str) -> None:
        if not self._dry_run:
            self._suspender.suspend(tenant_id=tenant_id, reason=reason)
        self._audit.emit(
            AuditEvent(
                type="abuse.operator.suspend",
                tenant_id=tenant_id,
                actor_kind="user",
                actor_id=actor_id,
                plane="control",
                outcome="success",
                detail={"dry_run": self._dry_run, "reason": reason},
            )
        )

    def unsuspend(self, tenant_id: str, *, actor_id: str, reason: str) -> None:
        if not self._dry_run:
            self._suspender.unsuspend(tenant_id=tenant_id, reason=reason)
        self._audit.emit(
            AuditEvent(
                type="abuse.operator.unsuspend",
                tenant_id=tenant_id,
                actor_kind="user",
                actor_id=actor_id,
                plane="control",
                outcome="success",
                detail={"dry_run": self._dry_run, "reason": reason},
            )
        )

    def kill_sandbox(self, tenant_id: str, lease_id: str, *, actor_id: str, reason: str) -> None:
        if not self._dry_run:
            self._killer.kill(tenant_id=tenant_id, lease_id=lease_id, reason=reason)
        self._audit.emit(
            AuditEvent(
                type="abuse.operator.kill_sandbox",
                tenant_id=tenant_id,
                actor_kind="user",
                actor_id=actor_id,
                sandbox_lease_id=lease_id,
                plane="control",
                outcome="success",
                detail={"dry_run": self._dry_run, "reason": reason},
            )
        )

    def throttle(
        self, tenant_id: str, project_id: str | None, *, actor_id: str, reason: str
    ) -> None:
        if not self._dry_run:
            self._throttler.throttle(tenant_id=tenant_id, project_id=project_id, reason=reason)
        self._audit.emit(
            AuditEvent(
                type="abuse.operator.throttle",
                tenant_id=tenant_id,
                actor_kind="user",
                actor_id=actor_id,
                project_id=project_id,
                plane="control",
                outcome="success",
                detail={"dry_run": self._dry_run, "reason": reason},
            )
        )

    def _upsert_incident(
        self, signal: AbuseSignal, signals: deque[AbuseSignal], score: Score
    ) -> Incident:
        key = (*signal.scope_key(), score.taxon)
        existing_id = self._store.by_scope.get(key)
        signal_ids = tuple(s.signal_id for s in signals)
        now = datetime.now(UTC)
        if existing_id is not None:
            incident = self._store.incidents[existing_id]
            incident.tier = score.tier
            incident.score = score.points
            incident.signal_ids = signal_ids
            incident.lease_id = signal.lease_id or incident.lease_id
            incident.action = TIER_ACTION[score.tier]
            incident.updated_at = now
            incident.detail = {"reason": score.reason, "window_seconds": score.window_seconds}
            return incident
        incident = Incident(
            incident_id=f"abuse_{uuid.uuid4().hex}",
            tenant_id=signal.tenant_id,
            taxon=score.taxon,
            tier=score.tier,
            state="open",
            score=score.points,
            signal_ids=signal_ids,
            project_id=signal.project_id,
            sandbox_id=signal.sandbox_id,
            lease_id=signal.lease_id,
            dry_run=self._dry_run,
            action=TIER_ACTION[score.tier],
            detail={"reason": score.reason, "window_seconds": score.window_seconds},
        )
        self._store.incidents[incident.incident_id] = incident
        self._store.by_scope[key] = incident.incident_id
        self._emit_action(
            incident, actor_id="loopit-abuse", action="flag", outcome="success", reason=score.reason
        )
        return incident

    def _enforce(self, incident: Incident, reason: str) -> None:
        if incident.state != "open" or (incident.incident_id, incident.tier) in self._enforced:
            return
        self._enforced.add((incident.incident_id, incident.tier))
        if not self._dry_run:
            if incident.tier == "T1":
                self._throttler.throttle(
                    tenant_id=incident.tenant_id, project_id=incident.project_id, reason=reason
                )
            elif incident.tier == "T2" and incident.lease_id:
                self._killer.kill(
                    tenant_id=incident.tenant_id, lease_id=incident.lease_id, reason=reason
                )
            elif incident.tier == "T3":
                self._suspender.suspend(tenant_id=incident.tenant_id, reason=reason)
        self._emit_action(
            incident,
            actor_id="loopit-abuse",
            action=TIER_ACTION[incident.tier],
            outcome="success",
            reason=reason,
        )

    def _points(self, signal: AbuseSignal) -> int:
        base = WEIGHTS[signal.kind]
        if signal.kind == "egress_denial" and str(signal.detail.get("reason", "")).startswith(
            "mining"
        ):
            return 70
        count = signal.detail.get("count")
        if isinstance(count, int) and count > 1:
            return min(100, base * count)
        return base

    def _taxon(self, signal: AbuseSignal) -> AbuseTaxon:
        if signal.kind == "cpu_saturation_without_build_progress":
            return AbuseTaxon.MINER
        if signal.kind == "sandbox_creation_spike":
            return AbuseTaxon.FAN_OUT
        if signal.kind == "unexpected_gpu_usage":
            return AbuseTaxon.GPU_MISUSE
        if signal.kind == "port_scan":
            return AbuseTaxon.PORT_SCAN
        if signal.kind == "auth_brute_force":
            return AbuseTaxon.AUTH_BRUTE_FORCE
        if signal.kind == "policy_violation":
            return AbuseTaxon.POLICY_VIOLATION
        return AbuseTaxon.EGRESS_DENIAL

    def _miner_heuristic(self, signals: list[AbuseSignal]) -> bool:
        for signal in signals:
            if signal.kind != "cpu_saturation_without_build_progress":
                continue
            cpu = float(signal.detail.get("cpu_percent", 0))
            seconds = int(signal.detail.get("duration_seconds", 0))
            progress = int(signal.detail.get("build_progress_events", 0))
            return cpu >= 90 and seconds >= 120 and progress == 0
        return False

    def _fanout_heuristic(self, signals: list[AbuseSignal]) -> bool:
        sandboxes = {
            s.sandbox_id or s.detail.get("sandbox_id")
            for s in signals
            if s.kind == "sandbox_creation_spike"
        }
        return len({s for s in sandboxes if s}) >= 5

    def _brute_force_heuristic(self, signals: list[AbuseSignal]) -> bool:
        failures = [s for s in signals if s.kind == "auth_brute_force"]
        return len(failures) >= 10 or any(int(s.detail.get("count", 0)) >= 10 for s in failures)

    def _trim(self, signals: deque[AbuseSignal], now: datetime) -> None:
        cutoff = now - timedelta(seconds=self._window_seconds)
        while signals and signals[0].occurred_at < cutoff:
            signals.popleft()

    def _is_allowlisted(self, signal: AbuseSignal) -> bool:
        taxon = self._taxon(signal)
        candidates = (
            (signal.tenant_id, None, None, None),
            (signal.tenant_id, taxon, None, None),
            (signal.tenant_id, taxon, signal.project_id, None),
            (signal.tenant_id, taxon, signal.project_id, signal.sandbox_id),
        )
        return any(candidate in self._store.allowlist for candidate in candidates)

    def _find_existing(self, signal: AbuseSignal) -> Incident | None:
        for incident in self._store.incidents.values():
            if signal.signal_id in incident.signal_ids:
                return incident
        return None

    def _require(self, incident_id: str) -> Incident:
        incident = self._store.get(incident_id)
        if incident is None:
            raise KeyError(incident_id)
        return incident

    def _emit_signal(self, signal: AbuseSignal, outcome: str, detail: dict[str, object]) -> None:
        self._audit.emit(
            AuditEvent(
                type="abuse.signal.ingested",
                tenant_id=signal.tenant_id,
                actor_kind="service",
                actor_service="loopit-abuse",
                project_id=signal.project_id,
                run_id=signal.run_id,
                sandbox_lease_id=signal.lease_id,
                plane="control",
                outcome="success" if outcome == "success" else "allowed",
                detail={"signal_id": signal.signal_id, "kind": signal.kind, **detail},
            )
        )

    def _emit_action(
        self,
        incident: Incident,
        *,
        actor_id: str,
        action: str,
        outcome: str,
        reason: str,
    ) -> None:
        self._audit.emit(
            AuditEvent(
                type="abuse.action",
                tenant_id=incident.tenant_id,
                actor_kind="service" if actor_id == "loopit-abuse" else "user",
                actor_id=None if actor_id == "loopit-abuse" else actor_id,
                actor_service="loopit-abuse" if actor_id == "loopit-abuse" else None,
                project_id=incident.project_id,
                sandbox_lease_id=incident.lease_id,
                plane="control",
                outcome="success" if outcome == "success" else "failure",
                detail={
                    "incident_id": incident.incident_id,
                    "tier": incident.tier,
                    "taxon": incident.taxon.value,
                    "action": action,
                    "dry_run": self._dry_run,
                    "reason": reason,
                },
            )
        )
