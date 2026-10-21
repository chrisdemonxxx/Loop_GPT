"""Failures raised by the preview proxy.

Every one of these is a *refusal*. There is no error here that a caller can
retry into a success by changing only its own behaviour, which is the point:
a preview route that can be talked into opening is not a boundary.
"""

from __future__ import annotations


class PreviewError(Exception):
    """Base class for preview-proxy refusals."""


class TokenInvalid(PreviewError):
    """The token is malformed, unsigned, or signed with the wrong key."""


class TokenExpired(PreviewError):
    """The token was well-formed but is past its expiry."""


class RouteNotFound(PreviewError):
    """No live route for the requested preview host.

    Deliberately indistinguishable from "route exists but is not yours".
    Confirming that a project exists is itself a disclosure.
    """


class RouteConflict(PreviewError):
    """A host is already bound to a different lease."""
