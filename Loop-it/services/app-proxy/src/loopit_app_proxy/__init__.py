"""Public app edge for deployed Loop-it projects."""

from __future__ import annotations

from .billing import (
    BufferedHostingBillingReporter,
    HostingBillingReporter,
    NoopHostingBillingReporter,
)
from .limits import PerHostRateLimiter, RateLimitSettings
from .proxy import (
    PLATFORM_REFUSAL_HEADERS,
    SERVICE_NAME,
    STRIPPED_REQUEST_HEADERS,
    AppDecision,
    AppProxy,
    AppRequest,
    Refusal,
    normalise_host,
    origin_matches_host,
)
from .routes import (
    Backend,
    DomainsRouteCacheSettings,
    DomainsRouteResolver,
    HostnameBinding,
    HostnameKind,
    HostnameResolver,
    InMemoryHostnameResolver,
    InMemoryProjectBackendResolver,
    ProjectBackendResolver,
    Route,
    RouteNotFound,
    RouteResolver,
    backends_from_json,
    hostnames_from_json,
    resolve_route,
)

__all__ = [
    "PLATFORM_REFUSAL_HEADERS",
    "SERVICE_NAME",
    "STRIPPED_REQUEST_HEADERS",
    "AppDecision",
    "AppProxy",
    "AppRequest",
    "Backend",
    "BufferedHostingBillingReporter",
    "DomainsRouteCacheSettings",
    "DomainsRouteResolver",
    "HostingBillingReporter",
    "HostnameBinding",
    "HostnameKind",
    "HostnameResolver",
    "InMemoryHostnameResolver",
    "InMemoryProjectBackendResolver",
    "NoopHostingBillingReporter",
    "PerHostRateLimiter",
    "ProjectBackendResolver",
    "RateLimitSettings",
    "Refusal",
    "Route",
    "RouteNotFound",
    "RouteResolver",
    "backends_from_json",
    "hostnames_from_json",
    "normalise_host",
    "origin_matches_host",
    "resolve_route",
]
