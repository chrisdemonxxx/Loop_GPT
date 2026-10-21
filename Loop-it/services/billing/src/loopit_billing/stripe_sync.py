from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any

from .ledger import BillingLedger
from .metering import MeterKind
from .plans import PlanManager
from .pricing import PriceTable


class StripeWebhookError(Exception):
    """Stripe webhook verification or handling failed."""


@dataclass(frozen=True, slots=True)
class CheckoutSession:
    id: str
    url: str


class StripeSync:
    """Mirrors Stripe state into Loop-it credits; the local ledger remains truth.

    ``external=True`` (``LOOPIT_EXTERNAL_BILLING=1``) keeps local usage accounting
    and refuses every Stripe API call and webhook grant. Loop-GPT's ledger is
    the only place money moves.
    """

    def __init__(
        self,
        *,
        ledger: BillingLedger,
        plans: PlanManager,
        api_key: str = "",
        webhook_secret: str = "",
        success_url: str = "",
        cancel_url: str = "",
        prices: PriceTable | None = None,
        external: bool = False,
    ) -> None:
        self._ledger = ledger
        self._plans = plans
        self._api_key = api_key
        self._webhook_secret = webhook_secret
        self._success_url = success_url
        self._cancel_url = cancel_url
        self._prices = prices or PriceTable()
        self._external = external
        self._processed_events: set[str] = set()
        self._customers: dict[str, str] = {}
        self._subscriptions: dict[str, tuple[str, str]] = {}

    def create_checkout_session(self, *, tenant_id: str, plan_name: str) -> CheckoutSession:
        if self._external:
            raise StripeWebhookError(
                "Stripe sync is disabled while LOOPIT_EXTERNAL_BILLING is set"
            )
        if not self._api_key:
            raise StripeWebhookError("Stripe is not configured")
        plan = self._plans.plan(plan_name)
        if not plan.stripe_price_id:
            raise StripeWebhookError(f"plan {plan_name!r} has no Stripe price id")
        stripe = _stripe()
        stripe.api_key = self._api_key
        session = stripe.checkout.Session.create(
            mode="subscription",
            line_items=[{"price": plan.stripe_price_id, "quantity": 1}],
            success_url=self._success_url,
            cancel_url=self._cancel_url,
            metadata={"tenant_id": tenant_id, "plan": plan_name},
            client_reference_id=tenant_id,
        )
        return CheckoutSession(id=str(session["id"]), url=str(session["url"]))

    def stripe_price_id_for_meter(self, kind: MeterKind) -> str | None:
        """Expose Stripe meter price IDs while the credit ledger remains truth."""
        return self._prices.stripe_meter_price_ids.get(kind)

    def handle_webhook(self, *, payload: bytes, signature: str) -> dict[str, str]:
        if self._external:
            raise StripeWebhookError(
                "Stripe sync is disabled while LOOPIT_EXTERNAL_BILLING is set"
            )
        event = self.verify_webhook(payload=payload, signature=signature)
        event_id = str(event["id"])
        if event_id in self._processed_events:
            return {"status": "duplicate", "event_id": event_id}
        self._processed_events.add(event_id)
        event_type = str(event.get("type", ""))
        obj = _object(event)
        if event_type == "checkout.session.completed":
            self._checkout_completed(event_id, obj)
        elif event_type == "invoice.paid":
            self._invoice_paid(event_id, obj)
        elif event_type == "invoice.payment_failed":
            self._invoice_failed(event_id, obj)
        elif event_type in {"customer.subscription.updated", "customer.subscription.deleted"}:
            self._subscription_changed(event_id, obj, deleted=event_type.endswith("deleted"))
        return {"status": "processed", "event_id": event_id}

    def verify_webhook(
        self, *, payload: bytes, signature: str, now: int | None = None
    ) -> dict[str, Any]:
        if not self._webhook_secret:
            raise StripeWebhookError("Stripe webhook secret is not configured")
        pieces: dict[str, list[str]] = {}
        for part in signature.split(","):
            key, sep, value = part.partition("=")
            if sep:
                pieces.setdefault(key, []).append(value)
        try:
            timestamp = int(pieces["t"][0])
        except (KeyError, ValueError, IndexError) as exc:
            raise StripeWebhookError("malformed Stripe signature") from exc
        moment = int(time.time() if now is None else now)
        if abs(moment - timestamp) > 300:
            raise StripeWebhookError("stale Stripe signature")
        signed = f"{timestamp}.".encode() + payload
        expected = hmac.new(self._webhook_secret.encode(), signed, hashlib.sha256).hexdigest()
        if not any(hmac.compare_digest(expected, candidate) for candidate in pieces.get("v1", [])):
            raise StripeWebhookError("bad Stripe signature")
        data = json.loads(payload.decode("utf-8"))
        if not isinstance(data, dict):
            raise StripeWebhookError("Stripe event payload must be an object")
        return data

    def _checkout_completed(self, event_id: str, obj: dict[str, Any]) -> None:
        tenant_id = _tenant(obj)
        plan_name = _plan(obj)
        customer = obj.get("customer")
        subscription = obj.get("subscription")
        if customer:
            self._customers[str(customer)] = tenant_id
        if subscription:
            self._subscriptions[str(subscription)] = (tenant_id, plan_name)
        self._plans.record_plan(tenant_id=tenant_id, plan_name=plan_name)

    def _invoice_paid(self, event_id: str, obj: dict[str, Any]) -> None:
        tenant_id = self._tenant_from_stripe_object(obj)
        plan_name = _plan(
            obj, default=self._subscriptions.get(str(obj.get("subscription")), ("", "free"))[1]
        )
        plan = self._plans.plan(plan_name)
        self._ledger.grant(
            tenant_id=tenant_id,
            amount=plan.monthly_credits,
            source="stripe.invoice.paid",
            idempotency_key=f"stripe:{event_id}:paid",
            description=f"Stripe invoice paid for {plan_name}",
        )

    def _invoice_failed(self, event_id: str, obj: dict[str, Any]) -> None:
        tenant_id = self._tenant_from_stripe_object(obj)
        plan = self._plans.current_plan(tenant_id)
        amount = min(self._ledger.balance(tenant_id), plan.monthly_credits)
        if amount > 0:
            self._ledger.debit(
                tenant_id=tenant_id,
                amount=amount,
                source="stripe.invoice.payment_failed",
                idempotency_key=f"stripe:{event_id}:failed",
                description="revoke current-period credits after failed payment",
            )

    def _subscription_changed(self, event_id: str, obj: dict[str, Any], *, deleted: bool) -> None:
        tenant_id = self._tenant_from_stripe_object(obj)
        plan_name = "free" if deleted else _plan(obj)
        subscription = obj.get("id")
        if subscription:
            self._subscriptions[str(subscription)] = (tenant_id, plan_name)
        self._plans.set_plan(
            tenant_id=tenant_id,
            plan_name=plan_name,
            idempotency_key=f"stripe:{event_id}:subscription",
            source="stripe.subscription",
        )

    def _tenant_from_stripe_object(self, obj: dict[str, Any]) -> str:
        tenant = _metadata(obj).get("tenant_id")
        if tenant:
            return str(tenant)
        subscription = obj.get("subscription") or obj.get("id")
        if subscription and str(subscription) in self._subscriptions:
            return self._subscriptions[str(subscription)][0]
        customer = obj.get("customer")
        if customer and str(customer) in self._customers:
            return self._customers[str(customer)]
        raise StripeWebhookError("Stripe object missing tenant mapping")


def _stripe() -> Any:
    try:
        import stripe
    except Exception as exc:  # pragma: no cover - import depends on optional deployment config.
        raise StripeWebhookError("stripe package is unavailable") from exc
    return stripe


def _object(event: dict[str, Any]) -> dict[str, Any]:
    raw = event.get("data", {}).get("object") if isinstance(event.get("data"), dict) else None
    if not isinstance(raw, dict):
        raise StripeWebhookError("Stripe event missing data.object")
    return raw


def _metadata(obj: dict[str, Any]) -> dict[str, Any]:
    metadata = obj.get("metadata", {})
    return metadata if isinstance(metadata, dict) else {}


def _tenant(obj: dict[str, Any]) -> str:
    tenant = _metadata(obj).get("tenant_id") or obj.get("client_reference_id")
    if not tenant:
        raise StripeWebhookError("Stripe object missing tenant_id metadata")
    return str(tenant)


def _plan(obj: dict[str, Any], default: str = "free") -> str:
    return str(_metadata(obj).get("plan") or default)
