"""The router's error taxonomy, in one place so every layer agrees on it.

These live apart from ``router.py`` and ``openai_upstream.py`` because both need
them and neither should import the other: the transport must be able to raise an
error the routing loop understands, without the routing loop knowing that HTTP
exists.

The distinction that matters is not severity but *what the caller should do
next*. ``TransientUpstreamError`` means try again. ``TerminalUpstreamError``
means stop — no retry and no failover will help, because the cause is the
account or the request rather than the model.
"""

from __future__ import annotations

from collections.abc import Sequence


class RouterError(Exception):
    """Base class for router failures."""


class UpstreamError(RouterError):
    """Every candidate model failed. The caller must not retry blindly."""

    def __init__(self, message: str, attempts: Sequence[str]) -> None:
        super().__init__(message)
        self.attempts = tuple(attempts)


class UpstreamHTTPError(RouterError):
    """An HTTP-level failure from a serving backend."""

    def __init__(self, message: str, *, status: int | None = None, body: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class TransientUpstreamError(UpstreamHTTPError):
    """Retryable: cold start, rate limit, or a temporarily unhealthy backend."""


class TerminalUpstreamError(UpstreamHTTPError):
    """Not retryable, and not recoverable by trying a different model.

    Authentication, billing, and malformed requests fail identically on every
    candidate. ``ModelRouter`` lets this escape its failover loop so the operator
    sees one accurate error instead of N misleading ones.
    """
