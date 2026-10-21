"""The preview host → sandbox backend routing table.

The backend address of a sandbox is internal-only and must never appear in a
response, a redirect, or an error message (I1). This table is the only place
that mapping lives, and it is deliberately not reversible from anything a
client can see.

Routes are bound to a lease. When the lease ends the route dies with it —
there is no such thing as a route that outlives the sandbox it points at,
because that is exactly how a preview URL ends up serving the *next* tenant
who lands on the recycled address.
"""

from __future__ import annotations

from dataclasses import dataclass

from .errors import RouteConflict, RouteNotFound


@dataclass(frozen=True, slots=True)
class Backend:
    """An internal sandbox address. Never disclosed to clients."""

    host: str
    port: int

    def __post_init__(self) -> None:
        if not self.host:
            raise ValueError("backend host must not be empty")
        if not 1 <= self.port <= 65535:
            raise ValueError("backend port must be in 1..65535")


@dataclass(frozen=True, slots=True)
class Route:
    """A live preview binding."""

    preview_host: str
    project_id: str
    tenant_id: str
    lease_id: str
    backend: Backend

    def __post_init__(self) -> None:
        for name in ("preview_host", "project_id", "tenant_id", "lease_id"):
            if not getattr(self, name):
                raise ValueError(f"{name} must not be empty")


class RouteTable:
    """In-memory routing table, keyed by lowercase preview host and project id."""

    def __init__(self) -> None:
        self._routes: dict[str, Route] = {}
        self._by_project: dict[str, str] = {}  # project_id → preview_host key

    @staticmethod
    def _key(preview_host: str) -> str:
        # Hostnames are case-insensitive; without normalising, `Proj.example`
        # and `proj.example` become two different routes and one of them is
        # unreachable in a way that looks like an outage.
        return preview_host.strip().lower()

    def bind(self, route: Route) -> None:
        """Publish a route. Rebinding the same lease is idempotent."""
        key = self._key(route.preview_host)
        existing = self._routes.get(key)
        if existing is not None and existing.lease_id != route.lease_id:
            raise RouteConflict(f"{key} is already bound to another lease")
        self._routes[key] = route
        self._by_project[route.project_id] = key

    def unbind(self, preview_host: str) -> None:
        """Remove a route. Idempotent: releasing twice is not an error."""
        key = self._key(preview_host)
        route = self._routes.pop(key, None)
        if route is not None:
            self._by_project.pop(route.project_id, None)

    def unbind_lease(self, lease_id: str) -> int:
        """Remove every route for a lease. Called on lease release."""
        doomed = [key for key, route in self._routes.items() if route.lease_id == lease_id]
        for key in doomed:
            route = self._routes.pop(key)
            self._by_project.pop(route.project_id, None)
        return len(doomed)

    def resolve_for(self, preview_host: str, *, project_id: str, tenant_id: str) -> Route:
        """Resolve a host, but only for the project and tenant that own it.

        A mismatch raises :class:`RouteNotFound`, not a distinct "forbidden"
        error, so a probe cannot enumerate which preview hosts exist by
        comparing failure modes.
        """
        route = self._routes.get(self._key(preview_host))
        if route is None:
            raise RouteNotFound("no such preview route")
        if route.project_id != project_id or route.tenant_id != tenant_id:
            raise RouteNotFound("no such preview route")
        return route

    def resolve_project(self, project_id: str, *, tenant_id: str) -> Route:
        """Resolve by project id (path-based previews). Same refusal opacity."""
        key = self._by_project.get(project_id)
        if key is None:
            raise RouteNotFound("no such preview route")
        route = self._routes.get(key)
        if route is None or route.tenant_id != tenant_id or route.project_id != project_id:
            raise RouteNotFound("no such preview route")
        return route

    def list_routes(self) -> list[Route]:
        return list(self._routes.values())

    def __len__(self) -> int:
        return len(self._routes)

    def __contains__(self, preview_host: object) -> bool:
        return isinstance(preview_host, str) and self._key(preview_host) in self._routes
