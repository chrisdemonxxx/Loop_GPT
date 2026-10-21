"""Lease-token authorization shared with the scheduler.

Lease tokens are issued by the scheduler, not by this service. Importing the
scheduler verifier keeps the signature format single-sourced while the extra
active-lease lookup here closes the gap between a valid token and a lease that
has since expired, been released, or belongs to a different sandbox.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol, cast, runtime_checkable

from fastapi import HTTPException
from loopit_sandbox_sdk import Lease, ResourceCaps
from loopit_scheduler.server import LeaseClaims, ServerSettings, _verify_token
from loopit_store import LeaseRecord
from loopit_store.models import LeaseStatus


@runtime_checkable
class LeaseResolver(Protocol):
    def resolve(self, lease_id: str, *, authorization: str | None) -> LeaseRecord: ...


@dataclass(frozen=True, slots=True)
class SchedulerLeaseResolver:
    """Resolve active leases through the scheduler's own lease view."""

    scheduler_url: str
    settings: ServerSettings
    timeout_seconds: float = 5.0

    def resolve(self, lease_id: str, *, authorization: str | None) -> LeaseRecord:
        claims = _claims(lease_id=lease_id, authorization=authorization, settings=self.settings)
        payload = self._list_tenant_leases(claims.tenant_id)
        leases = payload.get("leases")
        if not isinstance(leases, Sequence) or isinstance(leases, str | bytes):
            raise HTTPException(status_code=503, detail="scheduler returned invalid lease list")
        for item in leases:
            if isinstance(item, Mapping) and str(item.get("lease_id", "")) == lease_id:
                record = _record_from_mapping(item)
                _require_active(record)
                return record
        raise HTTPException(status_code=404, detail="lease not found")

    def _list_tenant_leases(self, tenant_id: str) -> Mapping[str, Any]:
        request = urllib.request.Request(  # noqa: S310 - scheduler_url is operator-configured HTTP(S).
            self.scheduler_url.rstrip("/") + "/leases",
            headers={
                "X-Loopit-Service-Token": self.settings.service_token,
                "X-Loopit-Tenant": tenant_id,
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(  # noqa: S310 - same operator-configured scheduler_url.
                request,
                timeout=self.timeout_seconds,
            ) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            if error.code in {401, 404}:
                raise HTTPException(status_code=404, detail="lease not found") from error
            raise HTTPException(status_code=503, detail="scheduler lease lookup failed") from error
        except OSError as error:
            raise HTTPException(status_code=503, detail="scheduler lease lookup failed") from error
        decoded = json.loads(raw)
        if not isinstance(decoded, Mapping):
            raise HTTPException(status_code=503, detail="scheduler returned invalid JSON")
        return decoded


@dataclass(frozen=True, slots=True)
class StaticLeaseResolver:
    """Test resolver for one or more explicit lease records."""

    records: Mapping[str, LeaseRecord]
    settings: ServerSettings

    def resolve(self, lease_id: str, *, authorization: str | None) -> LeaseRecord:
        claims = _claims(lease_id=lease_id, authorization=authorization, settings=self.settings)
        record = self.records.get(lease_id)
        if record is None or record.tenant_id != claims.tenant_id:
            raise HTTPException(status_code=404, detail="lease not found")
        _require_active(record)
        return record


def lease_from_record(record: LeaseRecord) -> Lease:
    return Lease(
        lease_id=record.lease_id,
        tenant_id=record.tenant_id,
        run_id=record.run_id,
        base_checkpoint_id=record.base_checkpoint_id,
        expires_at=record.expires_at,
        caps=ResourceCaps(**record.caps),
        allowed_tools=frozenset(record.allowed_tools),
    )


def _claims(*, lease_id: str, authorization: str | None, settings: ServerSettings) -> LeaseClaims:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="lease bearer token required")
    try:
        claims = _verify_token(authorization.removeprefix("Bearer ").strip(), settings)
    except ValueError as error:
        raise HTTPException(status_code=401, detail="invalid or expired lease token") from error
    if claims.lease_id != lease_id:
        raise HTTPException(status_code=404, detail="lease not found")
    return claims


def _require_active(record: LeaseRecord) -> None:
    if record.status != "active" or record.expires_at <= datetime.now(UTC):
        raise HTTPException(status_code=404, detail="lease not found")


def _record_from_mapping(item: Mapping[str, Any]) -> LeaseRecord:
    caps = item.get("caps", {})
    if not isinstance(caps, Mapping):
        caps = {}
    allowed_tools = item.get("allowed_tools", ())
    if not isinstance(allowed_tools, Sequence) or isinstance(allowed_tools, str | bytes):
        allowed_tools = ()
    status = item.get("status")
    if status not in {"active", "released", "expired"}:
        raise HTTPException(status_code=503, detail="scheduler returned invalid lease status")
    return LeaseRecord(
        lease_id=str(item["lease_id"]),
        tenant_id=str(item["tenant_id"]),
        run_id=str(item["run_id"]),
        project_id=str(item.get("project_id", "")),
        sandbox_id=str(item["sandbox_id"]),
        base_checkpoint_id=str(item["base_checkpoint_id"]),
        expires_at=_parse_time(item["expires_at"]),
        caps={key: int(value) for key, value in caps.items()},
        allowed_tools=tuple(str(tool) for tool in allowed_tools),
        status=cast(LeaseStatus, status),
    )


def _parse_time(value: Any) -> datetime:
    if not isinstance(value, str):
        raise HTTPException(status_code=503, detail="scheduler returned invalid expiry")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed
