"""Certificate authority seam.

Wildcard certificates require ACME DNS-01, and custom domains need their own
certificate lifecycle. This module models that lifecycle but intentionally does
not ship a production ACME client; operators must plug in a real
CertificateAuthority implementation before live TLS automation exists.
"""

from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import datetime, timedelta
from typing import Protocol, runtime_checkable

from .models import CertificateRecord, CertificateStatus


@runtime_checkable
class CertificateAuthority(Protocol):
    """Certificate issuance seam used by the domain state machine."""

    def issue_certificate(
        self, *, tenant_id: str, hostnames: tuple[str, ...], challenge_type: str, now: datetime
    ) -> CertificateRecord: ...

    def renew_certificate(
        self, certificate: CertificateRecord, *, now: datetime
    ) -> CertificateRecord: ...


class RefusingCertificateAuthority:
    """Fail-closed certificate authority used when production ACME is not configured."""

    def __init__(self, reason: str = "certificate automation is not configured") -> None:
        self._reason = reason

    def issue_certificate(
        self, *, tenant_id: str, hostnames: tuple[str, ...], challenge_type: str, now: datetime
    ) -> CertificateRecord:
        _ = (tenant_id, hostnames, challenge_type, now)
        raise NotImplementedError(self._reason)

    def renew_certificate(
        self, certificate: CertificateRecord, *, now: datetime
    ) -> CertificateRecord:
        _ = (certificate, now)
        raise NotImplementedError(self._reason)


class FakeCertificateAuthority:
    """ACME fake for tests and development; it creates active 90-day records."""

    def __init__(self) -> None:
        self.issued: list[tuple[str, tuple[str, ...], str]] = []
        self.renewed: list[str] = []

    def issue_certificate(
        self, *, tenant_id: str, hostnames: tuple[str, ...], challenge_type: str, now: datetime
    ) -> CertificateRecord:
        self.issued.append((tenant_id, hostnames, challenge_type))
        return CertificateRecord(
            certificate_id=f"cert_{uuid.uuid4().hex}",
            tenant_id=tenant_id,
            hostnames=hostnames,
            status=CertificateStatus.ACTIVE,
            challenge_type=challenge_type,
            issued_at=now,
            expires_at=now + timedelta(days=90),
        )

    def renew_certificate(
        self, certificate: CertificateRecord, *, now: datetime
    ) -> CertificateRecord:
        self.renewed.append(certificate.certificate_id)
        return replace(
            certificate,
            status=CertificateStatus.ACTIVE,
            issued_at=now,
            expires_at=now + timedelta(days=90),
            last_error="",
        )


class AcmeCertificateAuthority:
    """Placeholder for a real ACME client.

    The service is wired to this seam so a production integration can create
    DNS-01/HTTP-01 orders without changing domain ownership code. Until a real
    client is supplied, construction should use FakeCertificateAuthority only in
    development and tests.
    """

    def issue_certificate(
        self, *, tenant_id: str, hostnames: tuple[str, ...], challenge_type: str, now: datetime
    ) -> CertificateRecord:
        _ = (tenant_id, hostnames, challenge_type, now)
        raise NotImplementedError("production ACME integration is a seam, not implemented")

    def renew_certificate(
        self, certificate: CertificateRecord, *, now: datetime
    ) -> CertificateRecord:
        _ = (certificate, now)
        raise NotImplementedError("production ACME integration is a seam, not implemented")
