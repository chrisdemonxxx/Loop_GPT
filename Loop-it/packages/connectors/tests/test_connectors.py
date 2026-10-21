from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from loopit_agent_core import InMemoryAuditSink, ToolCall, ToolRejected, approval_binding_hash
from loopit_auth import Actor
from loopit_connectors import (
    Capability,
    ConnectorCredential,
    ConnectorError,
    ConnectorInvocation,
    ConnectorRegistry,
    ConnectorToolAdapter,
    GitHubIssuesConnector,
    InMemoryConnectorEnablementStore,
    ProjectConnectorManager,
    WebhookConnector,
)
from loopit_connectors.core import ConnectorResult
from loopit_connectors.recipes import load_recipes
from loopit_secrets import (
    Environment,
    Lease,
    SecretClass,
    SecretsBroker,
    SecretStore,
    SecretValue,
    StoredSecret,
)
from loopit_store import InMemoryAuditStore


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 1, 1, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


def actor(
    role: str = "admin",
    scopes: frozenset[str] = frozenset(
        {"connector:webhook:write", "connector:github_issues:write"}
    ),
) -> Actor:
    return Actor(
        subject="usr_1",
        tenant_id="org_1",
        org_id="org_1",
        role=role,  # type: ignore[arg-type]
        scopes=scopes,
    )


def manager(
    clock: Clock | None = None,
) -> tuple[ProjectConnectorManager, InMemoryAuditStore, InMemoryAuditSink]:
    registry = ConnectorRegistry()
    registry.register(WebhookConnector())
    registry.register(GitHubIssuesConnector())
    store = SecretStore(Environment.BUILD)
    for name in ("WEBHOOK_TOKEN", "GITHUB_ISSUES_TOKEN"):
        store.put(
            StoredSecret(
                name=name,
                environment=Environment.BUILD,
                secret_class=SecretClass.PROJECT,
                tenant_id="org_1",
                project_id="proj_1",
                value=SecretValue("tok_" + name.lower()),
            )
        )
    secret_audit = InMemoryAuditSink()
    broker = SecretsBroker(store, audit=secret_audit, clock=clock or Clock())
    audit = InMemoryAuditStore()
    return (
        ProjectConnectorManager(
            registry=registry,
            enablements=InMemoryConnectorEnablementStore(),
            audit=audit,
            secrets=broker,
        ),
        audit,
        secret_audit,
    )


def invocation() -> ConnectorInvocation:
    return ConnectorInvocation(
        project_id="proj_1",
        tenant_id="org_1",
        run_id="run_1",
        step_id="step_1",
        actor=actor(),
        operation="post",
        args={"payload": {"ok": True}},
    )


def test_enable_requires_rbac_and_scope_and_audits() -> None:
    mgr, audit, _ = manager()
    with pytest.raises(PermissionError):
        mgr.enable(actor=actor("viewer"), project_id="proj_1", connector_name="webhook")
    with pytest.raises(PermissionError):
        mgr.enable(actor=actor(scopes=frozenset()), project_id="proj_1", connector_name="webhook")
    enabled = mgr.enable(actor=actor(), project_id="proj_1", connector_name="webhook")
    assert enabled.egress.category == "app_apis"
    assert enabled.egress.policy.default_action == "deny"
    assert enabled.egress.policy.evaluate("hooks.example.test").allowed
    assert not enabled.egress.policy.evaluate("example.org").allowed
    assert not enabled.egress.policy.evaluate("metadata.google.internal").allowed
    assert [r.event_type for r in audit.list_for_tenant("org_1")].count("connector.enable") == 2


@pytest.mark.parametrize("domain", ["169.254.169.254", "metadata.google.internal", "127.0.0.1"])
def test_metadata_and_link_local_domains_are_never_allowlistable(domain: str) -> None:
    @dataclass(frozen=True, slots=True)
    class BadConnector:
        name: str = "bad"
        description: str = "bad"
        capabilities: frozenset[Capability] = frozenset({"read"})
        required_scopes: frozenset[str] = frozenset()
        egress_domains: frozenset[str] = frozenset({domain})
        credential_requirements: tuple[ConnectorCredential, ...] = ()

        def invoke(
            self, invocation: ConnectorInvocation, leases: Mapping[str, Lease]
        ) -> ConnectorResult:
            del invocation, leases
            raise AssertionError("not invoked")

    registry = ConnectorRegistry()
    with pytest.raises(ConnectorError):
        registry.register(BadConnector())


def test_invocation_uses_jit_secret_lease_and_expiry() -> None:
    clock = Clock()
    mgr, audit, secret_audit = manager(clock)
    mgr.enable(actor=actor(), project_id="proj_1", connector_name="webhook")
    result = mgr.invoke(connector_name="webhook", invocation=invocation())
    assert result.ok
    issued = secret_audit.of_type("secret.lease.issued")
    assert len(issued) == 1
    assert issued[0].detail["name"] == "WEBHOOK_TOKEN"
    assert audit.list_for_tenant("org_1")[-1].event_type == "connector.invoke"


def test_connector_declares_short_lived_jit_credential() -> None:
    captured: dict[str, Lease] = {}

    @dataclass(frozen=True, slots=True)
    class ShortLeaseConnector:
        name: str = "short"
        description: str = "short lease connector"
        capabilities: frozenset[Capability] = frozenset({"read"})
        required_scopes: frozenset[str] = frozenset({"connector:webhook:write"})
        egress_domains: frozenset[str] = frozenset({"hooks.example.test"})
        credential_requirements: tuple[ConnectorCredential, ...] = (
            ConnectorCredential("WEBHOOK_TOKEN", frozenset({"read"}), ttl=timedelta(seconds=1)),
        )

        def invoke(
            self, invocation: ConnectorInvocation, leases: Mapping[str, Lease]
        ) -> ConnectorResult:
            del invocation
            captured.update(leases)
            return ConnectorResult(True, "ok")

    clock = Clock()
    registry = ConnectorRegistry()
    registry.register(ShortLeaseConnector())
    store = SecretStore(Environment.BUILD)
    store.put(
        StoredSecret(
            name="WEBHOOK_TOKEN",
            environment=Environment.BUILD,
            secret_class=SecretClass.PROJECT,
            tenant_id="org_1",
            project_id="proj_1",
            value=SecretValue("tok_short"),
        )
    )
    mgr = ProjectConnectorManager(
        registry=registry,
        enablements=InMemoryConnectorEnablementStore(),
        audit=InMemoryAuditStore(),
        secrets=SecretsBroker(store, audit=InMemoryAuditSink(), clock=clock),
    )
    mgr.enable(actor=actor(), project_id="proj_1", connector_name="short")
    mgr.invoke(connector_name="short", invocation=invocation())
    assert captured["WEBHOOK_TOKEN"].expires_at == clock.now + timedelta(seconds=1)


def test_disabled_connector_invocation_is_denied_and_audited() -> None:
    mgr, audit, _ = manager()
    with pytest.raises(PermissionError):
        mgr.invoke(connector_name="webhook", invocation=invocation())
    assert audit.list_for_tenant("org_1")[-1].event_type == "connector.invoke"
    assert audit.list_for_tenant("org_1")[-1].payload["outcome"] == "denied"


def test_destructive_connector_is_gated_like_a_tool() -> None:
    mgr, _, _ = manager()
    mgr.enable(actor=actor(), project_id="proj_1", connector_name="webhook")
    call = ToolCall(tool="deploy", args={"target": "managed"}, call_id="call_1")
    with pytest.raises(ToolRejected):
        ConnectorToolAdapter(mgr).execute("webhook", call, invocation())
    approved = approval_binding_hash(call.tool, call.args, "run_1")
    assert (
        ConnectorToolAdapter(mgr, approved_gates=frozenset({approved}))
        .execute("webhook", call, invocation())
        .ok
    )


def test_destructive_connector_approval_is_single_use_and_run_scoped() -> None:
    mgr, _, _ = manager()
    mgr.enable(actor=actor(), project_id="proj_1", connector_name="webhook")
    call = ToolCall(tool="deploy", args={"target": "managed"}, call_id="call_1")
    approved = approval_binding_hash(call.tool, call.args, "run_1")
    adapter = ConnectorToolAdapter(mgr, approved_gates=frozenset({approved}))

    assert adapter.execute("webhook", call, invocation()).ok
    with pytest.raises(ToolRejected):
        adapter.execute("webhook", call, invocation())

    other_run = ConnectorInvocation(
        project_id="proj_1",
        tenant_id="org_1",
        run_id="run_2",
        step_id="step_1",
        actor=actor(),
        operation="post",
        args={"payload": {"ok": True}},
    )
    with pytest.raises(ToolRejected):
        ConnectorToolAdapter(mgr, approved_gates=frozenset({approved})).execute(
            "webhook", call, other_run
        )


def test_connector_credential_lease_ends_with_the_call_and_stays_out_of_environ() -> None:
    import os

    from loopit_secrets import LeaseRevoked

    clock = Clock()
    captured: dict[str, Lease] = {}

    @dataclass(frozen=True, slots=True)
    class RevealingConnector:
        name: str = "webhook"
        description: str = "reveals during the call only"
        capabilities: frozenset[Capability] = frozenset({"read"})
        required_scopes: frozenset[str] = frozenset({"connector:webhook:write"})
        egress_domains: frozenset[str] = frozenset({"hooks.example.test"})
        credential_requirements: tuple[ConnectorCredential, ...] = (
            ConnectorCredential("WEBHOOK_TOKEN", frozenset({"post:event"})),
        )

        def invoke(
            self, invocation: ConnectorInvocation, leases: Mapping[str, Lease]
        ) -> ConnectorResult:
            del invocation
            captured.update(leases)
            return ConnectorResult(True, "ok")

    registry = ConnectorRegistry()
    registry.register(RevealingConnector())
    store = SecretStore(Environment.BUILD)
    store.put(
        StoredSecret(
            name="WEBHOOK_TOKEN",
            environment=Environment.BUILD,
            secret_class=SecretClass.PROJECT,
            tenant_id="org_1",
            project_id="proj_1",
            value=SecretValue("tok_" + "webhook"),
        )
    )
    secret_audit = InMemoryAuditSink()
    broker = SecretsBroker(store, audit=secret_audit, clock=clock)
    mgr = ProjectConnectorManager(
        registry=registry,
        enablements=InMemoryConnectorEnablementStore(),
        audit=InMemoryAuditStore(),
        secrets=broker,
    )
    before = os.environ.copy()
    mgr.enable(actor=actor(), project_id="proj_1", connector_name="webhook")
    assert mgr.invoke(connector_name="webhook", invocation=invocation()).ok
    with pytest.raises(LeaseRevoked):
        broker.reveal(captured["WEBHOOK_TOKEN"])
    assert os.environ.copy() == before
    assert ("tok_" + "webhook") not in os.environ.values()


def test_recipes_validate_against_schema() -> None:
    recipes = load_recipes(__import__("pathlib").Path("stack-templates") / "recipes")
    assert {recipe["id"] for recipe in recipes} >= {
        "crud-app-with-auth",
        "dashboard-with-charts",
        "multi-tenant-saas-starter",
    }
    assert all(recipe["stack"] == "react-postgres" for recipe in recipes)
