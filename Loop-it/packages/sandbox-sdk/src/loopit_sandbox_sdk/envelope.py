"""Signed instruction envelopes.

The control plane signs every instruction it sends to a sandbox. Verification
happens inside the sandbox runtime *and* again on any result that crosses back,
so a compromised sandbox cannot forge an instruction to a different lease.

The signature covers the whole canonical payload including the lease binding and
the expiry, so none of it can be edited in flight. Replay is prevented by a
per-lease nonce cache: an envelope is accepted exactly once.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from .lease import Lease

_ALG = "HMAC-SHA256"
_DEFAULT_TTL_SECONDS = 120
_HKDF_HASH = "sha256"
_HKDF_LENGTH = 32
_HKDF_SALT = b"loopit-sandbox-rpc-v1"


class ChannelError(Exception):
    """Base class for channel failures. Always fail closed."""


class SignatureError(ChannelError):
    """The signature is missing, malformed, or does not verify."""


class ExpiredEnvelopeError(ChannelError):
    """The envelope's own expiry has passed, or its lease has."""


class LeaseMismatchError(ChannelError):
    """The envelope is bound to a different lease, tenant, or run."""


class ReplayError(ChannelError):
    """This envelope was already accepted. Envelopes are single-use."""


@dataclass(frozen=True, slots=True)
class Envelope:
    """One signed instruction bound to one lease."""

    lease_id: str
    tenant_id: str
    run_id: str
    tool: str
    args: Mapping[str, Any]
    nonce: str = field(default_factory=lambda: uuid.uuid4().hex)
    issued_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    expires_at: datetime = field(
        default_factory=lambda: datetime.now(UTC) + timedelta(seconds=_DEFAULT_TTL_SECONDS)
    )
    signature: str | None = None

    def canonical_payload(self) -> bytes:
        """The exact bytes the signature covers.

        Sorted keys and separators without whitespace make this stable across
        languages, so the TypeScript control plane and the Python sandbox
        runtime agree byte-for-byte.
        """
        return json.dumps(
            {
                "alg": _ALG,
                "lease_id": self.lease_id,
                "tenant_id": self.tenant_id,
                "run_id": self.run_id,
                "tool": self.tool,
                "args": _canonicalise(self.args),
                "nonce": self.nonce,
                "issued_at": self.issued_at.astimezone(UTC).isoformat(),
                "expires_at": self.expires_at.astimezone(UTC).isoformat(),
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")


def sign(envelope: Envelope, key: bytes) -> Envelope:
    """Return a copy of ``envelope`` carrying its signature."""
    if not key:
        raise SignatureError("signing key is empty")
    digest = hmac.new(key, envelope.canonical_payload(), hashlib.sha256).hexdigest()
    return Envelope(
        lease_id=envelope.lease_id,
        tenant_id=envelope.tenant_id,
        run_id=envelope.run_id,
        tool=envelope.tool,
        args=envelope.args,
        nonce=envelope.nonce,
        issued_at=envelope.issued_at,
        expires_at=envelope.expires_at,
        signature=digest,
    )


def derive_lease_signing_key(root_key: bytes, lease: Lease) -> bytes:
    """Derive the per-lease RPC HMAC key promised by the envelope binding.

    Only the derived key is injected into the sandbox runtime. Compromising one
    sandbox therefore does not reveal the root key or any sibling lease key.
    """
    if not root_key:
        raise SignatureError("root signing key is empty")
    info = (
        f"loopit-sandbox-rpc:lease={lease.lease_id}:tenant={lease.tenant_id}:run={lease.run_id}"
    ).encode()
    pseudorandom_key = hmac.new(_HKDF_SALT, root_key, _HKDF_HASH).digest()
    return hmac.new(pseudorandom_key, info + b"\x01", _HKDF_HASH).digest()[:_HKDF_LENGTH]


def verify(
    envelope: Envelope,
    key: bytes,
    lease: Lease,
    *,
    seen_nonces: set[str] | None = None,
    now: datetime | None = None,
) -> None:
    """Verify an envelope against its key and lease. Raises on any failure.

    Checks, in order: signature, expiry, lease binding, tool permission, replay.
    Every failure is fatal — there is no partial acceptance.

    Args:
        seen_nonces: per-lease nonce cache. Supply it to enforce single use.

    Raises:
        SignatureError, ExpiredEnvelopeError, LeaseMismatchError, ReplayError
    """
    if not envelope.signature:
        raise SignatureError("envelope is unsigned")

    expected = hmac.new(key, envelope.canonical_payload(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, envelope.signature):
        raise SignatureError("envelope signature does not verify")

    moment = now or datetime.now(UTC)
    if moment >= envelope.expires_at:
        raise ExpiredEnvelopeError("envelope has expired")
    if lease.is_expired(moment):
        raise ExpiredEnvelopeError(f"lease {lease.lease_id!r} has expired")

    if envelope.lease_id != lease.lease_id:
        raise LeaseMismatchError(
            f"envelope is bound to lease {envelope.lease_id!r}, not {lease.lease_id!r}"
        )
    if envelope.tenant_id != lease.tenant_id:
        raise LeaseMismatchError("envelope tenant does not match the lease tenant")
    if envelope.run_id != lease.run_id:
        raise LeaseMismatchError("envelope run does not match the lease run")

    if not lease.permits(envelope.tool):
        raise LeaseMismatchError(
            f"tool {envelope.tool!r} is not in this lease's tool surface; "
            "tool output can never silently escalate permissions"
        )

    if seen_nonces is not None:
        if envelope.nonce in seen_nonces:
            raise ReplayError(f"envelope nonce {envelope.nonce!r} was already used")
        seen_nonces.add(envelope.nonce)


def _canonicalise(value: Any) -> Any:
    """Make nested mappings order-independent for signing."""
    if isinstance(value, Mapping):
        return {key: _canonicalise(value[key]) for key in sorted(value, key=str)}
    if isinstance(value, list | tuple):
        return [_canonicalise(item) for item in value]
    return value
