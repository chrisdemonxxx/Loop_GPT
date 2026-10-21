from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal
from typing import Annotated, Any, cast

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from loopit_agent_core.config import require_secret
from loopit_auth import Actor, IdentityTokenError, TokenSigner
from loopit_auth.rbac import Resource, authorize
from loopit_policy import QuotaRequest, UsageSnapshot
from loopit_store import (
    InMemoryAuditStore,
    InMemoryQuotaStore,
    PostgresAuditStore,
    PostgresQuotaStore,
)
from loopit_store.postgres import connect
from loopit_telemetry import add_loopit_telemetry, configure_telemetry
from pydantic import BaseModel, Field

from .ledger import (
    BillingError,
    BillingLedger,
    InsufficientCredits,
    ReservationNotFound,
)
from .metering import MeterEvent, MeteringIngestor, MeterKind
from .metrics import CostInputs, cost_per_successful_deploy
from .plans import PLANS, PlanManager, PlanQuotaExceeded
from .pricing import PriceTable
from .reporter import UsageReporter, UsageReportError
from .stripe_sync import StripeSync, StripeWebhookError


@dataclass(frozen=True, slots=True)
class ServerSettings:
    host: str = "0.0.0.0"  # noqa: S104
    port: int = 8006
    store_dsn: str = ""
    identity_issuer: str = "loopit-gateway"
    identity_audience: str = "loopit-control-plane"
    identity_kid: str = "dev"
    identity_secret: str = ""
    service_token: str = ""
    stripe_api_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_success_url: str = "http://localhost:8080/billing/success"
    stripe_cancel_url: str = "http://localhost:8080/billing/cancel"
    usage_report_url: str = ""
    external_billing: bool = False

    @classmethod
    def from_env(cls) -> ServerSettings:
        return cls(
            host=os.environ.get("LOOPIT_BILLING_HOST", "0.0.0.0"),  # noqa: S104
            port=int(os.environ.get("LOOPIT_BILLING_PORT", os.environ.get("PORT", "8006"))),
            store_dsn=os.environ.get("LOOPIT_STORE_DSN", os.environ.get("DATABASE_URL", "")),
            identity_issuer=os.environ.get("LOOPIT_IDENTITY_ISSUER", "loopit-gateway"),
            identity_audience=os.environ.get("LOOPIT_IDENTITY_AUDIENCE", "loopit-control-plane"),
            identity_kid=os.environ.get("LOOPIT_IDENTITY_KID", "dev"),
            identity_secret=require_secret(os.environ, "LOOPIT_IDENTITY_SECRET"),
            service_token=require_secret(os.environ, "LOOPIT_SERVICE_TOKEN"),
            stripe_api_key=os.environ.get("STRIPE_API_KEY", ""),
            stripe_webhook_secret=os.environ.get("STRIPE_WEBHOOK_SECRET", ""),
            stripe_success_url=os.environ.get(
                "STRIPE_SUCCESS_URL", "http://localhost:8080/billing/success"
            ),
            stripe_cancel_url=os.environ.get(
                "STRIPE_CANCEL_URL", "http://localhost:8080/billing/cancel"
            ),
            usage_report_url=os.environ.get("LOOPIT_USAGE_REPORT_URL", "").strip(),
            external_billing=os.environ.get("LOOPIT_EXTERNAL_BILLING", "").strip() == "1",
        )


class QuotaRequestPayload(BaseModel):
    tokens: int = Field(default=0, ge=0)
    credits: float = Field(default=0.0, ge=0)
    sandbox_leases: int = Field(default=0, ge=0)
    egress_bytes: int = Field(default=0, ge=0)
    always_on_apps: int = Field(default=0, ge=0)
    custom_domains: int = Field(default=0, ge=0)
    hosting_egress_bytes: int = Field(default=0, ge=0)

    def to_policy(self) -> QuotaRequest:
        return QuotaRequest(
            tokens=self.tokens,
            credits=self.credits,
            sandbox_leases=self.sandbox_leases,
            egress_bytes=self.egress_bytes,
            always_on_apps=self.always_on_apps,
            custom_domains=self.custom_domains,
            hosting_egress_bytes=self.hosting_egress_bytes,
        )


class UsageSnapshotPayload(BaseModel):
    tokens_this_minute: int = Field(default=0, ge=0)
    credits_today: float = Field(default=0.0, ge=0)
    active_sandbox_leases: int = Field(default=0, ge=0)
    egress_bytes_today: int = Field(default=0, ge=0)
    active_always_on_apps: int = Field(default=0, ge=0)
    attached_custom_domains: int = Field(default=0, ge=0)
    hosting_egress_bytes_today: int = Field(default=0, ge=0)

    def to_policy(self) -> UsageSnapshot:
        return UsageSnapshot(
            tokens_this_minute=self.tokens_this_minute,
            credits_today=self.credits_today,
            active_sandbox_leases=self.active_sandbox_leases,
            egress_bytes_today=self.egress_bytes_today,
            active_always_on_apps=self.active_always_on_apps,
            attached_custom_domains=self.attached_custom_domains,
            hosting_egress_bytes_today=self.hosting_egress_bytes_today,
        )


class ReservationRequest(BaseModel):
    tenant_id: str
    estimated_cost: Decimal = Field(ge=0)
    idempotency_key: str
    run_id: str | None = None
    quota_request: QuotaRequestPayload | None = None
    usage: UsageSnapshotPayload | None = None


class SettlementRequest(BaseModel):
    reservation_id: str
    reserved_amount: Decimal | None = Field(default=None, ge=0)
    actual_cost: Decimal = Field(ge=0)
    idempotency_key: str
    run_id: str | None = None


class PlanChangeRequest(BaseModel):
    plan: str
    idempotency_key: str


class CheckoutRequest(BaseModel):
    plan: str


class CostMetricRequest(BaseModel):
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


class MeterEventRequest(BaseModel):
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


def create_app(
    *,
    settings: ServerSettings | None = None,
    ledger: BillingLedger | None = None,
    prices: PriceTable | None = None,
    plans: PlanManager | None = None,
    stripe_sync: StripeSync | None = None,
    reporter: UsageReporter | None = None,
) -> FastAPI:
    resolved = settings or ServerSettings.from_env()
    configure_telemetry("billing")
    app = FastAPI(title="loopit-billing")
    add_loopit_telemetry(app, "billing")
    if ledger is None:
        if resolved.store_dsn:
            conn = connect(resolved.store_dsn)
            ledger = BillingLedger(quota=PostgresQuotaStore(conn), audit=PostgresAuditStore(conn))
        else:
            ledger = BillingLedger(quota=InMemoryQuotaStore(), audit=InMemoryAuditStore())
    price_table = prices or PriceTable.from_env()
    plan_manager = plans or PlanManager(ledger=ledger)
    stripe_client = stripe_sync or StripeSync(
        ledger=ledger,
        plans=plan_manager,
        api_key=resolved.stripe_api_key,
        webhook_secret=resolved.stripe_webhook_secret,
        success_url=resolved.stripe_success_url,
        cancel_url=resolved.stripe_cancel_url,
        prices=price_table,
        external=resolved.external_billing,
    )
    app.state.settings = resolved
    app.state.ledger = ledger
    app.state.prices = price_table
    app.state.plans = plan_manager
    app.state.metering = MeteringIngestor(ledger=ledger, prices=price_table)
    app.state.stripe = stripe_client
    app.state.signer = TokenSigner(
        issuer=resolved.identity_issuer,
        audience=resolved.identity_audience,
        keys={resolved.identity_kid: resolved.identity_secret.encode()},
        current_kid=resolved.identity_kid,
    )
    if reporter is not None:
        app.state.reporter = reporter
    elif resolved.usage_report_url:
        app.state.reporter = UsageReporter(resolved.usage_report_url, app.state.signer)
    else:
        app.state.reporter = None

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/billing/balance")
    def balance(actor: Annotated[Actor, Depends(_require_actor)]) -> dict[str, str]:
        _require(actor, "quota:read")
        return {
            "tenant_id": actor.tenant_id,
            "balance": str(app.state.ledger.balance(actor.tenant_id)),
            "plan": app.state.plans.current_plan(actor.tenant_id).name,
        }

    @app.get("/v1/billing/usage")
    def usage(actor: Annotated[Actor, Depends(_require_actor)]) -> dict[str, Any]:
        _require(actor, "quota:read")
        entries = app.state.ledger.entries(actor.tenant_id)
        return {
            "tenant_id": actor.tenant_id,
            "entries": [
                {
                    "entry_id": entry.entry_id,
                    "amount": str(entry.amount),
                    "kind": entry.kind,
                    "source": entry.source,
                    "run_id": entry.run_id,
                    "description": entry.description,
                    "created_at": entry.created_at.isoformat(),
                }
                for entry in entries
            ],
        }

    @app.get("/v1/billing/plans")
    def list_plans(actor: Annotated[Actor, Depends(_require_actor)]) -> dict[str, Any]:
        _require(actor, "quota:read")
        return {"plans": [_plan_payload(plan) for plan in PLANS.values()]}

    @app.post("/v1/billing/plan")
    def change_plan(
        payload: PlanChangeRequest, actor: Annotated[Actor, Depends(_require_actor)]
    ) -> dict[str, Any]:
        _require(actor, "quota:manage")
        try:
            plan = app.state.plans.set_plan(
                tenant_id=actor.tenant_id,
                plan_name=payload.plan,
                idempotency_key=payload.idempotency_key,
            )
        except (ValueError, InsufficientCredits) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"tenant_id": actor.tenant_id, "plan": _plan_payload(plan)}

    @app.post("/v1/billing/reservations")
    def reserve(
        payload: ReservationRequest,
        x_loopit_service_token: Annotated[str | None, Header()] = None,
    ) -> dict[str, str]:
        _require_service_token(x_loopit_service_token, settings=resolved)
        if payload.usage is not None:
            raise HTTPException(status_code=400, detail="usage is computed server-side")
        try:
            reservation = app.state.plans.check_and_reserve(
                tenant_id=payload.tenant_id,
                estimated_cost=payload.estimated_cost,
                idempotency_key=payload.idempotency_key,
                request=(
                    payload.quota_request.to_policy() if payload.quota_request is not None else None
                ),
                run_id=payload.run_id,
            )
        except PlanQuotaExceeded as exc:
            raise HTTPException(status_code=429, detail=exc.reason) from exc
        except InsufficientCredits as exc:
            raise HTTPException(status_code=429, detail="quota exceeded") from exc
        return {
            "reservation_id": reservation.reservation_id,
            "reserved_amount": str(reservation.amount),
            "remaining": str(reservation.remaining_after_reservation),
        }

    @app.post("/v1/billing/settlements")
    def settle(
        payload: SettlementRequest, actor: Annotated[Actor, Depends(_require_actor)]
    ) -> dict[str, str]:
        _require(actor, "quota:manage")
        try:
            reservation = app.state.ledger.reservation(
                tenant_id=actor.tenant_id, reservation_id=payload.reservation_id
            )
            app.state.ledger.settle(
                reservation=reservation,
                actual_cost=payload.actual_cost,
                idempotency_key=payload.idempotency_key,
                run_id=payload.run_id,
            )
        except ReservationNotFound as exc:
            raise HTTPException(status_code=404, detail="reservation not found") from exc
        except InsufficientCredits as exc:
            raise HTTPException(status_code=429, detail="quota exceeded") from exc
        except BillingError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"balance": str(app.state.ledger.balance(actor.tenant_id))}

    @app.post("/v1/billing/meter")
    def ingest_meter(
        payload: MeterEventRequest,
        request: Request,
        authorization: str | None = Header(default=None),
        x_loopit_service_token: str | None = Header(default=None),
    ) -> dict[str, str]:
        if not _is_service_token(x_loopit_service_token, settings=resolved):
            actor = _require_actor(request, authorization)
            _require(actor, "quota:manage")
            if actor.tenant_id != payload.tenant_id:
                raise HTTPException(status_code=403, detail="tenant mismatch")
        event = MeterEvent(**payload.model_dump())
        try:
            amount = app.state.metering.ingest(event)
        except InsufficientCredits as exc:
            raise HTTPException(status_code=429, detail="quota exceeded") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        usage_reporter: UsageReporter | None = app.state.reporter
        if usage_reporter is not None:
            try:
                usage_reporter.report(event)
            except UsageReportError as exc:
                raise HTTPException(status_code=502, detail="usage report failed") from exc
        return {
            "credits": str(amount),
            "balance": str(app.state.ledger.balance(payload.tenant_id)),
        }

    @app.post("/v1/billing/stripe/checkout")
    def checkout(
        payload: CheckoutRequest, actor: Annotated[Actor, Depends(_require_actor)]
    ) -> dict[str, str]:
        _require(actor, "quota:manage")
        try:
            session = app.state.stripe.create_checkout_session(
                tenant_id=actor.tenant_id, plan_name=payload.plan
            )
        except StripeWebhookError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"session_id": session.id, "url": session.url}

    @app.post("/v1/billing/metrics/cost-per-successful-deploy")
    def cost_metric(
        payload: CostMetricRequest, actor: Annotated[Actor, Depends(_require_actor)]
    ) -> dict[str, str]:
        _require(actor, "quota:read")
        return {
            "cost_per_successful_deploy": str(
                cost_per_successful_deploy(CostInputs(**payload.model_dump()))
            )
        }

    @app.post("/stripe/webhook")
    async def stripe_webhook(
        request: Request,
        stripe_signature: str | None = Header(default=None, alias="Stripe-Signature"),
    ) -> dict[str, str]:
        if stripe_signature is None:
            raise HTTPException(status_code=400, detail="missing Stripe signature")
        try:
            result = app.state.stripe.handle_webhook(
                payload=await request.body(), signature=stripe_signature
            )
            return cast(dict[str, str], result)
        except (StripeWebhookError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return app


def _require_actor(
    request: Request,
    authorization: str | None = Header(default=None),
) -> Actor:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing identity")
    signer: TokenSigner = request.app.state.signer
    try:
        identity = signer.verify_identity(authorization.removeprefix("Bearer ").strip())
    except IdentityTokenError as exc:
        raise HTTPException(status_code=401, detail="invalid identity") from exc
    return Actor.from_claims(
        subject=identity.subject,
        org_id=identity.org_id,
        role=identity.role,
        scopes=identity.scopes,
    )


def _is_service_token(token: str | None, *, settings: ServerSettings) -> bool:
    return bool(
        settings.service_token and token is not None and hmac_compare(token, settings.service_token)
    )


def _require_service_token(token: str | None, *, settings: ServerSettings) -> None:
    if not _is_service_token(token, settings=settings):
        raise HTTPException(status_code=401, detail="service authentication required")


def hmac_compare(left: str, right: str) -> bool:
    import secrets

    return secrets.compare_digest(left, right)


def _require(actor: Actor, action: Any) -> None:
    if not authorize(actor, action, Resource(org_id=actor.org_id)):
        raise HTTPException(status_code=403, detail="forbidden")


def _plan_payload(plan: Any) -> dict[str, Any]:
    return {
        "name": plan.name,
        "monthly_credits": str(plan.monthly_credits),
        "soft_remaining_credits": str(plan.soft_remaining_credits),
        "limits": {
            "max_tokens_per_minute": plan.limits.max_tokens_per_minute,
            "max_credits_per_day": plan.limits.max_credits_per_day,
            "max_sandbox_leases": plan.limits.max_sandbox_leases,
            "max_egress_bytes_per_day": plan.limits.max_egress_bytes_per_day,
            "max_always_on_apps": plan.limits.max_always_on_apps,
            "max_custom_domains": plan.limits.max_custom_domains,
            "max_hosting_egress_bytes_per_day": plan.limits.max_hosting_egress_bytes_per_day,
            "hosting_idle_timeout_seconds": plan.limits.hosting_idle_timeout_seconds,
        },
    }


app = create_app()


def main() -> None:
    settings = ServerSettings.from_env()
    uvicorn.run(create_app(settings=settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
