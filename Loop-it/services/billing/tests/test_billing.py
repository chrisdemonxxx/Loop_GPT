from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from loopit_agent_core.config import SecretConfigurationError
from loopit_auth import TokenSigner
from loopit_billing.ledger import BillingLedger, InsufficientCredits
from loopit_billing.metering import MeterEvent, MeteringIngestor
from loopit_billing.metrics import CostInputs, cost_per_successful_deploy
from loopit_billing.plans import PLANS, PlanManager
from loopit_billing.pricing import PriceTable
from loopit_billing.server import ServerSettings, create_app
from loopit_billing.stripe_sync import StripeSync, StripeWebhookError
from loopit_policy import QuotaRequest, UsageSnapshot
from loopit_store import InMemoryAuditStore, InMemoryQuotaStore, QuotaEntry

TENANT = "org_1"
SECRET = "test-identity-secret-with-at-least-thirty-two-bytes"
SERVICE_AUTH = "test-service-token"


def _ledger() -> tuple[BillingLedger, InMemoryAuditStore]:
    audit = InMemoryAuditStore()
    return BillingLedger(quota=InMemoryQuotaStore(), audit=audit), audit


def _token(role: str = "owner", org_id: str = TENANT) -> str:
    signer = TokenSigner(
        issuer="loopit-gateway",
        audience="loopit-control-plane",
        keys={"dev": SECRET.encode()},
        current_kid="dev",
    )
    return signer.mint_identity(
        subject="user_1",
        org_id=org_id,
        role=role,  # type: ignore[arg-type]
        scopes=("quota:read", "quota:manage"),
        ttl_seconds=999_999_999,
    )


def _client(ledger: BillingLedger) -> TestClient:
    settings = ServerSettings(store_dsn="", identity_secret=SECRET, service_token=SERVICE_AUTH)
    return TestClient(create_app(settings=settings, ledger=ledger))


def _billing_headers(tenant_id: str = TENANT) -> dict[str, str]:
    return {"Authorization": "Bearer " + _token(org_id=tenant_id)}


def _service_headers() -> dict[str, str]:
    return {"X-Loopit-Service-Token": SERVICE_AUTH}


@pytest.mark.parametrize("bad_value", [None, "too-short", "dev-identity-key-change-me"])
def test_settings_reject_missing_short_or_placeholder_identity_secret(
    monkeypatch: pytest.MonkeyPatch, bad_value: str | None
) -> None:
    if bad_value is None:
        monkeypatch.delenv("LOOPIT_IDENTITY_SECRET", raising=False)
    else:
        monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", bad_value)

    with pytest.raises(SecretConfigurationError):
        ServerSettings.from_env()


def test_settings_accept_valid_identity_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", SECRET)

    assert ServerSettings.from_env().identity_secret == SECRET


def _stripe_signature(payload: bytes, secret: str = "whsec_test", now: int | None = None) -> str:
    timestamp = int(time.time() if now is None else now)
    digest = hmac.new(secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256)
    return f"t={timestamp},v1={digest.hexdigest()}"


def _event(event_id: str, event_type: str, obj: dict[str, object]) -> bytes:
    return json.dumps({"id": event_id, "type": event_type, "data": {"object": obj}}).encode()


def test_ledger_arithmetic_monotonicity_and_audit() -> None:
    ledger, audit = _ledger()
    ledger.grant(
        tenant_id=TENANT,
        amount=Decimal("10"),
        source="test",
        idempotency_key="grant",
    )
    reservation = ledger.check_and_reserve(
        tenant_id=TENANT, estimated_cost=Decimal("3"), idempotency_key="reserve"
    )
    ledger.settle(
        reservation=reservation,
        actual_cost=Decimal("2.25"),
        idempotency_key="settle",
    )

    assert ledger.balance(TENANT) == Decimal("7.75")
    assert ledger.reconcile(TENANT).ok
    assert [entry.kind for entry in ledger.entries(TENANT)] == [
        "credit",
        "reservation",
        "release",
        "debit",
    ]
    assert [record.event_type for record in audit.list_for_tenant(TENANT)] == [
        "billing.ledger.mutated",
        "billing.ledger.mutated",
        "billing.ledger.mutated",
        "billing.ledger.mutated",
    ]


def test_idempotent_meter_ingestion_same_key_charges_once() -> None:
    ledger, _audit = _ledger()
    ledger.grant(tenant_id=TENANT, amount=Decimal("1"), source="test", idempotency_key="grant")
    ingestor = MeteringIngestor(ledger=ledger, prices=PriceTable())
    event = MeterEvent(
        tenant_id=TENANT,
        idempotency_key="router-call-1",
        kind="inference",
        model="loopit/coder",
        input_tokens=1000,
        output_tokens=1000,
    )

    assert ingestor.ingest(event) == Decimal("0.0030")
    assert ingestor.ingest(event) == Decimal("0.0030")
    assert ledger.balance(TENANT) == Decimal("0.9970")
    assert len(ledger.entries(TENANT)) == 2


def test_balance_never_silently_negative() -> None:
    ledger, _audit = _ledger()
    ledger.grant(tenant_id=TENANT, amount=Decimal("1"), source="test", idempotency_key="grant")
    with pytest.raises(InsufficientCredits):
        ledger.debit(
            tenant_id=TENANT,
            amount=Decimal("2"),
            source="test",
            idempotency_key="too-much",
        )
    assert ledger.balance(TENANT) == Decimal("1")

    reservation = ledger.check_and_reserve(
        tenant_id=TENANT, estimated_cost=Decimal("1"), idempotency_key="reserve"
    )
    with pytest.raises(InsufficientCredits):
        ledger.settle(
            reservation=reservation,
            actual_cost=Decimal("2"),
            idempotency_key="settle-too-much",
        )


def test_settlement_loads_persisted_reservation_and_ignores_client_amount() -> None:
    ledger, _audit = _ledger()
    ledger.grant(tenant_id=TENANT, amount=Decimal("10"), source="test", idempotency_key="grant")
    client = _client(ledger)
    headers = {"Authorization": "Bearer " + _token()}
    reserved = client.post(
        "/v1/billing/reservations",
        headers=_service_headers(),
        json={"tenant_id": TENANT, "estimated_cost": "1.25", "idempotency_key": "reserve"},
    )
    assert reserved.status_code == 200

    settled = client.post(
        "/v1/billing/settlements",
        headers=headers,
        json={
            "reservation_id": reserved.json()["reservation_id"],
            "reserved_amount": "1000000",
            "actual_cost": "0",
            "idempotency_key": "settle",
        },
    )

    assert settled.status_code == 200
    assert ledger.balance(TENANT) == Decimal("10")
    assert [entry.amount for entry in ledger.entries(TENANT)][-2:] == [
        Decimal("1.25"),
        Decimal("0"),
    ]


def test_settlement_rejects_forged_or_cross_tenant_reservation() -> None:
    ledger, _audit = _ledger()
    ledger.grant(tenant_id=TENANT, amount=Decimal("10"), source="test", idempotency_key="grant")
    reservation = ledger.check_and_reserve(
        tenant_id=TENANT, estimated_cost=Decimal("2"), idempotency_key="reserve"
    )
    client = _client(ledger)

    forged = client.post(
        "/v1/billing/settlements",
        headers={"Authorization": "Bearer " + _token()},
        json={
            "reservation_id": "reservation-attacker-picked",
            "reserved_amount": "1000000",
            "actual_cost": "0",
            "idempotency_key": "forged",
        },
    )
    cross_tenant = client.post(
        "/v1/billing/settlements",
        headers={"Authorization": "Bearer " + _token(org_id="org_2")},
        json={
            "reservation_id": reservation.reservation_id,
            "reserved_amount": "2",
            "actual_cost": "0",
            "idempotency_key": "cross-tenant",
        },
    )

    assert forged.status_code == 404
    assert cross_tenant.status_code == 404
    assert ledger.balance(TENANT) == Decimal("8")


def test_reservation_idempotency_is_tenant_scoped_over_http() -> None:
    ledger, _audit = _ledger()
    ledger.grant(tenant_id="org_a", amount=Decimal("10"), source="test", idempotency_key="seed-a")
    ledger.grant(tenant_id="org_b", amount=Decimal("10"), source="test", idempotency_key="seed-b")
    client = _client(ledger)
    payload = {"estimated_cost": "1.25", "idempotency_key": "shared-reserve"}

    first_a = client.post(
        "/v1/billing/reservations",
        headers=_service_headers(),
        json={**payload, "tenant_id": "org_a"},
    )
    first_b = client.post(
        "/v1/billing/reservations",
        headers=_service_headers(),
        json={**payload, "tenant_id": "org_b"},
    )
    repeat_a = client.post(
        "/v1/billing/reservations",
        headers=_service_headers(),
        json={**payload, "tenant_id": "org_a"},
    )

    assert first_a.status_code == 200
    assert first_b.status_code == 200
    assert repeat_a.status_code == 200
    assert first_b.json()["reservation_id"] != first_a.json()["reservation_id"]
    assert repeat_a.json()["reservation_id"] == first_a.json()["reservation_id"]
    assert ledger.balance("org_a") == Decimal("8.75")
    assert ledger.balance("org_b") == Decimal("8.75")
    assert [entry.kind for entry in ledger.entries("org_a")].count("reservation") == 1
    assert [entry.kind for entry in ledger.entries("org_b")].count("reservation") == 1


def test_plan_idempotency_is_tenant_scoped_over_http() -> None:
    ledger, _audit = _ledger()
    client = _client(ledger)
    payload = {"plan": "pro", "idempotency_key": "shared-upgrade"}

    first_a = client.post("/v1/billing/plan", headers=_billing_headers("org_a"), json=payload)
    first_b = client.post("/v1/billing/plan", headers=_billing_headers("org_b"), json=payload)
    repeat_a = client.post("/v1/billing/plan", headers=_billing_headers("org_a"), json=payload)

    assert first_a.status_code == 200
    assert first_b.status_code == 200
    assert repeat_a.status_code == 200
    assert ledger.balance("org_a") == Decimal("95")
    assert ledger.balance("org_b") == Decimal("95")
    assert [entry.tenant_id for entry in ledger.entries("org_a")] == ["org_a"]
    assert [entry.tenant_id for entry in ledger.entries("org_b")] == ["org_b"]


def test_meter_idempotency_is_tenant_scoped_over_http() -> None:
    ledger, _audit = _ledger()
    ledger.grant(tenant_id="org_a", amount=Decimal("1"), source="test", idempotency_key="seed-a")
    ledger.grant(tenant_id="org_b", amount=Decimal("1"), source="test", idempotency_key="seed-b")
    client = _client(ledger)
    payload = {
        "tenant_id": "org_a",
        "idempotency_key": "shared-meter",
        "kind": "inference",
        "model": "loopit/coder",
        "input_tokens": 1000,
        "output_tokens": 1000,
    }

    first_a = client.post("/v1/billing/meter", headers=_billing_headers("org_a"), json=payload)
    first_b = client.post(
        "/v1/billing/meter",
        headers=_billing_headers("org_b"),
        json={**payload, "tenant_id": "org_b"},
    )
    repeat_a = client.post("/v1/billing/meter", headers=_billing_headers("org_a"), json=payload)

    assert first_a.status_code == 200
    assert first_b.status_code == 200
    assert repeat_a.status_code == 200
    assert ledger.balance("org_a") == Decimal("0.9970")
    assert ledger.balance("org_b") == Decimal("0.9970")
    assert [entry.kind for entry in ledger.entries("org_a")].count("debit") == 1
    assert [entry.kind for entry in ledger.entries("org_b")].count("debit") == 1


def test_reservation_endpoint_allows_free_ephemeral_hosting_request() -> None:
    ledger, _audit = _ledger()
    client = _client(ledger)
    ledger.grant(tenant_id=TENANT, amount=Decimal("1"), source="test", idempotency_key="grant")
    payload = {
        "estimated_cost": "0.01",
        "tenant_id": TENANT,
        "idempotency_key": "deploy-ephemeral",
        "quota_request": {"hosting_egress_bytes": 1},
    }

    response = client.post("/v1/billing/reservations", headers=_service_headers(), json=payload)

    assert response.status_code == 200
    assert ledger.balance(TENANT) == Decimal("0.99")


def test_reservation_endpoint_rejects_end_user_identity_tokens() -> None:
    ledger, _audit = _ledger()
    client = _client(ledger)
    ledger.grant(tenant_id=TENANT, amount=Decimal("1"), source="test", idempotency_key="grant")

    response = client.post(
        "/v1/billing/reservations",
        headers=_billing_headers(TENANT),
        json={
            "tenant_id": TENANT,
            "estimated_cost": "0.01",
            "idempotency_key": "tenant-forged-usage",
            "quota_request": {"custom_domains": 1},
        },
    )

    assert response.status_code == 401
    assert ledger.balance(TENANT) == Decimal("1")


def test_reservation_endpoint_rejects_caller_supplied_usage() -> None:
    ledger, _audit = _ledger()
    client = _client(ledger)
    ledger.grant(tenant_id=TENANT, amount=Decimal("1"), source="test", idempotency_key="grant")
    payload = {
        "estimated_cost": "0.01",
        "tenant_id": TENANT,
        "idempotency_key": "hosted-egress",
        "quota_request": {"hosting_egress_bytes": 1},
        "usage": {"hosting_egress_bytes_today": 250_000_000},
    }

    response = client.post("/v1/billing/reservations", headers=_service_headers(), json=payload)

    assert response.status_code == 400
    assert response.json()["detail"] == "usage is computed server-side"
    assert ledger.balance(TENANT) == Decimal("1")


def test_reservation_endpoint_computes_usage_from_ledger_not_payload() -> None:
    ledger, _audit = _ledger()
    plans = PlanManager(ledger=ledger)
    plans.set_plan(tenant_id=TENANT, plan_name="pro", idempotency_key="upgrade")
    client = TestClient(
        create_app(
            settings=ServerSettings(
                store_dsn="", identity_secret=SECRET, service_token=SERVICE_AUTH
            ),
            ledger=ledger,
            plans=plans,
        )
    )
    for index in range(3):
        response = client.post(
            "/v1/billing/reservations",
            headers=_service_headers(),
            json={
                "tenant_id": TENANT,
                "estimated_cost": "0",
                "idempotency_key": f"domain-{index}",
                "quota_request": {"custom_domains": 1},
            },
        )
        assert response.status_code == 200

    denied = client.post(
        "/v1/billing/reservations",
        headers=_service_headers(),
        json={
            "tenant_id": TENANT,
            "estimated_cost": "0",
            "idempotency_key": "domain-4",
            "quota_request": {"custom_domains": 1},
        },
    )

    assert denied.status_code == 429
    assert denied.json()["detail"] == "custom_domains quota exceeded"


def test_hosting_and_domain_meter_events_debit_ledger() -> None:
    ledger, _audit = _ledger()
    ledger.grant(tenant_id=TENANT, amount=Decimal("20"), source="test", idempotency_key="grant")
    ingestor = MeteringIngestor(ledger=ledger, prices=PriceTable())

    hosting = ingestor.ingest(
        MeterEvent(
            tenant_id=TENANT,
            idempotency_key="app-hour",
            kind="hosting_seconds",
            hosting_seconds=3600,
        )
    )
    domain = ingestor.ingest(
        MeterEvent(
            tenant_id=TENANT,
            idempotency_key="domain-month",
            kind="custom_domain_months",
            custom_domain_months=Decimal("1"),
        )
    )
    purchase = ingestor.ingest(
        MeterEvent(
            tenant_id=TENANT,
            idempotency_key="domain-buy",
            kind="domain_registration",
            registrar_cost_credits=Decimal("10"),
        )
    )

    assert hosting == Decimal("0.01000800")
    assert domain == Decimal("0.25000000")
    assert purchase == Decimal("11.50000000")
    assert ledger.balance(TENANT) == Decimal("8.23999200")


def test_double_settle_does_not_release_twice() -> None:
    ledger, _audit = _ledger()
    ledger.grant(tenant_id=TENANT, amount=Decimal("10"), source="test", idempotency_key="grant")
    reservation = ledger.check_and_reserve(
        tenant_id=TENANT, estimated_cost=Decimal("3"), idempotency_key="reserve"
    )

    ledger.settle(reservation=reservation, actual_cost=Decimal("1"), idempotency_key="settle-1")
    ledger.settle(reservation=reservation, actual_cost=Decimal("0"), idempotency_key="settle-2")

    assert ledger.balance(TENANT) == Decimal("9")
    assert [entry.kind for entry in ledger.entries(TENANT)].count("release") == 1


def test_hard_vs_soft_quota_behaviour() -> None:
    ledger, _audit = _ledger()
    plans = PlanManager(ledger=ledger)
    ledger.grant(tenant_id=TENANT, amount=Decimal("1.20"), source="test", idempotency_key="grant")

    soft = plans.evaluate(tenant_id=TENANT, estimated_cost=Decimal("0.50"))
    hard = plans.evaluate(tenant_id=TENANT, estimated_cost=Decimal("2"))

    assert soft.allowed
    assert soft.reason == "soft_quota"
    assert not hard.allowed
    assert hard.reason == "hard_quota"


def test_plan_hosting_and_domain_limits_differ_by_tier() -> None:
    assert PLANS["free"].limits.max_always_on_apps == 0
    assert PLANS["free"].limits.max_custom_domains == 0
    assert PLANS["free"].limits.max_hosting_egress_bytes_per_day == 250_000_000
    assert PLANS["free"].limits.hosting_idle_timeout_seconds == 900
    assert PLANS["pro"].limits.max_always_on_apps == 2
    assert PLANS["pro"].limits.max_custom_domains == 3
    assert PLANS["pro"].limits.max_hosting_egress_bytes_per_day == 10_000_000_000
    assert PLANS["pro"].limits.hosting_idle_timeout_seconds is None
    assert PLANS["team"].limits.max_always_on_apps == 10
    assert PLANS["team"].limits.max_custom_domains == 25
    assert PLANS["team"].limits.max_hosting_egress_bytes_per_day == 100_000_000_000
    assert PLANS["team"].limits.hosting_idle_timeout_seconds is None


def test_check_and_reserve_refuses_over_limit_hosting_and_domains() -> None:
    ledger, _audit = _ledger()
    plans = PlanManager(ledger=ledger)
    ledger.grant(tenant_id=TENANT, amount=Decimal("100"), source="test", idempotency_key="grant")

    free_deploy = plans.evaluate(
        tenant_id=TENANT,
        estimated_cost=Decimal("0.01"),
        request=QuotaRequest(always_on_apps=1),
        usage=UsageSnapshot(active_always_on_apps=0),
    )
    plans.set_plan(tenant_id=TENANT, plan_name="pro", idempotency_key="upgrade")
    pro_domain = plans.evaluate(
        tenant_id=TENANT,
        estimated_cost=Decimal("0.01"),
        request=QuotaRequest(custom_domains=1),
        usage=UsageSnapshot(attached_custom_domains=3),
    )
    pro_deploy = plans.evaluate(
        tenant_id=TENANT,
        estimated_cost=Decimal("0.01"),
        request=QuotaRequest(always_on_apps=1),
        usage=UsageSnapshot(active_always_on_apps=1),
    )

    assert not free_deploy.allowed
    assert free_deploy.reason == "always_on_apps quota exceeded"
    assert not pro_domain.allowed
    assert pro_domain.reason == "custom_domains quota exceeded"
    assert pro_deploy.allowed


def test_usage_snapshot_counts_only_current_utc_day_hosting_egress() -> None:
    quota = InMemoryQuotaStore()
    ledger = BillingLedger(quota=quota, audit=InMemoryAuditStore())
    plans = PlanManager(ledger=ledger)
    now = datetime.now(UTC)
    description = "pre-spend reservation; quota.hosting_egress_bytes=100"
    quota.append(
        QuotaEntry(
            entry_id="host-egress-today",
            tenant_id=TENANT,
            amount=Decimal("0"),
            kind="reservation",
            source="test",
            description=description,
            created_at=now,
        )
    )
    quota.append(
        QuotaEntry(
            entry_id="host-egress-yesterday",
            tenant_id=TENANT,
            amount=Decimal("0"),
            kind="reservation",
            source="test",
            description=description,
            created_at=now - timedelta(days=1),
        )
    )

    snapshot = plans.usage_snapshot(TENANT)

    assert snapshot.hosting_egress_bytes_today == 100


def test_concurrent_reservations_prevent_overspend() -> None:
    ledger, _audit = _ledger()
    ledger.grant(tenant_id=TENANT, amount=Decimal("1"), source="test", idempotency_key="grant")
    allowed = 0
    denied = 0
    lock = threading.Lock()

    def reserve(index: int) -> None:
        nonlocal allowed, denied
        try:
            ledger.check_and_reserve(
                tenant_id=TENANT,
                estimated_cost=Decimal("0.40"),
                idempotency_key=f"reserve-{index}",
            )
        except InsufficientCredits:
            with lock:
                denied += 1
        else:
            with lock:
                allowed += 1

    threads = [threading.Thread(target=reserve, args=(index,)) for index in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert allowed == 2
    assert denied == 3
    assert ledger.balance(TENANT) == Decimal("0.20")


def test_webhook_signature_rejection_and_idempotency() -> None:
    ledger, _audit = _ledger()
    plans = PlanManager(ledger=ledger)
    sync = StripeSync(
        ledger=ledger,
        plans=plans,
        webhook_secret="whsec_test",
    )
    payload = _event(
        "evt_1",
        "invoice.paid",
        {
            "customer": "cus_1",
            "subscription": "sub_1",
            "metadata": {"tenant_id": TENANT, "plan": "pro"},
        },
    )

    with pytest.raises(StripeWebhookError):
        sync.handle_webhook(payload=payload, signature="t=1,v1=bad")

    assert (
        sync.handle_webhook(payload=payload, signature=_stripe_signature(payload))["status"]
        == "processed"
    )
    assert (
        sync.handle_webhook(payload=payload, signature=_stripe_signature(payload))["status"]
        == "duplicate"
    )
    assert ledger.balance(TENANT) == Decimal("100")
    assert len(ledger.entries(TENANT)) == 1


def test_price_table_wires_stripe_meter_price_ids_from_env_mapping() -> None:
    table = PriceTable.from_mapping(
        {
            "stripe_meter_price_ids": {
                "hosting_seconds": "price_hosting_meter",
                "custom_domain_months": "price_domain_meter",
            }
        }
    )
    ledger, _audit = _ledger()
    sync = StripeSync(ledger=ledger, plans=PlanManager(ledger=ledger), prices=table)

    assert sync.stripe_price_id_for_meter("hosting_seconds") == "price_hosting_meter"
    assert sync.stripe_price_id_for_meter("custom_domain_months") == "price_domain_meter"
    assert sync.stripe_price_id_for_meter("domain_registration") is None


def test_checkout_completion_maps_subscription_without_double_granting() -> None:
    ledger, _audit = _ledger()
    plans = PlanManager(ledger=ledger)
    sync = StripeSync(ledger=ledger, plans=plans, webhook_secret="whsec_test")
    checkout = _event(
        "evt_checkout",
        "checkout.session.completed",
        {
            "customer": "cus_1",
            "subscription": "sub_1",
            "client_reference_id": TENANT,
            "metadata": {"plan": "pro"},
        },
    )
    invoice = _event("evt_paid", "invoice.paid", {"subscription": "sub_1", "customer": "cus_1"})

    sync.handle_webhook(payload=checkout, signature=_stripe_signature(checkout))
    sync.handle_webhook(payload=invoice, signature=_stripe_signature(invoice))

    assert plans.current_plan(TENANT).name == "pro"
    assert ledger.balance(TENANT) == Decimal("100")


def test_plan_upgrade_and_downgrade_credit_effects() -> None:
    ledger, _audit = _ledger()
    plans = PlanManager(ledger=ledger)

    plans.set_plan(tenant_id=TENANT, plan_name="pro", idempotency_key="upgrade")
    assert ledger.balance(TENANT) == Decimal("95")
    plans.set_plan(tenant_id=TENANT, plan_name="free", idempotency_key="downgrade")
    assert ledger.balance(TENANT) == Decimal("0")


def test_cost_per_successful_deploy() -> None:
    value = cost_per_successful_deploy(
        CostInputs(
            requests=10,
            avg_iterations=Decimal("2"),
            tokens_per_iteration=1000,
            price_per_token=Decimal("0.000001"),
            prefix_cache_hit_fraction=Decimal("0.25"),
            builds=4,
            avg_build_minutes=Decimal("15"),
            cost_per_sandbox_hour=Decimal("0.12"),
            warm_pool_size=1,
            pool_cost_per_hour=Decimal("0.01"),
            backend_cost=Decimal("2"),
            successful_deploys=5,
        )
    )
    assert value == Decimal("1.88700000")


def test_http_auth_401_and_403_on_protected_endpoints() -> None:
    ledger, _audit = _ledger()
    client = _client(ledger)

    assert client.get("/v1/billing/balance").status_code == 401
    viewer = _token(role="viewer")
    response = client.post(
        "/v1/billing/plan",
        headers={"Authorization": f"Bearer {viewer}"},
        json={"plan": "pro", "idempotency_key": "upgrade"},
    )
    assert response.status_code == 403


def test_http_uses_verified_identity_not_tenant_header() -> None:
    ledger, _audit = _ledger()
    ledger.grant(
        tenant_id=TENANT,
        amount=Decimal("5"),
        source="test",
        idempotency_key="grant",
    )
    client = _client(ledger)
    response = client.get(
        "/v1/billing/balance",
        headers={"Authorization": f"Bearer {_token()}", "X-Loopit-Tenant": "attacker"},
    )
    assert response.status_code == 200
    assert response.json()["tenant_id"] == TENANT


def test_webhook_endpoint_rejects_bad_signature() -> None:
    ledger, _audit = _ledger()
    client = _client(ledger)
    response = client.post(
        "/stripe/webhook",
        headers={"Stripe-Signature": "t=1,v1=bad"},
        content=b"{}",
    )
    assert response.status_code == 400
