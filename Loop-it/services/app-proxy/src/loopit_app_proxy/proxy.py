"""The public app proxy (Doc 02 §5, invariants I1/I4/I10).

Production apps need the opposite entry posture from previews: they are meant
to accept anonymous internet traffic on ``<project>.loopit.app`` and on
customer-owned domains. Public does not mean trusting the client. Every
request is still resolved at the edge against the domains service's current
hostname owner and the deployer's current live backend before a single byte is
forwarded.

The invariant that matters most is tenant isolation. The hostname, not any
client-supplied header, selects the tenant and project. Identity and forwarding
headers arriving from the internet are stripped before the proxy stamps its own
decision onto the upstream request; otherwise a caller could impersonate this
edge to the customer app.

Unlike previews, this service does **not** impose CSP, cache, referrer, or
frame policies on successful app responses. Those policies belong to the app:
a real customer site may need public caching, embeds, a payment provider's
script origins, or a cross-origin referrer policy. The platform's prerogative
is limited to responses the platform itself generates (uniform refusals and
gateway errors), where ``nosniff`` and ``no-store`` protect our boundary
without rewriting customer content.

Backend addresses are never echoed. "No such project", "unverified custom
domain", "not your project", and "temporarily no backend" are all externally
the same refusal so the edge cannot be used to enumerate tenants or topology.

WebSockets are supported because deployed apps use them. Browser WebSockets do
not have CORS preflight, so the proxy requires an ``Origin`` host, when
present, to match the requested public host before forwarding an upgrade. That
keeps an attacker site from silently driving a user's cookies against another
Loop-it app over a cross-site socket.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urlsplit

from loopit_agent_core.audit import AuditEvent, AuditSink

from .errors import RouteNotFound
from .routes import Backend, HostnameResolver, ProjectBackendResolver, Route, resolve_route

SERVICE_NAME = "app-proxy"

Refusal = Literal[
    "host_unknown", "no_route", "origin_mismatch", "quota_exceeded", "rate_limited", "too_large"
]

STRIPPED_REQUEST_HEADERS = frozenset(
    {
        "x-loopit-tenant",
        "x-loopit-project",
        "x-loopit-lease",
        "x-loopit-subject",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-real-ip",
    }
)

PLATFORM_REFUSAL_HEADERS: dict[str, str] = {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store, private",
}


@dataclass(frozen=True, slots=True)
class AppRequest:
    """One inbound production app request at the public edge."""

    host: str
    path: str
    method: str = "GET"
    headers: dict[str, str] = field(default_factory=dict)
    client_ip: str | None = None
    scheme: str = "https"

    def loggable(self) -> dict[str, object]:
        parts = urlsplit(self.path if self.path.startswith("/") else f"/{self.path}")
        return {
            "method": self.method.upper(),
            "host": normalise_host(self.host),
            "path": parts.path,
            "query_present": bool(parts.query),
            "client_ip": self.client_ip,
        }


@dataclass(frozen=True, slots=True)
class AppDecision:
    """The routing decision for one production app request."""

    allowed: bool
    reason: Refusal | None = None
    backend: Backend | None = None
    project_id: str | None = None
    tenant_id: str | None = None
    forward_headers: dict[str, str] = field(default_factory=dict)
    response_headers: dict[str, str] = field(default_factory=lambda: dict(PLATFORM_REFUSAL_HEADERS))

    @property
    def status(self) -> int:
        if self.allowed:
            return 200
        if self.reason == "rate_limited":
            return 429
        if self.reason == "too_large":
            return 413
        if self.reason == "quota_exceeded":
            return 402
        return 404

    def audit_event_type(self) -> str:
        return "app_proxy.allowed" if self.allowed else "app_proxy.denied"


def refuse(reason: Refusal) -> AppDecision:
    return AppDecision(allowed=False, reason=reason)


class AppProxy:
    """Resolves, isolates, and audits public app traffic."""

    def __init__(
        self,
        *,
        hostnames: HostnameResolver,
        backends: ProjectBackendResolver,
        audit: AuditSink,
    ) -> None:
        self._hostnames = hostnames
        self._backends = backends
        self._audit = audit

    async def decide(self, request: AppRequest) -> AppDecision:
        """Resolve a request without emitting audit. Pure apart from lookups."""
        host = normalise_host(request.host)
        if not _valid_host(host):
            return refuse("host_unknown")
        try:
            route = await resolve_route(host, hostnames=self._hostnames, backends=self._backends)
        except RouteNotFound:
            return refuse("no_route")
        if route.backend.serving_status == "quota_exceeded":
            return AppDecision(
                allowed=False,
                reason="quota_exceeded",
                project_id=route.binding.project_id,
                tenant_id=route.binding.tenant_id,
            )
        return AppDecision(
            allowed=True,
            backend=route.backend,
            project_id=route.binding.project_id,
            tenant_id=route.binding.tenant_id,
            forward_headers=self._forward_headers(request, route),
            response_headers={},
        )

    async def handle(self, request: AppRequest) -> AppDecision:
        decision = await self.decide(request)
        self._emit(request, decision)
        return decision

    def _forward_headers(self, request: AppRequest, route: Route) -> dict[str, str]:
        forwarded = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in STRIPPED_REQUEST_HEADERS
        }
        forwarded["X-Loopit-Tenant"] = route.binding.tenant_id
        forwarded["X-Loopit-Project"] = route.binding.project_id
        forwarded["X-Forwarded-Host"] = normalise_host(request.host)
        forwarded["X-Forwarded-Proto"] = request.scheme
        if request.client_ip is not None:
            forwarded["X-Forwarded-For"] = request.client_ip
            forwarded["X-Real-IP"] = request.client_ip
        return forwarded

    def _emit(self, request: AppRequest, decision: AppDecision) -> None:
        detail: dict[str, object] = dict(request.loggable())
        detail["status"] = decision.status
        if decision.reason is not None:
            detail["reason"] = decision.reason
        self._audit.emit(
            AuditEvent(
                type=decision.audit_event_type(),
                tenant_id=decision.tenant_id or "unknown",
                actor_kind="service",
                actor_service=SERVICE_NAME,
                project_id=decision.project_id,
                plane="data",
                outcome="allowed" if decision.allowed else "denied",
                detail=detail,
            )
        )


def normalise_host(host: str) -> str:
    return host.split(":", 1)[0].strip().removesuffix(".").lower()


def origin_matches_host(origin: str | None, host: str) -> bool:
    if not origin:
        return True
    parsed = urlsplit(origin)
    origin_host = parsed.hostname or ""
    return normalise_host(origin_host) == normalise_host(host)


def _valid_host(host: str) -> bool:
    if not host or "/" in host or "\\" in host or len(host) > 253:
        return False
    labels = host.split(".")
    return all(label and len(label) <= 63 for label in labels)


__all__ = [
    "PLATFORM_REFUSAL_HEADERS",
    "SERVICE_NAME",
    "STRIPPED_REQUEST_HEADERS",
    "AppDecision",
    "AppProxy",
    "AppRequest",
    "Refusal",
    "normalise_host",
    "origin_matches_host",
]
