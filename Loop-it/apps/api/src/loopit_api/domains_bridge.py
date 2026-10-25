"""Custom domains for Build Mode projects (Phase 2.4).

Offline: in-process :class:`DomainService` with fake DNS/TLS. Live: HTTP to
``LOOPIT_DOMAINS_URL``. On successful verify, meters ``custom_domain_months``
via ``LOOPIT_USAGE_URL`` when configured.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urljoin

from loopit_agent_core.audit import InMemoryAuditSink
from loopit_auth import Actor

LOGGER = logging.getLogger("loopit.api.domains")


@dataclass
class DomainClaimView:
    claim_id: str
    hostname: str
    status: str
    challenge_name: str
    challenge_value: str
    expires_at: str
    project_id: str
    tls_status: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "claim_id": self.claim_id,
            "hostname": self.hostname,
            "status": self.status,
            "challenge_name": self.challenge_name,
            "challenge_value": self.challenge_value,
            "expires_at": self.expires_at,
            "project_id": self.project_id,
            "tls_status": self.tls_status,
            "challenge_type": "TXT",
            "cname_target": os.environ.get("LOOPIT_APPS_BASE_DOMAIN") or "apps.loopit.local",
        }


class ProjectDomains:
    """Facade over in-process DomainService or remote domains HTTP API."""

    def __init__(self, *, mode: str = "fake") -> None:
        self.mode = mode
        self._remote_url = (os.environ.get("LOOPIT_DOMAINS_URL") or "").strip()
        self._service_token = (os.environ.get("LOOPIT_SERVICE_TOKEN") or "").strip()
        self._local = None
        self._resolver = None
        if mode == "fake" or not self._remote_url:
            self._init_local()

    def _init_local(self) -> None:
        from loopit_domains.dns import InMemoryDnsProvider, InMemoryPublicDnsResolver
        from loopit_domains.service import DomainService, InMemoryDomainRepository, NoopBillingClient
        from loopit_domains.tls import FakeCertificateAuthority

        self._resolver = InMemoryPublicDnsResolver()
        self._local = DomainService(
            base_domain=os.environ.get("LOOPIT_APPS_BASE_DOMAIN", "loopit.local"),
            app_proxy_target="app-proxy",
            dns=InMemoryDnsProvider(),
            certificates=FakeCertificateAuthority(),
            audit=InMemoryAuditSink(),
            public_resolver=self._resolver,
            billing=NoopBillingClient(),
            repository=InMemoryDomainRepository(),
        )
        self.mode = "fake"

    def _actor(self, *, tenant_id: str, subject: str, org_id: str | None = None) -> Actor:
        return Actor(
            subject=subject,
            tenant_id=tenant_id,
            org_id=org_id or tenant_id,
            role="owner",
            scopes=frozenset({"domains:operator"}),
        )

    def _claim_view(self, claim: Any, *, project_id: str) -> DomainClaimView:
        expires = claim.expires_at
        if isinstance(expires, datetime):
            expires_at = expires.astimezone(UTC).isoformat()
        else:
            expires_at = str(expires)
        raw_status = getattr(claim, "status", "pending")
        status = raw_status.value if hasattr(raw_status, "value") else str(raw_status)
        tls = None
        if status == "verified" and self._local is not None:
            cert = self._local.repository.certificate_for_host(
                claim.hostname, datetime.now(UTC)
            )
            if cert is not None:
                tls = cert.status.value if hasattr(cert.status, "value") else str(cert.status)
        return DomainClaimView(
            claim_id=claim.claim_id,
            hostname=claim.hostname,
            status=status,
            challenge_name=claim.challenge_name,
            challenge_value=claim.challenge_value,
            expires_at=expires_at,
            project_id=project_id,
            tls_status=tls,
        )

    def list_for_project(self, *, tenant_id: str, project_id: str) -> list[dict[str, Any]]:
        if self._local is None:
            return []
        out: list[dict[str, Any]] = []
        for claim in self._local.repository.custom_by_host.values():
            if claim.tenant_id == tenant_id and claim.project_id == project_id:
                out.append(self._claim_view(claim, project_id=project_id).as_dict())
        return out

    def claim(
        self,
        *,
        tenant_id: str,
        subject: str,
        project_id: str,
        hostname: str,
    ) -> dict[str, Any]:
        if self._remote_url and self._service_token and self.mode == "live":
            return self._remote_claim(project_id=project_id, hostname=hostname)
        assert self._local is not None
        actor = self._actor(tenant_id=tenant_id, subject=subject)
        claim = self._local.claim_custom_domain(
            actor=actor, project_id=project_id, hostname=hostname
        )
        return self._claim_view(claim, project_id=project_id).as_dict()

    def verify(
        self,
        *,
        tenant_id: str,
        subject: str,
        hostname: str,
        seed_txt: bool = False,
    ) -> dict[str, Any]:
        if self._remote_url and self._service_token and self.mode == "live":
            return self._remote_verify(hostname=hostname)
        assert self._local is not None
        actor = self._actor(tenant_id=tenant_id, subject=subject)
        claim = self._local.repository.custom_by_host.get(hostname.lower())
        if claim is None:
            raise LookupError("domain claim was not found")
        if seed_txt and self.mode == "live" and self._resolver is not None:
            self._resolver.set_txt(claim.challenge_name, claim.challenge_value)
        verified = self._local.verify_custom_domain(actor=actor, hostname=hostname)
        return self._claim_view(verified, project_id=verified.project_id).as_dict()

    def _remote_claim(self, *, project_id: str, hostname: str) -> dict[str, Any]:
        return self._http_json(
            "POST",
            "/custom-domains",
            {"project_id": project_id, "hostname": hostname},
        )

    def _remote_verify(self, *, hostname: str) -> dict[str, Any]:
        return self._http_json("POST", f"/custom-domains/{hostname}/verify", {})

    def _http_json(self, method: str, path: str, body: dict[str, Any]) -> dict[str, Any]:
        url = urljoin(self._remote_url.rstrip("/") + "/", path.lstrip("/"))
        request = urllib.request.Request(  # noqa: S310
            url,
            data=json.dumps(body).encode("utf-8") if body is not None else None,
            method=method,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._service_token}",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"domains service HTTP {error.code}: {detail}") from error


def meter_custom_domain_month(
    *,
    usage_url: str | None,
    identity_token: str,
    project_id: str,
    hostname: str,
) -> dict[str, Any] | None:
    """Post ``kind=custom_domain_months`` when the usage bridge is configured."""
    url = (usage_url or os.environ.get("LOOPIT_USAGE_URL") or "").strip()
    if not url:
        return None
    body = {
        "idempotencyKey": f"domain:{project_id}:{hostname}:{datetime.now(UTC).strftime('%Y-%m')}",
        "kind": "custom_domain_months",
        "customDomainMonths": 1,
        "runId": f"domain-{project_id}",
    }
    request = urllib.request.Request(  # noqa: S310
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {identity_token}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8"))
    except Exception as error:
        LOGGER.warning("custom domain metering failed: %s", error)
        return {"error": str(error)}


def domains_from_env() -> ProjectDomains:
    remote = (os.environ.get("LOOPIT_DOMAINS_URL") or "").strip()
    mode = (os.environ.get("LOOPIT_DOMAINS_MODE") or ("live" if remote else "fake")).strip().lower()
    return ProjectDomains(mode=mode)
