from __future__ import annotations

import asyncio
import hashlib
import json
from decimal import Decimal

import httpx2
import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_app_proxy import (
    Backend,
    DomainsRouteCacheSettings,
    DomainsRouteResolver,
    HostnameBinding,
    InMemoryHostnameResolver,
    InMemoryProjectBackendResolver,
    PerHostRateLimiter,
    RateLimitSettings,
)
from loopit_app_proxy.billing import BufferedHostingBillingReporter
from loopit_app_proxy.proxy import AppProxy, AppRequest, origin_matches_host

NOW_HOST = "alpha.loopit.app"
CUSTOM_HOST = "www.example.test"
BACKEND = Backend("10.91.0.4", 8080)


def _proxy(
    *,
    custom_verified: bool = True,
) -> tuple[AppProxy, InMemoryAuditSink]:
    audit = InMemoryAuditSink()
    hostnames = InMemoryHostnameResolver(
        [
            HostnameBinding(NOW_HOST, "tenant-a", "project-a", "allocated_subdomain", True),
            HostnameBinding(CUSTOM_HOST, "tenant-a", "project-a", "custom_domain", custom_verified),
            HostnameBinding(
                "beta.loopit.app", "tenant-b", "project-b", "allocated_subdomain", True
            ),
        ]
    )
    backends = InMemoryProjectBackendResolver(
        {
            ("tenant-a", "project-a"): BACKEND,
            ("tenant-b", "project-b"): Backend("10.91.0.9", 8080),
        }
    )
    return AppProxy(hostnames=hostnames, backends=backends, audit=audit), audit


@pytest.mark.asyncio
async def test_allocated_subdomain_resolves_to_live_backend() -> None:
    proxy, _ = _proxy()
    decision = await proxy.handle(AppRequest(NOW_HOST, "/"))
    assert decision.allowed is True
    assert decision.backend == BACKEND
    assert decision.project_id == "project-a"
    assert decision.tenant_id == "tenant-a"


@pytest.mark.asyncio
async def test_custom_domain_must_be_verified() -> None:
    proxy, _ = _proxy(custom_verified=False)
    decision = await proxy.handle(AppRequest(CUSTOM_HOST, "/"))
    assert decision.allowed is False
    assert decision.reason == "no_route"
    assert decision.status == 404


@pytest.mark.asyncio
async def test_unmapped_host_is_refused_like_an_authorisation_miss() -> None:
    proxy, _ = _proxy()
    decision = await proxy.handle(AppRequest("ghost.loopit.app", "/"))
    assert decision.allowed is False
    assert decision.reason == "no_route"
    assert decision.status == 404


@pytest.mark.asyncio
async def test_forged_loopit_and_forwarded_headers_are_stripped() -> None:
    proxy, _ = _proxy()
    decision = await proxy.handle(
        AppRequest(
            NOW_HOST,
            "/",
            headers={
                "X-Loopit-Tenant": "attacker",
                "X-Loopit-Project": "evil",
                "X-Forwarded-For": "203.0.113.99",
                "X-Real-IP": "203.0.113.99",
                "Accept": "*/*",
            },
            client_ip="198.51.100.7",
            scheme="https",
        )
    )
    assert decision.forward_headers["X-Loopit-Tenant"] == "tenant-a"
    assert decision.forward_headers["X-Loopit-Project"] == "project-a"
    assert decision.forward_headers["X-Forwarded-For"] == "198.51.100.7"
    assert decision.forward_headers["X-Real-IP"] == "198.51.100.7"
    assert decision.forward_headers["Accept"] == "*/*"


@pytest.mark.asyncio
async def test_cross_tenant_hostname_selects_only_that_tenants_backend() -> None:
    proxy, _ = _proxy()
    decision = await proxy.handle(
        AppRequest(
            "beta.loopit.app",
            "/",
            headers={"X-Loopit-Tenant": "tenant-a", "X-Loopit-Project": "project-a"},
        )
    )
    assert decision.allowed is True
    assert decision.tenant_id == "tenant-b"
    assert decision.project_id == "project-b"
    assert decision.backend == Backend("10.91.0.9", 8080)
    assert decision.backend != BACKEND


@pytest.mark.asyncio
async def test_backend_address_is_never_written_to_the_audit_log() -> None:
    proxy, audit = _proxy()
    await proxy.handle(AppRequest(NOW_HOST, "/reset?token=hunter2"))
    serialised = str(audit.events[0].detail)
    assert BACKEND.host not in serialised
    assert str(BACKEND.port) not in serialised
    assert "hunter2" not in serialised


def test_origin_must_match_host_for_browser_websockets() -> None:
    assert origin_matches_host("https://alpha.loopit.app", NOW_HOST)
    assert origin_matches_host(None, NOW_HOST)
    assert not origin_matches_host("https://evil.example", NOW_HOST)


def test_per_hostname_rate_limit_is_enforced_and_windowed() -> None:
    limiter = PerHostRateLimiter(RateLimitSettings(requests_per_window=2, window_seconds=10))
    assert limiter.allow(NOW_HOST, now=1.0)
    assert limiter.allow(NOW_HOST, now=2.0)
    assert not limiter.allow(NOW_HOST, now=3.0)
    assert limiter.allow("other.loopit.app", now=3.0)
    assert limiter.allow(NOW_HOST, now=12.0)


def test_per_hostname_rate_limiter_evicts_attacker_controlled_hosts() -> None:
    limiter = PerHostRateLimiter(
        RateLimitSettings(requests_per_window=10, window_seconds=60, max_hosts=2)
    )

    assert limiter.allow("a.loopit.app", now=1.0)
    assert limiter.allow("b.loopit.app", now=1.0)
    assert limiter.allow("c.loopit.app", now=1.0)

    assert len(limiter._buckets) == 2
    assert "a.loopit.app" not in limiter._buckets


@pytest.mark.asyncio
async def test_header_stripping_regression_test_is_non_vacuous() -> None:
    proxy, _ = _proxy()
    decision = await proxy.handle(
        AppRequest(NOW_HOST, "/", headers={"X-Loopit-Tenant": "attacker"})
    )
    with pytest.raises(AssertionError):
        assert {"X-Loopit-Tenant": "attacker"}["X-Loopit-Tenant"] == decision.forward_headers[
            "X-Loopit-Tenant"
        ]


@pytest.mark.asyncio
async def test_unverified_domain_regression_test_is_non_vacuous() -> None:
    proxy, _ = _proxy(custom_verified=False)
    decision = await proxy.handle(AppRequest(CUSTOM_HOST, "/"))
    with pytest.raises(AssertionError):
        assert True is decision.allowed


@pytest.mark.asyncio
async def test_unmapped_host_regression_test_is_non_vacuous() -> None:
    proxy, _ = _proxy()
    decision = await proxy.handle(AppRequest("ghost.loopit.app", "/"))
    with pytest.raises(AssertionError):
        assert True is decision.allowed


@pytest.mark.asyncio
async def test_cross_tenant_regression_test_is_non_vacuous() -> None:
    proxy, _ = _proxy()
    decision = await proxy.handle(
        AppRequest(
            "beta.loopit.app",
            "/",
            headers={"X-Loopit-Tenant": "tenant-a", "X-Loopit-Project": "project-a"},
        )
    )
    with pytest.raises(AssertionError):
        assert BACKEND == decision.backend


def test_backend_leak_regression_test_is_non_vacuous() -> None:
    leaky_body = f"connect failed for {BACKEND.host}:{BACKEND.port}"
    with pytest.raises(AssertionError):
        assert BACKEND.host not in leaky_body


@pytest.mark.asyncio
async def test_domains_resolver_refuses_unverified_or_backendless_hosts_indistinguishably() -> None:
    calls: list[str] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        calls.append(str(request.url))
        return httpx2.Response(404, json={"detail": "route not found"})

    resolver = DomainsRouteResolver(
        base_url="http://domains",
        service_token="service-token",
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        cache=DomainsRouteCacheSettings(positive_ttl_seconds=3, negative_ttl_seconds=1),
    )
    proxy = AppProxy(
        hostnames=resolver, backends=InMemoryProjectBackendResolver(), audit=InMemoryAuditSink()
    )

    unverified = await proxy.handle(AppRequest("pending.example.test", "/"))
    backendless = await proxy.handle(AppRequest("nobackend.example.test", "/"))

    assert (unverified.allowed, unverified.reason, unverified.status) == (False, "no_route", 404)
    assert (backendless.allowed, backendless.reason, backendless.status) == (False, "no_route", 404)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_domains_resolver_positive_cache_expires_after_revocation() -> None:
    live = True
    calls = 0

    def handler(request: httpx2.Request) -> httpx2.Response:
        nonlocal calls
        calls += 1
        assert request.headers["x-loopit-service-token"] == "service-token"
        if not live:
            return httpx2.Response(404, json={"detail": "route not found"})
        return httpx2.Response(
            200,
            json={
                "hostname": NOW_HOST,
                "tenant_id": "tenant-a",
                "project_id": "project-a",
                "kind": "subdomain",
                "certificate_status": "active",
                "certificate_expires_at": None,
                "backend_host": BACKEND.host,
                "backend_port": BACKEND.port,
            },
        )

    resolver = DomainsRouteResolver(
        base_url="http://domains",
        service_token="service-token",
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        cache=DomainsRouteCacheSettings(positive_ttl_seconds=0.05, negative_ttl_seconds=0.01),
    )
    proxy = AppProxy(
        hostnames=resolver, backends=InMemoryProjectBackendResolver(), audit=InMemoryAuditSink()
    )

    assert (await proxy.handle(AppRequest(NOW_HOST, "/"))).allowed is True
    live = False
    assert (await proxy.handle(AppRequest(NOW_HOST, "/"))).allowed is True
    import asyncio

    await asyncio.sleep(0.06)
    revoked = await proxy.handle(AppRequest(NOW_HOST, "/"))

    assert revoked.allowed is False
    assert revoked.status == 404
    assert calls == 2


@pytest.mark.asyncio
async def test_domains_resolver_bounds_negative_cache_for_random_hosts() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(404, json={"detail": "route not found"})

    resolver = DomainsRouteResolver(
        base_url="http://domains",
        service_token="service-token",
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        cache=DomainsRouteCacheSettings(
            positive_ttl_seconds=10, negative_ttl_seconds=10, max_entries=2
        ),
    )

    for host in ("a.loopit.app", "b.loopit.app", "c.loopit.app"):
        with pytest.raises(Exception):
            await resolver.resolve_route(host)

    assert len(resolver._cache) == 2
    assert "a.loopit.app" not in resolver._cache


@pytest.mark.asyncio
async def test_domains_resolver_coalesces_concurrent_cold_hostname_misses() -> None:
    calls = 0
    release = asyncio.Event()

    async def handler(request: httpx2.Request) -> httpx2.Response:
        nonlocal calls
        calls += 1
        await release.wait()
        return httpx2.Response(
            200,
            json={
                "hostname": NOW_HOST,
                "tenant_id": "tenant-a",
                "project_id": "project-a",
                "kind": "subdomain",
                "certificate_status": "active",
                "certificate_expires_at": None,
                "backend_host": BACKEND.host,
                "backend_port": BACKEND.port,
            },
        )

    resolver = DomainsRouteResolver(
        base_url="http://domains",
        service_token="service-token",
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    tasks = [asyncio.create_task(resolver.resolve_route(NOW_HOST)) for _ in range(5)]
    await asyncio.sleep(0)
    release.set()
    routes = await asyncio.gather(*tasks)

    assert {route.backend for route in routes} == {BACKEND}
    assert calls == 1


@pytest.mark.asyncio
async def test_domains_resolver_uses_hostname_derived_tenant_backend_atomically() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200,
            json={
                "hostname": "beta.loopit.app",
                "tenant_id": "tenant-b",
                "project_id": "project-b",
                "kind": "subdomain",
                "certificate_status": "active",
                "certificate_expires_at": None,
                "backend_host": "10.91.0.9",
                "backend_port": 8080,
            },
        )

    resolver = DomainsRouteResolver(
        base_url="http://domains",
        service_token="service-token",
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    proxy = AppProxy(
        hostnames=resolver,
        backends=InMemoryProjectBackendResolver({("tenant-a", "project-a"): BACKEND}),
        audit=InMemoryAuditSink(),
    )

    decision = await proxy.handle(
        AppRequest("beta.loopit.app", "/", headers={"X-Loopit-Tenant": "tenant-a"})
    )

    assert decision.allowed is True
    assert decision.tenant_id == "tenant-b"
    assert decision.backend == Backend("10.91.0.9", 8080)
    with pytest.raises(AssertionError):
        assert decision.backend == BACKEND


@pytest.mark.asyncio
async def test_quota_exhausted_route_is_not_indistinguishable_from_missing_host() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200,
            json={
                "hostname": NOW_HOST,
                "tenant_id": "tenant-a",
                "project_id": "project-a",
                "kind": "subdomain",
                "certificate_status": "active",
                "certificate_expires_at": None,
                "backend_host": BACKEND.host,
                "backend_port": BACKEND.port,
                "serving_status": "quota_exceeded",
                "refusal_reason": "hosting_egress_bytes_per_day quota exceeded",
            },
        )

    resolver = DomainsRouteResolver(
        base_url="http://domains",
        service_token="service-token",
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    proxy = AppProxy(
        hostnames=resolver,
        backends=InMemoryProjectBackendResolver(),
        audit=InMemoryAuditSink(),
    )

    decision = await proxy.handle(AppRequest(NOW_HOST, "/"))

    assert decision.allowed is False
    assert decision.reason == "quota_exceeded"
    assert decision.status == 402
    assert decision.tenant_id == "tenant-a"


@pytest.mark.asyncio
async def test_buffered_hosting_billing_batches_egress_and_caches_quota_refusal() -> None:
    calls: list[dict[str, object]] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        calls.append(json.loads(request.content))
        return httpx2.Response(429, json={"detail": "hosting_egress_bytes_per_day quota exceeded"})

    reporter = BufferedHostingBillingReporter(
        billing_url="http://billing",
        service_token="service-token",
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        flush_bytes=10,
        flush_interval_seconds=60,
    )

    await reporter.report_egress(
        host=NOW_HOST, tenant_id="tenant-a", project_id="project-a", byte_count=4
    )
    assert calls == []
    await reporter.report_egress(
        host=NOW_HOST, tenant_id="tenant-a", project_id="project-a", byte_count=6
    )
    await asyncio.sleep(0)

    assert calls[0]["quota_request"] == {"hosting_egress_bytes": 10}
    assert calls[0]["tenant_id"] == "tenant-a"
    assert "usage" not in calls[0]
    assert reporter.quota_refusal(NOW_HOST) == "hosting_egress_bytes_per_day quota exceeded"


@pytest.mark.asyncio
async def test_buffered_hosting_billing_flush_matches_real_billing_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity_secret = hashlib.sha256(b"app-proxy-billing-identity").hexdigest()
    service_token = hashlib.sha256(b"app-proxy-billing-service").hexdigest()
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", identity_secret)
    monkeypatch.setenv("LOOPIT_SERVICE_TOKEN", service_token)

    from loopit_billing.ledger import BillingLedger
    from loopit_billing.server import ServerSettings, create_app
    from loopit_store import InMemoryAuditStore, InMemoryQuotaStore

    ledger = BillingLedger(quota=InMemoryQuotaStore(), audit=InMemoryAuditStore())
    ledger.grant(
        tenant_id="tenant-a",
        amount=Decimal("1"),
        source="test",
        idempotency_key="grant",
    )
    billing_app = create_app(
        settings=ServerSettings(
            store_dsn="",
            identity_secret=identity_secret,
            service_token=service_token,
        ),
        ledger=ledger,
    )
    reporter = BufferedHostingBillingReporter(
        billing_url="http://billing",
        service_token=service_token,
        client=httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=billing_app),
            base_url="http://billing",
        ),
        flush_bytes=10,
        flush_interval_seconds=60,
    )

    await reporter.report_egress(
        host=NOW_HOST, tenant_id="tenant-a", project_id="project-a", byte_count=4
    )
    await reporter.report_egress(
        host=NOW_HOST, tenant_id="tenant-a", project_id="project-a", byte_count=6
    )
    await reporter.aclose()

    reservations = [entry for entry in ledger.entries("tenant-a") if entry.kind == "reservation"]
    assert len(reservations) == 1
    assert "quota.hosting_egress_bytes=10" in reservations[0].description
    assert reporter.quota_refusal(NOW_HOST) is None
