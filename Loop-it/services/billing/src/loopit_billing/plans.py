from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal

from loopit_policy import PlanLimits, QuotaRequest, UsageSnapshot, evaluate_quota

from .ledger import BillingLedger, InsufficientCredits, Reservation


@dataclass(frozen=True, slots=True)
class Plan:
    name: str
    monthly_credits: Decimal
    soft_remaining_credits: Decimal
    limits: PlanLimits
    stripe_price_id: str | None = None


@dataclass(frozen=True, slots=True)
class PlanLimitDecision:
    allowed: bool
    reason: str
    hard: bool
    remaining_credits: Decimal


class PlanQuotaExceeded(InsufficientCredits):
    """Raised when policy limits, not credit balance, deny a preflight."""

    def __init__(
        self,
        tenant_id: str,
        requested: Decimal,
        remaining: Decimal,
        *,
        reason: str,
    ) -> None:
        super().__init__(tenant_id, requested, remaining)
        self.reason = reason


PLANS: dict[str, Plan] = {
    "free": Plan(
        name="free",
        monthly_credits=Decimal("5"),
        soft_remaining_credits=Decimal("1"),
        limits=PlanLimits(
            max_tokens_per_minute=10_000,
            max_credits_per_day=2.0,
            max_sandbox_leases=1,
            max_egress_bytes_per_day=100_000_000,
            max_always_on_apps=0,
            max_custom_domains=0,
            max_hosting_egress_bytes_per_day=250_000_000,
            hosting_idle_timeout_seconds=900,
        ),
    ),
    "pro": Plan(
        name="pro",
        monthly_credits=Decimal("100"),
        soft_remaining_credits=Decimal("10"),
        limits=PlanLimits(
            max_tokens_per_minute=100_000,
            max_credits_per_day=25.0,
            max_sandbox_leases=4,
            max_egress_bytes_per_day=2_000_000_000,
            max_always_on_apps=2,
            max_custom_domains=3,
            max_hosting_egress_bytes_per_day=10_000_000_000,
            hosting_idle_timeout_seconds=None,
        ),
    ),
    "team": Plan(
        name="team",
        monthly_credits=Decimal("500"),
        soft_remaining_credits=Decimal("50"),
        limits=PlanLimits(
            max_tokens_per_minute=500_000,
            max_credits_per_day=150.0,
            max_sandbox_leases=12,
            max_egress_bytes_per_day=10_000_000_000,
            max_always_on_apps=10,
            max_custom_domains=25,
            max_hosting_egress_bytes_per_day=100_000_000_000,
            hosting_idle_timeout_seconds=None,
        ),
    ),
}


class PlanManager:
    def __init__(self, *, ledger: BillingLedger, plans: dict[str, Plan] | None = None) -> None:
        self._ledger = ledger
        self._plans = plans or PLANS
        self._tenant_plans: dict[str, str] = {}

    def set_plan(
        self,
        *,
        tenant_id: str,
        plan_name: str,
        idempotency_key: str,
        source: str = "billing.plan",
    ) -> Plan:
        plan = self.plan(plan_name)
        old = self.current_plan(tenant_id)
        self._tenant_plans[tenant_id] = plan.name
        delta = plan.monthly_credits - old.monthly_credits
        if delta > 0:
            self._ledger.grant(
                tenant_id=tenant_id,
                amount=delta,
                source=source,
                idempotency_key=f"{idempotency_key}:plan-credit",
                description=f"plan change {old.name}->{plan.name}",
            )
        elif delta < 0:
            self._ledger.debit(
                tenant_id=tenant_id,
                amount=-delta,
                source=source,
                idempotency_key=f"{idempotency_key}:plan-debit",
                description=f"plan change {old.name}->{plan.name}",
                allow_negative=False,
            )
        return plan

    def record_plan(self, *, tenant_id: str, plan_name: str) -> Plan:
        plan = self.plan(plan_name)
        self._tenant_plans[tenant_id] = plan.name
        return plan

    def current_plan(self, tenant_id: str) -> Plan:
        return self.plan(self._tenant_plans.get(tenant_id, "free"))

    def plan(self, name: str) -> Plan:
        try:
            return self._plans[name]
        except KeyError:
            raise ValueError(f"unknown plan {name!r}") from None

    def evaluate(
        self,
        *,
        tenant_id: str,
        estimated_cost: Decimal,
        request: QuotaRequest | None = None,
        usage: UsageSnapshot | None = None,
    ) -> PlanLimitDecision:
        plan = self.current_plan(tenant_id)
        policy = evaluate_quota(
            request or QuotaRequest(credits=float(estimated_cost)),
            usage or self.usage_snapshot(tenant_id),
            plan.limits,
        )
        if not policy.allowed:
            return PlanLimitDecision(False, policy.reason, True, self._ledger.balance(tenant_id))
        remaining = self._ledger.balance(tenant_id) - estimated_cost
        if remaining < 0:
            return PlanLimitDecision(False, "hard_quota", True, self._ledger.balance(tenant_id))
        if remaining <= plan.soft_remaining_credits:
            return PlanLimitDecision(True, "soft_quota", False, remaining)
        return PlanLimitDecision(True, "allowed", False, remaining)

    def check_and_reserve(
        self,
        *,
        tenant_id: str,
        estimated_cost: Decimal,
        idempotency_key: str,
        request: QuotaRequest | None = None,
        usage: UsageSnapshot | None = None,
        run_id: str | None = None,
    ) -> Reservation:
        decision = self.evaluate(
            tenant_id=tenant_id,
            estimated_cost=estimated_cost,
            request=request,
            usage=usage,
        )
        if not decision.allowed:
            raise PlanQuotaExceeded(
                tenant_id,
                estimated_cost,
                decision.remaining_credits,
                reason=decision.reason,
            )
        return self._ledger.check_and_reserve(
            tenant_id=tenant_id,
            estimated_cost=estimated_cost,
            idempotency_key=idempotency_key,
            run_id=run_id,
            description=_reservation_description(request),
        )

    def usage_snapshot(self, tenant_id: str) -> UsageSnapshot:
        active_always_on_apps = 0
        attached_custom_domains = 0
        hosting_egress_bytes_today = 0
        today_start = datetime.combine(datetime.now(UTC).date(), time.min, tzinfo=UTC)
        tomorrow_start = today_start + timedelta(days=1)
        released = {
            entry.description.removeprefix("release reservation ")
            for entry in self._ledger.entries(tenant_id)
            if entry.kind == "release" and entry.description.startswith("release reservation ")
        }
        for entry in self._ledger.entries(tenant_id):
            if entry.kind == "reservation" and entry.entry_id not in released:
                active_always_on_apps += _quota_count(entry.description, "always_on_apps")
                attached_custom_domains += _quota_count(entry.description, "custom_domains")
                created_at = _as_utc(entry.created_at)
                # Hosted-app egress is sold as a per-day quota. Use a UTC
                # calendar boundary so billing and every proxy share the same
                # reset instant without tenant-local time zone or DST drift.
                if today_start <= created_at < tomorrow_start:
                    hosting_egress_bytes_today += _quota_count(
                        entry.description, "hosting_egress_bytes"
                    )
        return UsageSnapshot(
            active_always_on_apps=active_always_on_apps,
            attached_custom_domains=attached_custom_domains,
            hosting_egress_bytes_today=hosting_egress_bytes_today,
        )


def _reservation_description(request: QuotaRequest | None) -> str:
    if request is None:
        return "pre-spend reservation"
    return (
        "pre-spend reservation; "
        f"quota.always_on_apps={request.always_on_apps}; "
        f"quota.custom_domains={request.custom_domains}; "
        f"quota.hosting_egress_bytes={request.hosting_egress_bytes}"
    )


def _quota_count(description: str, name: str) -> int:
    match = re.search(rf"quota\.{re.escape(name)}=(\d+)", description)
    return int(match.group(1)) if match else 0


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)
