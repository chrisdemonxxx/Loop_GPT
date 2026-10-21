"""Tests for the scheduler.

These cover the four rules that make sandbox isolation operational: one tenant
per sandbox, every lease has a TTL, release means destroy, and expired leases
are reaped rather than tolerated.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_checkpoint import CheckpointStore, InMemoryBlobStore
from loopit_sandbox_sdk.lease import LeaseError, ResourceCaps
from loopit_scheduler import (
    Assignment,
    CheckpointPinner,
    InMemoryProvider,
    LeaseExpired,
    LeaseNotFound,
    PoolExhausted,
    SandboxState,
    Scheduler,
    TenantConcurrencyExceeded,
    WarmPool,
)

TENANT = "tenant_acme"
PROJECT = "proj_shop"
CHECKPOINT = "ckpt_base"


@pytest.fixture
def provider() -> InMemoryProvider:
    return InMemoryProvider()


@pytest.fixture
def audit() -> InMemoryAuditSink:
    return InMemoryAuditSink()


@pytest.fixture
def scheduler(provider: InMemoryProvider, audit: InMemoryAuditSink) -> Scheduler:
    return Scheduler(pool=WarmPool(provider, target_size=2, max_live=20), audit=audit)


def _acquire(
    scheduler: Scheduler, *, tenant_id: str = TENANT, run_id: str, **kwargs: object
) -> Assignment:
    return scheduler.acquire(
        tenant_id=tenant_id,
        run_id=run_id,
        project_id=PROJECT,
        base_checkpoint_id=CHECKPOINT,
        **kwargs,  # type: ignore[arg-type]
    )


# --- Acquire ------------------------------------------------------------------


def test_acquire_returns_a_lease_bound_to_one_run(scheduler: Scheduler) -> None:
    assignment = _acquire(scheduler, run_id="run_1")

    assert assignment.lease.tenant_id == TENANT
    assert assignment.lease.run_id == "run_1"
    assert assignment.lease.base_checkpoint_id == CHECKPOINT
    assert assignment.sandbox.state is SandboxState.ASSIGNED


def test_every_lease_has_a_ttl(scheduler: Scheduler) -> None:
    """An open-ended lease is an unbounded bill and a machine nobody reclaims."""
    assignment = _acquire(scheduler, run_id="run_1", ttl_seconds=600)

    remaining = assignment.lease.expires_at - datetime.now(UTC)
    assert timedelta(seconds=595) < remaining <= timedelta(seconds=600)


def test_each_acquire_gets_a_distinct_sandbox(scheduler: Scheduler) -> None:
    first = _acquire(scheduler, run_id="run_1")
    second = _acquire(scheduler, tenant_id="tenant_other", run_id="run_2")

    assert first.sandbox.sandbox_id != second.sandbox.sandbox_id
    assert first.lease.lease_id != second.lease.lease_id


def test_a_lease_never_grants_deploy(scheduler: Scheduler) -> None:
    """Deploy is a separately gated action with its own credentials (I7)."""
    with pytest.raises(LeaseError, match="deploy"):
        _acquire(
            scheduler,
            run_id="run_1",
            allowed_tools=frozenset({"read_file", "deploy"}),
        )


def test_caps_default_to_the_sandbox_caps(scheduler: Scheduler) -> None:
    assignment = _acquire(scheduler, run_id="run_1")

    assert assignment.lease.caps.wall_clock_seconds > 0
    assert assignment.lease.caps.memory_mib > 0


def test_explicit_caps_are_applied(scheduler: Scheduler) -> None:
    assignment = _acquire(scheduler, run_id="run_1", caps=ResourceCaps(memory_mib=1024))

    assert assignment.lease.caps.memory_mib == 1024


# --- Tenant isolation and quota ----------------------------------------------


def test_tenant_concurrency_is_capped(provider: InMemoryProvider, audit: InMemoryAuditSink) -> None:
    """One tenant's fan-out must not become every other tenant's queue."""
    scheduler = Scheduler(
        pool=WarmPool(provider, target_size=1, max_live=20), audit=audit, tenant_concurrency=2
    )
    _acquire(scheduler, run_id="run_1")
    _acquire(scheduler, run_id="run_2")

    with pytest.raises(TenantConcurrencyExceeded):
        _acquire(scheduler, run_id="run_3")


def test_another_tenant_is_unaffected_by_a_neighbours_cap(
    provider: InMemoryProvider, audit: InMemoryAuditSink
) -> None:
    scheduler = Scheduler(
        pool=WarmPool(provider, target_size=1, max_live=20), audit=audit, tenant_concurrency=1
    )
    _acquire(scheduler, run_id="run_1")

    assert _acquire(scheduler, tenant_id="tenant_b", run_id="run_2").tenant_id == "tenant_b"


def test_releasing_frees_tenant_quota(provider: InMemoryProvider, audit: InMemoryAuditSink) -> None:
    scheduler = Scheduler(
        pool=WarmPool(provider, target_size=1, max_live=20), audit=audit, tenant_concurrency=1
    )
    first = _acquire(scheduler, run_id="run_1")
    scheduler.release(first.lease_id, tenant_id=TENANT)

    assert _acquire(scheduler, run_id="run_2").lease.run_id == "run_2"


def test_scheduler_rejects_a_zero_concurrency_configuration(
    provider: InMemoryProvider, audit: InMemoryAuditSink
) -> None:
    with pytest.raises(ValueError, match="at least 1"):
        Scheduler(pool=WarmPool(provider), audit=audit, tenant_concurrency=0)


def test_pool_exhaustion_surfaces_and_is_audited(audit: InMemoryAuditSink) -> None:
    scheduler = Scheduler(pool=WarmPool(InMemoryProvider(), target_size=0, max_live=1), audit=audit)
    _acquire(scheduler, run_id="run_1")

    with pytest.raises(PoolExhausted):
        _acquire(scheduler, tenant_id="tenant_b", run_id="run_2")

    refusals = audit.of_type("sandbox.acquire.refused")
    assert refusals[-1].detail["reason"] == "PoolExhausted"


# --- Resolve ------------------------------------------------------------------


def test_resolve_returns_an_active_lease(scheduler: Scheduler) -> None:
    assignment = _acquire(scheduler, run_id="run_1")

    assert scheduler.resolve(assignment.lease_id, tenant_id=TENANT) is assignment


def test_another_tenant_cannot_resolve_a_lease(scheduler: Scheduler) -> None:
    """Confirming a foreign lease exists is itself a leak, so this reads as not-found."""
    assignment = _acquire(scheduler, run_id="run_1")

    with pytest.raises(LeaseNotFound):
        scheduler.resolve(assignment.lease_id, tenant_id="tenant_intruder")


def test_resolving_an_unknown_lease(scheduler: Scheduler) -> None:
    with pytest.raises(LeaseNotFound):
        scheduler.resolve("lease_nope", tenant_id=TENANT)


def test_resolving_an_expired_lease_destroys_the_sandbox(scheduler: Scheduler) -> None:
    assignment = _acquire(scheduler, run_id="run_1", ttl_seconds=60)
    later = datetime.now(UTC) + timedelta(seconds=61)

    with pytest.raises(LeaseExpired):
        scheduler.resolve(assignment.lease_id, tenant_id=TENANT, now=later)

    assert assignment.sandbox.state is SandboxState.DESTROYED
    assert assignment.lease_id not in scheduler.active_leases


# --- Release and reap ---------------------------------------------------------


def test_release_destroys_the_sandbox(provider: InMemoryProvider, scheduler: Scheduler) -> None:
    assignment = _acquire(scheduler, run_id="run_1")
    scheduler.release(assignment.lease_id, tenant_id=TENANT)

    assert not provider.is_alive(assignment.sandbox.sandbox_id)
    assert scheduler.active_leases == ()


def test_another_tenant_cannot_release_a_lease(scheduler: Scheduler) -> None:
    assignment = _acquire(scheduler, run_id="run_1")

    with pytest.raises(LeaseNotFound):
        scheduler.release(assignment.lease_id, tenant_id="tenant_intruder")

    assert assignment.lease_id in scheduler.active_leases


def test_release_is_idempotent(scheduler: Scheduler) -> None:
    """Release runs in `finally`; a second call raising would mask the real fault."""
    assignment = _acquire(scheduler, run_id="run_1")

    scheduler.release(assignment.lease_id, tenant_id=TENANT)
    scheduler.release(assignment.lease_id, tenant_id=TENANT)
    scheduler.release("lease_never_existed", tenant_id=TENANT)


def test_reap_destroys_overrun_sandboxes(scheduler: Scheduler) -> None:
    short = _acquire(scheduler, run_id="run_short", ttl_seconds=60)
    long_lived = _acquire(scheduler, run_id="run_long", ttl_seconds=3600)

    reaped = scheduler.reap_expired(now=datetime.now(UTC) + timedelta(seconds=61))

    assert reaped == 1
    assert short.sandbox.state is SandboxState.DESTROYED
    assert long_lived.lease_id in scheduler.active_leases


def test_acquire_reaps_before_refusing_on_quota(
    provider: InMemoryProvider, audit: InMemoryAuditSink
) -> None:
    """Capacity held by an already-overrun run must not block a legitimate request."""
    scheduler = Scheduler(
        pool=WarmPool(provider, target_size=1, max_live=20), audit=audit, tenant_concurrency=1
    )
    stale = _acquire(scheduler, run_id="run_stale", ttl_seconds=60)

    fresh = scheduler.acquire(
        tenant_id=TENANT,
        run_id="run_fresh",
        project_id=PROJECT,
        base_checkpoint_id=CHECKPOINT,
        now=datetime.now(UTC) + timedelta(seconds=61),
    )

    assert stale.sandbox.state is SandboxState.DESTROYED
    assert fresh.lease.run_id == "run_fresh"


def test_shutdown_destroys_everything(provider: InMemoryProvider, scheduler: Scheduler) -> None:
    _acquire(scheduler, run_id="run_1")
    _acquire(scheduler, tenant_id="tenant_b", run_id="run_2")

    scheduler.shutdown()

    assert scheduler.active_leases == ()
    assert provider.live_count == 0


# --- Checkpoint pinning -------------------------------------------------------


def test_the_base_checkpoint_is_pinned_for_the_life_of_the_lease(
    provider: InMemoryProvider, audit: InMemoryAuditSink
) -> None:
    """Retention must not collect the state a live run is working against."""
    store = CheckpointStore(InMemoryBlobStore())
    base = store.snapshot(project_id=PROJECT, tenant_id=TENANT, files={"a.py": b"1"})
    scheduler = Scheduler(
        pool=WarmPool(provider, target_size=1, max_live=20),
        audit=audit,
        pin_checkpoints=store,
    )

    assignment = scheduler.acquire(
        tenant_id=TENANT,
        run_id="run_1",
        project_id=PROJECT,
        base_checkpoint_id=base.checkpoint_id,
    )
    assert store.is_pinned(base.checkpoint_id)

    scheduler.release(assignment.lease_id, tenant_id=TENANT)
    assert not store.is_pinned(base.checkpoint_id)


def test_checkpoint_store_satisfies_the_pinner_protocol() -> None:
    assert isinstance(CheckpointStore(InMemoryBlobStore()), CheckpointPinner)


# --- Audit --------------------------------------------------------------------


def test_acquire_and_release_are_audited(scheduler: Scheduler, audit: InMemoryAuditSink) -> None:
    assignment = _acquire(scheduler, run_id="run_1")
    scheduler.release(assignment.lease_id, tenant_id=TENANT)

    acquired = audit.of_type("sandbox.acquired")[0]
    released = audit.of_type("sandbox.released")[0]

    assert acquired.tenant_id == TENANT
    assert acquired.sandbox_lease_id == assignment.lease_id
    assert acquired.plane == "control"
    assert acquired.detail["caps"]["memory_mib"] > 0
    assert released.detail["destroyed"] is True
    assert released.detail["reason"] == "completed"


def test_a_reaped_lease_is_audited_with_its_reason(
    scheduler: Scheduler, audit: InMemoryAuditSink
) -> None:
    _acquire(scheduler, run_id="run_1", ttl_seconds=60)
    scheduler.reap_expired(now=datetime.now(UTC) + timedelta(seconds=61))

    assert audit.of_type("sandbox.released")[0].detail["reason"] == "ttl_expired"


def test_a_quota_refusal_is_audited(provider: InMemoryProvider, audit: InMemoryAuditSink) -> None:
    scheduler = Scheduler(
        pool=WarmPool(provider, target_size=1, max_live=20), audit=audit, tenant_concurrency=1
    )
    _acquire(scheduler, run_id="run_1")

    with pytest.raises(TenantConcurrencyExceeded):
        _acquire(scheduler, run_id="run_2")

    refusal = audit.of_type("sandbox.acquire.refused")[0]
    assert refusal.outcome == "denied"
    assert refusal.detail["reason"] == "tenant_concurrency"


def test_audit_records_never_carry_a_secret(scheduler: Scheduler, audit: InMemoryAuditSink) -> None:
    _acquire(scheduler, run_id="run_1")
    serialised = str(audit.of_type("sandbox.acquired")[0].to_dict())

    assert "sk-" not in serialised
    assert "token" not in serialised.lower() or "[REDACTED]" in serialised


def test_iterating_the_scheduler_yields_live_assignments(scheduler: Scheduler) -> None:
    _acquire(scheduler, run_id="run_1")
    _acquire(scheduler, tenant_id="tenant_b", run_id="run_2")

    assert {a.lease.run_id for a in scheduler} == {"run_1", "run_2"}
    assert scheduler.tenant_lease_count(TENANT) == 1
