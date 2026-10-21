"""Bind project leases to the preview-proxy (Phase 1.4).

Offline / local static previews never call this. Orchestrator mode binds a
sandbox backend so the iframe can load Vite with HMR through the proxy.
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


@dataclass(frozen=True, slots=True)
class PreviewBindResult:
    preview_host: str
    project_id: str
    lease_id: str
    public_url: str
    mode: str = "hmr"


class PreviewProxyClient:
    """HTTP client for preview-proxy ``/internal/routes``."""

    def __init__(
        self,
        base_url: str,
        *,
        service_token: str,
        public_base: str,
        preview_domain: str,
        timeout_seconds: float = 10.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.service_token = service_token
        self.public_base = public_base.rstrip("/")
        self.preview_domain = preview_domain if preview_domain.startswith(".") else f".{preview_domain}"
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls) -> PreviewProxyClient | None:
        url = (os.environ.get("LOOPIT_PREVIEW_PROXY_URL") or "").strip()
        token = (os.environ.get("LOOPIT_SERVICE_TOKEN") or "").strip()
        if not url or not token:
            return None
        public = (
            os.environ.get("LOOPIT_PREVIEW_PUBLIC_URL")
            or os.environ.get("LOOPIT_PREVIEW_PROXY_PUBLIC_URL")
            or url
        ).strip()
        domain = os.environ.get("LOOPIT_PREVIEW_DOMAIN", ".preview.loopit.dev")
        return cls(url, service_token=token, public_base=public, preview_domain=domain)

    def bind(
        self,
        *,
        project_id: str,
        tenant_id: str,
        lease_id: str,
        backend_host: str,
        backend_port: int,
    ) -> PreviewBindResult:
        preview_host = f"{project_id}{self.preview_domain}"
        self._request(
            "POST",
            "/internal/routes",
            body={
                "preview_host": preview_host,
                "project_id": project_id,
                "tenant_id": tenant_id,
                "lease_id": lease_id,
                "backend_host": backend_host,
                "backend_port": backend_port,
            },
        )
        # Prefer path-based public URL so the iframe can stay same-site via nginx.
        public_url = f"{self.public_base}/p/{project_id}/"
        return PreviewBindResult(
            preview_host=preview_host,
            project_id=project_id,
            lease_id=lease_id,
            public_url=public_url,
            mode="hmr",
        )

    def unbind(self, preview_host: str) -> None:
        try:
            self._request("DELETE", f"/internal/routes/{preview_host}")
        except PreviewProxyError:
            LOGGER.debug("preview unbind failed for %s", preview_host, exc_info=True)

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=payload,
            method=method,
            headers={
                "Content-Type": "application/json",
                "X-Loopit-Service-Token": self.service_token,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise PreviewProxyError(
                f"preview-proxy {method} {path} failed: {error.code} {detail}"
            ) from error
        except urllib.error.URLError as error:
            raise PreviewProxyError(f"preview-proxy unreachable: {error}") from error
        if not raw:
            return {}
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}


class PreviewProxyError(RuntimeError):
    """preview-proxy HTTP call failed."""


def default_backend_from_env() -> tuple[str, int]:
    """Sandbox dev-server address when the lease payload omits it."""
    host = os.environ.get("LOOPIT_SANDBOX_PREVIEW_HOST", "127.0.0.1")
    port = int(os.environ.get("LOOPIT_SANDBOX_PREVIEW_PORT", "5173"))
    return host, port


__all__ = [
    "PreviewBindResult",
    "PreviewProxyClient",
    "PreviewProxyError",
    "default_backend_from_env",
]
