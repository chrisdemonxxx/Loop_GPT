from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from threading import Barrier

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_auth import Actor
from loopit_domains import (
    DomainPurchase,
    DomainPurchaseAttempt,
    DomainService,
    DomainStatus,
    FakeCertificateAuthority,
    FakeDomainRegistrar,
    InMemoryDnsProvider,
    InMemoryPublicDnsResolver,
    PurchaseAttemptStatus,
    SqliteDomainRepository,
)
from loopit_domains.errors import DomainConflict, InvalidDomain, ReservedName, VerificationFailed

NOW = datetime(2026, 1, 1, tzinfo=UTC)
PURCHASE_ATTEMPT_DB = Path("services\\domains\\tests\\.purchase-attempts-test.sqlite")
ROUTING_STATE_DB = Path("services\\domains\\tests\\.routing-state-test.sqlite")


def actor(
    tenant_id: str = "tenant-1", role: str = "owner", scopes: frozenset[str] = frozenset()
) -> Actor:
    return Actor(
        subject="user-1",
        tenant_id=tenant_id,
        org_id=tenant_id,
        role=role,  # type: ignore[arg-type]
        scopes=scopes,
    )


class RecordingBillingClient:
    def __init__(self) -> None:
        self.custom_reservations: list[tuple[str, str, str]] = []
        self.registration_reservations: list[tuple[str, str, Decimal]] = []
        self.registration_meters: list[tuple[str, str, Decimal]] = []

    def reserve_custom_domain(
        self, *, tenant_id: str, project_id: str, hostname: str, idempotency_key: str
    ) -> None:
        _ = idempotency_key
        self.custom_reservations.append((tenant_id, project_id, hostname))

    def reserve_domain_registration(
        self,
        *,
        tenant_id: str,
        hostname: str,
        estimated_cost: Decimal,
        idempotency_key: str,
    ) -> None:
        _ = idempotency_key
        self.registration_reservations.append((tenant_id, hostname, estimated_cost))

    def meter_domain_registration(
        self,
        *,
        tenant_id: str,
        hostname: str,
        registrar_cost: Decimal,
        idempotency_key: str,
    ) -> None:
        _ = idempotency_key
        self.registration_meters.append((tenant_id, hostname, registrar_cost))


def build() -> tuple[
    DomainService, InMemoryDnsProvider, FakeCertificateAuthority, InMemoryPublicDnsResolver
]:
    dns = InMemoryDnsProvider()
    public_resolver = InMemoryPublicDnsResolver()
    ca = FakeCertificateAuthority()
    service = DomainService(
        base_domain="loopit.app",
        app_proxy_target="app-proxy.loopit.internal",
        dns=dns,
        certificates=ca,
        public_resolver=public_resolver,
        audit=InMemoryAuditSink(),
        platform_hostnames=frozenset({"console.loopit.app"}),
        brand_denylist=frozenset({"paypal", "yourbank"}),
    )
    return service, dns, ca, public_resolver


def register_backend(service: DomainService, hostname: str, project_id: str = "project") -> None:
    service.register_backend_for_host(
        hostname=hostname,
        project_id=project_id,
        host="slice-a.internal",
        port=8080,
        now=NOW,
    )


def test_allocated_subdomains_are_opaque_and_served_with_wildcard_certificate() -> None:
    service, _, ca, _ = build()

    record = service.allocate_subdomain(actor=actor(), project_id="my-bank-login", now=NOW)
    register_backend(service, record.hostname, "my-bank-login")
    route = service.route_for_host(record.hostname, now=NOW)

    assert record.label.startswith("p-")
    assert "my-bank-login" not in record.hostname
    assert route.project_id == "my-bank-login"
    assert ca.issued[0] == ("platform", ("*.loopit.app",), "dns-01")


def test_user_chosen_label_is_human_readable_when_safe() -> None:
    service, _, _, _ = build()

    record = service.claim_subdomain_label(
        actor=actor(), project_id="project", requested_label="my-todo-app", now=NOW
    )
    register_backend(service, record.hostname)

    assert record.hostname == "my-todo-app.loopit.app"
    assert service.route_for_host(record.hostname, now=NOW).project_id == "project"


def test_automatic_allocation_falls_back_when_requested_label_is_unsafe() -> None:
    service, _, _, _ = build()

    record = service.allocate_subdomain(
        actor=actor(), project_id="project", requested_label="login-yourbank", now=NOW
    )

    assert record.label.startswith("p-")
    assert "login-yourbank" not in record.hostname


@pytest.mark.parametrize("label", ["www", "api", "admin", "mail", "preview", "status"])
def test_reserved_subdomain_refused(label: str) -> None:
    service, _, _, _ = build()

    with pytest.raises(ReservedName):
        service.claim_subdomain_label(
            actor=actor(), project_id="project", requested_label=label, now=NOW
        )


@pytest.mark.parametrize("label", ["secure-login-paypal", "my-paypal-shop", "wallet-helper"])
def test_denylisted_substring_subdomain_refused(label: str) -> None:
    service, _, _, _ = build()

    with pytest.raises(ReservedName):
        service.claim_subdomain_label(
            actor=actor(), project_id="project", requested_label=label, now=NOW
        )
    assert label not in service.repository.subdomains_by_label


@pytest.mark.parametrize("label", ["xn--paypal-4ve", "bad_name", "-leading", "trailing-"])
def test_confusable_or_invalid_subdomain_label_refused(label: str) -> None:
    service, _, _, _ = build()

    with pytest.raises(InvalidDomain):
        service.claim_subdomain_label(
            actor=actor(), project_id="project", requested_label=label, now=NOW
        )
    assert label not in service.repository.subdomains_by_label


def test_cross_tenant_taken_subdomain_refused_without_owner_leakage() -> None:
    service, _, _, _ = build()
    service.claim_subdomain_label(
        actor=actor("tenant-1"), project_id="project-a", requested_label="shareable", now=NOW
    )

    with pytest.raises(DomainConflict, match="unavailable"):
        service.claim_subdomain_label(
            actor=actor("tenant-2"),
            project_id="project-b",
            requested_label="shareable",
            now=NOW,
        )
    assert service.repository.subdomains_by_label["shareable"].tenant_id == "tenant-1"


def test_duplicate_readable_label_claim_is_atomic_under_concurrency() -> None:
    service, _, _, _ = build()
    barrier = Barrier(2)

    def claim(tenant_id: str) -> str:
        barrier.wait(timeout=5)
        try:
            record = service.claim_subdomain_label(
                actor=actor(tenant_id),
                project_id=f"project-{tenant_id}",
                requested_label="race-winner",
                now=NOW,
            )
        except DomainConflict:
            return "conflict"
        return record.hostname

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = tuple(pool.map(claim, ("tenant-1", "tenant-2")))

    assert sorted(results) == ["conflict", "race-winner.loopit.app"]
    assert service.repository.subdomains_by_label["race-winner"].status.value == "verified"


def test_custom_domain_is_not_served_until_verified() -> None:
    service, _, _, _ = build()
    claim = service.claim_custom_domain(
        actor=actor(), project_id="project", hostname="app.example.org", now=NOW
    )

    with pytest.raises(DomainConflict):
        service.route_for_host(claim.hostname, now=NOW)


def test_cross_tenant_domain_claim_refused() -> None:
    service, _, _, public_resolver = build()
    first = service.claim_custom_domain(
        actor=actor("tenant-1"), project_id="project", hostname="app.example.org", now=NOW
    )
    public_resolver.set_txt(first.challenge_name, first.challenge_value)
    service.verify_custom_domain(actor=actor("tenant-1"), hostname="app.example.org", now=NOW)

    with pytest.raises(DomainConflict):
        service.claim_custom_domain(
            actor=actor("tenant-2"), project_id="project", hostname="app.example.org", now=NOW
        )


def test_unverified_custom_domain_can_be_reclaimed_by_true_owner() -> None:
    service, _, _, _ = build()
    first = service.claim_custom_domain(
        actor=actor("tenant-1"), project_id="project-a", hostname="victim.example.org", now=NOW
    )

    second = service.claim_custom_domain(
        actor=actor("tenant-2"), project_id="project-b", hostname="victim.example.org", now=NOW
    )

    assert first.status.value == "pending"
    assert second.tenant_id == "tenant-2"
    assert service.repository.custom_by_host["victim.example.org"].tenant_id == "tenant-2"


def test_expired_verification_refused() -> None:
    service, _, _, public_resolver = build()
    claim = service.claim_custom_domain(
        actor=actor(), project_id="project", hostname="app.example.org", now=NOW
    )
    public_resolver.set_txt(claim.challenge_name, claim.challenge_value)

    with pytest.raises(VerificationFailed):
        service.verify_custom_domain(
            actor=actor(), hostname="app.example.org", now=NOW + timedelta(days=2)
        )

    with pytest.raises(DomainConflict):
        service.route_for_host("app.example.org", now=NOW + timedelta(days=2))


def test_verified_custom_domain_gets_certificate_and_route() -> None:
    service, _, ca, public_resolver = build()
    claim = service.claim_custom_domain(
        actor=actor(), project_id="project", hostname="app.example.org", now=NOW
    )
    public_resolver.set_txt(claim.challenge_name, f'"{claim.challenge_value}"')

    service.verify_custom_domain(actor=actor(), hostname="app.example.org", now=NOW)
    register_backend(service, "app.example.org")
    route = service.route_for_host("app.example.org", now=NOW)

    assert route.project_id == "project"
    assert route.kind == "custom"
    assert ca.issued[-1] == ("tenant-1", ("app.example.org",), "http-01")


def test_custom_domain_verification_uses_public_resolver_not_platform_dns() -> None:
    service, dns, _, public_resolver = build()
    claim = service.claim_custom_domain(
        actor=actor(), project_id="project", hostname="app.example.co.uk", now=NOW
    )
    dns.create_record(
        zone="example.co.uk",
        name=claim.challenge_name,
        type="TXT",
        content=claim.challenge_value,
    )

    with pytest.raises(VerificationFailed):
        service.verify_custom_domain(actor=actor(), hostname=claim.hostname, now=NOW)

    public_resolver.set_txt(claim.challenge_name, claim.challenge_value)
    verified = service.verify_custom_domain(actor=actor(), hostname=claim.hostname, now=NOW)

    assert verified.status.value == "verified"


def test_verified_hostname_without_backend_is_refused_like_missing_route() -> None:
    service, _, _, _ = build()
    record = service.claim_subdomain_label(
        actor=actor(), project_id="project", requested_label="no-backend", now=NOW
    )

    with pytest.raises(DomainConflict, match="host is not verified"):
        service.route_for_host(record.hostname, now=NOW)


def test_quota_exhausted_route_still_resolves_with_safe_reason() -> None:
    service, _, _, _ = build()
    record = service.claim_subdomain_label(
        actor=actor(), project_id="project", requested_label="over-quota", now=NOW
    )
    service.register_backend_for_host(
        hostname=record.hostname,
        project_id="project",
        host="slice-a.internal",
        port=8080,
        serving_status="quota_exceeded",
        refusal_reason="hosting_egress_bytes_per_day quota exceeded",
        now=NOW,
    )

    route = service.route_for_host(record.hostname, now=NOW)

    assert route.backend.serving_status == "quota_exceeded"
    assert route.backend.refusal_reason == "hosting_egress_bytes_per_day quota exceeded"


def test_backend_registration_is_bound_to_hostname_owner() -> None:
    service, _, _, _ = build()
    record = service.claim_subdomain_label(
        actor=actor("tenant-a"), project_id="owned-project", requested_label="owned", now=NOW
    )

    with pytest.raises(DomainConflict, match="host is not verified"):
        service.register_backend_for_host(
            hostname=record.hostname,
            project_id="attacker-project",
            host="slice-a.internal",
            port=8080,
            now=NOW,
        )


def test_domain_purchase_uses_fake_registrar_and_scopes_to_tenant() -> None:
    service, _, _, _ = build()

    quote = service.quote_domain(actor=actor(), hostname="new-name.example", term_years=2)
    purchase = service.purchase_domain(
        actor=actor(),
        hostname="new-name.example",
        term_years=2,
        idempotency_key="purchase-new-name",
    )

    assert quote.available is True
    assert purchase.tenant_id == "tenant-1"
    assert purchase.domain == "new-name.example"


def test_domain_purchase_reserves_and_meters_before_and_after_registrar_call() -> None:
    billing = RecordingBillingClient()
    registrar = FakeDomainRegistrar()
    service = DomainService(
        base_domain="loopit.app",
        app_proxy_target="app-proxy.loopit.internal",
        dns=InMemoryDnsProvider(),
        certificates=FakeCertificateAuthority(),
        audit=InMemoryAuditSink(),
        registrar=registrar,
        billing=billing,
    )

    purchase = service.purchase_domain(
        actor=actor(),
        hostname="billable.example",
        idempotency_key="billing-domain-registration",
    )

    assert purchase.domain == "billable.example"
    assert billing.registration_reservations == [
        ("tenant-1", "billable.example", Decimal("13.8000"))
    ]
    assert registrar.purchase_calls == [
        ("tenant-1", "billable.example", "billing-domain-registration")
    ]
    assert billing.registration_meters == [("tenant-1", "billable.example", Decimal("12.00"))]


def test_custom_domain_claim_reserves_quota_before_persisting_claim() -> None:
    billing = RecordingBillingClient()
    service = DomainService(
        base_domain="loopit.app",
        app_proxy_target="app-proxy.loopit.internal",
        dns=InMemoryDnsProvider(),
        certificates=FakeCertificateAuthority(),
        audit=InMemoryAuditSink(),
        billing=billing,
    )

    claim = service.claim_custom_domain(
        actor=actor(), project_id="project", hostname="quota.example.org", now=NOW
    )

    assert billing.custom_reservations == [("tenant-1", "project", "quota.example.org")]
    assert service.repository.custom_by_host[claim.hostname] == claim


def test_domain_purchase_is_idempotent_on_stable_key() -> None:
    service, _, _, _ = build()

    first = service.purchase_domain(
        actor=actor(),
        hostname="idempotent.example",
        idempotency_key="billing-domain-registration-1",
    )
    retry = service.purchase_domain(
        actor=actor(),
        hostname="idempotent.example",
        idempotency_key="billing-domain-registration-1",
    )

    assert retry == first
    assert len(service.repository.purchase_attempts) == 1


def test_domain_purchase_attempts_persist_across_repository_restart() -> None:
    PURCHASE_ATTEMPT_DB.unlink(missing_ok=True)
    try:
        repo = SqliteDomainRepository(str(PURCHASE_ATTEMPT_DB))
        registrar = FakeDomainRegistrar()
        service = DomainService(
            base_domain="loopit.app",
            app_proxy_target="app-proxy.loopit.internal",
            dns=InMemoryDnsProvider(),
            certificates=FakeCertificateAuthority(),
            audit=InMemoryAuditSink(),
            registrar=registrar,
            repository=repo,
        )
        first = service.purchase_domain(
            actor=actor(), hostname="persisted.example", idempotency_key="persisted-key"
        )

        restarted = SqliteDomainRepository(str(PURCHASE_ATTEMPT_DB))

        assert restarted.purchase_attempts[("tenant-1", "persisted-key")].purchase == first
        repo.close()
        restarted.close()
    finally:
        PURCHASE_ATTEMPT_DB.unlink(missing_ok=True)


def test_routing_and_verification_state_persists_across_repository_restart() -> None:
    ROUTING_STATE_DB.unlink(missing_ok=True)
    repo: SqliteDomainRepository | None = None
    restarted_repo: SqliteDomainRepository | None = None
    try:
        repo = SqliteDomainRepository(str(ROUTING_STATE_DB))
        public_resolver = InMemoryPublicDnsResolver()
        service = DomainService(
            base_domain="loopit.app",
            app_proxy_target="app-proxy.loopit.internal",
            dns=InMemoryDnsProvider(),
            certificates=FakeCertificateAuthority(),
            audit=InMemoryAuditSink(),
            public_resolver=public_resolver,
            repository=repo,
        )
        subdomain = service.claim_subdomain_label(
            actor=actor(), project_id="project", requested_label="persisted-route", now=NOW
        )
        service.register_backend_for_host(
            hostname=subdomain.hostname,
            project_id="project",
            host="slice-a.internal",
            port=8080,
            now=NOW,
        )
        claim = service.claim_custom_domain(
            actor=actor(),
            project_id="custom-project",
            hostname="persisted.example.org",
            now=NOW,
        )
        public_resolver.set_txt(claim.challenge_name, claim.challenge_value)
        verified = service.verify_custom_domain(actor=actor(), hostname=claim.hostname, now=NOW)
        service.register_backend_for_host(
            hostname=verified.hostname,
            project_id="custom-project",
            host="slice-b.internal",
            port=9090,
            now=NOW,
        )
        repo.close()
        repo = None

        restarted_repo = SqliteDomainRepository(str(ROUTING_STATE_DB))
        restarted = DomainService(
            base_domain="loopit.app",
            app_proxy_target="app-proxy.loopit.internal",
            dns=InMemoryDnsProvider(),
            certificates=FakeCertificateAuthority(),
            audit=InMemoryAuditSink(),
            public_resolver=public_resolver,
            repository=restarted_repo,
        )

        subdomain_route = restarted.route_for_host(subdomain.hostname, now=NOW)
        custom_route = restarted.route_for_host(verified.hostname, now=NOW)

        assert subdomain_route.backend.host == "slice-a.internal"
        assert subdomain_route.backend.port == 8080
        assert custom_route.kind == "custom"
        assert custom_route.backend.host == "slice-b.internal"
        assert custom_route.backend.port == 9090
        assert (
            restarted.repository.custom_by_host[verified.hostname].status is DomainStatus.VERIFIED
        )
        assert restarted.repository.certificate_for_host(verified.hostname, NOW) is not None
        restarted_repo.close()
        restarted_repo = None
    finally:
        if repo is not None:
            repo.close()
        if restarted_repo is not None:
            restarted_repo.close()
        ROUTING_STATE_DB.unlink(missing_ok=True)


def test_domain_purchase_idempotency_key_cannot_change_domain() -> None:
    service, _, _, _ = build()
    service.purchase_domain(
        actor=actor(), hostname="first.example", idempotency_key="same-billing-key"
    )

    with pytest.raises(DomainConflict, match="different purchase"):
        service.purchase_domain(
            actor=actor(), hostname="second.example", idempotency_key="same-billing-key"
        )


def test_pending_purchase_retry_recovers_registrar_outcome_without_second_purchase() -> None:
    registrar = FakeDomainRegistrar()
    service = DomainService(
        base_domain="loopit.app",
        app_proxy_target="app-proxy.loopit.internal",
        dns=InMemoryDnsProvider(),
        certificates=FakeCertificateAuthority(),
        audit=InMemoryAuditSink(),
        registrar=registrar,
    )
    purchase = registrar.purchase(
        tenant_id="tenant-1",
        domain="recoverable.example",
        idempotency_key="recover-key",
    )
    service.repository.save_purchase_attempt(
        DomainPurchaseAttempt(
            tenant_id="tenant-1",
            domain="recoverable.example",
            idempotency_key="recover-key",
            term_years=1,
            auto_renew=True,
            status=PurchaseAttemptStatus.PENDING,
        )
    )

    recovered = service.purchase_domain(
        actor=actor(), hostname="recoverable.example", idempotency_key="recover-key"
    )

    assert recovered == purchase
    assert len(registrar.purchases) == 1
    assert len(registrar.purchase_calls) == 1


def test_first_seen_purchase_checks_registrar_idempotency_before_buying_again() -> None:
    class RecoveringRegistrar(FakeDomainRegistrar):
        def __init__(self) -> None:
            super().__init__()
            self.recovery_checks = 0

        def purchase_for_idempotency_key(
            self, *, tenant_id: str, idempotency_key: str
        ) -> DomainPurchase | None:
            self.recovery_checks += 1
            return super().purchase_for_idempotency_key(
                tenant_id=tenant_id, idempotency_key=idempotency_key
            )

    registrar = RecoveringRegistrar()
    purchase = registrar.purchase(
        tenant_id="tenant-1",
        domain="first-seen-retry.example",
        idempotency_key="recover-after-restart",
    )
    service = DomainService(
        base_domain="loopit.app",
        app_proxy_target="app-proxy.loopit.internal",
        dns=InMemoryDnsProvider(),
        certificates=FakeCertificateAuthority(),
        audit=InMemoryAuditSink(),
        registrar=registrar,
    )

    recovered = service.purchase_domain(
        actor=actor(), hostname="first-seen-retry.example", idempotency_key="recover-after-restart"
    )

    assert recovered == purchase
    assert registrar.recovery_checks == 1
    assert len(registrar.purchase_calls) == 1


def test_refused_purchase_does_not_make_hostname_routable() -> None:
    service, _, _, _ = build()

    with pytest.raises(ValueError):
        service.purchase_domain(
            actor=actor(), hostname="taken.example", idempotency_key="refused-registration"
        )
        service.purchase_domain(
            actor=actor(), hostname="taken.example", idempotency_key="other-key"
        )

    with pytest.raises(DomainConflict):
        service.route_for_host("taken.example", now=NOW)


def test_platform_owned_custom_domains_are_refused() -> None:
    service, _, _, _ = build()

    with pytest.raises(InvalidDomain):
        service.claim_custom_domain(
            actor=actor(), project_id="project", hostname="preview.loopit.app", now=NOW
        )


def test_released_subdomain_is_quarantined_before_reuse() -> None:
    service, _, _, _ = build()
    original = service.claim_subdomain_label(
        actor=actor(), project_id="project", requested_label="reusable", now=NOW
    )
    service.release_subdomain(actor=actor(), project_id="project", now=NOW)

    with pytest.raises(DomainConflict):
        service.claim_subdomain_label(
            actor=actor(),
            project_id="next",
            requested_label=original.label,
            now=NOW + timedelta(days=1),
        )

    reused = service.claim_subdomain_label(
        actor=actor(),
        project_id="next",
        requested_label=original.label,
        now=NOW + timedelta(days=31),
    )
    assert reused.hostname == original.hostname


def test_rename_allows_same_project_to_reclaim_its_own_quarantined_label() -> None:
    service, _, _, _ = build()
    original = service.claim_subdomain_label(
        actor=actor(), project_id="project", requested_label="first-name", now=NOW
    )
    renamed = service.rename_subdomain(
        actor=actor(), project_id="project", requested_label="second-name", now=NOW
    )

    reclaimed = service.rename_subdomain(
        actor=actor(), project_id="project", requested_label=original.label, now=NOW
    )

    assert renamed.hostname == "second-name.loopit.app"
    assert reclaimed.hostname == original.hostname


def test_operator_can_retire_and_seize_labels_for_abuse_response() -> None:
    service, _, _, _ = build()
    operator = actor("platform", scopes=frozenset({"domains:operator"}))
    service.claim_subdomain_label(
        actor=actor(), project_id="project", requested_label="reported-app", now=NOW
    )

    retired = service.retire_subdomain_label(
        actor=operator, label="reported-app", reason="abuse report", now=NOW
    )
    seized = service.seize_subdomain_label(
        actor=operator,
        tenant_id="tenant-2",
        org_id="tenant-2",
        project_id="project-b",
        label="replacement-app",
        reason="support migration",
        now=NOW,
    )

    assert retired.status.value == "retired"
    assert seized.hostname == "replacement-app.loopit.app"
