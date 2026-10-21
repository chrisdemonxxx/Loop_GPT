"""Domain registrar seam.

Real domain purchase requires a funded registrar account and production legal
flow. This module defines the contract and a fake; it does not buy domains in
the real world.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from typing import Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class DomainQuote:
    domain: str
    available: bool
    price_usd: Decimal
    term_years: int


@dataclass(frozen=True, slots=True)
class DomainPurchase:
    purchase_id: str
    tenant_id: str
    domain: str
    term_years: int
    auto_renew: bool


class PurchaseAttemptStatus(StrEnum):
    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class DomainPurchaseAttempt:
    tenant_id: str
    domain: str
    idempotency_key: str
    term_years: int
    auto_renew: bool
    status: PurchaseAttemptStatus
    purchase: DomainPurchase | None = None
    error: str = ""


@runtime_checkable
class DomainRegistrar(Protocol):
    """Registrar contract; production implementations must own payment/legal flow."""

    def search_availability(self, domain: str) -> bool: ...

    def quote(self, domain: str, *, term_years: int = 1) -> DomainQuote: ...

    def purchase(
        self,
        *,
        tenant_id: str,
        domain: str,
        idempotency_key: str,
        term_years: int = 1,
        auto_renew: bool = True,
    ) -> DomainPurchase: ...

    def purchase_for_idempotency_key(
        self, *, tenant_id: str, idempotency_key: str
    ) -> DomainPurchase | None: ...

    def renew(self, *, tenant_id: str, domain: str, term_years: int = 1) -> DomainPurchase: ...


class RefusingDomainRegistrar:
    """Fail-closed registrar used when no real funded registrar is configured."""

    def __init__(self, reason: str = "domain registrar integration is not configured") -> None:
        self._reason = reason

    def search_availability(self, domain: str) -> bool:
        _ = domain
        raise RuntimeError(self._reason)

    def quote(self, domain: str, *, term_years: int = 1) -> DomainQuote:
        _ = (domain, term_years)
        raise RuntimeError(self._reason)

    def purchase(
        self,
        *,
        tenant_id: str,
        domain: str,
        idempotency_key: str,
        term_years: int = 1,
        auto_renew: bool = True,
    ) -> DomainPurchase:
        _ = (tenant_id, domain, idempotency_key, term_years, auto_renew)
        raise RuntimeError(self._reason)

    def purchase_for_idempotency_key(
        self, *, tenant_id: str, idempotency_key: str
    ) -> DomainPurchase | None:
        _ = (tenant_id, idempotency_key)
        return None

    def renew(self, *, tenant_id: str, domain: str, term_years: int = 1) -> DomainPurchase:
        _ = (tenant_id, domain, term_years)
        raise RuntimeError(self._reason)


class FakeDomainRegistrar:
    """Deterministic registrar fake; useful for UI and workflow tests only."""

    def __init__(self, unavailable: set[str] | None = None) -> None:
        self._unavailable = {domain.lower() for domain in (unavailable or set())}
        self.purchases: list[DomainPurchase] = []
        self.purchase_calls: list[tuple[str, str, str]] = []
        self._purchases_by_key: dict[tuple[str, str], DomainPurchase] = {}

    def search_availability(self, domain: str) -> bool:
        return domain.lower() not in self._unavailable

    def quote(self, domain: str, *, term_years: int = 1) -> DomainQuote:
        normalized = domain.lower()
        return DomainQuote(
            domain=normalized,
            available=self.search_availability(normalized),
            price_usd=Decimal("12.00") * term_years,
            term_years=term_years,
        )

    def purchase(
        self,
        *,
        tenant_id: str,
        domain: str,
        idempotency_key: str,
        term_years: int = 1,
        auto_renew: bool = True,
    ) -> DomainPurchase:
        normalized = domain.lower()
        scoped_key = (tenant_id, idempotency_key)
        self.purchase_calls.append((tenant_id, normalized, idempotency_key))
        existing = self._purchases_by_key.get(scoped_key)
        if existing is not None:
            if (
                existing.domain != normalized
                or existing.term_years != term_years
                or existing.auto_renew != auto_renew
            ):
                raise ValueError("idempotency key reused for different purchase")
            return existing
        if not self.search_availability(normalized):
            raise ValueError("domain is unavailable")
        self._unavailable.add(normalized)
        purchase = DomainPurchase(
            purchase_id=f"purchase_{uuid.uuid4().hex}",
            tenant_id=tenant_id,
            domain=normalized,
            term_years=term_years,
            auto_renew=auto_renew,
        )
        self.purchases.append(purchase)
        self._purchases_by_key[scoped_key] = purchase
        return purchase

    def purchase_for_idempotency_key(
        self, *, tenant_id: str, idempotency_key: str
    ) -> DomainPurchase | None:
        return self._purchases_by_key.get((tenant_id, idempotency_key))

    def renew(self, *, tenant_id: str, domain: str, term_years: int = 1) -> DomainPurchase:
        purchase = DomainPurchase(
            purchase_id=f"renewal_{uuid.uuid4().hex}",
            tenant_id=tenant_id,
            domain=domain.lower(),
            term_years=term_years,
            auto_renew=True,
        )
        self.purchases.append(purchase)
        return purchase
