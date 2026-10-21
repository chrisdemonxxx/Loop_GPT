"""Tests for the preview proxy (P1-6).

The theme throughout: a preview URL is a capability, and every refusal must
look the same from outside so the proxy cannot be used as an enumerator.
"""

from __future__ import annotations

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_preview import (
    SECURITY_HEADERS,
    Backend,
    PreviewClaims,
    PreviewProxy,
    PreviewRequest,
    Route,
    RouteConflict,
    RouteNotFound,
    RouteTable,
    TokenExpired,
    TokenInvalid,
    TokenSigner,
    mint_for,
)

KEY = b"k" * 32
OTHER_KEY = b"z" * 32
NOW = 1_700_000_000.0
DOMAIN = ".preview.loopit.dev"
HOST = "proj-a.preview.loopit.dev"
BACKEND = Backend("10.42.0.7", 5173)

ROUTE = Route(
    preview_host=HOST,
    project_id="proj-a",
    tenant_id="tenant-1",
    lease_id="lease-1",
    backend=BACKEND,
)


def build() -> tuple[PreviewProxy, RouteTable, InMemoryAuditSink]:
    routes = RouteTable()
    routes.bind(ROUTE)
    audit = InMemoryAuditSink()
    proxy = PreviewProxy(signer=TokenSigner(KEY), routes=routes, audit=audit, preview_domain=DOMAIN)
    return proxy, routes, audit


def token(
    *,
    project_id: str = "proj-a",
    tenant_id: str = "tenant-1",
    lease_id: str = "lease-1",
    key: bytes = KEY,
    ttl: int = 900,
) -> str:
    return mint_for(
        TokenSigner(key),
        project_id=project_id,
        tenant_id=tenant_id,
        lease_id=lease_id,
        subject="user-1",
        now=NOW,
        ttl_seconds=ttl,
    )


# --- Tokens -------------------------------------------------------------------


def test_short_signing_keys_are_refused() -> None:
    with pytest.raises(ValueError, match="at least 32 bytes"):
        TokenSigner(b"too-short")


def test_round_trip_recovers_the_claims() -> None:
    signer = TokenSigner(KEY)
    claims = signer.verify(token(), now=NOW)
    assert claims == PreviewClaims("proj-a", "tenant-1", "lease-1", "user-1", NOW + 900)


def test_a_token_signed_with_another_key_does_not_verify() -> None:
    with pytest.raises(TokenInvalid, match="signature"):
        TokenSigner(KEY).verify(token(key=OTHER_KEY), now=NOW)


def test_tampering_with_the_payload_breaks_the_signature() -> None:
    body, _, signature = token().partition(".")
    forged = f"{body[:-2]}xy.{signature}"
    with pytest.raises(TokenInvalid):
        TokenSigner(KEY).verify(forged, now=NOW)


@pytest.mark.parametrize("bad", ["", "no-dot", ".sig", "body."])
def test_malformed_tokens_are_refused(bad: str) -> None:
    with pytest.raises(TokenInvalid):
        TokenSigner(KEY).verify(bad, now=NOW)


def test_expiry_is_enforced_at_the_boundary() -> None:
    signer = TokenSigner(KEY)
    signer.verify(token(ttl=900), now=NOW + 899)
    with pytest.raises(TokenExpired):
        signer.verify(token(ttl=900), now=NOW + 900)


def test_a_forged_token_reports_invalid_not_expired() -> None:
    """Signature is checked first, so forgeries never learn about expiry."""
    stale_forgery = mint_for(
        TokenSigner(OTHER_KEY),
        project_id="p",
        tenant_id="t",
        lease_id="l",
        subject="s",
        now=NOW,
        ttl_seconds=1,
    )
    with pytest.raises(TokenInvalid):
        TokenSigner(KEY).verify(stale_forgery, now=NOW + 9999)


def test_claims_reject_empty_identifiers() -> None:
    with pytest.raises(ValueError, match="project_id"):
        PreviewClaims("", "t", "l", "s", NOW)


def test_non_positive_ttl_is_refused() -> None:
    with pytest.raises(ValueError, match="ttl_seconds"):
        mint_for(
            TokenSigner(KEY),
            project_id="p",
            tenant_id="t",
            lease_id="l",
            subject="s",
            now=NOW,
            ttl_seconds=0,
        )


# --- Routing ------------------------------------------------------------------


def test_hosts_are_matched_case_insensitively() -> None:
    routes = RouteTable()
    routes.bind(ROUTE)
    assert routes.resolve_for(HOST.upper(), project_id="proj-a", tenant_id="tenant-1") == ROUTE


def test_rebinding_the_same_lease_is_idempotent() -> None:
    routes = RouteTable()
    routes.bind(ROUTE)
    routes.bind(ROUTE)
    assert len(routes) == 1


def test_a_host_cannot_be_stolen_by_another_lease() -> None:
    routes = RouteTable()
    routes.bind(ROUTE)
    thief = Route(HOST, "proj-b", "tenant-2", "lease-2", Backend("10.0.0.9", 80))
    with pytest.raises(RouteConflict):
        routes.bind(thief)


def test_another_tenant_gets_not_found_rather_than_forbidden() -> None:
    routes = RouteTable()
    routes.bind(ROUTE)
    with pytest.raises(RouteNotFound):
        routes.resolve_for(HOST, project_id="proj-a", tenant_id="tenant-2")


def test_releasing_a_lease_removes_all_of_its_routes() -> None:
    routes = RouteTable()
    routes.bind(ROUTE)
    routes.bind(Route("b.preview.loopit.dev", "proj-a", "tenant-1", "lease-1", BACKEND))
    assert routes.unbind_lease("lease-1") == 2
    assert len(routes) == 0


def test_unbinding_twice_is_not_an_error() -> None:
    routes = RouteTable()
    routes.bind(ROUTE)
    routes.unbind(HOST)
    routes.unbind(HOST)
    assert HOST not in routes


@pytest.mark.parametrize("port", [0, 65536, -1])
def test_backends_reject_impossible_ports(port: int) -> None:
    with pytest.raises(ValueError, match="port"):
        Backend("10.0.0.1", port)


# --- Proxy authorisation ------------------------------------------------------


def test_a_valid_request_is_forwarded_to_the_backend() -> None:
    proxy, _, _ = build()
    decision = proxy.handle(PreviewRequest(HOST, "/", token=token()), now=NOW)
    assert decision.allowed is True
    assert decision.backend == BACKEND
    assert decision.status == 200


def test_an_anonymous_request_is_refused() -> None:
    proxy, _, _ = build()
    decision = proxy.handle(PreviewRequest(HOST, "/"), now=NOW)
    assert decision.allowed is False
    assert decision.reason == "missing_token"
    assert decision.status == 401


def test_a_token_for_another_project_cannot_open_this_one() -> None:
    proxy, _, _ = build()
    decision = proxy.handle(PreviewRequest(HOST, "/", token=token(project_id="proj-b")), now=NOW)
    assert decision.allowed is False
    assert decision.reason == "no_route"


def test_a_token_for_another_tenant_cannot_open_this_project() -> None:
    proxy, _, _ = build()
    decision = proxy.handle(PreviewRequest(HOST, "/", token=token(tenant_id="tenant-2")), now=NOW)
    assert decision.allowed is False
    assert decision.reason == "no_route"


def test_a_stale_lease_token_does_not_reach_the_current_sandbox() -> None:
    proxy, routes, _ = build()
    routes.unbind_lease("lease-1")
    routes.bind(Route(HOST, "proj-a", "tenant-1", "lease-2", Backend("10.42.0.9", 5173)))
    decision = proxy.handle(PreviewRequest(HOST, "/", token=token(lease_id="lease-1")), now=NOW)
    assert decision.allowed is False
    assert decision.reason == "no_route"


def test_a_released_lease_stops_serving_immediately() -> None:
    proxy, routes, _ = build()
    routes.unbind_lease("lease-1")
    decision = proxy.handle(PreviewRequest(HOST, "/", token=token()), now=NOW)
    assert decision.allowed is False


def test_an_expired_token_is_refused() -> None:
    proxy, _, _ = build()
    decision = proxy.handle(PreviewRequest(HOST, "/", token=token(ttl=60)), now=NOW + 61)
    assert decision.reason == "expired_token"


def test_a_forged_token_is_refused() -> None:
    proxy, _, _ = build()
    decision = proxy.handle(PreviewRequest(HOST, "/", token=token(key=OTHER_KEY)), now=NOW)
    assert decision.reason == "invalid_token"


def test_lookalike_domains_do_not_match_the_preview_domain() -> None:
    proxy, _, _ = build()
    decision = proxy.handle(PreviewRequest("evil-preview.loopit.dev", "/", token=token()), now=NOW)
    assert decision.reason == "host_unknown"


def test_preview_domain_must_be_a_real_subdomain_suffix() -> None:
    with pytest.raises(ValueError, match="must start with"):
        PreviewProxy(
            signer=TokenSigner(KEY),
            routes=RouteTable(),
            audit=InMemoryAuditSink(),
            preview_domain="preview.loopit.dev",
        )


def test_every_authorisation_failure_returns_the_same_status() -> None:
    """A wrong project must be indistinguishable from a nonexistent one."""
    proxy, _, _ = build()
    wrong_project = proxy.decide(
        PreviewRequest(HOST, "/", token=token(project_id="proj-b")), now=NOW
    )
    no_such_host = proxy.decide(
        PreviewRequest("ghost.preview.loopit.dev", "/", token=token()), now=NOW
    )
    assert wrong_project.status == no_such_host.status == 404
    assert wrong_project.reason == no_such_host.reason == "no_route"


# --- Headers ------------------------------------------------------------------


def test_client_supplied_identity_headers_are_stripped() -> None:
    proxy, _, _ = build()
    request = PreviewRequest(
        HOST,
        "/",
        token=token(),
        headers={"X-Loopit-Tenant": "tenant-9", "X-Forwarded-For": "1.2.3.4", "Accept": "*/*"},
    )
    decision = proxy.handle(request, now=NOW)
    assert decision.forward_headers["X-Loopit-Tenant"] == "tenant-1"
    assert "X-Forwarded-For" not in decision.forward_headers
    assert decision.forward_headers["Accept"] == "*/*"


def test_security_headers_are_applied_to_every_response() -> None:
    proxy, _, _ = build()
    decision = proxy.handle(PreviewRequest(HOST, "/", token=token()), now=NOW)
    assert decision.response_headers == SECURITY_HEADERS
    assert "frame-ancestors 'self'" in decision.response_headers["Content-Security-Policy"]
    assert decision.response_headers["Cache-Control"] == "no-store, private"


def test_refusals_also_carry_security_headers() -> None:
    proxy, _, _ = build()
    decision = proxy.handle(PreviewRequest(HOST, "/"), now=NOW)
    assert decision.response_headers == SECURITY_HEADERS


# --- Audit --------------------------------------------------------------------


def test_allowed_and_denied_requests_are_both_audited() -> None:
    proxy, _, audit = build()
    proxy.handle(PreviewRequest(HOST, "/", token=token()), now=NOW)
    proxy.handle(PreviewRequest(HOST, "/"), now=NOW)
    assert [event.type for event in audit.events] == ["preview.allowed", "preview.denied"]


def test_the_backend_address_is_never_written_to_the_audit_log() -> None:
    proxy, _, audit = build()
    proxy.handle(PreviewRequest(HOST, "/", token=token()), now=NOW)
    serialised = str(audit.events[0].detail)
    assert BACKEND.host not in serialised
    assert str(BACKEND.port) not in serialised


def test_query_values_are_never_logged() -> None:
    proxy, _, audit = build()
    proxy.handle(
        PreviewRequest(HOST, "/reset?token=hunter2", token=token()),
        now=NOW,
    )
    detail = audit.events[0].detail
    assert detail["path"] == "/reset"
    assert detail["query_present"] is True
    assert "hunter2" not in str(detail)


def test_denied_events_record_the_reason_and_status() -> None:
    proxy, _, audit = build()
    proxy.handle(PreviewRequest(HOST, "/", token=token(key=OTHER_KEY)), now=NOW)
    detail = audit.events[0].detail
    assert detail["reason"] == "invalid_token"
    assert detail["status"] == 404


def test_decide_does_not_audit() -> None:
    """``decide`` is the pure half; only ``handle`` writes the record."""
    proxy, _, audit = build()
    proxy.decide(PreviewRequest(HOST, "/", token=token()), now=NOW)
    assert audit.events == ()
