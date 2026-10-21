from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_agent_core.config import require_secret
from loopit_auth import (
    DEFAULT_OPERATOR_AUDIENCE,
    DEFAULT_OPERATOR_ISSUER,
    PLATFORM_OPERATOR_SCOPE,
    IdentityTokenError,
    TokenSigner,
    VerifiedIdentity,
)
from loopit_telemetry import add_loopit_telemetry, configure_telemetry
from pydantic import BaseModel, Field

from .actions import HttpSandboxKiller, HttpTenantSuspender, HttpThrottler
from .engine import AbuseEngine, IncidentStore
from .models import AbuseSignal, AbuseTaxon, SignalKind


@dataclass(frozen=True, slots=True)
class ServerSettings:
    host: str = "0.0.0.0"  # noqa: S104 - container listener default.
    port: int = 8007
    service_token: str = ""
    identity_key: str = ""
    identity_issuer: str = "loopit-gateway"
    identity_audience: str = "loopit-control-plane"
    operator_identity_key: str = ""
    operator_identity_issuer: str = DEFAULT_OPERATOR_ISSUER
    operator_identity_audience: str = DEFAULT_OPERATOR_AUDIENCE
    operator_identity_kid: str = "operator-1"
    scheduler_url: str = "http://scheduler:8004"
    auth_admin_url: str = "http://api:8000"
    rate_limit_url: str = "http://api:8000"
    dry_run: bool = False

    @classmethod
    def from_env(cls) -> ServerSettings:
        return cls(
            host=os.environ.get("LOOPIT_ABUSE_HOST", "0.0.0.0"),  # noqa: S104
            port=int(os.environ.get("PORT", os.environ.get("LOOPIT_ABUSE_PORT", "8006"))),
            service_token=require_secret(os.environ, "LOOPIT_SERVICE_TOKEN"),
            identity_key=require_secret(os.environ, "LOOPIT_IDENTITY_SECRET"),
            identity_issuer=os.environ.get("LOOPIT_IDENTITY_ISSUER", "loopit-gateway"),
            identity_audience=os.environ.get("LOOPIT_IDENTITY_AUDIENCE", "loopit-control-plane"),
            operator_identity_key=require_secret(os.environ, "LOOPIT_OPERATOR_IDENTITY_SECRET"),
            operator_identity_issuer=os.environ.get(
                "LOOPIT_OPERATOR_IDENTITY_ISSUER", DEFAULT_OPERATOR_ISSUER
            ),
            operator_identity_audience=os.environ.get(
                "LOOPIT_OPERATOR_IDENTITY_AUDIENCE", DEFAULT_OPERATOR_AUDIENCE
            ),
            operator_identity_kid=os.environ.get("LOOPIT_OPERATOR_IDENTITY_KID", "operator-1"),
            scheduler_url=os.environ.get("LOOPIT_SCHEDULER_URL", "http://scheduler:8004"),
            auth_admin_url=os.environ.get("LOOPIT_AUTH_ADMIN_URL", "http://api:8000"),
            rate_limit_url=os.environ.get("LOOPIT_RATE_LIMIT_URL", "http://api:8000"),
            dry_run=os.environ.get("LOOPIT_ABUSE_DRY_RUN", "0").lower()
            in {"1", "true", "yes", "on"},
        )


class SignalBody(BaseModel):
    signal_id: str
    tenant_id: str
    kind: SignalKind
    project_id: str | None = None
    sandbox_id: str | None = None
    lease_id: str | None = None
    run_id: str | None = None
    occurred_at: datetime | None = None
    detail: dict[str, Any] = Field(default_factory=dict)


class OperatorBody(BaseModel):
    reason: str
    confirmed: bool = False


class AllowlistBody(BaseModel):
    tenant_id: str
    taxon: AbuseTaxon | None = None
    project_id: str | None = None
    sandbox_id: str | None = None
    reason: str
    confirmed: bool = False


class KillSandboxBody(OperatorBody):
    tenant_id: str
    lease_id: str


def create_app(
    *, engine: AbuseEngine | None = None, settings: ServerSettings | None = None
) -> FastAPI:
    resolved = settings or ServerSettings.from_env()
    if not resolved.operator_identity_key:
        raise RuntimeError("operator identity signing key is required")
    configure_telemetry("abuse-engine")
    sink = InMemoryAuditSink()
    app_engine = engine or AbuseEngine(
        killer=HttpSandboxKiller(resolved.scheduler_url, resolved.service_token),
        throttler=HttpThrottler(resolved.rate_limit_url),
        suspender=HttpTenantSuspender(resolved.auth_admin_url),
        audit=sink,
        store=IncidentStore(),
        dry_run=resolved.dry_run,
    )
    kid = os.environ.get("LOOPIT_IDENTITY_KID", "local-1")
    signer = TokenSigner(
        issuer=resolved.identity_issuer,
        audience=resolved.identity_audience,
        keys={kid: resolved.identity_key.encode()},
        current_kid=kid,
    )
    operator_signer = TokenSigner(
        issuer=resolved.operator_identity_issuer,
        audience=resolved.operator_identity_audience,
        keys={resolved.operator_identity_kid: resolved.operator_identity_key.encode()},
        current_kid=resolved.operator_identity_kid,
    )
    app = FastAPI(title="loopit-abuse")
    add_loopit_telemetry(app, "abuse-engine")
    app.state.engine = app_engine

    def service_auth(x_loopit_service_token: str | None = Header(default=None)) -> None:
        if x_loopit_service_token is None or not secrets.compare_digest(
            x_loopit_service_token, resolved.service_token
        ):
            raise HTTPException(status_code=401, detail="service authentication required")

    def admin_identity(authorization: str | None = Header(default=None)) -> VerifiedIdentity:
        if authorization is None or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="authentication required")
        raw_token = authorization.removeprefix("Bearer ").strip()
        try:
            identity = signer.verify_identity(raw_token)
        except IdentityTokenError:
            try:
                identity = operator_signer.verify_identity(raw_token)
            except IdentityTokenError as exc:
                raise HTTPException(status_code=401, detail="invalid identity token") from exc
        if identity.audience == resolved.operator_identity_audience:
            if identity.issuer != resolved.operator_identity_issuer:
                raise HTTPException(status_code=401, detail="invalid identity token")
            if PLATFORM_OPERATOR_SCOPE not in identity.scopes:
                raise HTTPException(status_code=403, detail="platform operator scope required")
            return identity
        if identity.role not in {"owner", "admin"}:
            raise HTTPException(status_code=403, detail="admin role required")
        return identity

    admin = Depends(admin_identity)

    @app.get("/healthz")
    def healthz() -> dict[str, str | bool]:
        return {"status": "ok", "dry_run": resolved.dry_run}

    @app.post("/v1/signals", dependencies=[Depends(service_auth)])
    def ingest_signal(body: SignalBody) -> dict[str, Any]:
        signal = AbuseSignal(
            signal_id=body.signal_id,
            tenant_id=body.tenant_id,
            kind=body.kind,
            project_id=body.project_id,
            sandbox_id=body.sandbox_id,
            lease_id=body.lease_id,
            run_id=body.run_id,
            occurred_at=body.occurred_at or datetime.now(UTC),
            detail=body.detail,
        )
        incident = app.state.engine.ingest(signal)
        return {"incident": _incident(incident) if incident else None}

    @app.get("/v1/incidents")
    def list_incidents(
        identity: VerifiedIdentity = admin,
        tenant_id: str | None = Query(default=None),
    ) -> dict[str, Any]:
        scoped = tenant_id or identity.org_id
        _require_tenant_access(identity, scoped, settings=resolved)
        return {"incidents": [_incident(item) for item in app.state.engine.store.list(scoped)]}

    @app.get("/v1/incidents/{incident_id}")
    def get_incident(incident_id: str, identity: VerifiedIdentity = admin) -> dict[str, Any]:
        incident = app.state.engine.store.get(incident_id)
        if incident is None:
            raise HTTPException(status_code=404, detail="incident not found")
        _require_tenant_access(identity, incident.tenant_id, settings=resolved)
        return {"incident": _incident(incident)}

    @app.post("/v1/incidents/{incident_id}/dismiss")
    def dismiss_incident(
        incident_id: str, body: OperatorBody, identity: VerifiedIdentity = admin
    ) -> dict[str, Any]:
        _require_confirmed(body.confirmed)
        try:
            incident = app.state.engine.store.get(incident_id)
            if incident is None:
                raise KeyError(incident_id)
            _require_tenant_access(identity, incident.tenant_id, settings=resolved)
            incident = app.state.engine.dismiss(
                incident_id, actor_id=identity.subject, reason=body.reason
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="incident not found") from exc
        return {"incident": _incident(incident)}

    @app.post("/v1/tenants/{tenant_id}/suspend")
    def suspend_tenant(
        tenant_id: str, body: OperatorBody, identity: VerifiedIdentity = admin
    ) -> dict[str, str]:
        _require_confirmed(body.confirmed)
        _require_tenant_access(identity, tenant_id, settings=resolved)
        app.state.engine.suspend(tenant_id, actor_id=identity.subject, reason=body.reason)
        return {"status": "suspended"}

    @app.post("/v1/tenants/{tenant_id}/unsuspend")
    def unsuspend_tenant(
        tenant_id: str, body: OperatorBody, identity: VerifiedIdentity = admin
    ) -> dict[str, str]:
        _require_confirmed(body.confirmed)
        _require_tenant_access(identity, tenant_id, settings=resolved)
        app.state.engine.unsuspend(tenant_id, actor_id=identity.subject, reason=body.reason)
        return {"status": "unsuspended"}

    @app.post("/v1/sandboxes/kill")
    def kill_sandbox(body: KillSandboxBody, identity: VerifiedIdentity = admin) -> dict[str, str]:
        _require_confirmed(body.confirmed)
        _require_tenant_access(identity, body.tenant_id, settings=resolved)
        app.state.engine.kill_sandbox(
            body.tenant_id, body.lease_id, actor_id=identity.subject, reason=body.reason
        )
        return {"status": "killed"}

    @app.post("/v1/allowlist")
    def allowlist(body: AllowlistBody, identity: VerifiedIdentity = admin) -> dict[str, str]:
        _require_confirmed(body.confirmed)
        _require_tenant_access(identity, body.tenant_id, settings=resolved)
        app.state.engine.add_allowlist(
            tenant_id=body.tenant_id,
            taxon=body.taxon,
            project_id=body.project_id,
            sandbox_id=body.sandbox_id,
            actor_id=identity.subject,
            reason=body.reason,
        )
        return {"status": "allowlisted"}

    @app.get("/v1/audit")
    def audit_log(identity: VerifiedIdentity = admin) -> dict[str, Any]:
        _require_platform_operator(identity, settings=resolved)
        events = getattr(sink, "events", ())
        return {"events": [event.to_dict() for event in events]}

    return app


def _require_confirmed(confirmed: bool) -> None:
    if not confirmed:
        raise HTTPException(status_code=409, detail="explicit confirmation required")


def _is_platform_operator(identity: VerifiedIdentity, *, settings: ServerSettings) -> bool:
    return (
        identity.audience == settings.operator_identity_audience
        and identity.issuer == settings.operator_identity_issuer
        and PLATFORM_OPERATOR_SCOPE in identity.scopes
    )


def _require_platform_operator(identity: VerifiedIdentity, *, settings: ServerSettings) -> None:
    if not _is_platform_operator(identity, settings=settings):
        raise HTTPException(status_code=403, detail="platform operator scope required")


def _require_tenant_access(
    identity: VerifiedIdentity, tenant_id: str, *, settings: ServerSettings
) -> None:
    if _is_platform_operator(identity, settings=settings):
        return
    if identity.org_id != tenant_id:
        raise HTTPException(status_code=403, detail="tenant access denied")


def _incident(incident: Any) -> dict[str, Any]:
    return {
        "incident_id": incident.incident_id,
        "tenant_id": incident.tenant_id,
        "project_id": incident.project_id,
        "sandbox_id": incident.sandbox_id,
        "lease_id": incident.lease_id,
        "taxon": incident.taxon.value,
        "tier": incident.tier,
        "state": incident.state,
        "score": incident.score,
        "action": incident.action,
        "dry_run": incident.dry_run,
        "signal_ids": list(incident.signal_ids),
        "created_at": incident.created_at.isoformat().replace("+00:00", "Z"),
        "updated_at": incident.updated_at.isoformat().replace("+00:00", "Z"),
        "detail": incident.detail,
    }


app = create_app()


def main() -> None:
    settings = ServerSettings.from_env()
    uvicorn.run(create_app(settings=settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
