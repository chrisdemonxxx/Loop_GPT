from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum


def now_utc() -> datetime:
    return datetime.now(UTC)


class DomainStatus(StrEnum):
    PENDING = "pending"
    VERIFIED = "verified"
    EXPIRED = "expired"
    RELEASED = "released"
    RETIRED = "retired"


class CertificateStatus(StrEnum):
    PENDING = "pending"
    ACTIVE = "active"
    RENEWAL_DUE = "renewal_due"
    EXPIRED = "expired"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class ProjectSubdomain:
    tenant_id: str
    org_id: str
    project_id: str
    label: str
    hostname: str
    status: DomainStatus = DomainStatus.VERIFIED
    created_at: datetime = field(default_factory=now_utc)
    released_at: datetime | None = None
    quarantine_until: datetime | None = None


@dataclass(frozen=True, slots=True)
class CustomDomainClaim:
    claim_id: str
    tenant_id: str
    org_id: str
    project_id: str
    hostname: str
    status: DomainStatus
    challenge_name: str
    challenge_value: str
    expires_at: datetime
    created_at: datetime = field(default_factory=now_utc)
    verified_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class CertificateRecord:
    certificate_id: str
    tenant_id: str
    hostnames: tuple[str, ...]
    status: CertificateStatus
    challenge_type: str
    issued_at: datetime | None = None
    expires_at: datetime | None = None
    last_error: str = ""


@dataclass(frozen=True, slots=True)
class ProjectBackend:
    tenant_id: str
    project_id: str
    host: str
    port: int
    checkpoint_id: str = ""
    release_id: str = ""
    serving_status: str = "active"
    refusal_reason: str = ""
    updated_at: datetime = field(default_factory=now_utc)


@dataclass(frozen=True, slots=True)
class HostedRoute:
    hostname: str
    tenant_id: str
    org_id: str
    project_id: str
    kind: str
    certificate_status: CertificateStatus
    certificate_expires_at: datetime | None
    backend: ProjectBackend
