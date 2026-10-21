from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from loopit_agent_core.config import SecretConfigurationError
from loopit_auth import (
    Actor,
    AuthService,
    IdentityTokenError,
    InMemoryAuthRepository,
    LoginError,
    OperatorTokenIssuer,
    OperatorTokenSettings,
    PasswordHasher,
    PlanQuota,
    PreflightGuard,
    Resource,
    TokenSigner,
    authorize,
)
from loopit_store import InMemoryAuditStore, InMemoryQuotaStore, QuotaEntry


def signer(**overrides: object) -> TokenSigner:
    config: dict[str, Any] = {
        "issuer": "loopit-api",
        "audience": "loopit-downstream",
        "keys": {"old": b"old-secret", "new": b"new-secret"},
        "current_kid": "new",
    }
    config.update(overrides)
    return TokenSigner(**config)


def test_scrypt_hash_verifies_and_rejects_wrong_password() -> None:
    hasher = PasswordHasher(n=2**12)
    encoded = hasher.hash("correct horse battery staple")
    assert "correct horse" not in encoded
    assert hasher.verify("correct horse battery staple", encoded)
    assert not hasher.verify("wrong password", encoded)


def test_login_locks_after_repeated_failures_and_audits_decisions() -> None:
    repo = InMemoryAuthRepository()
    audit = InMemoryAuditStore()
    service = AuthService(
        repository=repo,
        audit=audit,
        signer=signer(),
        password_hasher=PasswordHasher(n=2**12),
        max_failures=2,
    )
    registration = service.register(
        email="a@example.com", password="correct horse battery staple", org_name="Acme"
    )

    with pytest.raises(LoginError):
        service.login(
            email="a@example.com", password="wrong password", org_id=registration.org.org_id
        )
    with pytest.raises(LoginError):
        service.login(
            email="a@example.com", password="wrong password", org_id=registration.org.org_id
        )
    with pytest.raises(LoginError, match="account locked"):
        service.login(
            email="a@example.com",
            password="correct horse battery staple",
            org_id=registration.org.org_id,
        )
    assert [record.event_type for record in audit.list_for_tenant(registration.org.org_id)].count(
        "auth.login"
    ) == 3


def test_customer_signup_and_login_do_not_issue_operator_tokens() -> None:
    repo = InMemoryAuthRepository()
    audit = InMemoryAuditStore()
    customer_signer = signer()
    service = AuthService(
        repository=repo,
        audit=audit,
        signer=customer_signer,
        password_hasher=PasswordHasher(n=2**12),
    )
    operator_issuer = OperatorTokenIssuer(
        OperatorTokenSettings(
            issuer="loopit-operator",
            audience="loopit-platform-operator",
            kid="operator",
            secret="operator-secret-material-change-safe-32",
        )
    )

    registration = service.register(
        email="owner@example.com",
        password="correct horse battery staple",
        org_name="Acme",
    )
    login_token = service.login(
        email="owner@example.com",
        password="correct horse battery staple",
        org_id=registration.org.org_id,
    )

    for issued in (registration.identity_token, login_token):
        customer_identity = customer_signer.verify_identity(issued)
        assert customer_identity.audience == "loopit-downstream"
        assert "platform:operate" not in customer_identity.scopes
        with pytest.raises(IdentityTokenError):
            operator_issuer.verify(issued)


def test_password_reset_issues_event_without_exposing_token() -> None:
    repo = InMemoryAuthRepository()
    audit = InMemoryAuditStore()
    service = AuthService(
        repository=repo, audit=audit, signer=signer(), password_hasher=PasswordHasher(n=2**12)
    )
    registration = service.register(
        email="a@example.com", password="correct horse battery staple", org_name="Acme"
    )

    service.issue_password_reset(email="a@example.com", org_id=registration.org.org_id)

    records = audit.list_for_tenant(registration.org.org_id)
    assert records[-1].event_type == "auth.password_reset"
    assert "token" not in str(records[-1].payload).lower()


def test_token_verify_expiry_tamper_audience_and_key_rotation() -> None:
    tokens = signer(current_kid="old")
    token = tokens.mint_identity(
        subject="u1", org_id="org1", role="admin", scopes=("api",), now=100, ttl_seconds=60
    )
    verified = tokens.verify_identity(token, now=120)
    assert verified.subject == "u1"
    assert verified.kid == "old"
    with pytest.raises(IdentityTokenError):
        tokens.verify_identity(token, now=161)
    with pytest.raises(IdentityTokenError):
        tokens.verify_identity(token + "x", now=120)
    with pytest.raises(IdentityTokenError):
        tokens.verify_identity(token, audience="other", now=120)
    rotated = signer(keys={"new": b"new-secret"}, current_kid="new")
    with pytest.raises(IdentityTokenError):
        rotated.verify_identity(token, now=120)


def test_operator_tokens_use_separate_issuer_audience_key_and_scope() -> None:
    issuer = OperatorTokenIssuer(
        OperatorTokenSettings(
            issuer="loopit-operator",
            audience="loopit-platform-operator",
            kid="operator",
            secret="operator-secret-material-change-safe-32",
            ttl_seconds=300,
        )
    )

    token = issuer.mint(subject="ops-user", now=100)
    identity = issuer.verify(token, now=120)

    assert identity.issuer == "loopit-operator"
    assert identity.audience == "loopit-platform-operator"
    assert identity.org_id == "platform"
    assert identity.scopes == ("platform:operate",)
    with pytest.raises(IdentityTokenError):
        signer().verify_identity(token, now=120)


def test_operator_token_settings_fail_closed_without_signing_secret() -> None:
    with pytest.raises(SecretConfigurationError):
        OperatorTokenSettings.from_env({})


@pytest.mark.parametrize(
    ("role", "can_manage", "can_write", "can_read", "can_approve"),
    [
        ("owner", True, True, True, True),
        ("admin", False, True, True, True),
        ("member", False, True, True, False),
        ("viewer", False, False, True, False),
    ],
)
def test_rbac_matrix(
    role: str, can_manage: bool, can_write: bool, can_read: bool, can_approve: bool
) -> None:
    actor = Actor(subject="u", tenant_id="org", org_id="org", role=role)  # type: ignore[arg-type]
    resource = Resource(org_id="org")
    assert authorize(actor, "org:manage", resource) is can_manage
    assert authorize(actor, "project:write", resource) is can_write
    assert authorize(actor, "project:read", resource) is can_read
    assert authorize(actor, "run:approve", resource) is can_approve


def test_cross_org_access_is_denied() -> None:
    actor = Actor(subject="u", tenant_id="org_a", org_id="org_a", role="owner")
    assert not authorize(actor, "project:read", Resource(org_id="org_b", project_id="p"))


def test_preflight_denies_before_spend_for_rate_and_hard_quota() -> None:
    audit = InMemoryAuditStore()
    quota = InMemoryQuotaStore()
    actor = Actor(subject="u", tenant_id="org", org_id="org", role="member")
    quota.append(
        QuotaEntry(
            entry_id="seed", tenant_id="org", amount=Decimal("0.02"), kind="credit", source="test"
        )
    )
    guard = PreflightGuard(
        quota=quota, audit=audit, plan=PlanQuota(rate_capacity=1, rate_refill_per_second=0.1)
    )

    assert guard.check(actor=actor, estimated_credits=Decimal("0.01"), now=0).allowed
    rate_denied = guard.check(actor=actor, estimated_credits=Decimal("0.01"), now=0)
    assert not rate_denied.allowed
    assert rate_denied.reason == "rate_limited"
    hard_denied = guard.check(actor=actor, estimated_credits=Decimal("1"), now=20)
    assert not hard_denied.allowed
    assert hard_denied.reason == "hard_quota"
    assert [record.event_type for record in audit.list_for_tenant("org")].count(
        "auth.preflight"
    ) == 3
