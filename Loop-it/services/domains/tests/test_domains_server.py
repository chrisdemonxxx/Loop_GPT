from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from typing import Any

import loopit_domains.server as domains_server
import pytest
from fastapi.testclient import TestClient
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_domains import DomainService, FakeCertificateAuthority, InMemoryDnsProvider
from loopit_domains.server import ServerSettings, _service_from_settings, create_app

FACTORY_STATE_DB = Path("services\\domains\\tests\\.factory-state-test.sqlite")


def headers(role: str = "owner") -> dict[str, str]:
    return {
        "X-Loopit-Subject": "user-1",
        "X-Loopit-Tenant": "tenant-1",
        "X-Loopit-Org": "tenant-1",
        "X-Loopit-Role": role,
    }


def client() -> TestClient:
    service = DomainService(
        base_domain="loopit.app",
        app_proxy_target="app-proxy.loopit.internal",
        dns=InMemoryDnsProvider(),
        certificates=FakeCertificateAuthority(),
        audit=InMemoryAuditSink(),
    )
    settings = ServerSettings(apps_base_domain="loopit.app", service_token=service_token())
    return TestClient(create_app(settings=settings, service=service))


def service_headers() -> dict[str, str]:
    return {"X-Loopit-Service-Token": service_token()}


def service_token() -> str:
    return "test-service-token"


def production_service_token() -> str:
    return sha256(b"domains-production-factory-test").hexdigest()


def production_settings(**overrides: object) -> ServerSettings:
    values: dict[str, Any] = {
        "dns_provider": "cloudflare",
        "public_resolver": "doh",
        "certificate_provider": "disabled",
        "registrar_provider": "disabled",
        "audit_provider": "postgres",
        "audit_dsn": "postgresql://localhost/loopit",
        "billing_url": "https://billing.loopit.invalid",
        "purchase_attempts_db": str(FACTORY_STATE_DB),
        "service_token": production_service_token(),
    }
    values.update(overrides)
    return ServerSettings(**values)


def install_production_secret_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOOPIT_DOMAINS_ALLOW_FAKE_PROVIDERS", raising=False)
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", sha256(b"domains-cloudflare-token").hexdigest())
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", sha256(b"domains-cloudflare-account").hexdigest())
    monkeypatch.setattr(domains_server, "connect", lambda _dsn: object())


def test_healthz() -> None:
    assert client().get("/healthz").status_code == 200


def test_mutations_require_actor_headers() -> None:
    response = client().post("/projects/project/subdomain", json={})

    assert response.status_code == 401


def test_viewer_cannot_allocate_subdomain() -> None:
    response = client().post("/projects/project/subdomain", headers=headers("viewer"), json={})

    assert response.status_code == 403


def test_allocate_subdomain_and_resolve_route_contract() -> None:
    api = client()
    allocated = api.post("/projects/project/subdomain", headers=headers(), json={})
    assert allocated.status_code == 200
    hostname = allocated.json()["hostname"]
    registered = api.post(
        f"/routes/{hostname}/backend",
        headers=service_headers(),
        json={"project_id": "project", "backend_host": "slice-a.internal", "backend_port": 8080},
    )
    assert registered.status_code == 200

    route = api.get(f"/routes/{hostname}", headers=service_headers())

    assert route.status_code == 200
    assert route.json()["project_id"] == "project"
    assert route.json()["tenant_id"] == "tenant-1"
    assert route.json()["backend_host"] == "slice-a.internal"
    assert route.json()["backend_port"] == 8080


def test_route_lookup_requires_service_token() -> None:
    api = client()
    response = api.get("/routes/alpha.loopit.app")

    assert response.status_code == 401


def test_production_factory_refuses_implicit_fake_providers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_production_secret_env(monkeypatch)
    settings = ServerSettings(
        dns_provider="memory",
        certificate_provider="fake",
        registrar_provider="fake",
        audit_provider="memory",
        audit_dsn="",
        billing_url="https://billing.loopit.invalid",
        purchase_attempts_db=str(FACTORY_STATE_DB),
        service_token=service_token(),
    )

    try:
        with pytest.raises(RuntimeError, match="ALLOW_FAKE_PROVIDERS"):
            _service_from_settings(settings)
    finally:
        FACTORY_STATE_DB.unlink(missing_ok=True)


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"purchase_attempts_db": ""}, "LOOPIT_DOMAINS_PURCHASE_ATTEMPTS_DB"),
        ({"billing_url": ""}, "LOOPIT_BILLING_URL"),
        ({"service_token": ""}, "LOOPIT_SERVICE_TOKEN"),
        ({"dns_provider": "memory"}, "ALLOW_FAKE_PROVIDERS"),
        ({"public_resolver": "memory"}, "ALLOW_FAKE_PROVIDERS"),
        ({"certificate_provider": "fake"}, "ALLOW_FAKE_PROVIDERS"),
        ({"registrar_provider": "fake"}, "ALLOW_FAKE_PROVIDERS"),
        ({"audit_provider": "memory"}, "ALLOW_FAKE_PROVIDERS"),
    ],
    ids=[
        "routing-db",
        "billing-url",
        "service-token",
        "dns-provider",
        "public-resolver",
        "certificate-provider",
        "registrar-provider",
        "audit-provider",
    ],
)
def test_production_factory_refuses_each_missing_or_dev_only_config(
    monkeypatch: pytest.MonkeyPatch, overrides: dict[str, object], message: str
) -> None:
    install_production_secret_env(monkeypatch)
    FACTORY_STATE_DB.unlink(missing_ok=True)
    try:
        with pytest.raises(RuntimeError, match=message):
            _service_from_settings(production_settings(**overrides))
    finally:
        FACTORY_STATE_DB.unlink(missing_ok=True)
