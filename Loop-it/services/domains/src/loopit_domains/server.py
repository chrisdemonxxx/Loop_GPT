from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException
from loopit_agent_core.audit import AuditSink, InMemoryAuditSink
from loopit_agent_core.config import SecretConfigurationError, require_secret
from loopit_auth import Actor
from loopit_store import PostgresAppendOnlyAuditSink
from loopit_store.postgres import connect
from loopit_telemetry import add_loopit_telemetry, configure_telemetry
from pydantic import BaseModel

from .dns import (
    CloudflareDnsProvider,
    DnsProvider,
    DohPublicDnsResolver,
    InMemoryDnsProvider,
    PublicDnsResolver,
)
from .errors import AuthorizationDenied, CertificateUnavailable, DomainError, VerificationFailed
from .models import CertificateStatus, CustomDomainClaim, HostedRoute, ProjectSubdomain
from .registrar import DomainRegistrar, FakeDomainRegistrar, RefusingDomainRegistrar
from .service import BillingClient, DomainService, InMemoryDomainRepository, NoopBillingClient
from .tls import (
    AcmeCertificateAuthority,
    CertificateAuthority,
    FakeCertificateAuthority,
    RefusingCertificateAuthority,
)


@dataclass(frozen=True, slots=True)
class ServerSettings:
    host: str = "127.0.0.1"
    port: int = 8008
    apps_base_domain: str = "loopit.app"
    app_proxy_target: str = "app-proxy"
    dns_provider: str = "cloudflare"
    public_resolver: str = "doh"
    certificate_provider: str = "disabled"
    registrar_provider: str = "disabled"
    audit_provider: str = "postgres"
    audit_dsn: str = ""
    billing_url: str = ""
    purchase_attempts_db: str = ""
    platform_hostnames: frozenset[str] = frozenset()
    brand_denylist: frozenset[str] = frozenset()
    service_token: str = ""

    @classmethod
    def from_env(cls) -> ServerSettings:
        return cls(
            host=os.environ.get("LOOPIT_DOMAINS_HOST", "127.0.0.1"),
            port=int(os.environ.get("LOOPIT_DOMAINS_PORT", os.environ.get("PORT", "8008"))),
            apps_base_domain=os.environ.get("LOOPIT_APPS_BASE_DOMAIN", "loopit.app"),
            app_proxy_target=os.environ.get("LOOPIT_APP_PROXY_DNS_TARGET", "app-proxy"),
            dns_provider=os.environ.get("LOOPIT_DOMAINS_DNS_PROVIDER", "cloudflare"),
            public_resolver=os.environ.get("LOOPIT_DOMAINS_PUBLIC_RESOLVER", "doh"),
            certificate_provider=os.environ.get("LOOPIT_DOMAINS_CERTIFICATE_PROVIDER", "disabled"),
            registrar_provider=os.environ.get("LOOPIT_DOMAINS_REGISTRAR_PROVIDER", "disabled"),
            audit_provider=os.environ.get("LOOPIT_DOMAINS_AUDIT_PROVIDER", "postgres"),
            audit_dsn=_audit_dsn_from_env(),
            billing_url=os.environ.get("LOOPIT_BILLING_URL", ""),
            purchase_attempts_db=os.environ.get("LOOPIT_DOMAINS_PURCHASE_ATTEMPTS_DB", ""),
            platform_hostnames=_split_hostnames(os.environ.get("LOOPIT_PLATFORM_HOSTNAMES", "")),
            brand_denylist=_split_hostnames(os.environ.get("LOOPIT_SUBDOMAIN_BRAND_DENYLIST", "")),
            service_token=require_secret(os.environ, "LOOPIT_SERVICE_TOKEN"),
        )


class SubdomainRequest(BaseModel):
    requested_label: str | None = None


class LabelRequest(BaseModel):
    requested_label: str


class RetireLabelRequest(BaseModel):
    label: str
    reason: str


class SeizeLabelRequest(BaseModel):
    label: str
    tenant_id: str
    org_id: str
    project_id: str
    reason: str


class CustomDomainRequest(BaseModel):
    project_id: str
    hostname: str


class PurchaseRequest(BaseModel):
    hostname: str
    idempotency_key: str
    term_years: int = 1
    auto_renew: bool = True


class ServiceSubdomainRequest(BaseModel):
    tenant_id: str
    org_id: str | None = None
    requested_label: str | None = None


class BackendRegistrationRequest(BaseModel):
    project_id: str
    backend_host: str
    backend_port: int
    checkpoint_id: str = ""
    release_id: str = ""
    serving_status: str = "active"
    refusal_reason: str = ""


class ClaimResponse(BaseModel):
    claim_id: str
    hostname: str
    status: str
    challenge_name: str
    challenge_value: str
    expires_at: datetime


class RouteResponse(BaseModel):
    hostname: str
    tenant_id: str
    org_id: str
    project_id: str
    kind: str
    certificate_status: CertificateStatus
    certificate_expires_at: datetime | None
    backend_host: str
    backend_port: int
    serving_status: str
    refusal_reason: str = ""


class QuoteResponse(BaseModel):
    hostname: str
    available: bool
    price_usd: Decimal
    term_years: int


class PurchaseResponse(BaseModel):
    purchase_id: str
    tenant_id: str
    hostname: str
    term_years: int
    auto_renew: bool


def create_app(
    *, settings: ServerSettings | None = None, service: DomainService | None = None
) -> FastAPI:
    resolved = settings or ServerSettings.from_env()
    configure_telemetry("domains")
    app = FastAPI(title="loopit-domains")
    add_loopit_telemetry(app, "domains")
    app.state.settings = resolved
    app.state.service = service or _service_from_settings(resolved)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/projects/{project_id}/subdomain")
    def allocate_subdomain(
        project_id: str,
        payload: SubdomainRequest,
        actor: ActorDependency,
    ) -> dict[str, str]:
        try:
            record = app.state.service.allocate_subdomain(
                actor=actor, project_id=project_id, requested_label=payload.requested_label
            )
        except (DomainError, RuntimeError) as exc:
            raise _http_error(exc) from exc
        return _subdomain_payload(record)

    @app.post("/projects/{project_id}/subdomain-label")
    def claim_subdomain_label(
        project_id: str,
        payload: LabelRequest,
        actor: ActorDependency,
    ) -> dict[str, str]:
        try:
            record = app.state.service.claim_subdomain_label(
                actor=actor, project_id=project_id, requested_label=payload.requested_label
            )
        except (DomainError, RuntimeError) as exc:
            raise _http_error(exc) from exc
        return _subdomain_payload(record)

    @app.post("/projects/{project_id}/subdomain/rename")
    def rename_subdomain(
        project_id: str,
        payload: LabelRequest,
        actor: ActorDependency,
    ) -> dict[str, str]:
        try:
            record = app.state.service.rename_subdomain(
                actor=actor, project_id=project_id, requested_label=payload.requested_label
            )
        except (DomainError, RuntimeError) as exc:
            raise _http_error(exc) from exc
        return _subdomain_payload(record)

    @app.delete("/projects/{project_id}/subdomain")
    def release_subdomain(project_id: str, actor: ActorDependency) -> dict[str, str]:
        try:
            record = app.state.service.release_subdomain(actor=actor, project_id=project_id)
        except (DomainError, RuntimeError) as exc:
            raise _http_error(exc) from exc
        return _subdomain_payload(record)

    @app.post("/operator/subdomains/retire")
    def retire_subdomain_label(
        payload: RetireLabelRequest, actor: ActorDependency
    ) -> dict[str, str]:
        try:
            record = app.state.service.retire_subdomain_label(
                actor=actor, label=payload.label, reason=payload.reason
            )
        except DomainError as exc:
            raise _http_error(exc) from exc
        return _subdomain_payload(record)

    @app.post("/operator/subdomains/seize")
    def seize_subdomain_label(payload: SeizeLabelRequest, actor: ActorDependency) -> dict[str, str]:
        try:
            record = app.state.service.seize_subdomain_label(
                actor=actor,
                tenant_id=payload.tenant_id,
                org_id=payload.org_id,
                project_id=payload.project_id,
                label=payload.label,
                reason=payload.reason,
            )
        except DomainError as exc:
            raise _http_error(exc) from exc
        return _subdomain_payload(record)

    @app.post("/custom-domains", response_model=ClaimResponse)
    def claim_custom_domain(payload: CustomDomainRequest, actor: ActorDependency) -> ClaimResponse:
        try:
            claim = app.state.service.claim_custom_domain(
                actor=actor, project_id=payload.project_id, hostname=payload.hostname
            )
        except DomainError as exc:
            raise _http_error(exc) from exc
        return _claim_payload(claim)

    @app.post("/custom-domains/{hostname}/verify", response_model=ClaimResponse)
    def verify_custom_domain(hostname: str, actor: ActorDependency) -> ClaimResponse:
        try:
            claim = app.state.service.verify_custom_domain(actor=actor, hostname=hostname)
        except DomainError as exc:
            raise _http_error(exc) from exc
        return _claim_payload(claim)

    @app.post("/certificates/renew-due")
    def renew_due() -> dict[str, int]:
        renewed = app.state.service.renew_due_certificates(now=datetime.now(UTC))
        return {"renewed": len(renewed)}

    @app.get("/routes/{hostname}", response_model=RouteResponse)
    def route_for_host(
        hostname: str,
        x_loopit_service_token: Annotated[str | None, Header()] = None,
    ) -> RouteResponse:
        _require_service_token(x_loopit_service_token, settings=resolved)
        try:
            return _route_payload(app.state.service.route_for_host(hostname))
        except DomainError as exc:
            raise HTTPException(status_code=404, detail="route not found") from exc

    @app.post("/internal/projects/{project_id}/subdomain")
    def ensure_project_subdomain(
        project_id: str,
        payload: ServiceSubdomainRequest,
        x_loopit_service_token: Annotated[str | None, Header()] = None,
    ) -> dict[str, str]:
        _require_service_token(x_loopit_service_token, settings=resolved)
        try:
            record = app.state.service.allocate_subdomain(
                actor=_service_actor(payload.tenant_id, payload.org_id),
                project_id=project_id,
                requested_label=payload.requested_label,
            )
        except DomainError as exc:
            raise _http_error(exc) from exc
        return _subdomain_payload(record)

    @app.get("/internal/projects/{project_id}/subdomain")
    def project_subdomain(
        project_id: str,
        x_loopit_service_token: Annotated[str | None, Header()] = None,
    ) -> dict[str, str]:
        _require_service_token(x_loopit_service_token, settings=resolved)
        try:
            record = app.state.service.hostname_for_project(project_id)
        except DomainError as exc:
            raise HTTPException(status_code=404, detail="route not found") from exc
        return _subdomain_payload(record)

    @app.post("/routes/{hostname}/backend")
    def register_backend(
        hostname: str,
        payload: BackendRegistrationRequest,
        x_loopit_service_token: Annotated[str | None, Header()] = None,
    ) -> dict[str, str | int]:
        _require_service_token(x_loopit_service_token, settings=resolved)
        try:
            backend = app.state.service.register_backend_for_host(
                hostname=hostname,
                project_id=payload.project_id,
                host=payload.backend_host,
                port=payload.backend_port,
                checkpoint_id=payload.checkpoint_id,
                release_id=payload.release_id,
                serving_status=payload.serving_status,
                refusal_reason=payload.refusal_reason,
            )
        except DomainError as exc:
            raise _http_error(exc) from exc
        return {
            "tenant_id": backend.tenant_id,
            "project_id": backend.project_id,
            "backend_host": backend.host,
            "backend_port": backend.port,
        }

    @app.delete("/projects/{project_id}/backend")
    def clear_backend(project_id: str, actor: ActorDependency) -> dict[str, str | int]:
        try:
            backend = app.state.service.clear_backend_for_project(
                actor=actor, project_id=project_id
            )
        except DomainError as exc:
            raise _http_error(exc) from exc
        return {
            "tenant_id": backend.tenant_id,
            "project_id": backend.project_id,
            "backend_host": backend.host,
            "backend_port": backend.port,
        }

    @app.get("/registrar/search/{hostname}")
    def search_domain(hostname: str, actor: ActorDependency) -> dict[str, bool | str]:
        try:
            available = app.state.service.search_domain(actor=actor, hostname=hostname)
        except DomainError as exc:
            raise _http_error(exc) from exc
        return {"hostname": hostname.lower().rstrip("."), "available": available}

    @app.get("/registrar/quote/{hostname}", response_model=QuoteResponse)
    def quote_domain(hostname: str, actor: ActorDependency, term_years: int = 1) -> QuoteResponse:
        try:
            quote = app.state.service.quote_domain(
                actor=actor, hostname=hostname, term_years=term_years
            )
        except DomainError as exc:
            raise _http_error(exc) from exc
        return QuoteResponse(
            hostname=quote.domain,
            available=quote.available,
            price_usd=quote.price_usd,
            term_years=quote.term_years,
        )

    @app.post("/registrar/purchases", response_model=PurchaseResponse)
    def purchase_domain(payload: PurchaseRequest, actor: ActorDependency) -> PurchaseResponse:
        try:
            purchase = app.state.service.purchase_domain(
                actor=actor,
                hostname=payload.hostname,
                idempotency_key=payload.idempotency_key,
                term_years=payload.term_years,
                auto_renew=payload.auto_renew,
            )
        except (DomainError, RuntimeError, ValueError) as exc:
            raise _http_error(exc) from exc
        return PurchaseResponse(
            purchase_id=purchase.purchase_id,
            tenant_id=purchase.tenant_id,
            hostname=purchase.domain,
            term_years=purchase.term_years,
            auto_renew=purchase.auto_renew,
        )

    return app


def _service_from_settings(settings: ServerSettings) -> DomainService:
    fake_providers_allowed = _env_bool("LOOPIT_DOMAINS_ALLOW_FAKE_PROVIDERS")
    billing = _billing_from_settings(settings, fake_providers_allowed=fake_providers_allowed)
    if settings.dns_provider == "cloudflare":
        dns: DnsProvider = CloudflareDnsProvider(
            api_token=require_secret(os.environ, "CLOUDFLARE_API_TOKEN"),
            account_id=require_secret(os.environ, "CLOUDFLARE_ACCOUNT_ID", min_length=1),
        )
    elif settings.dns_provider == "memory" and fake_providers_allowed:
        dns = InMemoryDnsProvider()
    else:
        raise RuntimeError(
            "LOOPIT_DOMAINS_DNS_PROVIDER must be 'cloudflare'; 'memory' requires "
            "LOOPIT_DOMAINS_ALLOW_FAKE_PROVIDERS=1"
        )
    if settings.public_resolver == "doh":
        public_resolver: PublicDnsResolver = DohPublicDnsResolver()
    elif settings.public_resolver == "memory" and fake_providers_allowed:
        from .dns import InMemoryPublicDnsResolver

        public_resolver = InMemoryPublicDnsResolver()
    else:
        raise RuntimeError(
            "LOOPIT_DOMAINS_PUBLIC_RESOLVER must be 'doh'; 'memory' requires "
            "LOOPIT_DOMAINS_ALLOW_FAKE_PROVIDERS=1"
        )
    if settings.certificate_provider == "disabled":
        certificates: CertificateAuthority = RefusingCertificateAuthority()
    elif settings.certificate_provider == "acme":
        certificates = AcmeCertificateAuthority()
    elif settings.certificate_provider == "fake" and fake_providers_allowed:
        certificates = FakeCertificateAuthority()
    else:
        raise RuntimeError(
            "LOOPIT_DOMAINS_CERTIFICATE_PROVIDER must be 'disabled' or 'acme'; "
            "'fake' requires LOOPIT_DOMAINS_ALLOW_FAKE_PROVIDERS=1"
        )
    if settings.registrar_provider == "disabled":
        registrar: DomainRegistrar = RefusingDomainRegistrar()
    elif settings.registrar_provider == "fake" and fake_providers_allowed:
        registrar = FakeDomainRegistrar()
    else:
        raise RuntimeError(
            "domain registrar provider is not implemented; use "
            "LOOPIT_DOMAINS_REGISTRAR_PROVIDER=disabled or "
            "LOOPIT_DOMAINS_ALLOW_FAKE_PROVIDERS=1"
        )
    audit = _audit_sink(settings)
    repository = _repository_from_settings(settings, fake_providers_allowed=fake_providers_allowed)
    return DomainService(
        base_domain=settings.apps_base_domain,
        app_proxy_target=settings.app_proxy_target,
        dns=dns,
        certificates=certificates,
        public_resolver=public_resolver,
        registrar=registrar,
        audit=audit,
        billing=billing,
        repository=repository,
        platform_hostnames=settings.platform_hostnames,
        brand_denylist=settings.brand_denylist,
    )


def _repository_from_settings(
    settings: ServerSettings, *, fake_providers_allowed: bool
) -> InMemoryDomainRepository:
    # Registrar can be disabled while app-proxy still depends on durable route ownership.
    if settings.purchase_attempts_db:
        from .service import SqliteDomainRepository

        return SqliteDomainRepository(settings.purchase_attempts_db)
    if fake_providers_allowed:
        return InMemoryDomainRepository()
    raise RuntimeError(
        "LOOPIT_DOMAINS_PURCHASE_ATTEMPTS_DB is required for durable domain routing state"
    )


def _billing_from_settings(
    settings: ServerSettings, *, fake_providers_allowed: bool
) -> BillingClient:
    if settings.billing_url and settings.service_token:
        return HttpBillingClient(
            base_url=settings.billing_url, service_token=settings.service_token
        )
    if fake_providers_allowed:
        return NoopBillingClient()
    if not settings.billing_url:
        raise RuntimeError("LOOPIT_BILLING_URL is required for production domain billing")
    raise RuntimeError("LOOPIT_SERVICE_TOKEN is required for production domain billing")


class HttpBillingClient:
    def __init__(self, *, base_url: str, service_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_token = service_token
        if not self._base_url:
            raise RuntimeError("LOOPIT_BILLING_URL is required for production domain billing")
        if not self._service_token:
            raise RuntimeError("LOOPIT_SERVICE_TOKEN is required for production domain billing")

    def reserve_custom_domain(
        self, *, tenant_id: str, project_id: str, hostname: str, idempotency_key: str
    ) -> None:
        _ = (project_id, hostname)
        self._post(
            "/v1/billing/reservations",
            {
                "tenant_id": tenant_id,
                "estimated_cost": "0",
                "idempotency_key": idempotency_key,
                "quota_request": {"custom_domains": 1},
            },
        )

    def reserve_domain_registration(
        self,
        *,
        tenant_id: str,
        hostname: str,
        estimated_cost: Decimal,
        idempotency_key: str,
    ) -> None:
        _ = hostname
        self._post(
            "/v1/billing/reservations",
            {
                "tenant_id": tenant_id,
                "estimated_cost": str(estimated_cost),
                "idempotency_key": idempotency_key,
                "quota_request": {},
            },
        )

    def meter_domain_registration(
        self,
        *,
        tenant_id: str,
        hostname: str,
        registrar_cost: Decimal,
        idempotency_key: str,
    ) -> None:
        _ = hostname
        self._post(
            "/v1/billing/meter",
            {
                "tenant_id": tenant_id,
                "idempotency_key": idempotency_key,
                "kind": "domain_registration",
                "registrar_cost_credits": str(registrar_cost),
            },
        )

    def _post(self, path: str, payload: dict[str, object]) -> None:
        import httpx

        response = httpx.post(
            f"{self._base_url}{path}",
            headers={"X-Loopit-Service-Token": self._service_token},
            json=payload,
            timeout=10,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"billing rejected domain preflight: {response.text}")


def _audit_sink(settings: ServerSettings) -> AuditSink:
    if settings.audit_provider == "postgres":
        return PostgresAppendOnlyAuditSink(connect(settings.audit_dsn))
    if settings.audit_provider == "memory" and _env_bool("LOOPIT_DOMAINS_ALLOW_FAKE_PROVIDERS"):
        return InMemoryAuditSink()
    raise RuntimeError(
        "LOOPIT_DOMAINS_AUDIT_PROVIDER must be 'postgres'; 'memory' requires "
        "LOOPIT_DOMAINS_ALLOW_FAKE_PROVIDERS=1"
    )


def _audit_dsn_from_env() -> str:
    try:
        return require_secret(os.environ, "LOOPIT_AUDIT_DSN", min_length=1)
    except SecretConfigurationError:
        if os.environ.get("LOOPIT_DOMAINS_AUDIT_PROVIDER") == "memory" and _env_bool(
            "LOOPIT_DOMAINS_ALLOW_FAKE_PROVIDERS"
        ):
            return ""
        raise


def _env_bool(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _actor_from_headers(
    x_loopit_subject: Annotated[str | None, Header()] = None,
    x_loopit_tenant: Annotated[str | None, Header()] = None,
    x_loopit_org: Annotated[str | None, Header()] = None,
    x_loopit_role: Annotated[str | None, Header()] = None,
    x_loopit_scopes: Annotated[str | None, Header()] = None,
) -> Actor:
    if not x_loopit_subject or not x_loopit_tenant or not x_loopit_org or not x_loopit_role:
        raise HTTPException(status_code=401, detail="missing actor headers")
    scopes = frozenset(scope for scope in (x_loopit_scopes or "").split() if scope)
    if x_loopit_role not in {"owner", "admin", "member", "viewer"}:
        raise HTTPException(status_code=401, detail="invalid actor role")
    return Actor(
        subject=x_loopit_subject,
        tenant_id=x_loopit_tenant,
        org_id=x_loopit_org,
        role=x_loopit_role,  # type: ignore[arg-type]
        scopes=scopes,
    )


ActorDependency = Annotated[Actor, Depends(_actor_from_headers)]


def _require_service_token(token: str | None, *, settings: ServerSettings) -> None:
    if (
        not settings.service_token
        or token is None
        or not secrets.compare_digest(token, settings.service_token)
    ):
        raise HTTPException(status_code=401, detail="service authentication required")


def _service_actor(tenant_id: str, org_id: str | None = None) -> Actor:
    return Actor(
        subject="deployer",
        tenant_id=tenant_id,
        org_id=org_id or tenant_id,
        role="admin",
        scopes=frozenset({"domains:write"}),
    )


def _subdomain_payload(record: ProjectSubdomain) -> dict[str, str]:
    return {"hostname": record.hostname, "label": record.label, "status": record.status}


def _claim_payload(claim: CustomDomainClaim) -> ClaimResponse:
    return ClaimResponse(
        claim_id=claim.claim_id,
        hostname=claim.hostname,
        status=claim.status,
        challenge_name=claim.challenge_name,
        challenge_value=claim.challenge_value,
        expires_at=claim.expires_at,
    )


def _route_payload(route: HostedRoute) -> RouteResponse:
    return RouteResponse(
        hostname=route.hostname,
        tenant_id=route.tenant_id,
        org_id=route.org_id,
        project_id=route.project_id,
        kind=route.kind,
        certificate_status=route.certificate_status,
        certificate_expires_at=route.certificate_expires_at,
        backend_host=route.backend.host,
        backend_port=route.backend.port,
        serving_status=route.backend.serving_status,
        refusal_reason=route.backend.refusal_reason,
    )


def _http_error(exc: DomainError | RuntimeError | ValueError) -> HTTPException:
    if isinstance(exc, AuthorizationDenied):
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, VerificationFailed):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, CertificateUnavailable):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=409, detail=str(exc))


def _split_hostnames(raw: str) -> frozenset[str]:
    return frozenset(host.strip().lower().rstrip(".") for host in raw.split(",") if host.strip())


def main() -> None:
    settings = ServerSettings.from_env()
    uvicorn.run(
        "loopit_domains.server:create_app", host=settings.host, port=settings.port, factory=True
    )
