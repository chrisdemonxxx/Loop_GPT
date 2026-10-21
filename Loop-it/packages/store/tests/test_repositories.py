from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Protocol

import pytest
from loopit_agent_core.audit import AuditEvent
from loopit_store import (
    AuditStore,
    CheckpointRecord,
    CheckpointStore,
    InMemoryAuditStore,
    InMemoryCheckpointStore,
    InMemoryLeaseStore,
    InMemoryProjectStore,
    InMemoryQuotaStore,
    InMemoryRunStore,
    LeaseRecord,
    LeaseStore,
    ProjectRecord,
    ProjectStore,
    QuotaEntry,
    QuotaStore,
    RunBudget,
    RunEvent,
    RunRecord,
    RunStore,
)
from loopit_store.migrate import migrate

TENANT = "tenant_store_test"
PROJECT = "proj_store_test"
RUN = "run_store_test"
CHECKPOINT = "ckpt_store_test"


class Stores(Protocol):
    projects: ProjectStore
    runs: RunStore
    quota: QuotaStore
    audit: AuditStore
    leases: LeaseStore
    checkpoints: CheckpointStore


@dataclass(slots=True)
class StoreBundle:
    projects: ProjectStore
    runs: RunStore
    quota: QuotaStore
    audit: AuditStore
    leases: LeaseStore
    checkpoints: CheckpointStore


def _project(project_id: str = PROJECT) -> ProjectRecord:
    return ProjectRecord(
        project_id=project_id,
        tenant_id=TENANT,
        owner_user_id=None,
        name="Loop app",
        stack="react",
    )


def _run(run_id: str = RUN, project_id: str = PROJECT) -> RunRecord:
    return RunRecord(
        run_id=run_id,
        tenant_id=TENANT,
        project_id=project_id,
        prompt="Build a small CRM",
        status="queued",
        budget=RunBudget(max_iterations=12, max_tokens=1000, max_credits=Decimal("2.5")),
    )


def _checkpoint(checkpoint_id: str = CHECKPOINT, parent_id: str | None = None) -> CheckpointRecord:
    return CheckpointRecord(
        checkpoint_id=checkpoint_id,
        tenant_id=TENANT,
        project_id=PROJECT,
        parent_id=parent_id,
        manifest={"index.html": "abc123"},
        verified=True,
        created_by_run_id=RUN,
    )


def _lease(expires_at: datetime | None = None) -> LeaseRecord:
    return LeaseRecord(
        lease_id="lease_store_test",
        tenant_id=TENANT,
        run_id=RUN,
        project_id=PROJECT,
        sandbox_id="sbx_store_test",
        base_checkpoint_id=CHECKPOINT,
        expires_at=expires_at or datetime.now(UTC) + timedelta(minutes=30),
        caps={"cpu_millicores": 2000, "memory_mib": 4096},
        allowed_tools=("read_file", "apply_patch"),
    )


@contextmanager
def memory_stores() -> Iterator[Stores]:
    yield StoreBundle(
        projects=InMemoryProjectStore(),
        runs=InMemoryRunStore(),
        quota=InMemoryQuotaStore(),
        audit=InMemoryAuditStore(),
        leases=InMemoryLeaseStore(),
        checkpoints=InMemoryCheckpointStore(),
    )


@contextmanager
def postgres_stores() -> Iterator[Stores]:
    global TENANT, PROJECT, RUN, CHECKPOINT

    dsn = os.environ.get("LOOPIT_TEST_DSN")
    if not dsn:
        pytest.skip("LOOPIT_TEST_DSN is not set")
    from loopit_store.postgres import (
        PostgresAuditStore,
        PostgresCheckpointStore,
        PostgresLeaseStore,
        PostgresProjectStore,
        PostgresQuotaStore,
        PostgresRunStore,
        connect,
    )

    migrate(dsn)
    with connect(dsn) as conn:
        suffix = uuid.uuid4().hex[:10]
        tenant = f"{TENANT}_{suffix}"
        project = f"{PROJECT}_{suffix}"
        run = f"{RUN}_{suffix}"
        checkpoint = f"{CHECKPOINT}_{suffix}"
        conn.execute("INSERT INTO tenants (tenant_id, name) VALUES (%s, %s)", (tenant, tenant))

        stores = StoreBundle(
            projects=PostgresProjectStore(conn),
            runs=PostgresRunStore(conn),
            quota=PostgresQuotaStore(conn),
            audit=PostgresAuditStore(conn),
            leases=PostgresLeaseStore(conn),
            checkpoints=PostgresCheckpointStore(conn),
        )

        old = (TENANT, PROJECT, RUN, CHECKPOINT)
        TENANT, PROJECT, RUN, CHECKPOINT = tenant, project, run, checkpoint
        try:
            yield stores
        finally:
            TENANT, PROJECT, RUN, CHECKPOINT = old


@pytest.fixture(params=["memory", "postgres"])
def stores(request: pytest.FixtureRequest) -> Iterator[Stores]:
    manager = memory_stores() if request.param == "memory" else postgres_stores()
    with manager as value:
        yield value


def test_project_store_creates_lists_and_updates_current_checkpoint(stores: Stores) -> None:
    stores.projects.create(_project())
    assert stores.projects.get(PROJECT, tenant_id=TENANT) is not None
    assert stores.projects.get(PROJECT, tenant_id="tenant_other") is None
    assert [project.project_id for project in stores.projects.list_for_tenant(TENANT)] == [PROJECT]


def test_run_store_tracks_lifecycle_and_events(stores: Stores) -> None:
    stores.projects.create(_project())
    stores.runs.create(_run())
    assert stores.runs.start(RUN, tenant_id=TENANT).status == "running"
    progressed = stores.runs.update_progress(
        RUN, tenant_id=TENANT, iterations=3, cost_credits=Decimal("0.125")
    )
    assert progressed.iterations == 3
    assert progressed.cost_credits == Decimal("0.125")

    event = stores.runs.append_event(
        RunEvent(event_id="run_ev_1", run_id=RUN, event_type="tool.called", detail={"tool": "read"})
    )
    assert stores.runs.events(RUN) == (event,)

    finished = stores.runs.finish(
        RUN, tenant_id=TENANT, status="succeeded", summary="done", cost_credits=Decimal("0.5")
    )
    assert finished.finished_at is not None
    assert finished.summary == "done"
    assert stores.runs.list_for_project(PROJECT, tenant_id=TENANT)[0].run_id == RUN
    assert stores.runs.list_for_tenant(TENANT)[0].run_id == RUN


def test_checkpoint_store_tracks_current_parent_tree_and_pins(stores: Stores) -> None:
    stores.projects.create(_project())
    stores.runs.create(_run())
    root = stores.checkpoints.create(_checkpoint())
    child = stores.checkpoints.create(_checkpoint("ckpt_child", parent_id=root.checkpoint_id))

    assert stores.checkpoints.current(PROJECT, tenant_id=TENANT) == child
    assert stores.checkpoints.ancestors(child.checkpoint_id, tenant_id=TENANT) == (root,)
    stores.checkpoints.set_current(PROJECT, tenant_id=TENANT, checkpoint_id=root.checkpoint_id)
    assert stores.checkpoints.current(PROJECT, tenant_id=TENANT) == root

    stores.checkpoints.pin(root.checkpoint_id, run_id=RUN)
    assert stores.checkpoints.is_pinned(root.checkpoint_id)
    stores.checkpoints.unpin(root.checkpoint_id, run_id=RUN)
    assert not stores.checkpoints.is_pinned(root.checkpoint_id)


def test_lease_store_tracks_active_release_and_expiry(stores: Stores) -> None:
    stores.projects.create(_project())
    stores.runs.create(_run())
    stores.checkpoints.create(_checkpoint())

    lease = stores.leases.create(_lease())
    assert stores.leases.get(lease.lease_id, tenant_id=TENANT) == lease
    assert stores.leases.active_for_tenant(TENANT) == (lease,)
    released = stores.leases.release(lease.lease_id, tenant_id=TENANT)
    assert released.status == "released"
    assert stores.leases.active_for_tenant(TENANT) == ()

    expired = replace(_lease(datetime.now(UTC) - timedelta(seconds=1)), lease_id="lease_expired")
    stores.leases.create(expired)
    assert stores.leases.expire_due()[0].status == "expired"


def test_quota_store_is_append_only_source_of_truth(stores: Stores) -> None:
    stores.projects.create(_project())
    stores.runs.create(_run())
    stores.quota.append(
        QuotaEntry(
            entry_id="quota_credit",
            tenant_id=TENANT,
            amount=Decimal("10"),
            kind="credit",
            source="test",
        )
    )
    stores.quota.append(
        QuotaEntry(
            entry_id="quota_debit",
            tenant_id=TENANT,
            run_id=RUN,
            amount=Decimal("1.25"),
            kind="debit",
            source="router",
        )
    )
    assert stores.quota.balance(TENANT) == Decimal("8.75")
    assert [entry.entry_id for entry in stores.quota.entries_for_tenant(TENANT)] == [
        "quota_credit",
        "quota_debit",
    ]


def test_audit_store_appends_hash_chain_without_mutation_api(stores: Stores) -> None:
    first = stores.audit.append(
        AuditEvent(
            type="run.created",
            tenant_id=TENANT,
            actor_kind="service",
            actor_service="store-test",
            project_id=PROJECT,
            run_id=RUN,
            plane="control",
            outcome="success",
            detail={"prompt": "redacted by caller"},
        )
    )
    second = stores.audit.append(
        {
            "event_id": "ev_manual",
            "occurred_at": datetime.now(UTC).isoformat(),
            "type": "run.completed",
            "tenant_id": TENANT,
            "actor": {"kind": "service", "service": "store-test"},
        }
    )
    assert second.prev_row_hash == first.row_hash
    assert stores.audit.verify_chain()
    assert stores.audit.list_for_tenant(TENANT) == (first, second)
    assert not hasattr(stores.audit, "delete")
    assert not hasattr(stores.audit, "update")


def test_run_budget_rejects_unbounded_iterations() -> None:
    with pytest.raises(ValueError, match="max_iterations"):
        RunBudget(max_iterations=0)
