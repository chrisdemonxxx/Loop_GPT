from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient
from loopit_abuse import AbuseEngine, FakeSandboxKiller, FakeTenantSuspender, FakeThrottler
from loopit_agent_core.config import SecretConfigurationError
from loopit_auth import OperatorTokenIssuer, OperatorTokenSettings, TokenSigner
from loopit_auth.models import Role

KEY = "admin-test-key-with-at-least-thirty-two-bytes"
OPERATOR_KEY = "operator-test-key-with-at-least-thirty-two-bytes"
SERVICE_TOKEN = "abuse-service-token-with-at-least-thirty-two-bytes"

os.environ.setdefault("LOOPIT_SERVICE_TOKEN", SERVICE_TOKEN)
os.environ.setdefault("LOOPIT_IDENTITY_SECRET", KEY)
os.environ.setdefault("LOOPIT_OPERATOR_IDENTITY_SECRET", OPERATOR_KEY)

from loopit_abuse.server import ServerSettings, create_app  # noqa: E402


def app_client() -> TestClient:
    engine = AbuseEngine(
        killer=FakeSandboxKiller(), throttler=FakeThrottler(), suspender=FakeTenantSuspender()
    )
    settings = ServerSettings(
        service_token=SERVICE_TOKEN,
        identity_key=KEY,
        operator_identity_key=OPERATOR_KEY,
    )
    return TestClient(create_app(engine=engine, settings=settings))


def token(
    role: Role = "admin",
    *,
    org_id: str = "tenant",
    scopes: tuple[str, ...] = ("admin",),
    audience: str = "loopit-control-plane",
) -> str:
    signer = TokenSigner(
        issuer="loopit-gateway",
        audience=audience,
        keys={"local-1": KEY.encode()},
        current_kid="local-1",
    )
    return signer.mint_identity(
        subject="u1",
        org_id=org_id,
        role=role,
        scopes=scopes,
        now=100,
        ttl_seconds=9_999_999_999,
    )


def auth_headers(raw_token: str) -> dict[str, str]:
    return {"Authorization": "Bearer " + raw_token}


def operator_token() -> str:
    issuer = OperatorTokenIssuer(
        OperatorTokenSettings(
            issuer="loopit-operator",
            audience="loopit-platform-operator",
            kid="operator-1",
            secret=OPERATOR_KEY,
            ttl_seconds=9_999_999_999,
        )
    )
    return issuer.mint(subject="ops-user", now=100)


def test_signal_ingestion_requires_service_auth() -> None:
    client = app_client()
    assert (
        client.post(
            "/v1/signals", json={"signal_id": "s", "tenant_id": "tenant", "kind": "egress_denial"}
        ).status_code
        == 401
    )
    response = client.post(
        "/v1/signals",
        headers={"X-Loopit-Service-Token": SERVICE_TOKEN},
        json={"signal_id": "s", "tenant_id": "tenant", "kind": "egress_denial"},
    )
    assert response.status_code == 200


@pytest.mark.parametrize(
    "name", ["LOOPIT_SERVICE_TOKEN", "LOOPIT_IDENTITY_SECRET", "LOOPIT_OPERATOR_IDENTITY_SECRET"]
)
@pytest.mark.parametrize("bad_value", [None, "too-short", "dev-identity-key-change-me"])
def test_settings_reject_missing_short_or_placeholder_secrets(
    monkeypatch: pytest.MonkeyPatch, name: str, bad_value: str | None
) -> None:
    monkeypatch.setenv("LOOPIT_SERVICE_TOKEN", SERVICE_TOKEN)
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", KEY)
    monkeypatch.setenv("LOOPIT_OPERATOR_IDENTITY_SECRET", OPERATOR_KEY)
    if bad_value is None:
        monkeypatch.delenv(name)
    else:
        monkeypatch.setenv(name, bad_value)

    with pytest.raises(SecretConfigurationError):
        ServerSettings.from_env()


def test_settings_accept_valid_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_SERVICE_TOKEN", SERVICE_TOKEN)
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", KEY)
    monkeypatch.setenv("LOOPIT_OPERATOR_IDENTITY_SECRET", OPERATOR_KEY)

    settings = ServerSettings.from_env()

    assert settings.service_token == SERVICE_TOKEN
    assert settings.identity_key == KEY
    assert settings.operator_identity_key == OPERATOR_KEY


def test_admin_routes_require_auth_and_admin_role() -> None:
    client = app_client()
    assert client.get("/v1/incidents").status_code == 401
    assert client.get("/v1/incidents", headers=auth_headers(token("member"))).status_code == 403
    assert client.get("/v1/incidents", headers=auth_headers(token())).status_code == 200
    assert client.get("/v1/audit", headers=auth_headers(token())).status_code == 403
    assert client.get("/v1/audit", headers=auth_headers(operator_token())).status_code == 200


def test_operator_actions_require_confirmation() -> None:
    client = app_client()
    headers = auth_headers(token())
    assert (
        client.post(
            "/v1/tenants/tenant/suspend", headers=headers, json={"reason": "test"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/v1/tenants/tenant/suspend",
            headers=headers,
            json={"reason": "test", "confirmed": True},
        ).status_code
        == 200
    )


def test_customer_admin_cannot_operate_on_another_tenant() -> None:
    client = app_client()
    headers = auth_headers(token())
    incident = client.post(
        "/v1/signals",
        headers={"X-Loopit-Service-Token": SERVICE_TOKEN},
        json={"signal_id": "victim-signal", "tenant_id": "victim", "kind": "egress_denial"},
    ).json()["incident"]

    assert (
        client.get("/v1/incidents", headers=headers, params={"tenant_id": "victim"}).status_code
        == 403
    )
    assert (
        client.get(f"/v1/incidents/{incident['incident_id']}", headers=headers).status_code == 403
    )
    assert (
        client.post(
            f"/v1/incidents/{incident['incident_id']}/dismiss",
            headers=headers,
            json={"reason": "test", "confirmed": True},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/v1/tenants/victim/suspend",
            headers=headers,
            json={"reason": "test", "confirmed": True},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/v1/sandboxes/kill",
            headers=headers,
            json={
                "tenant_id": "victim",
                "lease_id": "lease-victim",
                "reason": "test",
                "confirmed": True,
            },
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/v1/allowlist",
            headers=headers,
            json={"tenant_id": "victim", "reason": "test", "confirmed": True},
        ).status_code
        == 403
    )


def test_platform_operator_scope_can_operate_cross_tenant() -> None:
    client = app_client()
    response = client.post(
        "/v1/tenants/victim/suspend",
        headers=auth_headers(operator_token()),
        json={"reason": "test", "confirmed": True},
    )

    assert response.status_code == 200


def test_operator_audience_without_platform_scope_is_rejected() -> None:
    client = app_client()
    signer = TokenSigner(
        issuer="loopit-operator",
        audience="loopit-platform-operator",
        keys={"operator-1": OPERATOR_KEY.encode()},
        current_kid="operator-1",
    )
    raw_token = signer.mint_identity(
        subject="ops-user",
        org_id="platform",
        role="admin",
        scopes=("admin",),
        now=100,
        ttl_seconds=9_999_999_999,
    )

    assert client.get("/v1/incidents", headers=auth_headers(raw_token)).status_code == 403


def test_customer_audience_token_with_platform_scope_cannot_cross_tenant() -> None:
    client = app_client()
    headers = auth_headers(token("owner", scopes=("admin", "platform:operate")))

    response = client.post(
        "/v1/tenants/victim/suspend",
        headers=headers,
        json={"reason": "test", "confirmed": True},
    )

    assert response.status_code == 403
