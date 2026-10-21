from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import httpx


class SandboxKiller(Protocol):
    def kill(self, *, tenant_id: str, lease_id: str, reason: str) -> None: ...


class Throttler(Protocol):
    def throttle(self, *, tenant_id: str, project_id: str | None, reason: str) -> None: ...


class TenantSuspender(Protocol):
    def suspend(self, *, tenant_id: str, reason: str) -> None: ...
    def unsuspend(self, *, tenant_id: str, reason: str) -> None: ...


@dataclass(slots=True)
class HttpSandboxKiller:
    scheduler_url: str
    service_token: str
    timeout: float = 5.0

    def kill(self, *, tenant_id: str, lease_id: str, reason: str) -> None:
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.scheduler_url.rstrip('/')}/leases/{lease_id}/release",
                headers={"X-Loopit-Service-Token": self.service_token},
                json={"tenant_id": tenant_id, "reason": reason},
            )
            response.raise_for_status()


@dataclass(slots=True)
class HttpThrottler:
    rate_limit_url: str
    timeout: float = 5.0

    def throttle(self, *, tenant_id: str, project_id: str | None, reason: str) -> None:
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.rate_limit_url.rstrip('/')}/internal/throttle",
                json={"tenant_id": tenant_id, "project_id": project_id, "reason": reason},
            )
            response.raise_for_status()


@dataclass(slots=True)
class HttpTenantSuspender:
    auth_admin_url: str
    timeout: float = 5.0

    def suspend(self, *, tenant_id: str, reason: str) -> None:
        self._post("suspend", tenant_id, reason)

    def unsuspend(self, *, tenant_id: str, reason: str) -> None:
        self._post("unsuspend", tenant_id, reason)

    def _post(self, action: str, tenant_id: str, reason: str) -> None:
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.auth_admin_url.rstrip('/')}/internal/tenants/{tenant_id}/{action}",
                json={"reason": reason},
            )
            response.raise_for_status()


@dataclass(slots=True)
class FakeSandboxKiller:
    calls: list[tuple[str, str, str]] = field(default_factory=list)

    def kill(self, *, tenant_id: str, lease_id: str, reason: str) -> None:
        self.calls.append((tenant_id, lease_id, reason))


@dataclass(slots=True)
class FakeThrottler:
    calls: list[tuple[str, str | None, str]] = field(default_factory=list)

    def throttle(self, *, tenant_id: str, project_id: str | None, reason: str) -> None:
        self.calls.append((tenant_id, project_id, reason))


@dataclass(slots=True)
class FakeTenantSuspender:
    suspended: list[tuple[str, str]] = field(default_factory=list)
    unsuspended: list[tuple[str, str]] = field(default_factory=list)

    def suspend(self, *, tenant_id: str, reason: str) -> None:
        self.suspended.append((tenant_id, reason))

    def unsuspend(self, *, tenant_id: str, reason: str) -> None:
        self.unsuspended.append((tenant_id, reason))
