"""Quota and rate policy evaluated before spend."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class PlanLimits:
    """Hard plan ceilings for scarce or abusable infrastructure resources."""

    max_tokens_per_minute: int
    max_credits_per_day: float
    max_sandbox_leases: int
    max_egress_bytes_per_day: int
    max_always_on_apps: int = 0
    max_custom_domains: int = 0
    max_hosting_egress_bytes_per_day: int = 0
    hosting_idle_timeout_seconds: int | None = None


@dataclass(frozen=True, slots=True)
class UsageSnapshot:
    """Current usage used to reject requests before a side effect is created."""

    tokens_this_minute: int = 0
    credits_today: float = 0.0
    active_sandbox_leases: int = 0
    egress_bytes_today: int = 0
    active_always_on_apps: int = 0
    attached_custom_domains: int = 0
    hosting_egress_bytes_today: int = 0


@dataclass(frozen=True, slots=True)
class QuotaRequest:
    """Incremental usage a caller wants to reserve before spending credits."""

    tokens: int = 0
    credits: float = 0.0
    sandbox_leases: int = 0
    egress_bytes: int = 0
    always_on_apps: int = 0
    custom_domains: int = 0
    hosting_egress_bytes: int = 0


@dataclass(frozen=True, slots=True)
class QuotaDecision:
    allowed: bool
    reason: str
    remaining: dict[str, float | int]


def evaluate_quota(
    request: QuotaRequest,
    usage: UsageSnapshot,
    limits: PlanLimits,
) -> QuotaDecision:
    """Deny requests that would exceed tenant plan limits before spend occurs."""
    remaining = {
        "tokens_per_minute": limits.max_tokens_per_minute - usage.tokens_this_minute,
        "credits_per_day": limits.max_credits_per_day - usage.credits_today,
        "sandbox_leases": limits.max_sandbox_leases - usage.active_sandbox_leases,
        "egress_bytes_per_day": limits.max_egress_bytes_per_day - usage.egress_bytes_today,
        "always_on_apps": limits.max_always_on_apps - usage.active_always_on_apps,
        "custom_domains": limits.max_custom_domains - usage.attached_custom_domains,
        "hosting_egress_bytes_per_day": (
            limits.max_hosting_egress_bytes_per_day - usage.hosting_egress_bytes_today
        ),
    }
    checks = (
        ("tokens_per_minute", request.tokens),
        ("credits_per_day", request.credits),
        ("sandbox_leases", request.sandbox_leases),
        ("egress_bytes_per_day", request.egress_bytes),
        ("always_on_apps", request.always_on_apps),
        ("custom_domains", request.custom_domains),
        ("hosting_egress_bytes_per_day", request.hosting_egress_bytes),
    )
    for name, requested in checks:
        if requested < 0:
            return QuotaDecision(False, f"invalid negative {name} request", remaining)
        if requested > remaining[name]:
            return QuotaDecision(False, f"{name} quota exceeded", remaining)
    return QuotaDecision(True, "within quota", remaining)
