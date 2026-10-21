from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_app_proxy import (
    Backend,
    HostnameBinding,
    InMemoryHostnameResolver,
    InMemoryProjectBackendResolver,
    PerHostRateLimiter,
    RateLimitSettings,
)
from loopit_app_proxy.billing import BufferedHostingBillingReporter, HostingBillingReporter
from loopit_app_proxy.proxy import AppProxy
from loopit_app_proxy.server import AppProxySettings, create_app

HOST = "alpha.loopit.app"
BACKEND = Backend("10.91.0.4", 8080)


def _client(
    handler: httpx2.SyncByteStream | None = None,
    *,
    rate_limit_per_minute: int = 600,
    billing: HostingBillingReporter | None = None,
) -> tuple[TestClient, list[httpx2.Request]]:
    seen: list[httpx2.Request] = []

    def transport_handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        if handler is None:
            return httpx2.Response(
                200,
                text="app",
                headers={
                    "Connection": "close",
                    "Content-Security-Policy": "default-src 'self'",
                    "Cache-Control": "public, max-age=60",
                },
            )
        return httpx2.Response(200, stream=handler)

    proxy = AppProxy(
        hostnames=InMemoryHostnameResolver(
            [HostnameBinding(HOST, "tenant-a", "project-a", "allocated_subdomain", True)]
        ),
        backends=InMemoryProjectBackendResolver({("tenant-a", "project-a"): BACKEND}),
        audit=InMemoryAuditSink(),
    )
    app = create_app(
        proxy=proxy,
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(transport_handler)),
        settings=AppProxySettings(audit_dsn="", rate_limit_per_minute=rate_limit_per_minute),
        rate_limiter=PerHostRateLimiter(
            RateLimitSettings(requests_per_window=rate_limit_per_minute, window_seconds=60)
        ),
        billing=billing,
    )
    return TestClient(app), seen


class EchoWebSocketDialer:
    async def connect(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        open_timeout: float,
    ) -> Any:
        del url, headers, open_timeout
        return EchoBackendWebSocket()


class EchoBackendWebSocket:
    def __init__(self) -> None:
        self._incoming: asyncio.Queue[str | bytes] = asyncio.Queue()
        self.closed = False

    async def send(self, message: str | bytes) -> None:
        if isinstance(message, str):
            await self._incoming.put(f"echo:{message}")
        else:
            await self._incoming.put(b"echo:" + message)

    async def recv(self) -> str | bytes:
        return await self._incoming.get()

    async def close(self) -> None:
        self.closed = True


class RecordingBilling:
    def __init__(self, refusal: str | None = None) -> None:
        self.egress: list[tuple[str, str, str, int]] = []
        self.refusal = refusal

    def quota_refusal(self, host: str) -> str | None:
        del host
        return self.refusal

    async def report_egress(
        self, *, host: str, tenant_id: str, project_id: str, byte_count: int
    ) -> None:
        self.egress.append((host, tenant_id, project_id, byte_count))

    async def aclose(self) -> None:
        return None


def test_healthz() -> None:
    client, _ = _client()
    assert client.get("/healthz").status_code == 200


def test_websocket_relay_forwards_text_and_binary_frames_bidirectionally() -> None:
    billing = RecordingBilling()
    proxy = AppProxy(
        hostnames=InMemoryHostnameResolver(
            [HostnameBinding(HOST, "tenant-a", "project-a", "allocated_subdomain", True)]
        ),
        backends=InMemoryProjectBackendResolver({("tenant-a", "project-a"): BACKEND}),
        audit=InMemoryAuditSink(),
    )
    app = create_app(
        proxy=proxy,
        client=httpx2.AsyncClient(
            transport=httpx2.MockTransport(lambda request: httpx2.Response(200))
        ),
        settings=AppProxySettings(audit_dsn=""),
        websocket_dialer=EchoWebSocketDialer(),
        billing=billing,
    )

    with TestClient(app).websocket_connect("/", headers={"Host": HOST}) as websocket:
        websocket.send_text('{"type":"ping"}')
        assert websocket.receive_text() == 'echo:{"type":"ping"}'
        websocket.send_bytes(b"\x00\x01")
        assert websocket.receive_bytes() == b"echo:\x00\x01"
        websocket.send_text("after-binary")
        assert websocket.receive_text() == "echo:after-binary"

    assert billing.egress == [
        (HOST, "tenant-a", "project-a", len('echo:{"type":"ping"}')),
        (HOST, "tenant-a", "project-a", len(b"echo:\x00\x01")),
        (HOST, "tenant-a", "project-a", len("echo:after-binary")),
    ]


def test_reverse_proxy_strips_forged_identity_headers() -> None:
    client, seen = _client()
    response = client.get(
        "/hello?visible=true",
        headers={"Host": HOST, "X-Loopit-Tenant": "attacker", "X-Forwarded-For": "1.2.3.4"},
    )
    assert response.status_code == 200
    assert response.text == "app"
    assert seen[0].url == httpx2.URL(f"http://{BACKEND.host}:{BACKEND.port}/hello?visible=true")
    assert seen[0].headers["x-loopit-tenant"] == "tenant-a"
    assert seen[0].headers["x-forwarded-for"] != "1.2.3.4"


def test_successful_app_responses_keep_customer_policy_headers() -> None:
    client, _ = _client()
    response = client.get("/", headers={"Host": HOST})
    assert response.headers["content-security-policy"] == "default-src 'self'"
    assert response.headers["cache-control"] == "public, max-age=60"
    assert "x-frame-options" not in response.headers


def test_request_size_limit_is_enforced_before_backend_send() -> None:
    client, seen = _client()
    response = client.post(
        "/upload",
        headers={"Host": HOST},
        content=b"x" * (AppProxySettings().max_request_bytes + 1),
    )
    assert response.status_code == 413
    assert seen == []


def test_rate_limit_is_per_hostname() -> None:
    client, seen = _client(rate_limit_per_minute=1)
    assert client.get("/", headers={"Host": HOST}).status_code == 200
    assert client.get("/", headers={"Host": HOST}).status_code == 429
    assert len(seen) == 1


def test_proxy_reports_hosting_egress_after_streaming_response() -> None:
    billing = RecordingBilling()
    client, _ = _client(billing=billing)

    response = client.get("/", headers={"Host": HOST})

    assert response.status_code == 200
    assert billing.egress == [(HOST, "tenant-a", "project-a", len(b"app"))]


def test_proxy_returns_402_for_locally_observed_hosting_quota_exhaustion() -> None:
    client, seen = _client(billing=RecordingBilling("hosting_egress_bytes_per_day quota exceeded"))

    response = client.get("/", headers={"Host": HOST})

    assert response.status_code == 402
    assert "upgrade to keep it live" in response.text.lower()
    assert seen == []


@pytest.mark.asyncio
async def test_proxy_recovers_after_hosting_quota_refusal_expires_and_billing_allows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity_secret = hashlib.sha256(b"app-server-billing-identity").hexdigest()
    service_token = hashlib.sha256(b"app-server-billing-service").hexdigest()
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", identity_secret)
    monkeypatch.setenv("LOOPIT_SERVICE_TOKEN", service_token)

    from loopit_billing.ledger import BillingLedger
    from loopit_billing.plans import PLANS, PlanManager
    from loopit_billing.server import ServerSettings
    from loopit_billing.server import create_app as create_billing_app
    from loopit_store import InMemoryAuditStore, InMemoryQuotaStore, QuotaEntry

    quota = InMemoryQuotaStore()
    ledger = BillingLedger(quota=quota, audit=InMemoryAuditStore())
    ledger.grant(
        tenant_id="tenant-a",
        amount=Decimal("1"),
        source="test",
        idempotency_key="grant",
    )
    quota.append(
        QuotaEntry(
            entry_id="free-tier-egress-spent",
            tenant_id="tenant-a",
            amount=Decimal("0"),
            kind="reservation",
            source="test",
            description=(
                "pre-spend reservation; "
                f"quota.hosting_egress_bytes={PLANS['free'].limits.max_hosting_egress_bytes_per_day}"
            ),
            created_at=datetime.now(UTC),
        )
    )
    plans = PlanManager(ledger=ledger)
    billing_app = create_billing_app(
        settings=ServerSettings(
            store_dsn="",
            identity_secret=identity_secret,
            service_token=service_token,
        ),
        ledger=ledger,
        plans=plans,
    )
    reporter = BufferedHostingBillingReporter(
        billing_url="http://billing",
        service_token=service_token,
        client=httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=billing_app),
            base_url="http://billing",
        ),
        flush_bytes=1,
        flush_interval_seconds=60,
        refusal_ttl_seconds=0.1,
    )
    await reporter.report_egress(
        host=HOST, tenant_id="tenant-a", project_id="project-a", byte_count=1
    )
    await reporter.aclose()
    assert reporter.quota_refusal(HOST) == "hosting_egress_bytes_per_day quota exceeded"

    seen: list[httpx2.Request] = []

    def transport_handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(200, text="app")

    proxy = AppProxy(
        hostnames=InMemoryHostnameResolver(
            [HostnameBinding(HOST, "tenant-a", "project-a", "allocated_subdomain", True)]
        ),
        backends=InMemoryProjectBackendResolver({("tenant-a", "project-a"): BACKEND}),
        audit=InMemoryAuditSink(),
    )
    app = create_app(
        proxy=proxy,
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(transport_handler)),
        settings=AppProxySettings(audit_dsn=""),
        billing=reporter,
    )

    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app),
        base_url="http://edge",
    ) as client:
        blocked = await client.get("/", headers={"Host": HOST})
        assert blocked.status_code == 402
        assert seen == []

        plans.set_plan(tenant_id="tenant-a", plan_name="pro", idempotency_key="upgrade")
        await asyncio.sleep(0.11)
        revalidating = await client.get("/", headers={"Host": HOST})
        assert revalidating.status_code == 402
        assert seen == []

        await asyncio.sleep(0.03)
        recovered = await client.get("/", headers={"Host": HOST})

    assert recovered.status_code == 200
    assert recovered.text == "app"
    assert len(seen) == 1
    assert reporter.quota_refusal(HOST) is None
    await reporter.aclose()


def test_backend_down_returns_generic_error_without_backend_address() -> None:
    seen: list[httpx2.Request] = []

    def transport_handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        raise httpx2.ConnectError(
            f"connection refused at {BACKEND.host}:{BACKEND.port}", request=request
        )

    proxy = AppProxy(
        hostnames=InMemoryHostnameResolver(
            [HostnameBinding(HOST, "tenant-a", "project-a", "allocated_subdomain", True)]
        ),
        backends=InMemoryProjectBackendResolver({("tenant-a", "project-a"): BACKEND}),
        audit=InMemoryAuditSink(),
    )
    app = create_app(
        proxy=proxy,
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(transport_handler)),
        settings=AppProxySettings(audit_dsn=""),
    )
    response = TestClient(app).get("/", headers={"Host": HOST})
    assert response.status_code == 502
    assert BACKEND.host not in response.text
    assert str(BACKEND.port) not in response.text
    assert len(seen) == 1


def test_settings_require_audit_dsn_unless_ephemeral_dev_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LOOPIT_AUDIT_DSN", raising=False)
    monkeypatch.delenv("LOOPIT_AUDIT_EPHEMERAL", raising=False)

    with pytest.raises(Exception):
        AppProxySettings.from_env()


def test_settings_allow_explicit_ephemeral_audit_for_dev(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LOOPIT_AUDIT_DSN", raising=False)
    monkeypatch.setenv("LOOPIT_AUDIT_EPHEMERAL", "1")

    assert AppProxySettings.from_env().audit_dsn == ""
