"""The sandbox scheduler (P1-1, Doc 02 §2 §6).

Owns the lifecycle of every sandbox: hand one out under a lease, enforce the
lease's TTL and per-tenant concurrency, and destroy it on completion. Four rules
carry the isolation guarantee:

* **One sandbox, one tenant, one run.** Nothing is ever shared or reused.
* **Every lease has a TTL.** An open-ended lease is an unbounded bill and an
  indefinitely live machine.
* **Recycle on done means destroy.** :meth:`release` never returns anything to
  the pool.
* **Expired leases are reaped, not tolerated.** A run that overruns its TTL has
  its sandbox destroyed whether or not it noticed.

Every acquire, release, refusal and reap emits an audit record, because a
sandbox's existence is both a billing fact and a forensics fact.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Protocol, runtime_checkable

from loopit_agent_core.audit import AuditEvent, AuditSink, Outcome
from loopit_sandbox_sdk.lease import Lease, ResourceCaps

from .errors import (
    LeaseExpired,
    LeaseNotFound,
    TenantConcurrencyExceeded,
)
from .pool import WarmPool
from .provider import Sandbox

SERVICE_NAME = "scheduler"

#: Default ceiling on concurrent sandboxes per tenant. One tenant's fan-out must
#: not become every other tenant's queue.
DEFAULT_TENANT_CONCURRENCY = 4


@runtime_checkable
class CheckpointPinner(Protocol):
    """The slice of ``CheckpointStore`` the scheduler needs.

    Declared structurally so the scheduler does not import the checkpoint
    package: pinning is an optional integration, and a hard dependency would
    make the scheduler untestable without a checkpoint store.
    """

    def pin(self, checkpoint_id: str, *, run_id: str) -> None: ...

    def unpin(self, checkpoint_id: str, *, run_id: str) -> None: ...


@dataclass(slots=True)
class Assignment:
    """A live sandbox and the lease that authorises it."""

    lease: Lease
    sandbox: Sandbox
    project_id: str

    @property
    def lease_id(self) -> str:
        return self.lease.lease_id

    @property
    def tenant_id(self) -> str:
        return self.lease.tenant_id


class Scheduler:
    """Hands out leased sandboxes and guarantees they are destroyed.

    Args:
        pool: supplies and destroys sandboxes.
        audit: append-only sink for lifecycle records.
        tenant_concurrency: max simultaneous sandboxes per tenant.
        pin_checkpoints: optional checkpoint store. When supplied, the base
            checkpoint is pinned for the life of the lease so retention cannot
            collect the state a live run is working against.
    """

    def __init__(
        self,
        *,
        pool: WarmPool,
        audit: AuditSink,
        tenant_concurrency: int = DEFAULT_TENANT_CONCURRENCY,
        pin_checkpoints: CheckpointPinner | None = None,
    ) -> None:
        if tenant_concurrency < 1:
            raise ValueError("tenant_concurrency must be at least 1")

        self._pool = pool
        self._audit = audit
        self._tenant_concurrency = tenant_concurrency
        self._pinner = pin_checkpoints
        self._assignments: dict[str, Assignment] = {}

    # --- Acquire --------------------------------------------------------------

    def acquire(
        self,
        *,
        tenant_id: str,
        run_id: str,
        project_id: str,
        base_checkpoint_id: str,
        ttl_seconds: int = 1800,
        caps: ResourceCaps | None = None,
        allowed_tools: frozenset[str] | None = None,
        now: datetime | None = None,
    ) -> Assignment:
        """Lease a fresh sandbox for one run.

        Reaps expired leases first: capacity held by a run that already blew its
        TTL should not cause a legitimate request to be refused.
        """
        self.reap_expired(now=now)

        held = self.tenant_lease_count(tenant_id)
        if held >= self._tenant_concurrency:
            self._emit(
                "sandbox.acquire.refused",
                tenant_id=tenant_id,
                run_id=run_id,
                project_id=project_id,
                outcome="denied",
                detail={"reason": "tenant_concurrency", "held": held},
            )
            raise TenantConcurrencyExceeded(
                f"tenant {tenant_id} already holds {held} sandboxes "
                f"(max {self._tenant_concurrency})"
            )

        try:
            sandbox = self._pool.take(tenant_id, now=now)
        except Exception as exc:
            self._emit(
                "sandbox.acquire.refused",
                tenant_id=tenant_id,
                run_id=run_id,
                project_id=project_id,
                outcome="denied",
                detail={"reason": type(exc).__name__, "message": str(exc)},
            )
            raise

        lease = Lease.issue(
            lease_id=f"lease_{uuid.uuid4().hex[:16]}",
            tenant_id=tenant_id,
            run_id=run_id,
            base_checkpoint_id=base_checkpoint_id,
            ttl_seconds=ttl_seconds,
            caps=caps or sandbox.caps,
            allowed_tools=allowed_tools,
        )

        if self._pinner is not None:
            self._pinner.pin(base_checkpoint_id, run_id=run_id)

        assignment = Assignment(lease=lease, sandbox=sandbox, project_id=project_id)
        self._assignments[lease.lease_id] = assignment

        self._emit(
            "sandbox.acquired",
            tenant_id=tenant_id,
            run_id=run_id,
            project_id=project_id,
            lease_id=lease.lease_id,
            outcome="success",
            detail={
                "sandbox_id": sandbox.sandbox_id,
                "base_checkpoint_id": base_checkpoint_id,
                "ttl_seconds": ttl_seconds,
                "caps": {
                    "cpu_millicores": lease.caps.cpu_millicores,
                    "memory_mib": lease.caps.memory_mib,
                    "disk_mib": lease.caps.disk_mib,
                    "wall_clock_seconds": lease.caps.wall_clock_seconds,
                },
                "allowed_tools": sorted(lease.allowed_tools),
            },
        )
        return assignment

    # --- Read -----------------------------------------------------------------

    def resolve(self, lease_id: str, *, tenant_id: str, now: datetime | None = None) -> Assignment:
        """Look up an active lease, refusing expired or foreign ones.

        A foreign lease is reported as not-found rather than as a permission
        error: confirming that another tenant's lease exists is itself a leak.
        """
        assignment = self._assignments.get(lease_id)
        if assignment is None or assignment.tenant_id != tenant_id:
            raise LeaseNotFound(f"no active lease {lease_id!r} for tenant {tenant_id!r}")

        if assignment.lease.is_expired(now):
            self.release(lease_id, tenant_id=assignment.tenant_id, reason="expired")
            raise LeaseExpired(f"lease {lease_id} expired at {assignment.lease.expires_at}")

        return assignment

    def tenant_lease_count(self, tenant_id: str) -> int:
        return sum(1 for a in self._assignments.values() if a.tenant_id == tenant_id)

    @property
    def active_leases(self) -> tuple[str, ...]:
        return tuple(self._assignments)

    def __iter__(self) -> Iterator[Assignment]:
        return iter(list(self._assignments.values()))

    # --- Release --------------------------------------------------------------

    def pause(self, lease_id: str, *, tenant_id: str) -> None:
        """Pause the sandbox behind an active lease (idle cost control)."""
        assignment = self.resolve(lease_id, tenant_id=tenant_id)
        self._pool.pause_assigned(assignment.sandbox.sandbox_id)
        self._emit(
            "sandbox.paused",
            tenant_id=assignment.tenant_id,
            run_id=assignment.lease.run_id,
            lease_id=lease_id,
            outcome="success",
            detail={"sandbox_id": assignment.sandbox.sandbox_id},
        )

    def resume(self, lease_id: str, *, tenant_id: str) -> None:
        """Resume a previously paused sandbox behind an active lease."""
        assignment = self.resolve(lease_id, tenant_id=tenant_id)
        self._pool.resume_assigned(assignment.sandbox.sandbox_id)
        self._emit(
            "sandbox.resumed",
            tenant_id=assignment.tenant_id,
            run_id=assignment.lease.run_id,
            lease_id=lease_id,
            outcome="success",
            detail={"sandbox_id": assignment.sandbox.sandbox_id},
        )

    def release(self, lease_id: str, *, tenant_id: str, reason: str = "completed") -> None:
        """Destroy the sandbox behind a lease. Idempotent.

        Idempotence matters because release runs in `finally` blocks and in the
        reaper; a second call raising would mask the original failure.
        """
        assignment = self._assignments.get(lease_id)
        if assignment is None:
            return
        if assignment.tenant_id != tenant_id:
            raise LeaseNotFound(f"no active lease {lease_id!r} for tenant {tenant_id!r}")
        removed = self._assignments.pop(lease_id)

        self._pool.release(removed.sandbox)

        if self._pinner is not None:
            self._pinner.unpin(removed.lease.base_checkpoint_id, run_id=removed.lease.run_id)

        self._emit(
            "sandbox.released",
            tenant_id=removed.tenant_id,
            run_id=removed.lease.run_id,
            lease_id=lease_id,
            outcome="success",
            detail={
                "sandbox_id": assignment.sandbox.sandbox_id,
                "reason": reason,
                "destroyed": True,
            },
        )

    def renew(
        self,
        lease_id: str,
        *,
        tenant_id: str,
        ttl_seconds: int = 1800,
        now: datetime | None = None,
    ) -> Assignment:
        """Extend an active lease's TTL after resolving tenant ownership."""
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        assignment = self.resolve(lease_id, tenant_id=tenant_id, now=now)
        renewed = Assignment(
            lease=replace(
                assignment.lease,
                expires_at=(now or datetime.now(UTC)) + timedelta(seconds=ttl_seconds),
            ),
            sandbox=assignment.sandbox,
            project_id=assignment.project_id,
        )
        self._assignments[lease_id] = renewed
        self._emit(
            "sandbox.renewed",
            tenant_id=tenant_id,
            run_id=renewed.lease.run_id,
            lease_id=lease_id,
            outcome="success",
            detail={"ttl_seconds": ttl_seconds},
        )
        return renewed

    def reap_expired(self, *, now: datetime | None = None) -> int:
        """Destroy every sandbox whose lease has passed its TTL."""
        moment = now or datetime.now(UTC)
        expired = [
            lease_id
            for lease_id, assignment in self._assignments.items()
            if assignment.lease.is_expired(moment)
        ]
        for lease_id in expired:
            assignment = self._assignments[lease_id]
            self.release(lease_id, tenant_id=assignment.tenant_id, reason="ttl_expired")
        return len(expired)

    def shutdown(self) -> None:
        """Destroy every sandbox this scheduler owns, leased or warm."""
        for lease_id in list(self._assignments):
            assignment = self._assignments[lease_id]
            self.release(lease_id, tenant_id=assignment.tenant_id, reason="shutdown")
        self._pool.drain()

    # --- Internals ------------------------------------------------------------

    def _emit(
        self,
        event_type: str,
        *,
        tenant_id: str,
        outcome: Outcome,
        detail: dict[str, object],
        run_id: str | None = None,
        project_id: str | None = None,
        lease_id: str | None = None,
    ) -> None:
        self._audit.emit(
            AuditEvent(
                type=event_type,
                tenant_id=tenant_id,
                actor_kind="service",
                actor_service=SERVICE_NAME,
                project_id=project_id,
                run_id=run_id,
                sandbox_lease_id=lease_id,
                plane="control",
                outcome=outcome,
                detail=detail,
            )
        )
