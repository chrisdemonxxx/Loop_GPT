from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from decimal import Decimal

from loopit_agent_core.audit import AuditEvent
from loopit_store import AuditStore, QuotaEntry, QuotaStore

from .models import Actor


@dataclass(frozen=True, slots=True)
class PlanQuota:
    hard_credits: Decimal = Decimal("2.0")
    soft_remaining_credits: Decimal = Decimal("0.25")
    rate_capacity: int = 10
    rate_refill_per_second: float = 1.0


@dataclass(frozen=True, slots=True)
class GuardDecision:
    allowed: bool
    reason: str
    remaining_credits: Decimal
    retry_after_seconds: float | None = None


@dataclass(slots=True)
class _Bucket:
    tokens: float
    updated_at: float


class PreflightGuard:
    """Rate and quota gate that runs before sandbox leases or model spend."""

    def __init__(
        self, *, quota: QuotaStore, audit: AuditStore, plan: PlanQuota | None = None
    ) -> None:
        self._quota = quota
        self._audit = audit
        self._plan = plan or PlanQuota()
        self._buckets: dict[tuple[str, str], _Bucket] = {}

    def check(
        self,
        *,
        actor: Actor,
        estimated_credits: Decimal,
        run_id: str | None = None,
        project_id: str | None = None,
        now: float | None = None,
    ) -> GuardDecision:
        if estimated_credits < 0:
            raise ValueError("estimated_credits cannot be negative")
        moment = time.time() if now is None else now
        rate = self._consume(actor, moment)
        if rate is not None:
            decision = GuardDecision(
                False, "rate_limited", self._quota.balance(actor.tenant_id), rate
            )
            self._emit(actor, decision, estimated_credits, run_id, project_id)
            return decision
        balance = self._quota.balance(actor.tenant_id)
        if balance - estimated_credits < 0:
            decision = GuardDecision(False, "hard_quota", balance)
            self._emit(actor, decision, estimated_credits, run_id, project_id)
            return decision
        reason = (
            "soft_quota"
            if balance - estimated_credits <= self._plan.soft_remaining_credits
            else "allowed"
        )
        self._quota.append(
            QuotaEntry(
                entry_id=f"quota_{uuid.uuid4().hex}",
                tenant_id=actor.tenant_id,
                amount=estimated_credits,
                kind="reservation",
                source="auth.preflight",
                # The reservation is written before the run row exists
                # (reserve-then-create); quota_ledger.run_id has an FK to
                # runs, so stamping it here violates the FK under Postgres.
                # Run attribution lands on the real spend entries later.
                run_id=None,
                description="preflight reservation before sandbox/model spend",
            )
        )
        decision = GuardDecision(True, reason, balance - estimated_credits)
        self._emit(actor, decision, estimated_credits, run_id, project_id)
        return decision

    def _consume(self, actor: Actor, now: float) -> float | None:
        key = (actor.tenant_id, actor.subject)
        bucket = self._buckets.get(key)
        if bucket is None:
            self._buckets[key] = _Bucket(tokens=float(self._plan.rate_capacity - 1), updated_at=now)
            return None
        elapsed = max(0.0, now - bucket.updated_at)
        bucket.tokens = min(
            float(self._plan.rate_capacity),
            bucket.tokens + elapsed * self._plan.rate_refill_per_second,
        )
        bucket.updated_at = now
        if bucket.tokens < 1.0:
            return (1.0 - bucket.tokens) / self._plan.rate_refill_per_second
        bucket.tokens -= 1.0
        return None

    def _emit(
        self,
        actor: Actor,
        decision: GuardDecision,
        estimated: Decimal,
        run_id: str | None,
        project_id: str | None,
    ) -> None:
        self._audit.append(
            AuditEvent(
                type="auth.preflight",
                tenant_id=actor.tenant_id,
                actor_kind="user",
                actor_id=actor.subject,
                project_id=project_id,
                run_id=run_id,
                plane="control",
                outcome="allowed" if decision.allowed else "denied",
                cost={"estimated_credits": str(estimated)},
                detail={
                    "reason": decision.reason,
                    "remaining_credits": str(decision.remaining_credits),
                },
            )
        )
