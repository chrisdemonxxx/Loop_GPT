from __future__ import annotations

import pytest
from loopit_agent_core import AuditEvent
from loopit_auth import Actor, InMemoryAuthRepository
from loopit_enterprise import (
    AuditExport,
    FakeOIDCIdP,
    OIDCClient,
    OIDCConfig,
    OIDCError,
    export_audit_log,
    import_and_verify_audit_export,
)
from loopit_store import InMemoryAuditStore


def oidc_config() -> OIDCConfig:
    return OIDCConfig(
        org_id="org_acme",
        issuer="https://idp.example.test",
        client_id="client_1",
        audience="client_1",
        redirect_uri="https://loop.example.test/callback",
        group_role_map={"platform-admins": "admin", "builders": "member"},
    )


def claims(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "iss": "https://idp.example.test",
        "aud": "client_1",
        "nonce": "nonce_1",
        "sub": "sub_123",
        "email": "Dev@Example.Test",
        "name": "Dev User",
        "groups": ["builders", "platform-admins"],
    }
    base.update(overrides)
    return base


def test_oidc_success_jit_provisions_user_and_maps_highest_role() -> None:
    repo = InMemoryAuthRepository()
    client = OIDCClient(config=oidc_config(), repository=repo, idp=FakeOIDCIdP({"code": claims()}))
    request = client.authorization_request()
    assert "code_challenge_method=S256" in request.url
    result = client.complete_login(
        code="code",
        redirect_uri=oidc_config().redirect_uri,
        code_verifier=request.code_verifier,
        expected_nonce="nonce_1",
    )
    assert result.identity.email == "dev@example.test"
    assert result.role == "admin"
    assert repo.membership(user_id=result.user_id, org_id="org_acme").role == "admin"  # type: ignore[union-attr]


@pytest.mark.parametrize(
    "bad_claim",
    [
        {"iss": "https://evil.example.test"},
        {"aud": "other-client"},
        {"nonce": "replayed"},
    ],
)
def test_oidc_fails_closed_on_issuer_audience_or_nonce_mismatch(
    bad_claim: dict[str, object],
) -> None:
    client = OIDCClient(
        config=oidc_config(),
        repository=InMemoryAuthRepository(),
        idp=FakeOIDCIdP({"code": claims(**bad_claim)}),
    )
    with pytest.raises(OIDCError):
        client.complete_login(
            code="code",
            redirect_uri=oidc_config().redirect_uri,
            code_verifier="verifier",
            expected_nonce="nonce_1",
        )


def admin() -> Actor:
    return Actor(subject="usr_admin", tenant_id="org_acme", org_id="org_acme", role="admin")


def audit_store() -> InMemoryAuditStore:
    store = InMemoryAuditStore()
    store.append(
        AuditEvent(
            type="project.create",
            tenant_id="org_acme",
            actor_kind="user",
            actor_id="u1",
            plane="control",
            outcome="success",
            detail={"p": "1"},
        )
    )
    store.append(
        AuditEvent(
            type="run.start",
            tenant_id="org_acme",
            actor_kind="agent",
            actor_id="a1",
            plane="data",
            outcome="success",
            detail={"r": "1"},
        )
    )
    return store


def test_audit_export_is_complete_signed_and_verifiable() -> None:
    exported = export_audit_log(
        audit_store(), actor=admin(), org_id="org_acme", signing_key=b"k" * 32, page_size=1
    )
    assert exported.manifest.record_count == 2
    assert exported.jsonl.count("\n") == 2
    assert import_and_verify_audit_export(exported, signing_key=b"k" * 32)


def test_audit_export_detects_tampering_and_requires_admin() -> None:
    exported = export_audit_log(
        audit_store(), actor=admin(), org_id="org_acme", signing_key=b"k" * 32
    )
    tampered = AuditExport(exported.jsonl.replace("run.start", "run.stop"), exported.manifest)
    assert not import_and_verify_audit_export(tampered, signing_key=b"k" * 32)
    viewer = Actor(subject="usr_view", tenant_id="org_acme", org_id="org_acme", role="viewer")
    with pytest.raises(PermissionError):
        export_audit_log(audit_store(), actor=viewer, org_id="org_acme", signing_key=b"k" * 32)
