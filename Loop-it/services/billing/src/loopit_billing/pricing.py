from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any


@dataclass(frozen=True, slots=True)
class PriceTable:
    model_input_per_1k: dict[str, Decimal] = field(default_factory=dict)
    model_output_per_1k: dict[str, Decimal] = field(default_factory=dict)
    default_input_per_1k: Decimal = Decimal("0.0006")
    default_output_per_1k: Decimal = Decimal("0.0024")
    sandbox_second_by_size: dict[str, Decimal] = field(
        default_factory=lambda: {
            "small": Decimal("0.000006"),
            "medium": Decimal("0.000012"),
            "large": Decimal("0.000024"),
        }
    )
    hosting_second_by_size: dict[str, Decimal] = field(
        default_factory=lambda: {
            "small": Decimal("0.00000278"),
            "medium": Decimal("0.00000556"),
            "large": Decimal("0.00001112"),
        }
    )
    storage_gb_month: Decimal = Decimal("0.10")
    custom_domain_month: Decimal = Decimal("0.25")
    domain_registration_margin_fraction: Decimal = Decimal("0.15")
    stripe_meter_price_ids: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> PriceTable:
        raw = os.environ.get("LOOPIT_BILLING_PRICE_TABLE_JSON")
        if not raw:
            return cls()
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("LOOPIT_BILLING_PRICE_TABLE_JSON must be a JSON object")
        return cls.from_mapping(data)

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> PriceTable:
        return cls(
            model_input_per_1k=_decimal_map(data.get("model_input_per_1k", {})),
            model_output_per_1k=_decimal_map(data.get("model_output_per_1k", {})),
            default_input_per_1k=Decimal(str(data.get("default_input_per_1k", "0.0006"))),
            default_output_per_1k=Decimal(str(data.get("default_output_per_1k", "0.0024"))),
            sandbox_second_by_size=_decimal_map(
                data.get(
                    "sandbox_second_by_size",
                    {"small": "0.000006", "medium": "0.000012", "large": "0.000024"},
                )
            ),
            hosting_second_by_size=_decimal_map(
                data.get(
                    "hosting_second_by_size",
                    {"small": "0.00000278", "medium": "0.00000556", "large": "0.00001112"},
                )
            ),
            storage_gb_month=Decimal(str(data.get("storage_gb_month", "0.10"))),
            custom_domain_month=Decimal(str(data.get("custom_domain_month", "0.25"))),
            domain_registration_margin_fraction=Decimal(
                str(data.get("domain_registration_margin_fraction", "0.15"))
            ),
            stripe_meter_price_ids=_string_map(data.get("stripe_meter_price_ids", {})),
        )

    def inference_cost(
        self,
        *,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cached_input_tokens: int = 0,
        provider_cost: Decimal | None = None,
    ) -> Decimal:
        if provider_cost is not None:
            return provider_cost.quantize(Decimal("0.00000001"))
        billable_input = max(0, input_tokens - cached_input_tokens)
        in_rate = self.model_input_per_1k.get(model, self.default_input_per_1k)
        out_rate = self.model_output_per_1k.get(model, self.default_output_per_1k)
        return ((Decimal(billable_input) / Decimal(1000)) * in_rate) + (
            (Decimal(output_tokens) / Decimal(1000)) * out_rate
        )

    def sandbox_cost(self, *, seconds: int, size: str) -> Decimal:
        if seconds < 0:
            raise ValueError("seconds cannot be negative")
        rate = self.sandbox_second_by_size.get(size, self.sandbox_second_by_size["medium"])
        return (Decimal(seconds) * rate).quantize(Decimal("0.00000001"))

    def storage_cost(self, *, gb_months: Decimal) -> Decimal:
        if gb_months < 0:
            raise ValueError("gb_months cannot be negative")
        return (gb_months * self.storage_gb_month).quantize(Decimal("0.00000001"))

    def hosting_cost(self, *, seconds: int, size: str) -> Decimal:
        """Charge every always-on second because VPS slices cost money while idle."""
        if seconds < 0:
            raise ValueError("seconds cannot be negative")
        rate = self.hosting_second_by_size.get(size, self.hosting_second_by_size["small"])
        return (Decimal(seconds) * rate).quantize(Decimal("0.00000001"))

    def custom_domain_cost(self, *, domain_months: Decimal) -> Decimal:
        if domain_months < 0:
            raise ValueError("domain_months cannot be negative")
        return (domain_months * self.custom_domain_month).quantize(Decimal("0.00000001"))

    def domain_registration_cost(self, *, registrar_cost: Decimal) -> Decimal:
        """Model purchased domains as pass-through registrar cost plus margin."""
        if registrar_cost < 0:
            raise ValueError("registrar_cost cannot be negative")
        return (
            registrar_cost * (Decimal("1") + self.domain_registration_margin_fraction)
        ).quantize(Decimal("0.00000001"))


def _decimal_map(value: object) -> dict[str, Decimal]:
    if not isinstance(value, dict):
        raise ValueError("price table sections must be objects")
    return {str(key): Decimal(str(item)) for key, item in value.items()}


def _string_map(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError("price table sections must be objects")
    return {str(key): str(item) for key, item in value.items()}
