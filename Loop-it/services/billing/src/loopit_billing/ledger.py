from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, cast

from loopit_agent_core.audit import AuditEvent
from loopit_store import AuditStore, QuotaEntry, QuotaStore
from loopit_store.models import QuotaKind

ZERO = Decimal("0")


class BillingError(Exception):
    """Base billing failure."""


class ReservationNotFound(BillingError):
    """Raised when a settlement references no persisted reservation."""


class InsufficientCredits(BillingError):
    """Raised before spend when a tenant cannot afford a reservation."""

    def __init__(self, tenant_id: str, requested: Decimal, remaining: Decimal) -> None:
        super().__init__(
            f"tenant {tenant_id!r} needs {requested} credits but has {remaining} remaining"
        )
        self.tenant_id = tenant_id
        self.requested = requested
        self.remaining = remaining


@dataclass(frozen=True, slots=True)
class Reservation:
    tenant_id: str
    reservation_id: str
    amount: Decimal
    remaining_after_reservation: Decimal


@dataclass(frozen=True, slots=True)
class ReconciliationReport:
    tenant_id: str
    balance: Decimal
    entry_count: int
    duplicate_entry_ids: tuple[str, ...]
    negative_points: tuple[tuple[str, Decimal], ...]

    @property
    def ok(self) -> bool:
        return not self.duplicate_entry_ids and not self.negative_points


class BillingLedger:
    """Append-only credit ledger facade backed by ``QuotaStore``.

    ``QuotaStore`` owns persistence in the existing ``quota_ledger`` table. This
    facade adds idempotency, reservations, settlement, reconciliation, and I10
    audit emission without duplicating the store schema.
    """

    def __init__(self, *, quota: QuotaStore, audit: AuditStore) -> None:
        self._quota = quota
        self._audit = audit
        self._lock = threading.RLock()
        self._idempotency: dict[tuple[str, str], tuple[QuotaEntry, ...]] = {}

    def balance(self, tenant_id: str) -> Decimal:
        return self._quota.balance(tenant_id)

    def entries(self, tenant_id: str) -> tuple[QuotaEntry, ...]:
        return self._quota.entries_for_tenant(tenant_id)

    def reservation(self, *, tenant_id: str, reservation_id: str) -> Reservation:
        """Load a persisted, unsettled reservation owned by ``tenant_id``."""
        return self._load_reservation(tenant_id=tenant_id, reservation_id=reservation_id)

    def grant(
        self,
        *,
        tenant_id: str,
        amount: Decimal,
        source: str,
        idempotency_key: str,
        description: str = "",
        run_id: str | None = None,
    ) -> QuotaEntry:
        return self._write_one(
            tenant_id=tenant_id,
            amount=amount,
            kind="credit",
            source=source,
            idempotency_key=idempotency_key,
            description=description,
            run_id=run_id,
        )

    def debit(
        self,
        *,
        tenant_id: str,
        amount: Decimal,
        source: str,
        idempotency_key: str,
        description: str = "",
        run_id: str | None = None,
        allow_negative: bool = False,
    ) -> QuotaEntry:
        with self._lock:
            scoped_key = self._scoped_idempotency_key(tenant_id, idempotency_key)
            existing = self._idempotency.get(scoped_key)
            if existing:
                return existing[0]
            if not allow_negative and self.balance(tenant_id) - amount < ZERO:
                raise InsufficientCredits(tenant_id, amount, self.balance(tenant_id))
            return self._write_one(
                tenant_id=tenant_id,
                amount=amount,
                kind="debit",
                source=source,
                idempotency_key=idempotency_key,
                description=description,
                run_id=run_id,
            )

    def check_and_reserve(
        self,
        *,
        tenant_id: str,
        estimated_cost: Decimal,
        idempotency_key: str,
        source: str = "billing.preflight",
        run_id: str | None = None,
        description: str = "pre-spend reservation",
    ) -> Reservation:
        if estimated_cost < ZERO:
            raise ValueError("estimated_cost cannot be negative")
        with self._lock:
            scoped_key = self._scoped_idempotency_key(tenant_id, idempotency_key)
            existing = self._idempotency.get(scoped_key)
            if existing:
                entry = existing[0]
                return Reservation(
                    tenant_id=tenant_id,
                    reservation_id=entry.entry_id,
                    amount=entry.amount,
                    remaining_after_reservation=self.balance(tenant_id),
                )
            balance = self.balance(tenant_id)
            if balance - estimated_cost < ZERO:
                self._emit(
                    "billing.reservation.denied",
                    tenant_id=tenant_id,
                    source=source,
                    outcome="denied",
                    cost={"estimated_credits": str(estimated_cost)},
                    detail={"remaining_credits": str(balance)},
                    run_id=run_id,
                )
                raise InsufficientCredits(tenant_id, estimated_cost, balance)
            entry = self._write_one(
                tenant_id=tenant_id,
                amount=estimated_cost,
                kind="reservation",
                source=source,
                idempotency_key=idempotency_key,
                description=description,
                run_id=run_id,
            )
            return Reservation(
                tenant_id=tenant_id,
                reservation_id=entry.entry_id,
                amount=estimated_cost,
                remaining_after_reservation=self.balance(tenant_id),
            )

    def settle(
        self,
        *,
        reservation: Reservation,
        actual_cost: Decimal,
        idempotency_key: str,
        source: str = "billing.settlement",
        run_id: str | None = None,
        description: str = "settle pre-spend reservation to actual cost",
    ) -> tuple[QuotaEntry, QuotaEntry]:
        if actual_cost < ZERO:
            raise ValueError("actual_cost cannot be negative")
        with self._lock:
            scoped_key = self._scoped_idempotency_key(reservation.tenant_id, idempotency_key)
            existing = self._idempotency.get(scoped_key)
            if existing:
                if len(existing) != 2:
                    raise BillingError("settlement idempotency key collided with single write")
                return existing[0], existing[1]
            persisted = self._load_reservation(
                tenant_id=reservation.tenant_id, reservation_id=reservation.reservation_id
            )
            prior_settlement = self._settlement_for(
                tenant_id=persisted.tenant_id, reservation_id=persisted.reservation_id
            )
            if prior_settlement is not None:
                self._idempotency[scoped_key] = prior_settlement
                return prior_settlement
            available_after_release = self.balance(persisted.tenant_id) + persisted.amount
            if available_after_release - actual_cost < ZERO:
                raise InsufficientCredits(persisted.tenant_id, actual_cost, available_after_release)
            release = self._append(
                QuotaEntry(
                    entry_id=self._entry_id(
                        persisted.tenant_id, persisted.reservation_id, "release"
                    ),
                    tenant_id=persisted.tenant_id,
                    amount=persisted.amount,
                    kind="release",
                    source=source,
                    run_id=run_id,
                    description=f"release reservation {persisted.reservation_id}",
                )
            )
            debit = self._append(
                QuotaEntry(
                    entry_id=self._entry_id(persisted.tenant_id, persisted.reservation_id, "debit"),
                    tenant_id=persisted.tenant_id,
                    amount=actual_cost,
                    kind="debit",
                    source=source,
                    run_id=run_id,
                    description=description,
                )
            )
            self._idempotency[scoped_key] = (release, debit)
            return release, debit

    def _load_reservation(self, *, tenant_id: str, reservation_id: str) -> Reservation:
        for entry in self.entries(tenant_id):
            if entry.entry_id == reservation_id and entry.kind == "reservation":
                return Reservation(
                    tenant_id=tenant_id,
                    reservation_id=reservation_id,
                    amount=entry.amount,
                    remaining_after_reservation=self.balance(tenant_id),
                )
        raise ReservationNotFound(f"reservation {reservation_id!r} was not found")

    def _settlement_for(
        self, *, tenant_id: str, reservation_id: str
    ) -> tuple[QuotaEntry, QuotaEntry] | None:
        entries = self.entries(tenant_id)
        release_description = f"release reservation {reservation_id}"
        for index, entry in enumerate(entries):
            if (
                entry.kind == "release"
                and entry.source == "billing.settlement"
                and entry.description == release_description
            ):
                following = entries[index + 1 :]
                debit = next(
                    (
                        candidate
                        for candidate in following
                        if candidate.kind == "debit" and candidate.source == "billing.settlement"
                    ),
                    entry,
                )
                return entry, debit
        return None

    def reconcile(self, tenant_id: str) -> ReconciliationReport:
        balance = ZERO
        seen: set[str] = set()
        duplicates: list[str] = []
        negative_points: list[tuple[str, Decimal]] = []
        entries = self.entries(tenant_id)
        for entry in entries:
            if entry.entry_id in seen:
                duplicates.append(entry.entry_id)
            seen.add(entry.entry_id)
            balance += entry.amount if entry.kind in {"credit", "release"} else -entry.amount
            if balance < ZERO:
                negative_points.append((entry.entry_id, balance))
        return ReconciliationReport(
            tenant_id=tenant_id,
            balance=balance,
            entry_count=len(entries),
            duplicate_entry_ids=tuple(duplicates),
            negative_points=tuple(negative_points),
        )

    def _write_one(
        self,
        *,
        tenant_id: str,
        amount: Decimal,
        kind: str,
        source: str,
        idempotency_key: str,
        description: str,
        run_id: str | None,
    ) -> QuotaEntry:
        if amount < ZERO:
            raise ValueError("ledger amount cannot be negative")
        with self._lock:
            scoped_key = self._scoped_idempotency_key(tenant_id, idempotency_key)
            existing = self._idempotency.get(scoped_key)
            if existing:
                return existing[0]
            entry = self._append(
                QuotaEntry(
                    entry_id=self._entry_id(tenant_id, idempotency_key, kind),
                    tenant_id=tenant_id,
                    amount=amount,
                    kind=cast(QuotaKind, kind),
                    source=source,
                    run_id=run_id,
                    description=description,
                )
            )
            self._idempotency[scoped_key] = (entry,)
            return entry

    def _append(self, entry: QuotaEntry) -> QuotaEntry:
        written = self._quota.append(entry)
        self._emit(
            "billing.ledger.mutated",
            tenant_id=entry.tenant_id,
            source=entry.source,
            outcome="success",
            cost={"credits": str(entry.amount)},
            detail={
                "entry_id": entry.entry_id,
                "kind": entry.kind,
                "description": entry.description,
                "balance": str(self.balance(entry.tenant_id)),
            },
            run_id=entry.run_id,
        )
        return written

    def _emit(
        self,
        event_type: str,
        *,
        tenant_id: str,
        source: str,
        outcome: str,
        detail: dict[str, object],
        cost: dict[str, object] | None = None,
        run_id: str | None = None,
    ) -> None:
        self._audit.append(
            AuditEvent(
                type=event_type,
                tenant_id=tenant_id,
                actor_kind="service",
                actor_service="billing",
                plane="control",
                outcome=cast(Any, outcome),
                run_id=run_id,
                cost=cost,
                detail={"source": source, **detail},
            )
        )

    @staticmethod
    def _scoped_idempotency_key(tenant_id: str, idempotency_key: str) -> tuple[str, str]:
        return tenant_id, idempotency_key

    @staticmethod
    def _entry_id(tenant_id: str, idempotency_key: str, suffix: str) -> str:
        safe = uuid.uuid5(
            uuid.NAMESPACE_URL, f"loopit-billing:{tenant_id}:{idempotency_key}:{suffix}"
        ).hex
        return f"quota_{safe}"
