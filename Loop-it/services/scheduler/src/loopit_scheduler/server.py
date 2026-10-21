"""HTTP service for sandbox lease scheduling."""

from __future__ import annotations

import base64
import hmac
import json
import logging
import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from loopit_agent_core.audit import AuditEvent, AuditSink
from loopit_agent_core.config import require_secret
from loopit_sandbox_sdk.lease import ResourceCaps
from loopit_store import (
    AuditStore,
    InMemoryAuditStore,
    InMemoryLeaseStore,
    LeaseRecord,
    LeaseStore,
    PostgresAppendOnlyAuditSink,
    PostgresLeaseStore,
)
from loopit_store.postgres import connect
from loopit_telemetry import add_loopit_telemetry, configure_telemetry
from pydantic import BaseModel, Field

from .errors import LeaseExpired, LeaseNotFound, TenantConcurrencyExceeded
from .factory import SchedulerSettings, create_scheduler
from .scheduler import Assignment, Scheduler

LOG = logging.getLogger("loopit.scheduler")


@dataclass(frozen=True, slots=True)
class ServerSettings:
    host: str = "0.0.0.0"  # noqa: S104 - service listener default.
    port: int = 8080
    lease_token_secret: str = ""
    service_token: str = ""
    scheduler_store_dsn: str = ""
    audit_dsn: str = ""

    @classmethod
    def from_env(cls) -> ServerSettings:
        return cls(
            host=os.environ.get("LOOPIT_SCHEDULER_HOST", "0.0.0.0"),  # noqa: S104
            port=int(os.environ.get("LOOPIT_SCHEDULER_PORT", "8080")),
            lease_token_secret=require_secret(os.environ, "LOOPIT_LEASE_TOKEN_SECRET"),
            service_token=require_secret(os.environ, "LOOPIT_SERVICE_TOKEN"),
            scheduler_store_dsn=os.environ.get("LOOPIT_SCHEDULER_STORE_DSN", ""),
            audit_dsn=os.environ.get("LOOPIT_AUDIT_DSN", ""),
        )


class StoreAuditSink:
    def __init__(self, store: AuditStore) -> None:
        self._store = store

    def emit(self, event: AuditEvent) -> None:
        self._store.append(event)


class AcquireRequest(BaseModel):
    tenant_id: str
    run_id: str
    project_id: str
    base_checkpoint_id: str
    ttl_seconds: int = Field(default=1800, gt=0)
    allowed_tools: list[str] | None = None
    caps: dict[str, int] | None = None


class RenewRequest(BaseModel):
    tenant_id: str | None = None
    ttl_seconds: int = Field(default=1800, gt=0)


class ReleaseRequest(BaseModel):
    tenant_id: str | None = None
    reason: str = "completed"


class PauseResumeRequest(BaseModel):
    tenant_id: str | None = None


def create_app(
    *,
    scheduler: Scheduler | None = None,
    settings: ServerSettings | None = None,
    lease_store: LeaseStore | None = None,
) -> FastAPI:
    resolved = settings or ServerSettings.from_env()
    logging.basicConfig(level=os.environ.get("LOOPIT_LOG_LEVEL", "INFO"), format="%(message)s")
    configure_telemetry("scheduler")
    audit = _audit_sink(resolved)
    scheduler_instance = scheduler or create_scheduler(
        audit=audit, settings=SchedulerSettings.from_env()
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            scheduler_instance.shutdown()

    app = FastAPI(title="loopit-scheduler", lifespan=lifespan)
    add_loopit_telemetry(app, "scheduler")
    app.state.settings = resolved
    app.state.scheduler = scheduler_instance
    app.state.lease_store = lease_store or _lease_store(resolved)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/leases")
    def acquire(
        payload: AcquireRequest,
        x_loopit_service_token: str | None = Header(default=None),
    ) -> dict[str, Any]:
        _require_service_token(x_loopit_service_token, settings=resolved)
        try:
            assignment = app.state.scheduler.acquire(
                tenant_id=payload.tenant_id,
                run_id=payload.run_id,
                project_id=payload.project_id,
                base_checkpoint_id=payload.base_checkpoint_id,
                ttl_seconds=payload.ttl_seconds,
                caps=_caps(payload.caps),
                allowed_tools=frozenset(payload.allowed_tools) if payload.allowed_tools else None,
            )
        except TenantConcurrencyExceeded as exc:
            raise HTTPException(status_code=429, detail="tenant concurrency exceeded") from exc
        record = app.state.lease_store.create(_record(assignment, payload.project_id))
        return {
            **_assignment(assignment, payload.project_id),
            "lease_token": _token(record, resolved),
        }

    @app.post("/leases/{lease_id}/release")
    def release(
        lease_id: str,
        payload: ReleaseRequest,
        authorization: str | None = Header(default=None),
        x_loopit_service_token: str | None = Header(default=None),
    ) -> dict[str, str]:
        tenant_id = _authorized_tenant(
            lease_id=lease_id,
            payload_tenant_id=payload.tenant_id,
            authorization=authorization,
            service_token=x_loopit_service_token,
            settings=resolved,
        )
        try:
            app.state.scheduler.release(lease_id, tenant_id=tenant_id, reason=payload.reason)
        except LeaseNotFound as exc:
            raise HTTPException(status_code=404, detail="lease not found") from exc
        try:
            app.state.lease_store.release(lease_id, tenant_id=tenant_id, reason=payload.reason)
        except KeyError:
            pass
        return {"status": "released"}

    @app.post("/leases/{lease_id}/renew")
    def renew(
        lease_id: str,
        payload: RenewRequest,
        authorization: str | None = Header(default=None),
        x_loopit_service_token: str | None = Header(default=None),
    ) -> dict[str, Any]:
        tenant_id = _authorized_tenant(
            lease_id=lease_id,
            payload_tenant_id=payload.tenant_id,
            authorization=authorization,
            service_token=x_loopit_service_token,
            settings=resolved,
        )
        try:
            current_record = app.state.lease_store.get(lease_id, tenant_id=tenant_id)
            assignment = app.state.scheduler.renew(
                lease_id, tenant_id=tenant_id, ttl_seconds=payload.ttl_seconds
            )
        except (LeaseNotFound, LeaseExpired) as exc:
            raise HTTPException(status_code=404, detail="lease not found") from exc
        project_id = (
            current_record.project_id if current_record is not None else assignment.project_id
        )
        record = _persist_renewed_record(
            app.state.lease_store,
            _record(assignment, project_id),
        )
        return {
            **_assignment(assignment, project_id=record.project_id),
            "lease_token": _token(record, resolved),
        }

    @app.post("/leases/{lease_id}/pause")
    def pause_lease(
        lease_id: str,
        payload: PauseResumeRequest,
        authorization: str | None = Header(default=None),
        x_loopit_service_token: str | None = Header(default=None),
    ) -> dict[str, str]:
        tenant_id = _authorized_tenant(
            lease_id=lease_id,
            payload_tenant_id=payload.tenant_id,
            authorization=authorization,
            service_token=x_loopit_service_token,
            settings=resolved,
        )
        try:
            app.state.scheduler.pause(lease_id, tenant_id=tenant_id)
        except LeaseNotFound as exc:
            raise HTTPException(status_code=404, detail="lease not found") from exc
        except NotImplementedError as exc:
            raise HTTPException(status_code=501, detail=str(exc)) from exc
        return {"status": "paused", "lease_id": lease_id}

    @app.post("/leases/{lease_id}/resume")
    def resume_lease(
        lease_id: str,
        payload: PauseResumeRequest,
        authorization: str | None = Header(default=None),
        x_loopit_service_token: str | None = Header(default=None),
    ) -> dict[str, str]:
        tenant_id = _authorized_tenant(
            lease_id=lease_id,
            payload_tenant_id=payload.tenant_id,
            authorization=authorization,
            service_token=x_loopit_service_token,
            settings=resolved,
        )
        try:
            app.state.scheduler.resume(lease_id, tenant_id=tenant_id)
        except LeaseNotFound as exc:
            raise HTTPException(status_code=404, detail="lease not found") from exc
        except NotImplementedError as exc:
            raise HTTPException(status_code=501, detail=str(exc)) from exc
        return {"status": "resumed", "lease_id": lease_id}

    @app.get("/leases")
    def list_leases(
        authorization: str | None = Header(default=None),
        x_loopit_service_token: str | None = Header(default=None),
        x_loopit_tenant: str | None = Header(default=None),
    ) -> dict[str, list[dict[str, Any]]]:
        tenant_id = _authorized_tenant(
            lease_id=None,
            payload_tenant_id=x_loopit_tenant,
            authorization=authorization,
            service_token=x_loopit_service_token,
            settings=resolved,
        )
        return {
            "leases": [
                _assignment(
                    assignment,
                    project_id=_project_id_for_assignment(app.state.lease_store, assignment),
                )
                for assignment in app.state.scheduler
                if assignment.tenant_id == tenant_id
            ]
        }

    return app


def _audit_sink(settings: ServerSettings) -> AuditSink:
    if not settings.audit_dsn:
        return StoreAuditSink(InMemoryAuditStore())
    return PostgresAppendOnlyAuditSink(connect(settings.audit_dsn))


def _lease_store(settings: ServerSettings) -> LeaseStore:
    if not settings.scheduler_store_dsn:
        return InMemoryLeaseStore()
    return PostgresLeaseStore(connect(settings.scheduler_store_dsn))


def _caps(raw: dict[str, int] | None) -> ResourceCaps | None:
    return ResourceCaps(**raw) if raw else None


def _record(assignment: Assignment, project_id: str) -> LeaseRecord:
    lease = assignment.lease
    return LeaseRecord(
        lease_id=lease.lease_id,
        tenant_id=lease.tenant_id,
        run_id=lease.run_id,
        project_id=project_id,
        sandbox_id=assignment.sandbox.sandbox_id,
        base_checkpoint_id=lease.base_checkpoint_id,
        expires_at=lease.expires_at,
        caps={
            "cpu_millicores": lease.caps.cpu_millicores,
            "memory_mib": lease.caps.memory_mib,
            "disk_mib": lease.caps.disk_mib,
            "wall_clock_seconds": lease.caps.wall_clock_seconds,
            "max_processes": lease.caps.max_processes,
        },
        allowed_tools=tuple(sorted(lease.allowed_tools)),
    )


def _project_id_for_assignment(store: LeaseStore, assignment: Assignment) -> str:
    record = store.get(assignment.lease_id, tenant_id=assignment.tenant_id)
    return record.project_id if record is not None else assignment.project_id


def _assignment(assignment: Assignment, project_id: str) -> dict[str, Any]:
    lease = assignment.lease
    return {
        "lease_id": lease.lease_id,
        "tenant_id": lease.tenant_id,
        "run_id": lease.run_id,
        "project_id": project_id,
        "sandbox_id": assignment.sandbox.sandbox_id,
        "base_checkpoint_id": lease.base_checkpoint_id,
        "expires_at": lease.expires_at.isoformat().replace("+00:00", "Z"),
        "allowed_tools": sorted(lease.allowed_tools),
        "caps": _record(assignment, project_id).caps,
        "status": "active",
    }


def _persist_renewed_record(store: LeaseStore, record: LeaseRecord) -> LeaseRecord:
    return store.renew(record)


@dataclass(frozen=True, slots=True)
class LeaseClaims:
    tenant_id: str
    lease_id: str
    project_id: str
    expires_at: float


def _token(record: LeaseRecord, settings: ServerSettings) -> str:
    payload = {
        "tenant_id": record.tenant_id,
        "lease_id": record.lease_id,
        "run_id": record.run_id,
        "project_id": record.project_id,
        "exp": record.expires_at.timestamp(),
    }
    body = _b64(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
    sig = _b64(hmac.new(settings.lease_token_secret.encode(), body.encode(), sha256).digest())
    return f"{body}.{sig}"


def _verify_token(token: str, settings: ServerSettings) -> LeaseClaims:
    body, dot, sig = token.partition(".")
    expected = _b64(hmac.new(settings.lease_token_secret.encode(), body.encode(), sha256).digest())
    if not dot or not hmac.compare_digest(sig, expected):
        raise ValueError("lease token signature is invalid")
    try:
        payload = json.loads(_b64d(body))
        claims = LeaseClaims(
            tenant_id=str(payload["tenant_id"]),
            lease_id=str(payload["lease_id"]),
            project_id=str(payload["project_id"]),
            expires_at=float(payload["exp"]),
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("lease token payload is invalid") from exc
    if claims.expires_at <= datetime.now(UTC).timestamp():
        raise ValueError("lease token expired")
    return claims


def _authorized_tenant(
    *,
    lease_id: str | None,
    payload_tenant_id: str | None,
    authorization: str | None,
    service_token: str | None,
    settings: ServerSettings,
) -> str:
    if service_token is not None:
        _require_service_token(service_token, settings=settings)
        if payload_tenant_id is None:
            raise HTTPException(status_code=400, detail="tenant_id required for service credential")
        return payload_tenant_id
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="lease bearer token required")
    try:
        claims = _verify_token(authorization.removeprefix("Bearer ").strip(), settings)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="invalid or expired lease token") from exc
    if lease_id is not None and claims.lease_id != lease_id:
        raise HTTPException(status_code=404, detail="lease not found")
    return claims.tenant_id


def _require_service_token(token: str | None, *, settings: ServerSettings) -> None:
    if token is None or not secrets.compare_digest(token, settings.service_token):
        raise HTTPException(status_code=401, detail="service authentication required")


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64d(raw: str) -> bytes:
    return base64.urlsafe_b64decode((raw + "=" * (-len(raw) % 4)).encode())


app = create_app()


def main() -> None:
    settings = ServerSettings.from_env()
    uvicorn.run(create_app(settings=settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
