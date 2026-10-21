"""Domain-control service for generated apps.

This package is responsible for safe hostname ownership, not for being the
public edge. App-proxy should ask this service which tenant/project owns a host
and whether the certificate state is safe to serve.

Cloudflare DNS is implemented against the REST API. ACME and registrar support
are explicit seams with fakes: the service models issuance, renewal, expiry,
search, quoting, purchase, and renewal, but it does not contain a funded
registrar integration or a production ACME client yet.
"""

from __future__ import annotations

from .dns import (
    CloudflareDnsProvider,
    DnsProvider,
    DnsRecord,
    DohPublicDnsResolver,
    InMemoryDnsProvider,
    InMemoryPublicDnsResolver,
    PublicDnsResolver,
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
    DomainRegistrar,
    FakeDomainRegistrar,
    PurchaseAttemptStatus,
    RefusingDomainRegistrar,
)
from .service import (
    BillingClient,
    DomainService,
    InMemoryDomainRepository,
    NoopBillingClient,
    SqliteDomainRepository,
)
from .tls import (
    AcmeCertificateAuthority,
    CertificateAuthority,
    FakeCertificateAuthority,
    RefusingCertificateAuthority,
)

__all__ = [
    "AcmeCertificateAuthority",
    "BillingClient",
    "CertificateAuthority",
    "CertificateRecord",
    "CertificateStatus",
    "CloudflareDnsProvider",
    "CustomDomainClaim",
    "DnsProvider",
    "DnsRecord",
    "DohPublicDnsResolver",
    "DomainPurchase",
    "DomainPurchaseAttempt",
    "DomainRegistrar",
    "DomainService",
    "DomainStatus",
    "FakeCertificateAuthority",
    "FakeDomainRegistrar",
    "HostedRoute",
    "InMemoryDnsProvider",
    "InMemoryDomainRepository",
    "InMemoryPublicDnsResolver",
    "NoopBillingClient",
    "ProjectBackend",
    "ProjectSubdomain",
    "PublicDnsResolver",
    "PurchaseAttemptStatus",
    "RefusingCertificateAuthority",
    "RefusingDomainRegistrar",
    "SqliteDomainRepository",
]
