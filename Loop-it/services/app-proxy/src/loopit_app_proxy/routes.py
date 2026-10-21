"""Narrow contracts the public app edge needs from sibling services.

The app proxy does not own domain allocation, custom-domain verification, VPS
placement, or deploy lifecycles. It only needs two point lookups at request
time: the asserted owner of a hostname, and the current live backend for that
owner's project. Keeping those contracts separate prevents a stale edge cache
from serving a re-pointed hostname after domains or deployer have changed
state.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol, cast

import httpx2

from .errors import RouteNotFound

HostnameKind = Literal["allocated_subdomain", "custom_domain"]


@dataclass(frozen=True, slots=True)
class Backend:
    """An internal app backend address. Never disclose it to clients."""

    host: str
    port: int
    serving_status: str = "active"
    refusal_reason: str = ""

    def __post_init__(self) -> None:
        if not self.host:
            raise ValueError("backend host must not be empty")
        if not 1 <= self.port <= 65535:
            raise ValueError("backend port must be in 1..65535")
        if self.serving_status not in {"active", "quota_exceeded"}:
            raise ValueError("backend serving_status must be active or quota_exceeded")


@dataclass(frozen=True, slots=True)
class HostnameBinding:
    """The domains-service assertion for one requested hostname."""

    hostname: str
    tenant_id: str
    project_id: str
    kind: HostnameKind
    verified: bool

    def __post_init__(self) -> None:
        for name in ("hostname", "tenant_id", "project_id"):
            if not getattr(self, name):
                raise ValueError(f"{name} must not be empty")


@dataclass(frozen=True, slots=True)
class Route:
    """A verified hostname joined to a live project backend."""

    binding: HostnameBinding
    backend: Backend


class RouteResolver(Protocol):
    async def resolve_route(self, hostname: str) -> Route:
        """Resolve a verified hostname and its backend in one trusted lookup."""


class HostnameResolver(Protocol):
    """Resolve a lowercase hostname to its owning tenant/project, if any."""

    async def resolve_hostname(self, hostname: str) -> HostnameBinding | None:
        """Return the current hostname binding, or ``None`` when unmapped."""


class ProjectBackendResolver(Protocol):
    """Resolve the live backend for a tenant-owned deployed project."""

    async def resolve_backend(self, *, tenant_id: str, project_id: str) -> Backend | None:
        """Return the current internal backend, or ``None`` when not live."""


class InMemoryHostnameResolver:
    """Small resolver used by tests and local compose JSON configuration."""

    def __init__(self, bindings: Sequence[HostnameBinding] = ()) -> None:
        self._bindings = {_normalise_host(binding.hostname): binding for binding in bindings}

    async def resolve_hostname(self, hostname: str) -> HostnameBinding | None:
        return self._bindings.get(_normalise_host(hostname))


class InMemoryProjectBackendResolver:
    """Small backend resolver keyed by tenant and project."""

    def __init__(self, backends: Mapping[tuple[str, str], Backend] | None = None) -> None:
        self._backends = dict(backends or {})

    async def resolve_backend(self, *, tenant_id: str, project_id: str) -> Backend | None:
        return self._backends.get((tenant_id, project_id))


@dataclass(frozen=True, slots=True)
class DomainsRouteCacheSettings:
    positive_ttl_seconds: float = 3.0
    negative_ttl_seconds: float = 1.0
    timeout_seconds: float = 1.5
    max_entries: int = 10_000

    def __post_init__(self) -> None:
        if self.max_entries <= 0:
            raise ValueError("max_entries must be positive")


@dataclass(frozen=True, slots=True)
class _CacheEntry:
    expires_at: float
    route: Route | None


class DomainsRouteResolver:
    """HTTP-backed app edge resolver using domains as the single route authority."""

    def __init__(
        self,
        *,
        base_url: str,
        service_token: str,
        client: httpx2.AsyncClient | None = None,
        cache: DomainsRouteCacheSettings | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_token = service_token
        self._client = client or httpx2.AsyncClient(
            timeout=httpx2.Timeout((cache or DomainsRouteCacheSettings()).timeout_seconds)
        )
        self._owns_client = client is None
        self._settings = cache or DomainsRouteCacheSettings()
        self._cache: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._inflight: dict[str, asyncio.Task[Route]] = {}
        self._lock = asyncio.Lock()

    async def resolve_route(self, hostname: str) -> Route:
        normalized = _normalise_host(hostname)
        now = time.monotonic()
        async with self._lock:
            cached = self._cache.get(normalized)
            if cached is not None and cached.expires_at > now:
                self._cache.move_to_end(normalized)
                if cached.route is None:
                    raise RouteNotFound("no verified public hostname route")
                return cached.route
            if cached is not None:
                self._cache.pop(normalized, None)
            task = self._inflight.get(normalized)
            owner = task is None
            if task is None:
                task = asyncio.create_task(self._resolve_uncached(normalized))
                self._inflight[normalized] = task
        try:
            return await asyncio.shield(task)
        finally:
            if owner:
                async with self._lock:
                    if self._inflight.get(normalized) is task:
                        self._inflight.pop(normalized, None)

    async def _resolve_uncached(self, normalized: str) -> Route:
        try:
            response = await self._get_route_response(normalized)
        except (httpx2.TimeoutException, httpx2.TransportError) as exc:
            await self._store_cache(normalized, None, self._settings.negative_ttl_seconds)
            raise RouteNotFound("domains route lookup failed closed") from exc
        if response.status_code == 404:
            await self._store_cache(normalized, None, self._settings.negative_ttl_seconds)
            raise RouteNotFound("no verified public hostname route")
        try:
            response.raise_for_status()
            route = _route_from_domains(response.json())
        except (httpx2.HTTPStatusError, KeyError, TypeError, ValueError) as exc:
            await self._store_cache(normalized, None, self._settings.negative_ttl_seconds)
            raise RouteNotFound("domains route lookup failed closed") from exc
        await self._store_cache(normalized, route, self._settings.positive_ttl_seconds)
        return route

    async def _store_cache(self, hostname: str, route: Route | None, ttl_seconds: float) -> None:
        now = time.monotonic()
        async with self._lock:
            for cached_host in list(self._cache):
                if self._cache[cached_host].expires_at <= now:
                    self._cache.pop(cached_host, None)
            self._cache[hostname] = _CacheEntry(expires_at=now + ttl_seconds, route=route)
            self._cache.move_to_end(hostname)
            while len(self._cache) > self._settings.max_entries:
                self._cache.popitem(last=False)

    async def resolve_hostname(self, hostname: str) -> HostnameBinding | None:
        try:
            return (await self.resolve_route(hostname)).binding
        except RouteNotFound:
            return None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _get_route_response(self, hostname: str) -> httpx2.Response:
        last_error: httpx2.TimeoutException | httpx2.TransportError | None = None
        for _ in range(2):
            try:
                return await self._client.get(
                    f"{self._base_url}/routes/{hostname}",
                    headers={"X-Loopit-Service-Token": self._service_token},
                )
            except (httpx2.TimeoutException, httpx2.TransportError) as exc:
                last_error = exc
        raise last_error or httpx2.TransportError("domains route lookup failed")


def route_from(
    *,
    hostname: str,
    hostnames: HostnameResolver,
    backends: ProjectBackendResolver,
) -> object:
    """Type anchor for the contract documented above.

    This function is intentionally not called. It keeps the two Protocols near
    their value types and makes accidental broadening of the public contract
    obvious in review.
    """
    return hostname, hostnames, backends


async def resolve_route(
    hostname: str,
    *,
    hostnames: HostnameResolver,
    backends: ProjectBackendResolver,
) -> Route:
    """Resolve and verify a public app route without disclosing miss reasons."""
    one_lookup = getattr(hostnames, "resolve_route", None)
    if callable(one_lookup):
        return cast(Route, await one_lookup(_normalise_host(hostname)))
    binding = await hostnames.resolve_hostname(_normalise_host(hostname))
    if binding is None or not binding.verified:
        raise RouteNotFound("no verified public hostname route")
    backend = await backends.resolve_backend(
        tenant_id=binding.tenant_id, project_id=binding.project_id
    )
    if backend is None:
        raise RouteNotFound("no live backend for public hostname route")
    return Route(binding=binding, backend=backend)


def hostnames_from_json(raw: str) -> InMemoryHostnameResolver:
    bindings: list[HostnameBinding] = []
    loaded = json.loads(raw)
    if not isinstance(loaded, list):
        return InMemoryHostnameResolver()
    for item in loaded:
        if not isinstance(item, Mapping):
            continue
        bindings.append(
            HostnameBinding(
                hostname=str(item["hostname"]),
                tenant_id=str(item["tenant_id"]),
                project_id=str(item["project_id"]),
                kind=_kind(str(item.get("kind", "custom_domain"))),
                verified=bool(item["verified"]),
            )
        )
    return InMemoryHostnameResolver(bindings)


def backends_from_json(raw: str) -> InMemoryProjectBackendResolver:
    backends: dict[tuple[str, str], Backend] = {}
    loaded = json.loads(raw)
    if not isinstance(loaded, list):
        return InMemoryProjectBackendResolver()
    for item in loaded:
        if not isinstance(item, Mapping):
            continue
        backends[(str(item["tenant_id"]), str(item["project_id"]))] = Backend(
            host=str(item["backend_host"]),
            port=int(item["backend_port"]),
        )
    return InMemoryProjectBackendResolver(backends)


def _normalise_host(hostname: str) -> str:
    return hostname.strip().removesuffix(".").lower()


def _kind(raw: str) -> HostnameKind:
    if raw == "allocated_subdomain":
        return "allocated_subdomain"
    return "custom_domain"


def _route_from_domains(data: Mapping[str, object]) -> Route:
    kind: HostnameKind = "allocated_subdomain" if data["kind"] == "subdomain" else "custom_domain"
    binding = HostnameBinding(
        hostname=str(data["hostname"]),
        tenant_id=str(data["tenant_id"]),
        project_id=str(data["project_id"]),
        kind=kind,
        verified=True,
    )
    return Route(
        binding=binding,
        backend=Backend(
            host=str(data["backend_host"]),
            port=int(str(data["backend_port"])),
            serving_status=str(data.get("serving_status", "active")),
            refusal_reason=str(data.get("refusal_reason", "")),
        ),
    )


__all__ = [
    "Backend",
    "DomainsRouteCacheSettings",
    "DomainsRouteResolver",
    "HostnameBinding",
    "HostnameKind",
    "HostnameResolver",
    "InMemoryHostnameResolver",
    "InMemoryProjectBackendResolver",
    "ProjectBackendResolver",
    "Route",
    "RouteNotFound",
    "RouteResolver",
    "backends_from_json",
    "hostnames_from_json",
    "resolve_route",
]
