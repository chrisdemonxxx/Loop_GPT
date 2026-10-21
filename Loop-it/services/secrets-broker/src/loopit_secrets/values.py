"""A plaintext wrapper that refuses to leak through ``repr``, ``str``, or logs.

Doc 08 §5/§6 is categorical: values never enter logs, audit events, or error
messages — those reference secret *names* and lease ids only. The most common
way a secret escapes is not a deliberate ``print`` but an incidental one: an
exception rendered into a traceback, a dataclass ``repr`` in a debugger, an
f-string in a log line. Wrapping the plaintext in a type whose string forms are
redacted removes that whole class of accident at the source, so the plaintext is
reachable only through the explicit :meth:`SecretValue.reveal` call a reader has
to mean to write.

This is a backstop, not a licence to pass secrets around: the broker still
mediates every read so access can be revoked and expired.
"""

from __future__ import annotations

from loopit_agent_core.audit import REDACTED


class SecretValue:
    """Plaintext held so it cannot be rendered by accident.

    ``reveal`` is the single narrow door to the plaintext; ``repr`` and ``str``
    both return the redaction marker, so the value survives interpolation into a
    log line or a traceback intact only as ``[REDACTED]``.
    """

    __slots__ = ("_plaintext",)

    def __init__(self, plaintext: str) -> None:
        self._plaintext = plaintext

    def reveal(self) -> str:
        """Return the raw plaintext. Call sites are the audited exception."""
        return self._plaintext

    def __repr__(self) -> str:
        return f"SecretValue({REDACTED})"

    def __str__(self) -> str:
        return REDACTED
