"""Loop-GPT usage reporting and external billing.

External billing records meter events on the local ledger and never calls
Stripe. When a report URL is set, the same event is posted to Loop-GPT with
the idempotency key the local debit already used.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from loopit_auth import TokenSigner
from loopit_billing.ledger import BillingLedger
from loopit_billing.plans import PlanManager
from loopit_billing.reporter import UsageReporter, UsageReportError
from loopit_billing.server import ServerSettings, create_app
from loopit_billing.stripe_sync import StripeSync, StripeWebhookError
from loopit_store import InMemoryAuditStore, InMemoryQuotaStore

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


METER = {
    "tenant_id": TENANT,
    "idempotency_key": "router-call-9",
    "kind": "inference",
    "model": "loopit/coder",
    "input_tokens": 1000,
    "output_tokens": 1000,
}


def _granted() -> BillingLedger:
    ledger, _audit = _ledger()
    ledger.grant(tenant_id=TENANT, amount=Decimal("5"), source="test", idempotency_key="grant")
    return ledger


def _auth() -> dict[str, str]:
    return {"Authorization": "Bearer " + _token()}


def test_from_env_reads_report_url_and_external_billing_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LOOPIT_USAGE_REPORT_URL", "http://loop-gpt.test/api/loopit/usage")
    monkeypatch.setenv("LOOPIT_EXTERNAL_BILLING", "1")
    settings = ServerSettings.from_env()
    assert settings.usage_report_url == "http://loop-gpt.test/api/loopit/usage"
    assert settings.external_billing is True

    monkeypatch.setenv("LOOPIT_EXTERNAL_BILLING", "true")
    assert ServerSettings.from_env().external_billing is False


def test_reporter_is_installed_only_when_the_url_is_set() -> None:
    ledger = _granted()
    quiet = create_app(
        settings=ServerSettings(identity_secret=SECRET, service_token=SERVICE_AUTH),
        ledger=ledger,
    )
    assert quiet.state.reporter is None
    reporting = create_app(
        settings=ServerSettings(
            identity_secret=SECRET,
            service_token=SERVICE_AUTH,
            usage_report_url="http://127.0.0.1:9/api/loopit/usage",
        ),
        ledger=ledger,
    )
    assert reporting.state.reporter is not None
    assert reporting.state.reporter.url == "http://127.0.0.1:9/api/loopit/usage"


def test_usage_report_posts_the_event_and_keeps_the_local_debit() -> None:
    ledger = _granted()
    posted: list[dict[str, object]] = []

    def transport(url: str, body: dict[str, object], token: str) -> None:
        posted.append({"url": url, "body": body, "token": token})

    signer = TokenSigner(
        issuer="loopit-gateway",
        audience="loopit-control-plane",
        keys={"dev": SECRET.encode()},
        current_kid="dev",
    )
    reporter = UsageReporter(
        "http://loop-gpt.test/api/loopit/usage", signer, transport=transport
    )
    client = TestClient(
        create_app(
            settings=ServerSettings(identity_secret=SECRET, service_token=SERVICE_AUTH),
            ledger=ledger,
            reporter=reporter,
        )
    )

    response = client.post("/v1/billing/meter", headers=_auth(), json=METER)

    assert response.status_code == 200
    assert ledger.balance(TENANT) == Decimal("4.9970")
    assert posted[0]["url"] == "http://loop-gpt.test/api/loopit/usage"
    assert posted[0]["body"]["idempotencyKey"] == "router-call-9"
    assert posted[0]["body"]["tenantId"] == TENANT
    assert posted[0]["body"]["kind"] == "inference"
    identity = signer.verify_identity(str(posted[0]["token"]))
    assert identity.org_id == TENANT
    assert "stripe" not in str(posted[0]["body"]).lower()


def test_usage_report_is_skipped_when_no_reporter_is_configured() -> None:
    ledger = _granted()
    client = TestClient(
        create_app(
            settings=ServerSettings(identity_secret=SECRET, service_token=SERVICE_AUTH),
            ledger=ledger,
        )
    )

    response = client.post("/v1/billing/meter", headers=_auth(), json=METER)

    assert response.status_code == 200
    assert ledger.balance(TENANT) == Decimal("4.9970")
    assert client.app.state.reporter is None


def test_failed_report_retries_without_a_second_local_debit() -> None:
    ledger = _granted()
    calls = {"n": 0}

    def transport(url: str, body: dict[str, object], token: str) -> None:
        del url, body, token
        calls["n"] += 1
        if calls["n"] == 1:
            raise UsageReportError("downstream unavailable")

    signer = TokenSigner(
        issuer="loopit-gateway",
        audience="loopit-control-plane",
        keys={"dev": SECRET.encode()},
        current_kid="dev",
    )
    client = TestClient(
        create_app(
            settings=ServerSettings(identity_secret=SECRET, service_token=SERVICE_AUTH),
            ledger=ledger,
            reporter=UsageReporter(
                "http://loop-gpt.test/api/loopit/usage", signer, transport=transport
            ),
        )
    )

    failed = client.post("/v1/billing/meter", headers=_auth(), json=METER)
    retried = client.post("/v1/billing/meter", headers=_auth(), json=METER)

    assert failed.status_code == 502
    assert retried.status_code == 200
    assert calls["n"] == 2
    assert ledger.balance(TENANT) == Decimal("4.9970")
    assert len([entry for entry in ledger.entries(TENANT) if entry.kind == "debit"]) == 1


def test_external_billing_records_usage_locally_and_never_calls_stripe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom() -> None:
        raise AssertionError("stripe was called")

    monkeypatch.setattr("loopit_billing.stripe_sync._stripe", boom)
    ledger, _audit = _ledger()
    ledger.grant(tenant_id=TENANT, amount=Decimal("5"), source="test", idempotency_key="grant")
    sync = StripeSync(
        ledger=ledger,
        plans=PlanManager(ledger=ledger),
        api_key="stripe-test-api-key",
        webhook_secret="whsec_test",
        external=True,
    )
    with pytest.raises(StripeWebhookError, match="LOOPIT_EXTERNAL_BILLING"):
        sync.create_checkout_session(tenant_id=TENANT, plan_name="pro")
    with pytest.raises(StripeWebhookError, match="LOOPIT_EXTERNAL_BILLING"):
        sync.handle_webhook(payload=b"{}", signature="t=1,v1=deadbeef")
    assert ledger.balance(TENANT) == Decimal("5")

    client = TestClient(
        create_app(
            settings=ServerSettings(
                identity_secret=SECRET,
                service_token=SERVICE_AUTH,
                external_billing=True,
                stripe_api_key="stripe-test-api-key",
                stripe_webhook_secret="whsec_test",
            ),
            ledger=ledger,
        )
    )
    metered = client.post("/v1/billing/meter", headers=_auth(), json=METER)
    checkout = client.post(
        "/v1/billing/stripe/checkout",
        headers=_auth(),
        json={"plan": "pro"},
    )
    webhook = client.post(
        "/stripe/webhook",
        headers={"Stripe-Signature": "t=1,v1=deadbeef"},
        content=b"{}",
    )

    assert metered.status_code == 200
    assert ledger.balance(TENANT) == Decimal("4.9970")
    assert checkout.status_code == 503
    assert webhook.status_code == 400
    stripe_entries = [
        entry for entry in ledger.entries(TENANT) if entry.source.startswith("stripe")
    ]
    assert stripe_entries == []
