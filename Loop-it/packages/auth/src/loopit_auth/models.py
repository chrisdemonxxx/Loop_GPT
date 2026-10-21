from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

Role = Literal["owner", "admin", "member", "viewer"]


def now_utc() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class AuthUser:
    user_id: str
    tenant_id: str
    email: str
    display_name: str | None = None
    disabled: bool = False
    created_at: datetime = field(default_factory=now_utc)


@dataclass(frozen=True, slots=True)
class Org:
    org_id: str
    tenant_id: str
    name: str
    created_at: datetime = field(default_factory=now_utc)


@dataclass(frozen=True, slots=True)
class Membership:
    user_id: str
    org_id: str
    tenant_id: str
    role: Role
    created_at: datetime = field(default_factory=now_utc)


@dataclass(frozen=True, slots=True)
class Actor:
    subject: str
    tenant_id: str
    org_id: str
    role: Role
    scopes: frozenset[str] = frozenset()

    @classmethod
    def from_claims(
        cls,
        *,
        subject: str,
        org_id: str,
        role: Role,
        scopes: list[str] | tuple[str, ...] | frozenset[str],
    ) -> Actor:
        return cls(
            subject=subject, tenant_id=org_id, org_id=org_id, role=role, scopes=frozenset(scopes)
        )
