"""In-memory repository implementations matching the Postgres store protocols."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from loopit_agent_core.audit import AuditEvent

from .models import (
    AuditRecord,
    CheckpointRecord,
    LeaseRecord,
    LeaseStatus,
    ProjectRecord,
    QuotaEntry,
    RunEvent,
    RunRecord,
    RunStatus,
    audit_row_hash,
    now_utc,
)


def _payload(event: AuditEvent | Mapping[str, Any]) -> dict[str, Any]:
    return event.to_dict() if isinstance(event, AuditEvent) else dict(event)


class InMemoryProjectStore:
    def __init__(self) -> None:
        self._projects: dict[str, ProjectRecord] = {}

    def create(self, project: ProjectRecord) -> ProjectRecord:
        if project.project_id in self._projects:
            raise ValueError(f"project {project.project_id!r} already exists")
        self._projects[project.project_id] = project
        return project

    def get(self, project_id: str, *, tenant_id: str) -> ProjectRecord | None:
        project = self._projects.get(project_id)
        if project is None or project.tenant_id != tenant_id:
            return None
        return project

    def list_for_tenant(self, tenant_id: str) -> tuple[ProjectRecord, ...]:
        return tuple(p for p in self._projects.values() if p.tenant_id == tenant_id)

    def set_current_checkpoint(
        self, project_id: str, *, tenant_id: str, checkpoint_id: str
    ) -> ProjectRecord:
        project = self.get(project_id, tenant_id=tenant_id)
        if project is None:
            raise KeyError(project_id)
        updated = replace(project, current_checkpoint_id=checkpoint_id, updated_at=now_utc())
        self._projects[project_id] = updated
        return updated

    def rename(self, project_id: str, *, tenant_id: str, name: str) -> ProjectRecord:
        project = self.get(project_id, tenant_id=tenant_id)
        if project is None:
            raise KeyError(project_id)
        cleaned = name.strip()
        if not cleaned:
            raise ValueError("name must be non-empty")
        updated = replace(project, name=cleaned, updated_at=now_utc())
        self._projects[project_id] = updated
        return updated

    def archive(self, project_id: str, *, tenant_id: str) -> ProjectRecord:
        project = self.get(project_id, tenant_id=tenant_id)
        if project is None:
            raise KeyError(project_id)
        updated = replace(project, archived_at=now_utc(), updated_at=now_utc())
        self._projects[project_id] = updated
        return updated

    def restore(self, project_id: str, *, tenant_id: str) -> ProjectRecord:
        project = self.get(project_id, tenant_id=tenant_id)
        if project is None:
            raise KeyError(project_id)
        updated = replace(project, archived_at=None, updated_at=now_utc())
        self._projects[project_id] = updated
        return updated


class InMemoryRunStore:
    def __init__(self) -> None:
        self._runs: dict[str, RunRecord] = {}
        self._events: dict[str, list[RunEvent]] = {}

    def create(self, run: RunRecord) -> RunRecord:
        if run.run_id in self._runs:
            raise ValueError(f"run {run.run_id!r} already exists")
        self._runs[run.run_id] = run
        return run

    def start(self, run_id: str, *, tenant_id: str) -> RunRecord:
        run = self._require(run_id, tenant_id)
        updated = replace(run, status="running", started_at=now_utc())
        self._runs[run_id] = updated
        return updated

    def finish(
        self,
        run_id: str,
        *,
        tenant_id: str,
        status: RunStatus,
        summary: str = "",
        cost_credits: Decimal | None = None,
    ) -> RunRecord:
        if status not in {"succeeded", "failed", "cancelled"}:
            raise ValueError("finish status must be terminal")
        run = self._require(run_id, tenant_id)
        updated = replace(
            run,
            status=status,
            summary=summary,
            cost_credits=run.cost_credits if cost_credits is None else cost_credits,
            finished_at=now_utc(),
            started_at=run.started_at or now_utc(),
        )
        self._runs[run_id] = updated
        return updated

    def update_progress(
        self, run_id: str, *, tenant_id: str, iterations: int, cost_credits: Decimal
    ) -> RunRecord:
        if iterations < 0 or cost_credits < 0:
            raise ValueError("progress values cannot be negative")
        run = self._require(run_id, tenant_id)
        updated = replace(run, iterations=iterations, cost_credits=cost_credits)
        self._runs[run_id] = updated
        return updated

    def get(self, run_id: str, *, tenant_id: str) -> RunRecord | None:
        run = self._runs.get(run_id)
        if run is None or run.tenant_id != tenant_id:
            return None
        return run

    def list_for_project(self, project_id: str, *, tenant_id: str) -> tuple[RunRecord, ...]:
        return tuple(
            r
            for r in self._runs.values()
            if r.project_id == project_id and r.tenant_id == tenant_id
        )

    def list_for_tenant(self, tenant_id: str) -> tuple[RunRecord, ...]:
        return tuple(r for r in self._runs.values() if r.tenant_id == tenant_id)

    def append_event(self, event: RunEvent) -> RunEvent:
        if event.run_id not in self._runs:
            raise KeyError(event.run_id)
        self._events.setdefault(event.run_id, []).append(event)
        return event

    def events(self, run_id: str) -> tuple[RunEvent, ...]:
        return tuple(self._events.get(run_id, ()))

    def _require(self, run_id: str, tenant_id: str) -> RunRecord:
        run = self.get(run_id, tenant_id=tenant_id)
        if run is None:
            raise KeyError(run_id)
        return run


class InMemoryQuotaStore:
    def __init__(self) -> None:
        self._entries: list[QuotaEntry] = []

    def append(self, entry: QuotaEntry) -> QuotaEntry:
        self._entries.append(entry)
        return entry

    def entries_for_tenant(self, tenant_id: str) -> tuple[QuotaEntry, ...]:
        return tuple(e for e in self._entries if e.tenant_id == tenant_id)

    def balance(self, tenant_id: str) -> Decimal:
        total = Decimal("0")
        for entry in self.entries_for_tenant(tenant_id):
            if entry.kind in {"credit", "release"}:
                total += entry.amount
            else:
                total -= entry.amount
        return total


class InMemoryAuditStore:
    """Append-only audit store with per-row hash chaining."""

    def __init__(self) -> None:
        self._records: list[AuditRecord] = []

    def append(self, event: AuditEvent | Mapping[str, Any]) -> AuditRecord:
        payload = _payload(event)
        occurred_raw = payload.get("occurred_at")
        occurred_at = (
            datetime.fromisoformat(str(occurred_raw).replace("Z", "+00:00"))
            if occurred_raw
            else now_utc()
        )
        if occurred_at.tzinfo is None:
            occurred_at = occurred_at.replace(tzinfo=UTC)
        prev_hash = self._records[-1].row_hash if self._records else None
        event_id = str(payload["event_id"])
        tenant_id = str(payload["tenant_id"])
        event_type = str(payload["type"])
        row_hash = audit_row_hash(
            event_id=event_id,
            tenant_id=tenant_id,
            event_type=event_type,
            payload=payload,
            occurred_at=occurred_at,
            prev_row_hash=prev_hash,
        )
        record = AuditRecord(
            audit_id=len(self._records) + 1,
            event_id=event_id,
            tenant_id=tenant_id,
            event_type=event_type,
            payload=payload,
            prev_row_hash=prev_hash,
            row_hash=row_hash,
            occurred_at=occurred_at,
        )
        self._records.append(record)
        return record

    def list_for_tenant(self, tenant_id: str) -> tuple[AuditRecord, ...]:
        return tuple(r for r in self._records if r.tenant_id == tenant_id)

    def verify_chain(self, tenant_id: str | None = None) -> bool:
        records = [r for r in self._records if tenant_id is None or r.tenant_id == tenant_id]
        previous: str | None = None
        for record in records:
            expected = audit_row_hash(
                event_id=record.event_id,
                tenant_id=record.tenant_id,
                event_type=record.event_type,
                payload=record.payload,
                occurred_at=record.occurred_at,
                prev_row_hash=record.prev_row_hash,
            )
            if record.prev_row_hash != previous or record.row_hash != expected:
                return False
            previous = record.row_hash
        return True


class InMemoryLeaseStore:
    def __init__(self) -> None:
        self._leases: dict[str, LeaseRecord] = {}

    def create(self, lease: LeaseRecord) -> LeaseRecord:
        if lease.lease_id in self._leases:
            raise ValueError(f"lease {lease.lease_id!r} already exists")
        self._leases[lease.lease_id] = lease
        return lease

    def get(self, lease_id: str, *, tenant_id: str) -> LeaseRecord | None:
        lease = self._leases.get(lease_id)
        if lease is None or lease.tenant_id != tenant_id:
            return None
        return lease

    def active_for_tenant(self, tenant_id: str) -> tuple[LeaseRecord, ...]:
        return tuple(
            lease
            for lease in self._leases.values()
            if lease.tenant_id == tenant_id and lease.status == "active"
        )

    def release(self, lease_id: str, *, tenant_id: str, reason: str = "completed") -> LeaseRecord:
        lease = self.get(lease_id, tenant_id=tenant_id)
        if lease is None:
            raise KeyError(lease_id)
        status: LeaseStatus = "expired" if reason == "expired" else "released"
        updated = replace(lease, status=status, released_at=now_utc())
        self._leases[lease_id] = updated
        return updated

    def renew(self, lease: LeaseRecord) -> LeaseRecord:
        existing = self.get(lease.lease_id, tenant_id=lease.tenant_id)
        renewed = (
            replace(lease, created_at=existing.created_at, status="active", released_at=None)
            if existing is not None
            else lease
        )
        self._leases[lease.lease_id] = renewed
        return renewed

    def expire_due(self) -> tuple[LeaseRecord, ...]:
        moment = now_utc()
        expired: list[LeaseRecord] = []
        for lease in list(self._leases.values()):
            if lease.status == "active" and lease.expires_at <= moment:
                expired.append(
                    self.release(lease.lease_id, tenant_id=lease.tenant_id, reason="expired")
                )
        return tuple(expired)


class InMemoryCheckpointStore:
    def __init__(self) -> None:
        self._checkpoints: dict[str, CheckpointRecord] = {}
        self._current: dict[str, str] = {}
        self._pins: dict[str, set[str]] = {}

    def create(self, checkpoint: CheckpointRecord) -> CheckpointRecord:
        if checkpoint.checkpoint_id in self._checkpoints:
            raise ValueError(f"checkpoint {checkpoint.checkpoint_id!r} already exists")
        if checkpoint.parent_id is not None and checkpoint.parent_id not in self._checkpoints:
            raise KeyError(checkpoint.parent_id)
        self._checkpoints[checkpoint.checkpoint_id] = checkpoint
        self._current[checkpoint.project_id] = checkpoint.checkpoint_id
        return checkpoint

    def get(self, checkpoint_id: str, *, tenant_id: str) -> CheckpointRecord | None:
        checkpoint = self._checkpoints.get(checkpoint_id)
        if checkpoint is None or checkpoint.tenant_id != tenant_id:
            return None
        return checkpoint

    def current(self, project_id: str, *, tenant_id: str) -> CheckpointRecord | None:
        checkpoint_id = self._current.get(project_id)
        if checkpoint_id is None:
            return None
        return self.get(checkpoint_id, tenant_id=tenant_id)

    def ancestors(self, checkpoint_id: str, *, tenant_id: str) -> tuple[CheckpointRecord, ...]:
        checkpoint = self.get(checkpoint_id, tenant_id=tenant_id)
        if checkpoint is None:
            raise KeyError(checkpoint_id)
        found: list[CheckpointRecord] = []
        parent_id = checkpoint.parent_id
        while parent_id is not None:
            parent = self.get(parent_id, tenant_id=tenant_id)
            if parent is None:
                raise KeyError(parent_id)
            found.append(parent)
            parent_id = parent.parent_id
        return tuple(found)

    def set_current(self, project_id: str, *, tenant_id: str, checkpoint_id: str) -> None:
        checkpoint = self.get(checkpoint_id, tenant_id=tenant_id)
        if checkpoint is None or checkpoint.project_id != project_id:
            raise KeyError(checkpoint_id)
        self._current[project_id] = checkpoint_id

    def pin(self, checkpoint_id: str, *, run_id: str) -> None:
        self._pins.setdefault(checkpoint_id, set()).add(run_id)

    def unpin(self, checkpoint_id: str, *, run_id: str) -> None:
        holders = self._pins.get(checkpoint_id)
        if holders is None:
            return
        holders.discard(run_id)
        if not holders:
            del self._pins[checkpoint_id]

    def is_pinned(self, checkpoint_id: str) -> bool:
        return bool(self._pins.get(checkpoint_id))
