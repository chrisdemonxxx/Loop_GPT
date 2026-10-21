from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

from .ledger import BillingLedger
from .pricing import PriceTable

MeterKind = Literal[
    "inference",
    "sandbox_seconds",
    "storage",
    "hosting_seconds",
    "custom_domain_months",
    "domain_registration",
]


@dataclass(frozen=True, slots=True)
class MeterEvent:
    tenant_id: str
    idempotency_key: str
    kind: MeterKind
    model: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0
    provider_cost_credits: Decimal | None = None
    sandbox_seconds: int = 0
    sandbox_size: str = "medium"
    storage_gb_months: Decimal = Decimal("0")
    hosting_seconds: int = 0
    hosting_size: str = "small"
    custom_domain_months: Decimal = Decimal("0")
    registrar_cost_credits: Decimal | None = None
    run_id: str | None = None


class MeteringIngestor:
    def __init__(self, *, ledger: BillingLedger, prices: PriceTable) -> None:
        self._ledger = ledger
        self._prices = prices

    def ingest(self, event: MeterEvent) -> Decimal:
        amount = self.price(event)
        self._ledger.debit(
            tenant_id=event.tenant_id,
            amount=amount,
            source=f"billing.meter.{event.kind}",
            idempotency_key=f"meter:{event.idempotency_key}",
            description=self._description(event),
            run_id=event.run_id,
        )
        return amount

    def price(self, event: MeterEvent) -> Decimal:
        match event.kind:
            case "inference":
                if not event.model:
                    raise ValueError("inference meter events require model")
                return self._prices.inference_cost(
                    model=event.model,
                    input_tokens=event.input_tokens,
                    output_tokens=event.output_tokens,
                    cached_input_tokens=event.cached_input_tokens,
                    provider_cost=event.provider_cost_credits,
                )
            case "sandbox_seconds":
                return self._prices.sandbox_cost(
                    seconds=event.sandbox_seconds, size=event.sandbox_size
                )
            case "storage":
                return self._prices.storage_cost(gb_months=event.storage_gb_months)
            case "hosting_seconds":
                return self._prices.hosting_cost(
                    seconds=event.hosting_seconds, size=event.hosting_size
                )
            case "custom_domain_months":
                return self._prices.custom_domain_cost(domain_months=event.custom_domain_months)
            case "domain_registration":
                if event.registrar_cost_credits is None:
                    raise ValueError("domain_registration meter events require registrar cost")
                return self._prices.domain_registration_cost(
                    registrar_cost=event.registrar_cost_credits
                )

    @staticmethod
    def _description(event: MeterEvent) -> str:
        if event.kind == "inference":
            return (
                f"inference tokens model={event.model} input={event.input_tokens} "
                f"output={event.output_tokens} cached={event.cached_input_tokens}"
            )
        if event.kind == "sandbox_seconds":
            return f"sandbox seconds size={event.sandbox_size} seconds={event.sandbox_seconds}"
        if event.kind == "storage":
            return f"storage gb_months={event.storage_gb_months}"
        if event.kind == "hosting_seconds":
            return f"hosting seconds size={event.hosting_size} seconds={event.hosting_seconds}"
        if event.kind == "custom_domain_months":
            return f"custom domain months={event.custom_domain_months}"
        return f"domain registration registrar_cost={event.registrar_cost_credits}"
