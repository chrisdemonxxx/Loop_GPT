from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True, slots=True)
class CostInputs:
    requests: int
    avg_iterations: Decimal
    tokens_per_iteration: int
    price_per_token: Decimal
    prefix_cache_hit_fraction: Decimal
    builds: int
    avg_build_minutes: Decimal
    cost_per_sandbox_hour: Decimal
    warm_pool_size: int
    pool_cost_per_hour: Decimal
    backend_cost: Decimal
    successful_deploys: int


def cost_per_successful_deploy(inputs: CostInputs) -> Decimal:
    if inputs.successful_deploys <= 0:
        raise ValueError("successful_deploys must be positive")
    inference = (
        Decimal(inputs.requests)
        * inputs.avg_iterations
        * Decimal(inputs.tokens_per_iteration)
        * inputs.price_per_token
        * (Decimal("1") - inputs.prefix_cache_hit_fraction)
    )
    sandbox = (
        Decimal(inputs.builds)
        * inputs.avg_build_minutes
        / Decimal(60)
        * inputs.cost_per_sandbox_hour
    ) + (Decimal(inputs.warm_pool_size) * inputs.pool_cost_per_hour * Decimal(730))
    return (inference + sandbox + inputs.backend_cost) / Decimal(inputs.successful_deploys)
