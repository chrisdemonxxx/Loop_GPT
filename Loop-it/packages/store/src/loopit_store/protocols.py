"""Narrow repository protocols for current control-plane state shapes."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from decimal import Decimal
from typing import Any, Protocol, runtime_checkable

from loopit_agent_core.audit import AuditEvent

from .models import (
    AuditRecord,
    CheckpointRecord,
    LeaseRecord,
    ProjectRecord,
    QuotaEntry,
    RunEvent,
    RunRecord,
    RunStatus,
)


@runtime_checkable
class ProjectStore(Protocol):
    def create(self, project: ProjectRecord) -> ProjectRecord: ...

    def get(self, project_id: str, *, tenant_id: str) -> ProjectRecord | None: ...

    def list_for_tenant(self, tenant_id: str) -> tuple[ProjectRecord, ...]: ...

    def set_current_checkpoint(
        self, project_id: str, *, tenant_id: str, checkpoint_id: str
    ) -> ProjectRecord: ...

    def rename(self, project_id: str, *, tenant_id: str, name: str) -> ProjectRecord: ...

    def archive(self, project_id: str, *, tenant_id: str) -> ProjectRecord: ...

    def restore(self, project_id: str, *, tenant_id: str) -> ProjectRecord: ...


@runtime_checkable
class RunStore(Protocol):
    def create(self, run: RunRecord) -> RunRecord: ...

    def start(self, run_id: str, *, tenant_id: str) -> RunRecord: ...

    def finish(
        self,
        run_id: str,
        *,
        tenant_id: str,
        status: RunStatus,
        summary: str = "",
        cost_credits: Decimal | None = None,
    ) -> RunRecord: ...

    def update_progress(
        self, run_id: str, *, tenant_id: str, iterations: int, cost_credits: Decimal
    ) -> RunRecord: ...

    def get(self, run_id: str, *, tenant_id: str) -> RunRecord | None: ...

    def list_for_project(self, project_id: str, *, tenant_id: str) -> tuple[RunRecord, ...]: ...

    def list_for_tenant(self, tenant_id: str) -> tuple[RunRecord, ...]: ...

    def append_event(self, event: RunEvent) -> RunEvent: ...

    def events(self, run_id: str) -> tuple[RunEvent, ...]: ...


@runtime_checkable
class QuotaStore(Protocol):
    def append(self, entry: QuotaEntry) -> QuotaEntry: ...

    def entries_for_tenant(self, tenant_id: str) -> tuple[QuotaEntry, ...]: ...

    def balance(self, tenant_id: str) -> Decimal: ...


@runtime_checkable
class AuditStore(Protocol):
    """Append-only audit repository; intentionally no update/delete methods."""

    def append(self, event: AuditEvent | Mapping[str, Any]) -> AuditRecord: ...

    def list_for_tenant(self, tenant_id: str) -> tuple[AuditRecord, ...]: ...

    def verify_chain(self, tenant_id: str | None = None) -> bool: ...


@runtime_checkable
class LeaseStore(Protocol):
    def create(self, lease: LeaseRecord) -> LeaseRecord: ...

    def get(self, lease_id: str, *, tenant_id: str) -> LeaseRecord | None: ...

    def active_for_tenant(self, tenant_id: str) -> tuple[LeaseRecord, ...]: ...

    def release(
        self, lease_id: str, *, tenant_id: str, reason: str = "completed"
    ) -> LeaseRecord: ...

    def renew(self, lease: LeaseRecord) -> LeaseRecord: ...

    def expire_due(self) -> tuple[LeaseRecord, ...]: ...


@runtime_checkable
class CheckpointStore(Protocol):
    def create(self, checkpoint: CheckpointRecord) -> CheckpointRecord: ...

    def get(self, checkpoint_id: str, *, tenant_id: str) -> CheckpointRecord | None: ...

    def current(self, project_id: str, *, tenant_id: str) -> CheckpointRecord | None: ...

    def ancestors(self, checkpoint_id: str, *, tenant_id: str) -> tuple[CheckpointRecord, ...]: ...

    def set_current(self, project_id: str, *, tenant_id: str, checkpoint_id: str) -> None: ...

    def pin(self, checkpoint_id: str, *, run_id: str) -> None: ...

    def unpin(self, checkpoint_id: str, *, run_id: str) -> None: ...

    def is_pinned(self, checkpoint_id: str) -> bool: ...


def assert_protocols(
    *,
    projects: ProjectStore,
    runs: RunStore,
    quota: QuotaStore,
    audit: AuditStore,
    leases: LeaseStore,
    checkpoints: CheckpointStore,
) -> None:
    """Runtime smoke check used by tests and adopters of repository bundles."""

    values: Iterable[object] = (projects, runs, quota, audit, leases, checkpoints)
    if not all(values):
        raise ValueError("all stores must be supplied")
