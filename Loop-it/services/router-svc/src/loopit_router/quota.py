"""Per-tenant quota, enforced *before* tokens are spent (Doc 06 §1, Doc 09 §3).

Reconciling spend after the fact is how a runaway agent loop turns into an
unrecoverable bill. The ledger reserves an upper-bound cost before the upstream
call, then settles to actual afterwards. A tenant at their limit is refused, and
the refusal is an audit event, not a silent truncation.

The credit ledger — not the payment processor — is the source of truth for
what a tenant may spend (ADR-0016).
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field


class QuotaError(Exception):
    """Base class for quota failures."""


class QuotaExceeded(QuotaError):
    """The tenant cannot afford this call. Raised before any spend occurs."""

    def __init__(self, tenant_id: str, requested: float, remaining: float) -> None:
        super().__init__(
            f"tenant {tenant_id!r} needs {requested:.4f} credits but has {remaining:.4f} remaining"
        )
        self.tenant_id = tenant_id
        self.requested = requested
        self.remaining = remaining


@dataclass(frozen=True, slots=True)
class TenantQuota:
    """A tenant's spending envelope.

    ``concurrent_runs`` is here rather than in the sandbox pool because
    concurrency is a cost control first and a capacity control second: it is the
    tightest bound on how fast a single tenant can burn credits.
    """

    tenant_id: str
    credit_limit: float
    concurrent_runs: int = 3

    def __post_init__(self) -> None:
        if self.credit_limit < 0:
            raise QuotaError(f"credit_limit for {self.tenant_id!r} must not be negative")
        if self.concurrent_runs < 1:
            raise QuotaError(f"concurrent_runs for {self.tenant_id!r} must be at least 1")


@dataclass
class _Account:
    settled: float = 0.0
    reserved: float = 0.0

    @property
    def committed(self) -> float:
        return self.settled + self.reserved


class QuotaLedger:
    """Tracks reserved and settled spend per tenant.

    Thread-safe because a single tenant's parallel tasks share one envelope; the
    check and the reservation must be atomic or two concurrent calls can each
    see enough headroom for a spend only one of them can afford.
    """

    def __init__(self, quotas: dict[str, TenantQuota] | None = None) -> None:
        self._quotas: dict[str, TenantQuota] = dict(quotas or {})
        self._accounts: dict[str, _Account] = {}
        self._lock = threading.RLock()

    def set_quota(self, quota: TenantQuota) -> None:
        with self._lock:
            self._quotas[quota.tenant_id] = quota

    def quota_for(self, tenant_id: str) -> TenantQuota:
        try:
            return self._quotas[tenant_id]
        except KeyError:
            raise QuotaError(
                f"no quota configured for tenant {tenant_id!r}; unknown tenants are "
                "refused rather than defaulted to unlimited"
            ) from None

    def spent(self, tenant_id: str) -> float:
        """Credits actually settled for this tenant."""
        with self._lock:
            return self._accounts.get(tenant_id, _Account()).settled

    def remaining(self, tenant_id: str) -> float:
        """Credits still available, counting outstanding reservations."""
        with self._lock:
            quota = self.quota_for(tenant_id)
            account = self._accounts.setdefault(tenant_id, _Account())
            return quota.credit_limit - account.committed

    @contextmanager
    def reserve(self, tenant_id: str, estimate: float) -> Iterator[Reservation]:
        """Reserve ``estimate`` credits for the duration of the block.

        Raises :class:`QuotaExceeded` *before* yielding if the tenant cannot
        afford it. The reservation is always released, and is replaced by a
        settled charge if :meth:`Reservation.settle` was called.
        """
        if estimate < 0:
            raise QuotaError("cost estimate must not be negative")

        with self._lock:
            quota = self.quota_for(tenant_id)
            account = self._accounts.setdefault(tenant_id, _Account())
            if account.committed + estimate > quota.credit_limit:
                raise QuotaExceeded(tenant_id, estimate, quota.credit_limit - account.committed)
            account.reserved += estimate

        reservation = Reservation(tenant_id=tenant_id, estimate=estimate)
        try:
            yield reservation
        finally:
            with self._lock:
                account = self._accounts[tenant_id]
                account.reserved -= estimate
                # A failed call still costs whatever it burned before failing.
                account.settled += reservation.actual


@dataclass
class Reservation:
    """A held claim on a tenant's credits, settled to the real cost on exit."""

    tenant_id: str
    estimate: float
    actual: float = field(default=0.0)

    def settle(self, actual: float) -> None:
        """Record what the call actually cost."""
        if actual < 0:
            raise QuotaError("actual cost must not be negative")
        self.actual = actual
