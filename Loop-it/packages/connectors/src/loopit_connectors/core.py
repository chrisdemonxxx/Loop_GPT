from __future__ import annotations

from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Literal, Protocol, runtime_checkable

from loopit_agent_core import ApprovalBindings, AuditEvent, ToolCall, ToolRejected, ToolResult
from loopit_auth import Actor, Resource, authorize
from loopit_policy import Category, EgressPolicy
from loopit_secrets import Lease, SecretsBroker, StepContext
from loopit_store.protocols import AuditStore

Capability = Literal["read", "external_write", "delete", "admin"]


class ConnectorError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class ConnectorCredential:
    name: str
    scopes: frozenset[str]
    ttl: timedelta = timedelta(minutes=2)


@dataclass(frozen=True, slots=True)
class ConnectorInvocation:
    project_id: str
    tenant_id: str
    run_id: str
    step_id: str
    actor: Actor
    operation: str
    args: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ConnectorResult:
    ok: bool
    output: str
    detail: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class EgressGrant:
    category: Literal["app_apis"]
    domains: frozenset[str]
    policy: EgressPolicy


@runtime_checkable
class Connector(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def description(self) -> str: ...

    @property
    def capabilities(self) -> frozenset[Capability]: ...

    @property
    def required_scopes(self) -> frozenset[str]: ...

    @property
    def egress_domains(self) -> frozenset[str]: ...

    @property
    def credential_requirements(self) -> tuple[ConnectorCredential, ...]: ...

    def invoke(
        self, invocation: ConnectorInvocation, leases: Mapping[str, Lease]
    ) -> ConnectorResult: ...


@dataclass(frozen=True, slots=True)
class EnabledConnector:
    tenant_id: str
    project_id: str
    connector_name: str
    enabled_by: str
    scopes: frozenset[str]
    egress: EgressGrant


class ConnectorRegistry:
    def __init__(self) -> None:
        self._connectors: dict[str, Connector] = {}

    def register(self, connector: Connector) -> None:
        if connector.name in self._connectors:
            raise ConnectorError(f"connector {connector.name!r} already registered")
        _egress_grant(connector.egress_domains)
        self._connectors[connector.name] = connector

    def get(self, name: str) -> Connector:
        try:
            return self._connectors[name]
        except KeyError as exc:
            raise ConnectorError(f"unknown connector {name!r}") from exc

    def list(self) -> tuple[Connector, ...]:
        return tuple(self._connectors[name] for name in sorted(self._connectors))


class InMemoryConnectorEnablementStore:
    def __init__(self) -> None:
        self._enabled: MutableMapping[tuple[str, str, str], EnabledConnector] = {}

    def put(self, enabled: EnabledConnector) -> None:
        self._enabled[(enabled.tenant_id, enabled.project_id, enabled.connector_name)] = enabled

    def delete(self, *, tenant_id: str, project_id: str, connector_name: str) -> None:
        self._enabled.pop((tenant_id, project_id, connector_name), None)

    def get(
        self, *, tenant_id: str, project_id: str, connector_name: str
    ) -> EnabledConnector | None:
        return self._enabled.get((tenant_id, project_id, connector_name))


class ProjectConnectorManager:
    def __init__(
        self,
        *,
        registry: ConnectorRegistry,
        enablements: InMemoryConnectorEnablementStore,
        audit: AuditStore,
        secrets: SecretsBroker,
    ) -> None:
        self._registry = registry
        self._enablements = enablements
        self._audit = audit
        self._secrets = secrets

    def enable(self, *, actor: Actor, project_id: str, connector_name: str) -> EnabledConnector:
        connector = self._registry.get(connector_name)
        self._require(actor, "project:write", project_id)
        if not connector.required_scopes.issubset(actor.scopes):
            self._emit(
                "connector.enable", actor, project_id, connector_name, "denied", reason="scope"
            )
            raise PermissionError("actor lacks connector scopes")
        enabled = EnabledConnector(
            tenant_id=actor.tenant_id,
            project_id=project_id,
            connector_name=connector.name,
            enabled_by=actor.subject,
            scopes=connector.required_scopes,
            egress=_egress_grant(connector.egress_domains),
        )
        self._enablements.put(enabled)
        self._emit("connector.enable", actor, project_id, connector_name, "success")
        return enabled

    def disable(self, *, actor: Actor, project_id: str, connector_name: str) -> None:
        self._require(actor, "project:write", project_id)
        self._enablements.delete(
            tenant_id=actor.tenant_id, project_id=project_id, connector_name=connector_name
        )
        self._emit("connector.disable", actor, project_id, connector_name, "success")

    def invoke(self, *, connector_name: str, invocation: ConnectorInvocation) -> ConnectorResult:
        connector = self._registry.get(connector_name)
        self._require(invocation.actor, "run:start", invocation.project_id)
        enabled = self._enablements.get(
            tenant_id=invocation.tenant_id,
            project_id=invocation.project_id,
            connector_name=connector_name,
        )
        if enabled is None:
            self._emit(
                "connector.invoke",
                invocation.actor,
                invocation.project_id,
                connector_name,
                "denied",
                reason="disabled",
            )
            raise PermissionError("connector is not enabled for project")
        if not connector.required_scopes.issubset(enabled.scopes | invocation.actor.scopes):
            self._emit(
                "connector.invoke",
                invocation.actor,
                invocation.project_id,
                connector_name,
                "denied",
                reason="scope",
            )
            raise PermissionError("connector scope denied")
        leases: dict[str, Lease] = {}
        context = StepContext(
            run_id=invocation.run_id,
            step_id=invocation.step_id,
            tenant_id=invocation.tenant_id,
            project_id=invocation.project_id,
            declared_secrets=frozenset(req.name for req in connector.credential_requirements),
        )
        # Leases are request-scoped: reveal works only inside invoke, and the
        # broker never copies the plaintext into os.environ. The run id on the
        # lease is what revoke_run matches if the run is cancelled first.
        with self._secrets.request_scope(context) as issue_lease:
            for requirement in connector.credential_requirements:
                leases[requirement.name] = issue_lease(requirement.name, ttl=requirement.ttl)
            result = connector.invoke(invocation, leases)
        self._emit(
            "connector.invoke",
            invocation.actor,
            invocation.project_id,
            connector_name,
            "success" if result.ok else "failure",
            operation=invocation.operation,
        )
        return result

    def _require(self, actor: Actor, action: str, project_id: str) -> None:
        if not authorize(actor, action, Resource(org_id=actor.org_id, project_id=project_id)):  # type: ignore[arg-type]
            raise PermissionError(f"{actor.subject} cannot {action}")

    def _emit(
        self,
        event_type: str,
        actor: Actor,
        project_id: str,
        connector_name: str,
        outcome: Literal["denied", "success", "failure"],
        **detail: str,
    ) -> None:
        self._audit.append(
            AuditEvent(
                type=event_type,
                tenant_id=actor.tenant_id,
                actor_kind="user",
                actor_id=actor.subject,
                project_id=project_id,
                plane="control",
                outcome=outcome,
                detail={"connector": connector_name, **detail},
            )
        )


class ConnectorToolAdapter:
    """Adapts connector calls to ToolCall/ToolResult while preserving I7 gating semantics."""

    def __init__(
        self, manager: ProjectConnectorManager, *, approved_gates: frozenset[str] = frozenset()
    ) -> None:
        self._manager = manager
        self._approval_bindings = ApprovalBindings(approved_gates)

    def requires_gate(self, connector: Connector, call: ToolCall, *, run_id: str = "local") -> bool:
        return self._approval_bindings.requires_gate(
            call.tool,
            call.args,
            run_id,
            requires_confirmation=bool(
                connector.capabilities & {"external_write", "delete", "admin"}
            ),
        )

    def execute(
        self, connector_name: str, call: ToolCall, invocation: ConnectorInvocation
    ) -> ToolResult:
        connector = self._manager._registry.get(connector_name)
        if self.requires_gate(connector, call, run_id=invocation.run_id):
            raise ToolRejected("connector external write requires an approved confirmation gate")
        if connector.capabilities & {"external_write", "delete", "admin"}:
            self._approval_bindings.consume(call.tool, call.args, invocation.run_id)
        result = self._manager.invoke(connector_name=connector_name, invocation=invocation)
        return ToolResult(result.ok, result.output, result.detail)


def _egress_grant(domains: frozenset[str]) -> EgressGrant:
    try:
        policy = EgressPolicy(categories=(Category("app_apis", True),), extra_allow=domains)
    except ValueError as exc:
        raise ConnectorError(str(exc)) from exc
    for domain in domains:
        decision = policy.evaluate(domain, resolved_ips=())
        if not decision.allowed:
            raise ConnectorError(f"connector egress domain {domain!r} is not allowlistable")
        for forbidden in ("169.254.169.254", "metadata.google.internal", "127.0.0.1"):
            if policy.evaluate(forbidden).allowed:
                raise ConnectorError("connector egress policy bypassed default deny")
    return EgressGrant(category="app_apis", domains=domains, policy=policy)
