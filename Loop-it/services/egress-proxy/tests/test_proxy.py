"""Tests for the logging egress proxy.

The property under test is completeness: every request produces exactly one
audit record, allowed ones included, and no record ever carries a credential.
"""

from __future__ import annotations

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_egress import (
    Category,
    EgressPolicy,
    EgressProxy,
    EgressRequest,
    StaticPolicyResolver,
    Verdict,
)

LEASE = "lease_1"
TENANT = "tenant_acme"


@pytest.fixture
def audit() -> InMemoryAuditSink:
    return InMemoryAuditSink()


@pytest.fixture
def resolver() -> StaticPolicyResolver:
    return StaticPolicyResolver(
        {
            LEASE: EgressPolicy(
                categories=(
                    Category("package_registries", enabled=True),
                    Category("deploy_targets", enabled=True, window="deploy_step_only"),
                ),
                extra_allow=frozenset({"api.stripe.com"}),
                router_host="router.internal.loopit",
            )
        }
    )


@pytest.fixture
def proxy(resolver: StaticPolicyResolver, audit: InMemoryAuditSink) -> EgressProxy:
    return EgressProxy(resolver=resolver, audit=audit)


def _request(url: str, **kwargs: object) -> EgressRequest:
    return EgressRequest(
        lease_id=str(kwargs.pop("lease_id", LEASE)),
        tenant_id=TENANT,
        method=str(kwargs.pop("method", "GET")),
        url=url,
        run_id="run_1",
        project_id="proj_shop",
        **kwargs,  # type: ignore[arg-type]
    )


# --- URL parsing --------------------------------------------------------------


def test_host_and_port_are_parsed_from_the_url() -> None:
    request = _request("https://registry.npmjs.org/left-pad")

    assert request.host == "registry.npmjs.org"
    assert request.port == 443


def test_an_explicit_port_wins() -> None:
    assert _request("http://pool.example.com:3333/").port == 3333


def test_a_bare_host_and_port_parses() -> None:
    request = _request("evil.example.com:4444")

    assert request.host == "evil.example.com"
    assert request.port == 4444


def test_a_malformed_port_does_not_crash_the_proxy() -> None:
    """A parse failure must fall through to default-deny, not raise."""
    assert _request("http://host.example.com:notaport/").port is None


# --- Enforcement --------------------------------------------------------------


def test_an_allowlisted_registry_is_permitted(proxy: EgressProxy) -> None:
    assert proxy.handle(_request("https://registry.npmjs.org/left-pad")).allowed


def test_an_unlisted_host_is_denied_by_default(proxy: EgressProxy) -> None:
    decision = proxy.handle(_request("https://paste.example.com/upload"))

    assert decision.verdict is Verdict.DENY
    assert decision.reason == "default_deny"


def test_a_metadata_reach_is_denied(proxy: EgressProxy) -> None:
    assert (
        proxy.handle(_request("http://169.254.169.254/latest/meta-data/")).verdict is Verdict.DENY
    )


def test_a_stratum_port_is_denied_through_the_proxy(proxy: EgressProxy) -> None:
    decision = proxy.handle(_request("http://registry.npmjs.org:5555/"))

    assert decision.reason == "stratum_port:5555"


def test_deploy_targets_stay_shut_during_a_build(proxy: EgressProxy) -> None:
    assert not proxy.handle(_request("https://api.vercel.com/v13/deployments")).allowed


def test_deploy_targets_open_in_the_deploy_step(proxy: EgressProxy) -> None:
    request = _request("https://api.vercel.com/v13/deployments", step="deploy")

    assert proxy.handle(request).allowed


def test_an_unknown_lease_gets_a_default_deny_policy(
    resolver: StaticPolicyResolver, audit: InMemoryAuditSink
) -> None:
    """An unrecognised lease must fail closed, not crash the proxy open."""
    proxy = EgressProxy(resolver=resolver, audit=audit)

    decision = proxy.handle(_request("https://registry.npmjs.org/x", lease_id="lease_unknown"))

    assert decision.verdict is Verdict.DENY


# --- Logging ------------------------------------------------------------------


def test_allowed_requests_are_logged_too(proxy: EgressProxy, audit: InMemoryAuditSink) -> None:
    """Exfiltration hides in the allowed set; logging only denials misses it."""
    proxy.handle(_request("https://registry.npmjs.org/left-pad"))

    assert len(audit.of_type("egress.allowed")) == 1


def test_every_request_produces_exactly_one_record(
    proxy: EgressProxy, audit: InMemoryAuditSink
) -> None:
    proxy.handle(_request("https://registry.npmjs.org/a"))
    proxy.handle(_request("https://paste.example.com/b"))
    proxy.handle(_request("https://api.stripe.com/v1/charges"))

    assert len(audit) == 3


def test_the_record_carries_the_forensic_context(
    proxy: EgressProxy, audit: InMemoryAuditSink
) -> None:
    proxy.handle(_request("https://registry.npmjs.org/left-pad", method="post"))
    event = audit.of_type("egress.allowed")[0]

    assert event.tenant_id == TENANT
    assert event.sandbox_lease_id == LEASE
    assert event.run_id == "run_1"
    assert event.plane == "data"
    assert event.outcome == "allowed"
    assert event.detail["method"] == "POST"
    assert event.detail["host"] == "registry.npmjs.org"
    assert event.detail["path"] == "/left-pad"


def test_denials_record_a_stable_machine_readable_reason(
    proxy: EgressProxy, audit: InMemoryAuditSink
) -> None:
    proxy.handle(_request("https://paste.example.com/upload"))

    assert audit.of_type("egress.denied")[0].detail["reason"] == "default_deny"


def test_query_values_are_never_logged(proxy: EgressProxy, audit: InMemoryAuditSink) -> None:
    """Tokens ride in query strings; logging them makes the audit store a key dump."""
    proxy.handle(_request("https://registry.npmjs.org/x?api_key=sk-live-abcdefghijklmnop&page=2"))
    serialised = str(audit.of_type("egress.allowed")[0].to_dict())

    assert "sk-live-abcdefghijklmnop" not in serialised
    assert "api_key" in serialised
    assert "page" in serialised


def test_resolved_ips_are_recorded(proxy: EgressProxy, audit: InMemoryAuditSink) -> None:
    proxy.handle(
        _request("https://registry.npmjs.org/x", resolved_ips=("104.16.0.35", "104.16.1.35"))
    )

    assert audit.of_type("egress.allowed")[0].detail["resolved_ips"] == [
        "104.16.0.35",
        "104.16.1.35",
    ]


def test_dns_rebinding_is_denied_and_logged(proxy: EgressProxy, audit: InMemoryAuditSink) -> None:
    """An allowlisted name pointing at link-local is the rebinding attack."""
    decision = proxy.handle(
        _request("https://registry.npmjs.org/x", resolved_ips=("169.254.169.254",))
    )

    assert decision.verdict is Verdict.DENY
    assert "metadata_endpoint" in str(audit.of_type("egress.denied")[0].detail["reason"])


# --- Accounting ---------------------------------------------------------------


def test_outbound_bytes_are_accumulated(proxy: EgressProxy) -> None:
    proxy.handle(_request("https://registry.npmjs.org/a", request_bytes=1000))
    proxy.handle(_request("https://registry.npmjs.org/b", request_bytes=2000))

    assert proxy.usage_for(LEASE).bytes_out == 3000
    assert proxy.usage_for(LEASE).requests_allowed == 2


def test_denied_requests_do_not_consume_budget(proxy: EgressProxy) -> None:
    proxy.handle(_request("https://paste.example.com/x", request_bytes=5000))

    usage = proxy.usage_for(LEASE)
    assert usage.bytes_out == 0
    assert usage.requests_denied == 1
    assert usage.denied_reasons["default_deny"] == 1


def test_the_byte_budget_stops_bulk_exfiltration(
    resolver: StaticPolicyResolver, audit: InMemoryAuditSink
) -> None:
    proxy = EgressProxy(resolver=resolver, audit=audit, byte_budget=10_000)
    proxy.handle(_request("https://registry.npmjs.org/a", request_bytes=9_000))

    decision = proxy.handle(_request("https://registry.npmjs.org/b", request_bytes=2_000))

    assert decision.reason == "egress_byte_budget_exceeded"
    assert audit.of_type("egress.denied")[0].detail["reason"] == "egress_byte_budget_exceeded"


def test_the_budget_is_per_lease_not_global(
    resolver: StaticPolicyResolver, audit: InMemoryAuditSink
) -> None:
    resolver.set("lease_2", resolver.policy_for(LEASE))
    proxy = EgressProxy(resolver=resolver, audit=audit, byte_budget=10_000)
    proxy.handle(_request("https://registry.npmjs.org/a", request_bytes=9_999))

    other = _request("https://registry.npmjs.org/b", lease_id="lease_2", request_bytes=9_999)
    assert proxy.handle(other).allowed


def test_usage_is_dropped_when_a_lease_ends(proxy: EgressProxy) -> None:
    proxy.handle(_request("https://registry.npmjs.org/a", request_bytes=1000))
    proxy.forget(LEASE)

    assert proxy.usage_for(LEASE).bytes_out == 0


def test_a_nonpositive_budget_is_refused(
    resolver: StaticPolicyResolver, audit: InMemoryAuditSink
) -> None:
    with pytest.raises(ValueError, match="positive"):
        EgressProxy(resolver=resolver, audit=audit, byte_budget=0)
