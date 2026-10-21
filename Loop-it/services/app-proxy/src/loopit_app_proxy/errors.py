"""Failures raised by the production app edge.

These are intentionally coarse refusals. A public hostname can be probed by
anyone on the internet, so "unknown host", "unverified custom domain", "wrong
tenant", and "no live backend" must collapse to the same outside shape.
"""

from __future__ import annotations


class AppProxyError(Exception):
    """Base class for app-proxy refusals."""


class RouteNotFound(AppProxyError):
    """No verified public route and live backend exist for this hostname."""
