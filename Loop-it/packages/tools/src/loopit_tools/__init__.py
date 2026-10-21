"""Concrete tool layer for the Loop-it agent harness.

The package binds :mod:`loopit_agent_core` tool calls to least-privilege
workspace transports. LocalWorkspace exists for tests and single-user local
runs; production callers use RemoteWorkspace so effects happen inside a leased
sandbox rather than the control plane.
"""

from .registry import AuditContext, ToolRegistry, default_registry
from .transport import (
    BrowserActionResult,
    CommandResult,
    LocalWorkspace,
    RemoteWorkspace,
    RemoteWorkspaceClient,
    WorkspaceTransport,
)

__all__ = [
    "AuditContext",
    "BrowserActionResult",
    "CommandResult",
    "LocalWorkspace",
    "RemoteWorkspace",
    "RemoteWorkspaceClient",
    "ToolRegistry",
    "WorkspaceTransport",
    "default_registry",
]
