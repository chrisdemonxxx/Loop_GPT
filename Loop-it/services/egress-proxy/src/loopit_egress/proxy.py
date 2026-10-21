"""The logging egress proxy (Doc 02 §5, invariants I3/I4/I10, P1-2).

Every outbound byte from a sandbox passes through here. Two jobs:

1. **Enforce the policy.** Default-deny, metadata ranges blocked, mining
   infrastructure blocked, categories opened only in their window.
2. **Log every request — allowed and denied.** Denials alone tell you what was
   stopped; the allowed stream is what tells you a sandbox spent an hour POSTing
   to an allowlisted paste site. Exfiltration hides inside the allowed set, so
   logging only refusals is logging the wrong half.

Query strings are never logged verbatim. Tokens routinely ride in query
parameters, and an audit log that captures them turns the forensics store into
the highest-value credential dump in the system. Parameter *names* are kept,
because those carry the diagnostic value.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable
from urllib.parse import urlsplit

from loopit_agent_core.audit import AuditEvent, AuditSink

from .policy import Decision, EgressPolicy, Verdict

SERVICE_NAME = "egress-proxy"

#: Default per-lease outbound byte ceiling. A build pulls packages; it does not
#: upload gigabytes. Crossing this is a strong exfiltration or mining signal.
DEFAULT_EGRESS_BYTE_BUDGET = 2 * 1024 * 1024 * 1024  # 2 GiB


@dataclass(frozen=True, slots=True)
class EgressRequest:
    """One outbound request attempt from a sandbox."""

    lease_id: str
    tenant_id: str
    method: str
    url: str
    run_id: str | None = None
    project_id: str | None = None
    step: str | None = None
    resolved_ips: tuple[str, ...] = ()
    request_bytes: int = 0

    @property
    def host(self) -> str:
        parts = urlsplit(self.url if "//" in self.url else f"//{self.url}")
        return (parts.hostname or "").lower()

    @property
    def port(self) -> int | None:
        parts = urlsplit(self.url if "//" in self.url else f"//{self.url}")
        try:
            explicit = parts.port
        except ValueError:
            return None
        if explicit is not None:
            return explicit
        return {"http": 80, "https": 443}.get(parts.scheme)

    def loggable(self) -> dict[str, object]:
        """The request reduced to what is safe to persist forever."""
        parts = urlsplit(self.url if "//" in self.url else f"//{self.url}")
        query_keys = sorted({pair.split("=", 1)[0] for pair in parts.query.split("&") if pair})
        return {
            "method": self.method.upper(),
            "scheme": parts.scheme or "unknown",
            "host": self.host,
            "port": self.port,
            "path": parts.path or "/",
            "query_keys": query_keys,
            "resolved_ips": list(self.resolved_ips),
            "request_bytes": self.request_bytes,
        }


@runtime_checkable
class PolicyResolver(Protocol):
    """Supplies the egress policy attached to a lease."""

    def policy_for(self, lease_id: str) -> EgressPolicy: ...


@dataclass(slots=True)
class LeaseUsage:
    """Running egress totals for one lease."""

    requests_allowed: int = 0
    requests_denied: int = 0
    bytes_out: int = 0
    denied_reasons: dict[str, int] = field(default_factory=dict)


class StaticPolicyResolver:
    """A resolver backed by an in-memory map, for tests and single-tenant runs.

    Unknown leases get a bare default-deny policy rather than an error: an
    unrecognised lease must not be able to reach the network *and* must not be
    able to crash the proxy into an open state.
    """

    def __init__(self, policies: dict[str, EgressPolicy] | None = None) -> None:
        self._policies = policies or {}

    def policy_for(self, lease_id: str) -> EgressPolicy:
        return self._policies.get(lease_id, EgressPolicy())

    def set(self, lease_id: str, policy: EgressPolicy) -> None:
        self._policies[lease_id] = policy


class EgressProxy:
    """Evaluates, records and accounts for every outbound sandbox request."""

    def __init__(
        self,
        *,
        resolver: PolicyResolver,
        audit: AuditSink,
        byte_budget: int = DEFAULT_EGRESS_BYTE_BUDGET,
    ) -> None:
        if byte_budget <= 0:
            raise ValueError("byte_budget must be positive")

        self._resolver = resolver
        self._audit = audit
        self._byte_budget = byte_budget
        self._usage: dict[str, LeaseUsage] = {}

    def handle(self, request: EgressRequest) -> Decision:
        """Decide one request, log it, and account for it.

        The audit record is written before the decision is returned, so there is
        no path where a request is permitted but unlogged.
        """
        usage = self._usage.setdefault(request.lease_id, LeaseUsage())

        if usage.bytes_out + request.request_bytes > self._byte_budget:
            decision = Decision(Verdict.DENY, "egress_byte_budget_exceeded")
        else:
            policy = self._resolver.policy_for(request.lease_id)
            decision = policy.evaluate(
                request.host,
                step=request.step,
                resolved_ips=request.resolved_ips,
                port=request.port,
            )

        if decision.allowed:
            usage.requests_allowed += 1
            usage.bytes_out += request.request_bytes
        else:
            usage.requests_denied += 1
            usage.denied_reasons[decision.reason] = usage.denied_reasons.get(decision.reason, 0) + 1

        self._emit(request, decision, usage)
        return decision

    def usage_for(self, lease_id: str) -> LeaseUsage:
        return self._usage.get(lease_id, LeaseUsage())

    def forget(self, lease_id: str) -> None:
        """Drop accounting for a finished lease.

        The audit stream is the durable record; this in-memory tally exists only
        to enforce the live budget, so retaining it after teardown would be an
        unbounded leak with no forensic value.
        """
        self._usage.pop(lease_id, None)

    def _emit(self, request: EgressRequest, decision: Decision, usage: LeaseUsage) -> None:
        detail: dict[str, object] = {
            "reason": decision.reason,
            "category": decision.category,
            "lease_bytes_out": usage.bytes_out,
            **request.loggable(),
        }
        self._audit.emit(
            AuditEvent(
                type=decision.audit_event_type(),
                tenant_id=request.tenant_id,
                actor_kind="service",
                actor_service=SERVICE_NAME,
                project_id=request.project_id,
                run_id=request.run_id,
                sandbox_lease_id=request.lease_id,
                plane="data",
                outcome="allowed" if decision.allowed else "denied",
                detail=detail,
            )
        )
