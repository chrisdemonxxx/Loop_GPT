"""MCP facade over the Loop-it control-plane API.

The portal (LibreChat or any MCP client) never holds model keys. This service
forwards a Loop-it identity JWT to ``apps/api`` and exposes run, gate,
checkpoint, preview, and export tools.
"""

from .client import LoopitApiClient, LoopitApiError
from .protocol import handle_rpc
from .tools import TOOLS, dispatch_tool

__all__ = [
    "TOOLS",
    "LoopitApiClient",
    "LoopitApiError",
    "dispatch_tool",
    "handle_rpc",
]
