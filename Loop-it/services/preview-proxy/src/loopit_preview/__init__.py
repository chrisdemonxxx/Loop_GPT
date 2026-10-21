"""Authenticated preview routing.

Sandbox ports are never public (I1). Every preview request is authenticated at
this edge, scoped to a single project, and audited (I10).
"""

from .errors import (
    PreviewError,
    RouteConflict,
    RouteNotFound,
    TokenExpired,
    TokenInvalid,
)
from .proxy import (
    SECURITY_HEADERS,
    SERVICE_NAME,
    STRIPPED_REQUEST_HEADERS,
    PreviewDecision,
    PreviewProxy,
    PreviewRequest,
)
from .bridge import (
    CONSOLE_BRIDGE_SCRIPT,
    INSPECTOR_BRIDGE_SCRIPT,
    inject_console_bridge,
    inject_inspector_bridge,
    inject_preview_bridges,
)
from .routes import Backend, Route, RouteTable
from .tokens import (
    DEFAULT_TTL_SECONDS,
    MIN_KEY_BYTES,
    PreviewClaims,
    TokenSigner,
    mint_for,
)

__all__ = [
    "CONSOLE_BRIDGE_SCRIPT",
    "DEFAULT_TTL_SECONDS",
    "INSPECTOR_BRIDGE_SCRIPT",
    "MIN_KEY_BYTES",
    "SECURITY_HEADERS",
    "SERVICE_NAME",
    "STRIPPED_REQUEST_HEADERS",
    "Backend",
    "PreviewClaims",
    "PreviewDecision",
    "PreviewError",
    "PreviewProxy",
    "PreviewRequest",
    "Route",
    "RouteConflict",
    "RouteNotFound",
    "RouteTable",
    "TokenExpired",
    "TokenInvalid",
    "TokenSigner",
    "inject_console_bridge",
    "inject_inspector_bridge",
    "inject_preview_bridges",
    "mint_for",
]
