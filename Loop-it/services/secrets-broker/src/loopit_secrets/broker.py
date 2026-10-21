"""The broker — issues, mediates, revokes, and expires per-step secret leases.

This is the enforcement point for every rule the other modules make possible. A
:class:`StepContext` names the run, step, tenant, project, and — crucially — the
exact set of secret names the step declared it needs. :meth:`SecretsBroker.issue`
will lease *only* a declared name, refusing anything else (least privilege), and
:meth:`SecretsBroker.reveal` is the single door to a plaintext, so the grant can
be revoked and expires on its own.

Three lifecycle hazards from the ticket are handled deliberately:

* **Expiry mid-step.** ``reveal`` checks the clock on every call; once ``expires_at``
  has passed the lease transitions to :attr:`~loopit_secrets.lease.LeaseState.EXPIRED`
  and access is denied — a step that runs long does not keep a stale credential.
* **Run cancellation.** :meth:`revoke_run` revokes every live lease for a run in
  one call, so a cancelled or killed run leaves no readable secret behind.
* **Replay.** A lease id is single-purpose. Presenting a forged id, an id whose
  lease is already expired or revoked, or a handle whose fields disagree with the
  recorded lease is denied and audited — a captured ticket cannot be reused to
  reach a secret it no longer authorises.

The broker is wired to exactly one :class:`~loopit_secrets.store.SecretStore`,
and therefore to exactly one environment; it has no method that accepts an
environment, which is what makes the build↔prod firewall structural here rather
than a comparison. Every decision — issue, deny, reveal, revoke — emits one audit
record naming the secret and lease id but never the value (Doc 08 §5/§6, I10).

Connector credentials are leases, not environment variables. ``issue`` returns a
:class:`~loopit_secrets.lease.Lease` bound to one run. ``reveal`` returns the
plaintext to the caller and never writes ``os.environ``. :meth:`request_scope`
revokes those leases when the request returns, and :meth:`revoke_run` revokes
whatever is still live when the run itself ends.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from loopit_agent_core.audit import AuditEvent, AuditSink, Outcome

from .environment import PLATFORM_RESERVED_NAMES, Environment
from .errors import (
    LeaseExpired,
    LeaseMismatch,
    LeaseRevoked,
    LeaseTooLong,
    PlatformSecretForbidden,
    SecretNotFound,
    UndeclaredSecret,
    UnknownLease,
)
from .lease import Lease, LeaseState
from .store import SecretStore
from .values import SecretValue

#: Leases are short-lived by construction. A build step that needs a secret needs
#: it for the moment it runs, not for the session; capping the ttl keeps a leaked
#: ticket useful for minutes rather than for the life of the run.
MAX_LEASE_TTL: timedelta = timedelta(minutes=5)

Clock = Callable[[], datetime]


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class StepContext:
    """The identity and declared least-privilege scope of one build step.

    ``declared_secrets`` is the whole of what the step is permitted to lease.
    There is no wildcard and no "all" sentinel: a name absent from this set is a
    name the step cannot reach, which is what turns least privilege from a
    convention into a checked property.
    """

    run_id: str
    step_id: str
    tenant_id: str
    project_id: str
    declared_secrets: frozenset[str]


@dataclass(slots=True)
class _LeaseRecord:
    """The broker's private, authoritative view of a lease and its plaintext.

    The value is excluded from ``repr`` and is a :class:`SecretValue` besides, so
    even this internal record cannot leak the plaintext into a traceback.
    """

    lease: Lease
    value: SecretValue = field(repr=False)
    state: LeaseState = LeaseState.ACTIVE
    redeem_count: int = 0


class SecretsBroker:
    """Mediates every project-secret access for one environment's build steps."""

    def __init__(
        self,
        store: SecretStore,
        *,
        audit: AuditSink,
        clock: Clock = _utcnow,
        max_ttl: timedelta = MAX_LEASE_TTL,
    ) -> None:
        self._store = store
        self._audit = audit
        self._clock = clock
        self._max_ttl = max_ttl
        self._leases: dict[str, _LeaseRecord] = {}

    @property
    def environment(self) -> Environment:
        """The single environment this broker serves; there is no other."""
        return self._store.environment

    def issue(self, context: StepContext, name: str, *, ttl: timedelta) -> Lease:
        """Lease a declared secret to a step, or deny and audit the attempt.

        The checks run in escalating order of trust: refuse platform-owned names
        outright, then refuse anything the step did not declare, then require the
        secret to actually exist for this tenant/project in this environment.
        Only a request that clears all three yields a lease.
        """
        if name in PLATFORM_RESERVED_NAMES:
            self._deny(context, name, "platform_reserved")
            raise PlatformSecretForbidden(
                f"{name!r} is a platform-owned secret; the sandbox reaches models "
                "only via the router and never holds platform credentials"
            )
        if name not in context.declared_secrets:
            self._deny(context, name, "undeclared")
            raise UndeclaredSecret(
                f"step {context.step_id!r} did not declare {name!r}; a step may "
                "lease only the names it declares it needs"
            )
        secret = self._store.get(context.tenant_id, context.project_id, name)
        if secret is None:
            self._deny(context, name, "not_found")
            raise SecretNotFound(
                f"no secret {name!r} for this project in the {self.environment.value!r} environment"
            )

        now = self._clock()
        lease = Lease(
            lease_id=f"lease_{uuid.uuid4().hex}",
            secret_name=name,
            environment=self.environment,
            run_id=context.run_id,
            step_id=context.step_id,
            tenant_id=context.tenant_id,
            project_id=context.project_id,
            issued_at=now,
            expires_at=now + self._checked_ttl(context, name, ttl),
        )
        self._leases[lease.lease_id] = _LeaseRecord(lease=lease, value=secret.value)
        self._emit("secret.lease.issued", "allowed", lease=lease)
        return lease

    @contextmanager
    def request_scope(self, context: StepContext) -> Iterator[Callable[..., Lease]]:
        """Issue leases that die with this request and never enter ``os.environ``.

        The yielded ``issue`` is :meth:`issue` plus bookkeeping. Leaving the
        block — including by exception — revokes every lease this scope issued.
        Callers pass the lease handles into the step; they do not copy values
        into the process environment. A run that is cancelled separately still
        goes through :meth:`revoke_run`.
        """

        issued: list[Lease] = []

        def issue(name: str, *, ttl: timedelta) -> Lease:
            lease = self.issue(context, name, ttl=ttl)
            issued.append(lease)
            return lease

        try:
            yield issue
        finally:
            for lease in issued:
                self.revoke(lease, reason="request_complete")

    def reveal(self, lease: Lease) -> str:
        """Return the plaintext for a live lease, or deny and audit the attempt.

        This is the only path to a plaintext. It re-validates every time — the
        lease must be known, unrevoked, unexpired, and identical to the recorded
        handle — so a ticket that was captured and replayed after its step, or
        after expiry or revocation, buys nothing.
        """
        record = self._leases.get(lease.lease_id)
        if record is None:
            self._emit("secret.reveal", "denied", lease=lease, reason="unknown_lease")
            raise UnknownLease(f"no live lease {lease.lease_id!r}")
        if record.lease != lease:
            self._emit("secret.reveal", "denied", lease=record.lease, reason="handle_mismatch")
            raise LeaseMismatch(
                f"presented handle for {lease.lease_id!r} does not match the issued lease"
            )
        if record.state is LeaseState.REVOKED:
            self._emit("secret.reveal", "denied", lease=record.lease, reason="revoked")
            raise LeaseRevoked(f"lease {lease.lease_id!r} was revoked")
        if self._clock() >= record.lease.expires_at:
            record.state = LeaseState.EXPIRED
            self._emit("secret.reveal", "denied", lease=record.lease, reason="expired")
            raise LeaseExpired(f"lease {lease.lease_id!r} expired at {record.lease.expires_at}")

        record.redeem_count += 1
        self._emit("secret.reveal", "success", lease=record.lease)
        return record.value.reveal()

    def revoke(self, lease: Lease, *, reason: str = "explicit") -> None:
        """Revoke a single lease. Idempotent: revoking a dead lease is a no-op."""
        record = self._leases.get(lease.lease_id)
        if record is None or record.state is not LeaseState.ACTIVE:
            return
        record.state = LeaseState.REVOKED
        self._emit("secret.lease.revoked", "success", lease=record.lease, reason=reason)

    def revoke_step(self, run_id: str, step_id: str) -> None:
        """Revoke every live lease for a step — call on step completion."""
        self._revoke_matching(
            lambda r: r.lease.run_id == run_id and r.lease.step_id == step_id,
            reason="step_complete",
        )

    def revoke_run(self, run_id: str) -> None:
        """Revoke every live lease for a run — call on run cancellation or kill."""
        self._revoke_matching(lambda r: r.lease.run_id == run_id, reason="run_cancelled")

    def _revoke_matching(self, predicate: Callable[[_LeaseRecord], bool], *, reason: str) -> None:
        for record in self._active_records():
            if predicate(record):
                record.state = LeaseState.REVOKED
                self._emit("secret.lease.revoked", "success", lease=record.lease, reason=reason)

    def _active_records(self) -> Iterable[_LeaseRecord]:
        return [r for r in self._leases.values() if r.state is LeaseState.ACTIVE]

    def _checked_ttl(self, context: StepContext, name: str, ttl: timedelta) -> timedelta:
        if ttl <= timedelta(0) or ttl > self._max_ttl:
            self._deny(context, name, "ttl_out_of_bounds")
            raise LeaseTooLong(
                f"ttl {ttl} is not in (0, {self._max_ttl}]; leases are short-lived by design"
            )
        return ttl

    def _deny(self, context: StepContext, name: str, reason: str) -> None:
        self._audit.emit(
            AuditEvent(
                type="secret.lease.denied",
                tenant_id=context.tenant_id,
                actor_kind="service",
                actor_service="secrets-broker",
                project_id=context.project_id,
                run_id=context.run_id,
                plane="control",
                outcome="denied",
                detail={
                    "name": name,
                    "step_id": context.step_id,
                    "environment": self.environment.value,
                    "reason": reason,
                },
            )
        )

    def _emit(
        self,
        event_type: str,
        outcome: Outcome,
        *,
        lease: Lease,
        reason: str | None = None,
    ) -> None:
        detail: dict[str, str] = {
            "lease_id": lease.lease_id,
            "name": lease.secret_name,
            "step_id": lease.step_id,
            "environment": lease.environment.value,
        }
        if reason is not None:
            detail["reason"] = reason
        self._audit.emit(
            AuditEvent(
                type=event_type,
                tenant_id=lease.tenant_id,
                actor_kind="service",
                actor_service="secrets-broker",
                project_id=lease.project_id,
                run_id=lease.run_id,
                plane="control",
                outcome=outcome,
                detail=detail,
            )
        )


__all__ = [
    "MAX_LEASE_TTL",
    "SecretsBroker",
    "StepContext",
]
