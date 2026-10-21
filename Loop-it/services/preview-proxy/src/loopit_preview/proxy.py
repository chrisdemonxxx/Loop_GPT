"""The preview proxy (Doc 02 §5, invariants I1/I4/I10, P1-6).

Users need to see the app the agent is building. The naive way to give them
that is to expose the sandbox's dev-server port on a public address. That is
the mistake this service exists to prevent: a publicly reachable sandbox port
is an unauthenticated door into a machine that is, by design, running
model-authored code with a filesystem full of a tenant's data.

Instead every preview request arrives here, at an authenticated edge, and is
matched against three things before a single byte is forwarded:

1. a **valid signature** on the token,
2. a **project and tenant** in the token that match the host being asked for,
3. a **live route** — meaning the lease is still running.

Failing any of them produces the same shaped refusal. The backend address is
never echoed, and neither is the reason a route lookup missed, because "no
such project" and "not your project" are different answers only to someone
trying to enumerate.

The proxy is also where preview responses get their isolation headers. Preview
content is tenant-authored HTML on a platform-controlled origin; without a
strict CSP and a same-origin frame policy, one tenant's preview is a
cross-origin foothold against the console that renders it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urlsplit

from loopit_agent_core.audit import AuditEvent, AuditSink

from .errors import PreviewError, RouteNotFound, TokenExpired, TokenInvalid
from .routes import Backend, RouteTable
from .tokens import TokenSigner

SERVICE_NAME = "preview-proxy"

#: Refusal reasons. Coarse on purpose: they are safe to return to a client.
Refusal = Literal["missing_token", "invalid_token", "expired_token", "no_route", "host_unknown"]

#: Headers a client must never be able to set on a proxied preview request.
#:
#: These are how the edge tells the backend who the caller is. If a client can
#: forge them, it can impersonate the edge's own authentication decision.
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

#: Response headers applied to every preview response.
#:
#: ``frame-ancestors 'self'`` keeps a tenant preview from being framed by an
#: attacker page; ``no-store`` keeps preview HTML out of shared caches, where
#: one tenant's build output could otherwise be served to another.
SECURITY_HEADERS: dict[str, str] = {
    "Content-Security-Policy": "frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store, private",
    "X-Frame-Options": "SAMEORIGIN",
}


@dataclass(frozen=True, slots=True)
class PreviewRequest:
    """One inbound preview request at the edge."""

    host: str
    path: str
    method: str = "GET"
    token: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    client_ip: str | None = None

    def loggable(self) -> dict[str, object]:
        """The request reduced to what is safe to keep forever.

        The path is kept but the query string is dropped entirely: preview URLs
        for half-built apps routinely carry session identifiers and reset
        tokens in the query, and this log is retained far longer than they are.
        """
        parts = urlsplit(self.path if self.path.startswith("/") else f"/{self.path}")
        return {
            "method": self.method.upper(),
            "host": self.host.lower(),
            "path": parts.path,
            "query_present": bool(parts.query),
            "client_ip": self.client_ip,
        }


@dataclass(frozen=True, slots=True)
class PreviewDecision:
    """The outcome of one preview request."""

    allowed: bool
    reason: Refusal | None = None
    backend: Backend | None = None
    project_id: str | None = None
    tenant_id: str | None = None
    lease_id: str | None = None
    forward_headers: dict[str, str] = field(default_factory=dict)
    response_headers: dict[str, str] = field(default_factory=lambda: dict(SECURITY_HEADERS))

    @property
    def status(self) -> int:
        """HTTP status for a refusal.

        Every refusal is 404 except a missing token, which is 401. A wrong
        project and a nonexistent project must not differ, so authorisation
        failures are reported as "not found" rather than "forbidden".
        """
        if self.allowed:
            return 200
        return 401 if self.reason == "missing_token" else 404

    def audit_event_type(self) -> str:
        return "preview.allowed" if self.allowed else "preview.denied"


def _refuse(reason: Refusal) -> PreviewDecision:
    return PreviewDecision(allowed=False, reason=reason)


class PreviewProxy:
    """Authenticates, authorises, and audits every preview request."""

    def __init__(
        self,
        *,
        signer: TokenSigner,
        routes: RouteTable,
        audit: AuditSink,
        preview_domain: str,
    ) -> None:
        if not preview_domain.startswith("."):
            # Matching on a bare suffix would let `evil-preview.test` satisfy
            # `preview.test`. Requiring the leading dot makes the check a real
            # subdomain test rather than a string suffix test.
            raise ValueError("preview_domain must start with '.' (e.g. '.preview.loopit.dev')")
        self._signer = signer
        self._routes = routes
        self._audit = audit
        self._domain = preview_domain.lower()

    def decide(
        self,
        request: PreviewRequest,
        *,
        now: float,
        path_project_id: str | None = None,
    ) -> PreviewDecision:
        """Authorise a request without emitting audit. Pure and testable.

        Subdomain mode: host must end with ``preview_domain`` (e.g.
        ``proj.preview.loopit.dev``). Path mode: when ``path_project_id`` is set
        (from ``/p/{project_id}/...``), the host check is skipped so the same
        proxy can sit behind a shared origin (nginx path prefix).
        """
        host = request.host.strip().lower()
        path_mode = bool(path_project_id)
        if not path_mode and not host.endswith(self._domain):
            return _refuse("host_unknown")
        if not request.token:
            return _refuse("missing_token")

        try:
            claims = self._signer.verify(request.token, now=now)
        except TokenExpired:
            return _refuse("expired_token")
        except TokenInvalid:
            return _refuse("invalid_token")

        if path_mode and path_project_id != claims.project_id:
            return _refuse("no_route")

        try:
            if path_mode:
                route = self._routes.resolve_project(
                    claims.project_id, tenant_id=claims.tenant_id
                )
            else:
                route = self._routes.resolve_for(
                    host, project_id=claims.project_id, tenant_id=claims.tenant_id
                )
        except RouteNotFound:
            return _refuse("no_route")

        if route.lease_id != claims.lease_id:
            # The route was rebound to a newer lease. Honouring the stale token
            # would serve the *current* sandbox to a holder of an old link.
            return _refuse("no_route")

        return PreviewDecision(
            allowed=True,
            backend=route.backend,
            project_id=route.project_id,
            tenant_id=route.tenant_id,
            lease_id=route.lease_id,
            forward_headers=self._forward_headers(request, route.tenant_id, route.project_id),
        )

    def _forward_headers(
        self, request: PreviewRequest, tenant_id: str, project_id: str
    ) -> dict[str, str]:
        forwarded = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in STRIPPED_REQUEST_HEADERS
        }
        forwarded["X-Loopit-Tenant"] = tenant_id
        forwarded["X-Loopit-Project"] = project_id
        return forwarded

    def handle(
        self,
        request: PreviewRequest,
        *,
        now: float,
        path_project_id: str | None = None,
    ) -> PreviewDecision:
        """Authorise and audit. This is what the edge calls."""
        decision = self.decide(request, now=now, path_project_id=path_project_id)
        self._emit(request, decision)
        return decision

    def _emit(self, request: PreviewRequest, decision: PreviewDecision) -> None:
        detail: dict[str, object] = dict(request.loggable())
        detail["status"] = decision.status
        if decision.reason is not None:
            detail["reason"] = decision.reason
        # The backend address is intentionally absent: the audit store is read
        # by more people than the routing table is, and an internal address is
        # exactly the thing an attacker needs to skip this proxy entirely.
        self._audit.emit(
            AuditEvent(
                type=decision.audit_event_type(),
                tenant_id=decision.tenant_id or "unknown",
                actor_kind="service",
                actor_service=SERVICE_NAME,
                project_id=decision.project_id,
                sandbox_lease_id=decision.lease_id,
                plane="data",
                outcome="allowed" if decision.allowed else "denied",
                detail=detail,
            )
        )


__all__ = [
    "SECURITY_HEADERS",
    "SERVICE_NAME",
    "STRIPPED_REQUEST_HEADERS",
    "PreviewDecision",
    "PreviewError",
    "PreviewProxy",
    "PreviewRequest",
    "Refusal",
]
