"""Safe domain ownership and serving decisions.

The central rule is that a hostname is never served just because it points at
Loop-it. A project that gives no naming input gets an opaque, unguessable
subdomain immediately; a project that asks for a readable label gets one only
after abuse-oriented validation. Custom domains move through an expiring
ownership challenge before route lookup exposes them to the edge. Certificate
state is checked on every lookup so an expired certificate cannot silently
continue serving.

Readable labels use conservative ASCII and deny security/brand substrings. The
service intentionally does not yet reject visual confusables against the full
existing-name index (for example ``rn`` versus ``m``): that needs a reviewed
normalisation table and appeal path, while ASCII-only plus punycode rejection
blocks the highest-risk homograph class without false positives.
"""

from __future__ import annotations

import json
import re
import secrets
import sqlite3
import threading
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Protocol, runtime_checkable

from loopit_agent_core.audit import AuditEvent, AuditSink
from loopit_auth import Actor

from .dns import DnsProvider, InMemoryPublicDnsResolver, PublicDnsResolver
from .errors import (
    AuthorizationDenied,
    CertificateUnavailable,
    DomainConflict,
    InvalidDomain,
    ReservedName,
    VerificationFailed,
)
from .models import (
    CertificateRecord,
    CertificateStatus,
    CustomDomainClaim,
    DomainStatus,
    HostedRoute,
    ProjectBackend,
    ProjectSubdomain,
)
from .registrar import (
    DomainPurchase,
    DomainPurchaseAttempt,
    DomainQuote,
    DomainRegistrar,
    FakeDomainRegistrar,
    PurchaseAttemptStatus,
)
from .tls import CertificateAuthority

LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
RESERVED_LABELS = frozenset({"www", "api", "admin", "mail", "preview", "status"})
SECURITY_DENYLIST_TERMS = frozenset(
    {"login", "signin", "secure", "account", "billing", "verify", "support", "wallet", "admin"}
)
MUTATING_ROLES = frozenset({"owner", "admin"})
OPERATOR_SCOPE = "domains:operator"


@runtime_checkable
class BillingClient(Protocol):
    """Pre-spend quota and metering contract used before irreversible domain work."""

    def reserve_custom_domain(
        self, *, tenant_id: str, project_id: str, hostname: str, idempotency_key: str
    ) -> None: ...

    def reserve_domain_registration(
        self,
        *,
        tenant_id: str,
        hostname: str,
        estimated_cost: Decimal,
        idempotency_key: str,
    ) -> None: ...

    def meter_domain_registration(
        self,
        *,
        tenant_id: str,
        hostname: str,
        registrar_cost: Decimal,
        idempotency_key: str,
    ) -> None: ...


class NoopBillingClient:
    """Test/development billing seam; production wiring should supply an HTTP client."""

    def reserve_custom_domain(
        self, *, tenant_id: str, project_id: str, hostname: str, idempotency_key: str
    ) -> None:
        _ = (tenant_id, project_id, hostname, idempotency_key)

    def reserve_domain_registration(
        self,
        *,
        tenant_id: str,
        hostname: str,
        estimated_cost: Decimal,
        idempotency_key: str,
    ) -> None:
        _ = (tenant_id, hostname, estimated_cost, idempotency_key)

    def meter_domain_registration(
        self,
        *,
        tenant_id: str,
        hostname: str,
        registrar_cost: Decimal,
        idempotency_key: str,
    ) -> None:
        _ = (tenant_id, hostname, registrar_cost, idempotency_key)


class InMemoryDomainRepository:
    """Domain state seam until packages/store grows persistent domain tables."""

    def __init__(self) -> None:
        self.subdomains_by_project: dict[tuple[str, str], ProjectSubdomain] = {}
        self.subdomains_by_label: dict[str, ProjectSubdomain] = {}
        self.custom_by_host: dict[str, CustomDomainClaim] = {}
        self.certificates: dict[str, CertificateRecord] = {}
        self.backends_by_project: dict[tuple[str, str], ProjectBackend] = {}
        self.purchase_attempts: dict[tuple[str, str], DomainPurchaseAttempt] = {}
        self.dns_records_by_host: dict[str, str] = {}
        self.lock = threading.RLock()

    def save_subdomain(self, record: ProjectSubdomain) -> None:
        self.subdomains_by_project[(record.tenant_id, record.project_id)] = record
        self.subdomains_by_label[record.label] = record

    def save_custom(self, claim: CustomDomainClaim) -> None:
        self.custom_by_host[claim.hostname] = claim

    def save_certificate(self, certificate: CertificateRecord) -> None:
        self.certificates[certificate.certificate_id] = certificate

    def save_backend(self, backend: ProjectBackend) -> None:
        self.backends_by_project[(backend.tenant_id, backend.project_id)] = backend

    def delete_backend(self, *, tenant_id: str, project_id: str) -> ProjectBackend | None:
        return self.backends_by_project.pop((tenant_id, project_id), None)

    def save_dns_record(self, *, hostname: str, record_id: str) -> None:
        self.dns_records_by_host[hostname] = record_id

    def delete_dns_record(self, *, hostname: str) -> str | None:
        return self.dns_records_by_host.pop(hostname, None)

    def save_purchase_attempt(self, attempt: DomainPurchaseAttempt) -> None:
        self.purchase_attempts[(attempt.tenant_id, attempt.idempotency_key)] = attempt

    def certificate_for_host(self, hostname: str, now: datetime) -> CertificateRecord | None:
        normalized = hostname.lower()
        best: CertificateRecord | None = None
        for certificate in self.certificates.values():
            if _covers(certificate, normalized) and _not_failed(certificate):
                if certificate.expires_at is not None and certificate.expires_at <= now:
                    expired = replace(certificate, status=CertificateStatus.EXPIRED)
                    self.save_certificate(expired)
                    continue
                best = certificate
                break
        return best


class SqliteDomainRepository(InMemoryDomainRepository):
    """Repository variant that persists routing authority state to SQLite."""

    def __init__(self, path: str) -> None:
        super().__init__()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS domain_subdomains (
                label TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                org_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                hostname TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                released_at TEXT,
                quarantine_until TEXT
            );
            CREATE TABLE IF NOT EXISTS domain_custom_claims (
                hostname TEXT PRIMARY KEY,
                claim_id TEXT NOT NULL,
                tenant_id TEXT NOT NULL,
                org_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                status TEXT NOT NULL,
                challenge_name TEXT NOT NULL,
                challenge_value TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                verified_at TEXT
            );
            CREATE TABLE IF NOT EXISTS domain_certificates (
                certificate_id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                hostnames_json TEXT NOT NULL,
                status TEXT NOT NULL,
                challenge_type TEXT NOT NULL,
                issued_at TEXT,
                expires_at TEXT,
                last_error TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS domain_backends (
                tenant_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                checkpoint_id TEXT NOT NULL DEFAULT '',
                release_id TEXT NOT NULL DEFAULT '',
                serving_status TEXT NOT NULL,
                refusal_reason TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (tenant_id, project_id)
            );
            CREATE TABLE IF NOT EXISTS domain_dns_records (
                hostname TEXT PRIMARY KEY,
                record_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS domain_purchase_attempts (
                tenant_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                domain TEXT NOT NULL,
                term_years INTEGER NOT NULL,
                auto_renew INTEGER NOT NULL,
                status TEXT NOT NULL,
                purchase_id TEXT,
                error TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (tenant_id, idempotency_key)
            );
            """
        )
        self._db.commit()
        self._load_routing_state()
        self._load_purchase_attempts()

    def save_subdomain(self, record: ProjectSubdomain) -> None:
        super().save_subdomain(record)
        self._db.execute(
            """
            INSERT INTO domain_subdomains (
                label, tenant_id, org_id, project_id, hostname, status, created_at,
                released_at, quarantine_until
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(label) DO UPDATE SET
                tenant_id = excluded.tenant_id,
                org_id = excluded.org_id,
                project_id = excluded.project_id,
                hostname = excluded.hostname,
                status = excluded.status,
                created_at = excluded.created_at,
                released_at = excluded.released_at,
                quarantine_until = excluded.quarantine_until
            """,
            (
                record.label,
                record.tenant_id,
                record.org_id,
                record.project_id,
                record.hostname,
                record.status.value,
                _format_datetime(record.created_at),
                _format_datetime(record.released_at),
                _format_datetime(record.quarantine_until),
            ),
        )
        self._db.commit()

    def save_custom(self, claim: CustomDomainClaim) -> None:
        super().save_custom(claim)
        self._db.execute(
            """
            INSERT INTO domain_custom_claims (
                hostname, claim_id, tenant_id, org_id, project_id, status, challenge_name,
                challenge_value, expires_at, created_at, verified_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(hostname) DO UPDATE SET
                claim_id = excluded.claim_id,
                tenant_id = excluded.tenant_id,
                org_id = excluded.org_id,
                project_id = excluded.project_id,
                status = excluded.status,
                challenge_name = excluded.challenge_name,
                challenge_value = excluded.challenge_value,
                expires_at = excluded.expires_at,
                created_at = excluded.created_at,
                verified_at = excluded.verified_at
            """,
            (
                claim.hostname,
                claim.claim_id,
                claim.tenant_id,
                claim.org_id,
                claim.project_id,
                claim.status.value,
                claim.challenge_name,
                claim.challenge_value,
                _format_datetime(claim.expires_at),
                _format_datetime(claim.created_at),
                _format_datetime(claim.verified_at),
            ),
        )
        self._db.commit()

    def save_certificate(self, certificate: CertificateRecord) -> None:
        super().save_certificate(certificate)
        self._db.execute(
            """
            INSERT INTO domain_certificates (
                certificate_id, tenant_id, hostnames_json, status, challenge_type, issued_at,
                expires_at, last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(certificate_id) DO UPDATE SET
                tenant_id = excluded.tenant_id,
                hostnames_json = excluded.hostnames_json,
                status = excluded.status,
                challenge_type = excluded.challenge_type,
                issued_at = excluded.issued_at,
                expires_at = excluded.expires_at,
                last_error = excluded.last_error
            """,
            (
                certificate.certificate_id,
                certificate.tenant_id,
                json.dumps(certificate.hostnames),
                certificate.status.value,
                certificate.challenge_type,
                _format_datetime(certificate.issued_at),
                _format_datetime(certificate.expires_at),
                certificate.last_error,
            ),
        )
        self._db.commit()

    def save_backend(self, backend: ProjectBackend) -> None:
        super().save_backend(backend)
        self._db.execute(
            """
            INSERT INTO domain_backends (
                tenant_id, project_id, host, port, checkpoint_id, release_id, serving_status,
                refusal_reason, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, project_id) DO UPDATE SET
                host = excluded.host,
                port = excluded.port,
                checkpoint_id = excluded.checkpoint_id,
                release_id = excluded.release_id,
                serving_status = excluded.serving_status,
                refusal_reason = excluded.refusal_reason,
                updated_at = excluded.updated_at
            """,
            (
                backend.tenant_id,
                backend.project_id,
                backend.host,
                backend.port,
                backend.checkpoint_id,
                backend.release_id,
                backend.serving_status,
                backend.refusal_reason,
                _format_datetime(backend.updated_at),
            ),
        )
        self._db.commit()

    def delete_backend(self, *, tenant_id: str, project_id: str) -> ProjectBackend | None:
        removed = super().delete_backend(tenant_id=tenant_id, project_id=project_id)
        if removed is not None:
            self._db.execute(
                "DELETE FROM domain_backends WHERE tenant_id = ? AND project_id = ?",
                (tenant_id, project_id),
            )
            self._db.commit()
        return removed

    def save_dns_record(self, *, hostname: str, record_id: str) -> None:
        super().save_dns_record(hostname=hostname, record_id=record_id)
        self._db.execute(
            """
            INSERT INTO domain_dns_records (hostname, record_id)
            VALUES (?, ?)
            ON CONFLICT(hostname) DO UPDATE SET record_id = excluded.record_id
            """,
            (hostname, record_id),
        )
        self._db.commit()

    def delete_dns_record(self, *, hostname: str) -> str | None:
        record_id = super().delete_dns_record(hostname=hostname)
        if record_id is not None:
            self._db.execute("DELETE FROM domain_dns_records WHERE hostname = ?", (hostname,))
            self._db.commit()
        return record_id

    def save_purchase_attempt(self, attempt: DomainPurchaseAttempt) -> None:
        super().save_purchase_attempt(attempt)
        self._db.execute(
            """
            INSERT INTO domain_purchase_attempts (
                tenant_id, idempotency_key, domain, term_years, auto_renew, status,
                purchase_id, error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, idempotency_key) DO UPDATE SET
                domain = excluded.domain,
                term_years = excluded.term_years,
                auto_renew = excluded.auto_renew,
                status = excluded.status,
                purchase_id = excluded.purchase_id,
                error = excluded.error
            """,
            (
                attempt.tenant_id,
                attempt.idempotency_key,
                attempt.domain,
                attempt.term_years,
                int(attempt.auto_renew),
                attempt.status.value,
                attempt.purchase.purchase_id if attempt.purchase else None,
                attempt.error,
            ),
        )
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def _load_routing_state(self) -> None:
        self._load_subdomains()
        self._load_custom_claims()
        self._load_certificates()
        self._load_backends()
        self._load_dns_records()

    def _load_subdomains(self) -> None:
        rows = self._db.execute(
            """
            SELECT tenant_id, org_id, project_id, label, hostname, status, created_at,
                   released_at, quarantine_until
            FROM domain_subdomains
            ORDER BY created_at, COALESCE(released_at, '')
            """
        ).fetchall()
        for row in rows:
            tenant_id, org_id, project_id, label, hostname, status, created_at = row[:7]
            released_at, quarantine_until = row[7:]
            super().save_subdomain(
                ProjectSubdomain(
                    tenant_id=tenant_id,
                    org_id=org_id,
                    project_id=project_id,
                    label=label,
                    hostname=hostname,
                    status=DomainStatus(status),
                    created_at=_parse_datetime_required(created_at),
                    released_at=_parse_datetime(released_at),
                    quarantine_until=_parse_datetime(quarantine_until),
                )
            )

    def _load_custom_claims(self) -> None:
        rows = self._db.execute(
            """
            SELECT claim_id, tenant_id, org_id, project_id, hostname, status, challenge_name,
                   challenge_value, expires_at, created_at, verified_at
            FROM domain_custom_claims
            """
        ).fetchall()
        for row in rows:
            (
                claim_id,
                tenant_id,
                org_id,
                project_id,
                hostname,
                status,
                challenge_name,
                challenge_value,
                expires_at,
                created_at,
                verified_at,
            ) = row
            super().save_custom(
                CustomDomainClaim(
                    claim_id=claim_id,
                    tenant_id=tenant_id,
                    org_id=org_id,
                    project_id=project_id,
                    hostname=hostname,
                    status=DomainStatus(status),
                    challenge_name=challenge_name,
                    challenge_value=challenge_value,
                    expires_at=_parse_datetime_required(expires_at),
                    created_at=_parse_datetime_required(created_at),
                    verified_at=_parse_datetime(verified_at),
                )
            )

    def _load_certificates(self) -> None:
        rows = self._db.execute(
            """
            SELECT certificate_id, tenant_id, hostnames_json, status, challenge_type, issued_at,
                   expires_at, last_error
            FROM domain_certificates
            """
        ).fetchall()
        for row in rows:
            certificate_id, tenant_id, hostnames_json, status, challenge_type = row[:5]
            issued_at, expires_at, last_error = row[5:]
            hostnames = tuple(str(hostname) for hostname in json.loads(hostnames_json))
            super().save_certificate(
                CertificateRecord(
                    certificate_id=certificate_id,
                    tenant_id=tenant_id,
                    hostnames=hostnames,
                    status=CertificateStatus(status),
                    challenge_type=challenge_type,
                    issued_at=_parse_datetime(issued_at),
                    expires_at=_parse_datetime(expires_at),
                    last_error=last_error,
                )
            )

    def _load_backends(self) -> None:
        rows = self._db.execute(
            """
            SELECT tenant_id, project_id, host, port, checkpoint_id, release_id, serving_status,
                   refusal_reason, updated_at
            FROM domain_backends
            """
        ).fetchall()
        for row in rows:
            (
                tenant_id,
                project_id,
                host,
                port,
                checkpoint_id,
                release_id,
                serving_status,
                refusal_reason,
                updated_at,
            ) = row
            super().save_backend(
                ProjectBackend(
                    tenant_id=tenant_id,
                    project_id=project_id,
                    host=host,
                    port=port,
                    checkpoint_id=checkpoint_id,
                    release_id=release_id,
                    serving_status=serving_status,
                    refusal_reason=refusal_reason,
                    updated_at=_parse_datetime_required(updated_at),
                )
            )

    def _load_dns_records(self) -> None:
        rows = self._db.execute("SELECT hostname, record_id FROM domain_dns_records").fetchall()
        for hostname, record_id in rows:
            super().save_dns_record(hostname=hostname, record_id=record_id)

    def _load_purchase_attempts(self) -> None:
        rows = self._db.execute(
            """
            SELECT tenant_id, idempotency_key, domain, term_years, auto_renew, status,
                   purchase_id, error
            FROM domain_purchase_attempts
            """
        ).fetchall()
        for row in rows:
            tenant_id, key, domain, term_years, auto_renew, status, purchase_id, error = row
            purchase = (
                DomainPurchase(
                    purchase_id=purchase_id,
                    tenant_id=tenant_id,
                    domain=domain,
                    term_years=term_years,
                    auto_renew=bool(auto_renew),
                )
                if purchase_id
                else None
            )
            super().save_purchase_attempt(
                DomainPurchaseAttempt(
                    tenant_id=tenant_id,
                    domain=domain,
                    idempotency_key=key,
                    term_years=term_years,
                    auto_renew=bool(auto_renew),
                    status=PurchaseAttemptStatus(status),
                    purchase=purchase,
                    error=error,
                )
            )


def _format_datetime(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat()


def _parse_datetime(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


def _parse_datetime_required(value: str) -> datetime:
    parsed = _parse_datetime(value)
    if parsed is None:
        raise RuntimeError("stored domain timestamp is missing")
    return parsed


class DomainService:
    """Coordinates DNS, ownership verification, TLS state, tenancy, and audit."""

    def __init__(
        self,
        *,
        base_domain: str,
        app_proxy_target: str,
        dns: DnsProvider,
        certificates: CertificateAuthority,
        audit: AuditSink,
        public_resolver: PublicDnsResolver | None = None,
        billing: BillingClient | None = None,
        registrar: DomainRegistrar | None = None,
        repository: InMemoryDomainRepository | None = None,
        platform_hostnames: frozenset[str] = frozenset(),
        brand_denylist: frozenset[str] = frozenset(),
        quarantine_days: int = 30,
    ) -> None:
        self._base_domain = _normalize_hostname(base_domain)
        self._app_proxy_target = app_proxy_target.strip().lower().rstrip(".")
        self._dns = dns
        self._public_resolver = public_resolver or InMemoryPublicDnsResolver()
        self._certificates = certificates
        self._audit = audit
        self._billing = billing or NoopBillingClient()
        self._registrar = registrar or FakeDomainRegistrar()
        self._repo = repository or InMemoryDomainRepository()
        self._platform_hostnames = frozenset(
            {_normalize_hostname(hostname) for hostname in platform_hostnames}
            | {self._base_domain, f"www.{self._base_domain}", f"api.{self._base_domain}"}
        )
        self._reserved = RESERVED_LABELS | {
            hostname.split(".", maxsplit=1)[0] for hostname in self._platform_hostnames
        }
        self._denylist_terms = SECURITY_DENYLIST_TERMS | frozenset(
            term.strip().lower() for term in brand_denylist if term.strip()
        )
        self._quarantine = timedelta(days=quarantine_days)

    @property
    def repository(self) -> InMemoryDomainRepository:
        return self._repo

    @property
    def base_domain(self) -> str:
        return self._base_domain

    def allocate_subdomain(
        self,
        *,
        actor: Actor,
        project_id: str,
        requested_label: str | None = None,
        now: datetime | None = None,
    ) -> ProjectSubdomain:
        moment = _moment(now)
        self._require_mutation(actor)
        with self._repo.lock:
            existing = self._repo.subdomains_by_project.get((actor.tenant_id, project_id))
            if existing is not None and existing.status is DomainStatus.VERIFIED:
                return existing
            try:
                label = self._choose_label(requested_label, moment, actor, project_id)
            except (DomainConflict, InvalidDomain, ReservedName):
                if requested_label is None:
                    raise
                label = self._choose_label(None, moment, actor, project_id)
            record = self._activate_label(actor, project_id, label)
        self.ensure_wildcard_certificate(now=moment)
        self._emit(
            actor,
            "domains.subdomain.allocated",
            "success",
            project_id,
            {"host": record.hostname, "requested_label": requested_label or ""},
        )
        return record

    def claim_subdomain_label(
        self,
        *,
        actor: Actor,
        project_id: str,
        requested_label: str,
        now: datetime | None = None,
    ) -> ProjectSubdomain:
        """Strictly claim a readable label.

        This is the UI "try this name" path. It refuses unsafe or unavailable
        labels; callers that need zero-friction deployment should use
        allocate_subdomain, which falls back to an opaque label.
        """
        moment = _moment(now)
        self._require_mutation(actor)
        with self._repo.lock:
            label = self._choose_label(requested_label, moment, actor, project_id)
            existing = self._repo.subdomains_by_project.get((actor.tenant_id, project_id))
            if existing is not None and existing.status is DomainStatus.VERIFIED:
                if existing.label == label:
                    return existing
                self._release_record(existing, moment)
            record = self._activate_label(actor, project_id, label)
        self.ensure_wildcard_certificate(now=moment)
        self._emit(
            actor, "domains.subdomain.claimed", "success", project_id, {"host": record.hostname}
        )
        return record

    def rename_subdomain(
        self,
        *,
        actor: Actor,
        project_id: str,
        requested_label: str,
        now: datetime | None = None,
    ) -> ProjectSubdomain:
        moment = _moment(now)
        self._require_mutation(actor)
        with self._repo.lock:
            current = self._repo.subdomains_by_project.get((actor.tenant_id, project_id))
            if current is not None and current.status is DomainStatus.VERIFIED:
                self._release_record(current, moment)
            try:
                label = self._choose_label(requested_label, moment, actor, project_id)
            except (DomainConflict, InvalidDomain, ReservedName):
                label = self._choose_label(None, moment, actor, project_id)
            record = self._activate_label(actor, project_id, label)
        self.ensure_wildcard_certificate(now=moment)
        self._emit(
            actor,
            "domains.subdomain.renamed",
            "success",
            project_id,
            {"host": record.hostname, "requested_label": requested_label},
        )
        return record

    def release_subdomain(
        self, *, actor: Actor, project_id: str, now: datetime | None = None
    ) -> ProjectSubdomain:
        moment = _moment(now)
        self._require_mutation(actor)
        with self._repo.lock:
            record = self._repo.subdomains_by_project.get((actor.tenant_id, project_id))
            if record is None or record.status is not DomainStatus.VERIFIED:
                raise DomainConflict("project has no active subdomain")
            released = self._release_record(record, moment)
        self._emit(
            actor,
            "domains.subdomain.released",
            "success",
            project_id,
            {
                "host": record.hostname,
                "quarantine_until": (released.quarantine_until or moment).isoformat(),
            },
        )
        return released

    def retire_subdomain_label(
        self,
        *,
        actor: Actor,
        label: str,
        reason: str,
        now: datetime | None = None,
    ) -> ProjectSubdomain:
        moment = _moment(now)
        self._require_operator(actor)
        normalized = _normalize_label(label)
        with self._repo.lock:
            current = self._repo.subdomains_by_label.get(normalized)
            if current is not None and current.status is DomainStatus.VERIFIED:
                self._release_record(current, moment)
            retired = ProjectSubdomain(
                tenant_id="platform",
                org_id="platform",
                project_id="retired",
                label=normalized,
                hostname=f"{normalized}.{self._base_domain}",
                status=DomainStatus.RETIRED,
                created_at=moment,
                released_at=moment,
            )
            self._repo.save_subdomain(retired)
        self._emit(
            actor,
            "domains.subdomain.retired",
            "success",
            "",
            {"label": normalized, "reason": reason},
        )
        return retired

    def seize_subdomain_label(
        self,
        *,
        actor: Actor,
        tenant_id: str,
        org_id: str,
        project_id: str,
        label: str,
        reason: str,
        now: datetime | None = None,
    ) -> ProjectSubdomain:
        moment = _moment(now)
        self._require_operator(actor)
        normalized = _normalize_label(label)
        self._ensure_label_safe(normalized)
        with self._repo.lock:
            current = self._repo.subdomains_by_label.get(normalized)
            if current is not None and current.status is DomainStatus.VERIFIED:
                self._release_record(current, moment)
            target_actor = replace(actor, tenant_id=tenant_id, org_id=org_id)
            record = self._activate_label(target_actor, project_id, normalized)
        self.ensure_wildcard_certificate(now=moment)
        self._emit(
            actor,
            "domains.subdomain.seized",
            "success",
            project_id,
            {"label": normalized, "reason": reason},
        )
        return record

    def claim_custom_domain(
        self,
        *,
        actor: Actor,
        project_id: str,
        hostname: str,
        now: datetime | None = None,
    ) -> CustomDomainClaim:
        moment = _moment(now)
        self._require_mutation(actor)
        normalized = _normalize_hostname(hostname)
        self._reject_platform_owned(normalized)
        self._billing.reserve_custom_domain(
            tenant_id=actor.tenant_id,
            project_id=project_id,
            hostname=normalized,
            idempotency_key=f"custom-domain:{actor.tenant_id}:{project_id}:{normalized}",
        )
        with self._repo.lock:
            current = self._repo.custom_by_host.get(normalized)
            if current is not None:
                if current.tenant_id != actor.tenant_id:
                    if current.status is DomainStatus.VERIFIED:
                        raise DomainConflict("domain is already claimed by another tenant")
                elif current.status is DomainStatus.VERIFIED:
                    return current
            value = f"loopit-verify-{secrets.token_urlsafe(24).replace('_', '-')}"
            claim = CustomDomainClaim(
                claim_id=f"claim_{uuid.uuid4().hex}",
                tenant_id=actor.tenant_id,
                org_id=actor.org_id,
                project_id=project_id,
                hostname=normalized,
                status=DomainStatus.PENDING,
                challenge_name=f"_loopit-verify.{normalized}",
                challenge_value=value,
                expires_at=moment + timedelta(hours=24),
            )
            self._repo.save_custom(claim)
        self._emit(
            actor,
            "domains.custom.claimed",
            "pending",
            project_id,
            {"host": normalized, "challenge_name": claim.challenge_name},
        )
        return claim

    def verify_custom_domain(
        self, *, actor: Actor, hostname: str, now: datetime | None = None
    ) -> CustomDomainClaim:
        moment = _moment(now)
        self._require_mutation(actor)
        normalized = _normalize_hostname(hostname)
        claim = self._repo.custom_by_host.get(normalized)
        if claim is None or claim.tenant_id != actor.tenant_id:
            raise DomainConflict("domain claim was not found")
        if claim.status is DomainStatus.VERIFIED:
            return claim
        if moment >= claim.expires_at:
            expired = replace(claim, status=DomainStatus.EXPIRED)
            self._repo.save_custom(expired)
            self._emit(
                actor, "domains.custom.expired", "denied", claim.project_id, {"host": normalized}
            )
            raise VerificationFailed("domain verification challenge expired")
        records = self._public_resolver.resolve_txt(claim.challenge_name)
        if not any(_txt_matches(record, claim.challenge_value) for record in records):
            self._emit(
                actor,
                "domains.custom.verify_failed",
                "denied",
                claim.project_id,
                {"host": normalized},
            )
            raise VerificationFailed("domain verification challenge not found")
        verified = replace(claim, status=DomainStatus.VERIFIED, verified_at=moment)
        self._repo.save_custom(verified)
        certificate = self._certificates.issue_certificate(
            tenant_id=actor.tenant_id,
            hostnames=(normalized,),
            challenge_type="http-01",
            now=moment,
        )
        self._repo.save_certificate(certificate)
        self._emit(
            actor, "domains.custom.verified", "success", claim.project_id, {"host": normalized}
        )
        return verified

    def ensure_wildcard_certificate(self, *, now: datetime | None = None) -> CertificateRecord:
        moment = _moment(now)
        wildcard = f"*.{self._base_domain}"
        existing = self._repo.certificate_for_host(f"x.{self._base_domain}", moment)
        if existing is not None:
            return self._renew_if_due(existing, now=moment)
        certificate = self._certificates.issue_certificate(
            tenant_id="platform",
            hostnames=(wildcard,),
            challenge_type="dns-01",
            now=moment,
        )
        self._repo.save_certificate(certificate)
        return certificate

    def renew_due_certificates(
        self, *, now: datetime | None = None
    ) -> tuple[CertificateRecord, ...]:
        moment = _moment(now)
        renewed: list[CertificateRecord] = []
        for certificate in tuple(self._repo.certificates.values()):
            updated = self._renew_if_due(certificate, now=moment)
            if (
                updated.certificate_id == certificate.certificate_id
                and updated.issued_at != certificate.issued_at
            ):
                renewed.append(updated)
        return tuple(renewed)

    def route_for_host(self, hostname: str, *, now: datetime | None = None) -> HostedRoute:
        moment = _moment(now)
        normalized, owner, kind = self._owner_for_host(hostname)
        certificate = self._repo.certificate_for_host(normalized, moment)
        if certificate is None:
            raise CertificateUnavailable("no active certificate covers host")
        certificate = self._renew_if_due(certificate, now=moment)
        if certificate.status is not CertificateStatus.ACTIVE:
            raise CertificateUnavailable("certificate is not active")
        backend = self._repo.backends_by_project.get((owner.tenant_id, owner.project_id))
        if backend is None:
            raise DomainConflict("host is not verified")
        return HostedRoute(
            hostname=normalized,
            tenant_id=owner.tenant_id,
            org_id=owner.org_id,
            project_id=owner.project_id,
            kind=kind,
            certificate_status=certificate.status,
            certificate_expires_at=certificate.expires_at,
            backend=backend,
        )

    def register_backend_for_host(
        self,
        *,
        hostname: str,
        project_id: str,
        host: str,
        port: int,
        checkpoint_id: str = "",
        release_id: str = "",
        serving_status: str = "active",
        refusal_reason: str = "",
        now: datetime | None = None,
    ) -> ProjectBackend:
        moment = _moment(now)
        _normalized, owner, _kind = self._owner_for_host(hostname)
        if owner.project_id != project_id:
            raise DomainConflict("host is not verified")
        backend = ProjectBackend(
            tenant_id=owner.tenant_id,
            project_id=owner.project_id,
            host=_normalize_backend_host(host),
            port=_normalize_backend_port(port),
            checkpoint_id=checkpoint_id,
            release_id=release_id,
            serving_status=_normalize_serving_status(serving_status),
            refusal_reason=refusal_reason.strip()[:200],
            updated_at=moment,
        )
        with self._repo.lock:
            self._repo.save_backend(backend)
        return backend

    def clear_backend_for_project(
        self,
        *,
        actor: Actor,
        project_id: str,
    ) -> ProjectBackend:
        self._require_mutation(actor)
        with self._repo.lock:
            removed = self._repo.delete_backend(tenant_id=actor.tenant_id, project_id=project_id)
        if removed is None:
            raise DomainConflict("host is not verified")
        return removed

    def hostname_for_project(self, project_id: str) -> ProjectSubdomain:
        matches = [
            record
            for record in self._repo.subdomains_by_project.values()
            if record.project_id == project_id and record.status is DomainStatus.VERIFIED
        ]
        if len(matches) != 1:
            raise DomainConflict("host is not verified")
        return matches[0]

    def search_domain(self, *, actor: Actor, hostname: str) -> bool:
        self._require_tenant_actor(actor)
        normalized = _normalize_hostname(hostname)
        self._reject_platform_owned(normalized)
        return self._registrar.search_availability(normalized)

    def quote_domain(self, *, actor: Actor, hostname: str, term_years: int = 1) -> DomainQuote:
        self._require_tenant_actor(actor)
        normalized = _normalize_hostname(hostname)
        self._reject_platform_owned(normalized)
        return self._registrar.quote(normalized, term_years=term_years)

    def purchase_domain(
        self,
        *,
        actor: Actor,
        hostname: str,
        idempotency_key: str,
        term_years: int = 1,
        auto_renew: bool = True,
    ) -> DomainPurchase:
        self._require_mutation(actor)
        normalized = _normalize_hostname(hostname)
        key = _normalize_idempotency_key(idempotency_key)
        self._reject_platform_owned(normalized)
        quote = self._registrar.quote(normalized, term_years=term_years)
        self._billing.reserve_domain_registration(
            tenant_id=actor.tenant_id,
            hostname=normalized,
            estimated_cost=quote.price_usd * Decimal("1.15"),
            idempotency_key=key,
        )
        with self._repo.lock:
            attempt = self._repo.purchase_attempts.get((actor.tenant_id, key))
            if attempt is None:
                attempt = DomainPurchaseAttempt(
                    tenant_id=actor.tenant_id,
                    domain=normalized,
                    idempotency_key=key,
                    term_years=term_years,
                    auto_renew=auto_renew,
                    status=PurchaseAttemptStatus.PENDING,
                )
                self._repo.save_purchase_attempt(attempt)
            else:
                _ensure_same_purchase_attempt(
                    attempt, domain=normalized, term_years=term_years, auto_renew=auto_renew
                )
                if attempt.status is PurchaseAttemptStatus.SUCCEEDED and attempt.purchase:
                    return attempt.purchase
            recovered = self._registrar.purchase_for_idempotency_key(
                tenant_id=actor.tenant_id, idempotency_key=key
            )
            if recovered is not None:
                _ensure_same_purchase_attempt(
                    attempt,
                    domain=recovered.domain,
                    term_years=recovered.term_years,
                    auto_renew=recovered.auto_renew,
                )
                succeeded = replace(
                    attempt, status=PurchaseAttemptStatus.SUCCEEDED, purchase=recovered
                )
                self._repo.save_purchase_attempt(succeeded)
                self._billing.meter_domain_registration(
                    tenant_id=actor.tenant_id,
                    hostname=normalized,
                    registrar_cost=quote.price_usd,
                    idempotency_key=key,
                )
                return recovered
        try:
            purchase = self._registrar.purchase(
                tenant_id=actor.tenant_id,
                domain=normalized,
                idempotency_key=key,
                term_years=term_years,
                auto_renew=auto_renew,
            )
        except ValueError as exc:
            with self._repo.lock:
                self._repo.save_purchase_attempt(
                    replace(attempt, status=PurchaseAttemptStatus.FAILED, error=str(exc))
                )
            raise
        with self._repo.lock:
            self._repo.save_purchase_attempt(
                replace(attempt, status=PurchaseAttemptStatus.SUCCEEDED, purchase=purchase)
            )
        self._billing.meter_domain_registration(
            tenant_id=actor.tenant_id,
            hostname=normalized,
            registrar_cost=quote.price_usd,
            idempotency_key=key,
        )
        self._emit(
            actor, "domains.registrar.purchase_requested", "success", "", {"host": normalized}
        )
        return purchase

    def _activate_label(self, actor: Actor, project_id: str, label: str) -> ProjectSubdomain:
        hostname = f"{label}.{self._base_domain}"
        record = ProjectSubdomain(
            tenant_id=actor.tenant_id,
            org_id=actor.org_id,
            project_id=project_id,
            label=label,
            hostname=hostname,
        )
        dns_record = self._dns.create_record(
            zone=self._base_domain,
            name=hostname,
            type="CNAME",
            content=self._app_proxy_target,
            ttl=300,
            proxied=True,
        )
        self._repo.save_subdomain(record)
        self._repo.save_dns_record(hostname=hostname, record_id=dns_record.record_id)
        return record

    def _release_record(self, record: ProjectSubdomain, now: datetime) -> ProjectSubdomain:
        released = replace(
            record,
            status=DomainStatus.RELEASED,
            released_at=now,
            quarantine_until=now + self._quarantine,
        )
        dns_id = self._repo.delete_dns_record(hostname=record.hostname)
        if dns_id is not None:
            self._dns.delete_record(zone=self._base_domain, record_id=dns_id)
        self._repo.delete_backend(tenant_id=record.tenant_id, project_id=record.project_id)
        self._repo.save_subdomain(released)
        return released

    def _choose_label(
        self, requested_label: str | None, now: datetime, actor: Actor, project_id: str
    ) -> str:
        if requested_label is not None:
            label = _normalize_label(requested_label)
            self._ensure_label_available(label, now, actor, project_id)
            return label
        for _ in range(25):
            label = f"p-{secrets.token_hex(10)}"
            if self._label_available(label, now, actor, project_id):
                return label
        raise DomainConflict("could not allocate a unique subdomain")

    def _ensure_label_available(
        self, label: str, now: datetime, actor: Actor, project_id: str
    ) -> None:
        self._ensure_label_safe(label)
        if not self._label_available(label, now, actor, project_id):
            raise DomainConflict("subdomain label is unavailable")

    def _ensure_label_safe(self, label: str) -> None:
        if label in self._reserved:
            raise ReservedName("subdomain label is reserved")
        if label.startswith("xn--"):
            raise InvalidDomain("punycode labels are not allowed")
        for term in self._denylist_terms:
            if term and term in label:
                raise ReservedName("subdomain label is reserved")

    def _label_available(self, label: str, now: datetime, actor: Actor, project_id: str) -> bool:
        try:
            self._ensure_label_safe(label)
        except (InvalidDomain, ReservedName):
            return False
        record = self._repo.subdomains_by_label.get(label)
        if record is None:
            return True
        if record.status is DomainStatus.RETIRED:
            return False
        if (
            record.status is DomainStatus.RELEASED
            and record.tenant_id == actor.tenant_id
            and record.project_id == project_id
        ):
            return True
        if record.status is DomainStatus.RELEASED and (
            record.quarantine_until is None or record.quarantine_until <= now
        ):
            return True
        return False

    def _subdomain_route(self, hostname: str) -> ProjectSubdomain | None:
        suffix = f".{self._base_domain}"
        if not hostname.endswith(suffix):
            return None
        label = hostname[: -len(suffix)]
        record = self._repo.subdomains_by_label.get(label)
        if (
            record is None
            or record.hostname != hostname
            or record.status is not DomainStatus.VERIFIED
        ):
            return None
        return record

    def _owner_for_host(self, hostname: str) -> tuple[str, ProjectSubdomain, str]:
        normalized = _normalize_hostname(hostname)
        subdomain = self._subdomain_route(normalized)
        custom = self._repo.custom_by_host.get(normalized)
        if subdomain is None and (custom is None or custom.status is not DomainStatus.VERIFIED):
            raise DomainConflict("host is not verified")
        if custom is not None and custom.status is DomainStatus.VERIFIED:
            return (
                normalized,
                ProjectSubdomain(
                    tenant_id=custom.tenant_id,
                    org_id=custom.org_id,
                    project_id=custom.project_id,
                    label=normalized,
                    hostname=normalized,
                ),
                "custom",
            )
        if subdomain is None:
            raise DomainConflict("host is not verified")
        return normalized, subdomain, "subdomain"

    def _reject_platform_owned(self, hostname: str) -> None:
        if hostname in self._platform_hostnames or hostname == self._base_domain:
            raise InvalidDomain("platform-owned hostname cannot be claimed")
        if hostname.endswith(f".{self._base_domain}"):
            raise InvalidDomain("platform-owned hostname cannot be claimed")

    def _require_mutation(self, actor: Actor) -> None:
        self._require_tenant_actor(actor)
        if actor.role not in MUTATING_ROLES and "domains:write" not in actor.scopes:
            raise AuthorizationDenied("actor cannot mutate domains")

    def _require_tenant_actor(self, actor: Actor) -> None:
        if not actor.tenant_id or not actor.org_id:
            raise AuthorizationDenied("actor must be scoped to a tenant")

    def _require_operator(self, actor: Actor) -> None:
        if OPERATOR_SCOPE not in actor.scopes:
            raise AuthorizationDenied("actor cannot administer platform domains")

    def _emit(
        self,
        actor: Actor,
        event_type: str,
        outcome: str,
        project_id: str,
        detail: dict[str, str],
    ) -> None:
        self._audit.emit(
            AuditEvent(
                type=event_type,
                tenant_id=actor.tenant_id,
                actor_kind="user",
                actor_id=actor.subject,
                project_id=project_id,
                plane="control",
                outcome=outcome,  # type: ignore[arg-type]
                detail=detail,
            )
        )

    def _renew_if_due(self, certificate: CertificateRecord, *, now: datetime) -> CertificateRecord:
        if certificate.expires_at is None:
            return certificate
        if certificate.expires_at <= now:
            expired = replace(certificate, status=CertificateStatus.EXPIRED)
            self._repo.save_certificate(expired)
            return expired
        if certificate.expires_at - now > timedelta(days=30):
            return certificate
        due = replace(certificate, status=CertificateStatus.RENEWAL_DUE)
        self._repo.save_certificate(due)
        renewed = self._certificates.renew_certificate(due, now=now)
        self._repo.save_certificate(renewed)
        return renewed


def _normalize_hostname(hostname: str) -> str:
    normalized = hostname.strip().lower().rstrip(".")
    if not normalized or len(normalized) > 253 or "*" in normalized:
        raise InvalidDomain("invalid hostname")
    labels = normalized.split(".")
    if len(labels) < 2:
        raise InvalidDomain("hostname must contain a registrable domain")
    for label in labels:
        _normalize_label(label)
    return normalized


def _normalize_label(label: str) -> str:
    normalized = label.strip().lower()
    if not LABEL_RE.fullmatch(normalized):
        raise InvalidDomain("invalid DNS label")
    return normalized


def _normalize_backend_host(host: str) -> str:
    normalized = host.strip().lower().rstrip(".")
    if not normalized or "/" in normalized or "\\" in normalized or len(normalized) > 253:
        raise InvalidDomain("invalid backend host")
    return normalized


def _normalize_backend_port(port: int) -> int:
    if not 1 <= port <= 65535:
        raise InvalidDomain("invalid backend port")
    return port


def _normalize_serving_status(status: str) -> str:
    normalized = status.strip().lower()
    if normalized not in {"active", "quota_exceeded"}:
        raise InvalidDomain("invalid serving status")
    return normalized


def _normalize_idempotency_key(key: str) -> str:
    normalized = key.strip()
    if not normalized or len(normalized) > 200:
        raise InvalidDomain("invalid idempotency key")
    return normalized


def _ensure_same_purchase_attempt(
    attempt: DomainPurchaseAttempt, *, domain: str, term_years: int, auto_renew: bool
) -> None:
    if (
        attempt.domain != domain
        or attempt.term_years != term_years
        or attempt.auto_renew != auto_renew
    ):
        raise DomainConflict("idempotency key was already used for a different purchase")


def _zone_for(hostname: str) -> str:
    parts = hostname.split(".")
    if len(parts) < 2:
        raise InvalidDomain("hostname must contain a registrable domain")
    return ".".join(parts[-2:])


def _covers(certificate: CertificateRecord, hostname: str) -> bool:
    for candidate in certificate.hostnames:
        if candidate == hostname:
            return True
        if (
            candidate.startswith("*.")
            and hostname.endswith(candidate[1:])
            and hostname.count(".") == candidate.count(".")
        ):
            return True
    return False


def _not_failed(certificate: CertificateRecord) -> bool:
    return certificate.status not in {CertificateStatus.FAILED, CertificateStatus.EXPIRED}


def _txt_matches(content: str, expected: str) -> bool:
    return content.strip().strip('"') == expected


def _moment(now: datetime | None) -> datetime:
    if now is None:
        return datetime.now(UTC)
    if now.tzinfo is None:
        return now.replace(tzinfo=UTC)
    return now
