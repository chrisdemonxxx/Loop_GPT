"""HTTP client for the sandbox scheduler (leases).

Used by the API when ``LOOPIT_RUN_EXECUTION_MODE=orchestrator`` so
``/api/projects/*`` can resolve or acquire a per-project lease without
talking to Temporal. Offline/mock stacks set ``LOOPIT_SANDBOX_PROVIDER=memory``
on the scheduler; this client is transport-only.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

LOGGER = logging.getLogger(__name__)

DEFAULT_ALLOWED_TOOLS: tuple[str, ...] = (
    "read_file",
    "search_code",
    "apply_patch",
    "run_shell",
    "install_package",
    "start_dev_server",
    "read_logs",
    "browser",
)


@dataclass(frozen=True, slots=True)
class LeaseHandle:
    lease_id: str
    lease_token: str
    sandbox_id: str
    project_id: str
    expires_at: str
    allowed_tools: tuple[str, ...] = ()


class SchedulerClient:
    """Thin wrapper around ``POST/GET /leases``."""

    def __init__(
        self,
        base_url: str,
        *,
        service_token: str,
        timeout_seconds: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.service_token = service_token
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls) -> SchedulerClient | None:
        url = (os.environ.get("LOOPIT_SCHEDULER_URL") or "").strip()
        token = (os.environ.get("LOOPIT_SERVICE_TOKEN") or "").strip()
        if not url or not token:
            return None
        return cls(url, service_token=token)

    def list_leases(self, *, tenant_id: str) -> list[LeaseHandle]:
        data = self._request(
            "GET",
            "/leases",
            headers={
                "X-Loopit-Service-Token": self.service_token,
                "X-Loopit-Tenant": tenant_id,
            },
        )
        leases = data.get("leases") if isinstance(data, dict) else None
        if not isinstance(leases, list):
            return []
        return [self._handle(item) for item in leases if isinstance(item, dict)]

    def find_project_lease(self, *, tenant_id: str, project_id: str) -> LeaseHandle | None:
        for lease in self.list_leases(tenant_id=tenant_id):
            if lease.project_id == project_id:
                return lease
        return None

    def acquire(
        self,
        *,
        tenant_id: str,
        run_id: str,
        project_id: str,
        base_checkpoint_id: str = "scaffold",
        ttl_seconds: int = 1800,
        allowed_tools: tuple[str, ...] | None = None,
    ) -> LeaseHandle:
        body = {
            "tenant_id": tenant_id,
            "run_id": run_id,
            "project_id": project_id,
            "base_checkpoint_id": base_checkpoint_id,
            "ttl_seconds": ttl_seconds,
            "allowed_tools": list(allowed_tools or DEFAULT_ALLOWED_TOOLS),
        }
        data = self._request(
            "POST",
            "/leases",
            body=body,
            headers={"X-Loopit-Service-Token": self.service_token},
        )
        return self._handle(data)

    def renew(
        self, *, tenant_id: str, lease_id: str, ttl_seconds: int = 1800
    ) -> LeaseHandle:
        data = self._request(
            "POST",
            f"/leases/{lease_id}/renew",
            body={"tenant_id": tenant_id, "ttl_seconds": ttl_seconds},
            headers={"X-Loopit-Service-Token": self.service_token},
        )
        return self._handle(data)

    def release(self, *, tenant_id: str, lease_id: str, reason: str = "idle") -> None:
        self._request(
            "POST",
            f"/leases/{lease_id}/release",
            body={"tenant_id": tenant_id, "reason": reason},
            headers={"X-Loopit-Service-Token": self.service_token},
        )

    def pause(self, *, tenant_id: str, lease_id: str) -> None:
        self._request(
            "POST",
            f"/leases/{lease_id}/pause",
            body={"tenant_id": tenant_id},
            headers={"X-Loopit-Service-Token": self.service_token},
        )

    def resume(self, *, tenant_id: str, lease_id: str) -> None:
        self._request(
            "POST",
            f"/leases/{lease_id}/resume",
            body={"tenant_id": tenant_id},
            headers={"X-Loopit-Service-Token": self.service_token},
        )

    def ensure_project_lease(
        self,
        *,
        tenant_id: str,
        project_id: str,
        run_id: str | None = None,
        base_checkpoint_id: str = "scaffold",
    ) -> LeaseHandle:
        """Return an active lease for the project, acquiring one if needed.

        Idle E2B sandboxes can be paused via :meth:`pause` / :meth:`resume`
        when the provider SDK supports it; otherwise release + warm-pool refill
        remains the idle path.
        """
        existing = self.find_project_lease(tenant_id=tenant_id, project_id=project_id)
        if existing is not None:
            try:
                return self.renew(tenant_id=tenant_id, lease_id=existing.lease_id)
            except SchedulerError:
                LOGGER.info("renew failed for %s; acquiring a fresh lease", existing.lease_id)
        return self.acquire(
            tenant_id=tenant_id,
            run_id=run_id or f"project-{project_id}",
            project_id=project_id,
            base_checkpoint_id=base_checkpoint_id,
        )

    def _handle(self, data: dict[str, Any]) -> LeaseHandle:
        tools = data.get("allowed_tools") or ()
        return LeaseHandle(
            lease_id=str(data["lease_id"]),
            lease_token=str(data.get("lease_token") or ""),
            sandbox_id=str(data.get("sandbox_id") or ""),
            project_id=str(data.get("project_id") or ""),
            expires_at=str(data.get("expires_at") or ""),
            allowed_tools=tuple(str(t) for t in tools),
        )

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=payload,
            method=method,
            headers={
                "Content-Type": "application/json",
                **(headers or {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise SchedulerError(f"scheduler {method} {path} failed: {error.code} {detail}") from error
        except urllib.error.URLError as error:
            raise SchedulerError(f"scheduler unreachable: {error}") from error
        if not raw:
            return {}
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise SchedulerError("scheduler returned a non-object payload")
        return parsed


class SchedulerError(RuntimeError):
    """Scheduler HTTP call failed."""


__all__ = [
    "DEFAULT_ALLOWED_TOOLS",
    "LeaseHandle",
    "SchedulerClient",
    "SchedulerError",
]
