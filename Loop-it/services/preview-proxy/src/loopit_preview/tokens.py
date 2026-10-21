"""Signed, scoped, short-lived preview tokens.

A preview URL is a capability. Anyone holding it can see a tenant's
in-progress application, which routinely contains their real data. So the
token, not the URL's obscurity, is the access control: unguessable hostnames
are not a security boundary because they leak through referrers, logs, chat
messages and screenshots.

Three properties are load-bearing:

* **Signed.** HMAC-SHA256 over the whole payload, verified in constant time.
  Without this the token is a claim, not a proof.
* **Scoped to one project.** A token minted for project A must not open
  project B, even inside the same tenant, or a shared link becomes a
  cross-project read.
* **Short-lived.** Sandboxes are ephemeral; a token that outlives its lease
  is a credential with no owner.

Tokens are opaque to the browser and carry no secret material of their own —
only identifiers, an expiry, and the signature over them.
"""

from __future__ import annotations

import base64
import hmac
import json
from dataclasses import dataclass
from hashlib import sha256
from typing import Any

from .errors import TokenExpired, TokenInvalid

#: Preview tokens expire fast. They are refreshed by the authenticated control
#: plane, so a short life costs a round trip, not a broken preview.
DEFAULT_TTL_SECONDS = 900

#: Minimum signing-key length. A short HMAC key is a brute-forceable one, and
#: the failure is silent — everything keeps working right up until it doesn't.
MIN_KEY_BYTES = 32


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    try:
        return base64.urlsafe_b64decode(text + padding)
    except (ValueError, TypeError) as exc:  # pragma: no cover - defensive
        raise TokenInvalid("token is not valid base64url") from exc


@dataclass(frozen=True, slots=True)
class PreviewClaims:
    """What a preview token asserts."""

    project_id: str
    tenant_id: str
    lease_id: str
    subject: str
    expires_at: float

    def __post_init__(self) -> None:
        for name in ("project_id", "tenant_id", "lease_id", "subject"):
            if not getattr(self, name):
                raise ValueError(f"{name} must not be empty")

    def as_payload(self) -> dict[str, Any]:
        return {
            "project_id": self.project_id,
            "tenant_id": self.tenant_id,
            "lease_id": self.lease_id,
            "sub": self.subject,
            "exp": self.expires_at,
        }


class TokenSigner:
    """Mints and verifies preview tokens."""

    def __init__(self, key: bytes) -> None:
        if len(key) < MIN_KEY_BYTES:
            raise ValueError(f"signing key must be at least {MIN_KEY_BYTES} bytes")
        self._key = key

    def _sign(self, body: str) -> str:
        return _b64e(hmac.new(self._key, body.encode("utf-8"), sha256).digest())

    def mint(self, claims: PreviewClaims) -> str:
        # Sorted keys and compact separators keep the signed bytes reproducible;
        # a payload whose serialisation varies cannot be verified reliably.
        body = _b64e(
            json.dumps(claims.as_payload(), sort_keys=True, separators=(",", ":")).encode("utf-8")
        )
        return f"{body}.{self._sign(body)}"

    def verify(self, token: str, *, now: float) -> PreviewClaims:
        """Verify signature then expiry, and return the claims.

        Signature is checked *before* expiry so an attacker cannot use the
        difference between "expired" and "invalid" to confirm that a forged
        token's structure was otherwise acceptable.
        """
        body, _, signature = token.partition(".")
        if not body or not signature:
            raise TokenInvalid("token must be '<payload>.<signature>'")
        if not hmac.compare_digest(signature, self._sign(body)):
            raise TokenInvalid("signature does not verify")

        try:
            payload = json.loads(_b64d(body))
        except (ValueError, UnicodeDecodeError) as exc:
            raise TokenInvalid("token payload is not valid JSON") from exc
        if not isinstance(payload, dict):
            raise TokenInvalid("token payload is not an object")

        try:
            claims = PreviewClaims(
                project_id=str(payload["project_id"]),
                tenant_id=str(payload["tenant_id"]),
                lease_id=str(payload["lease_id"]),
                subject=str(payload["sub"]),
                expires_at=float(payload["exp"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise TokenInvalid("token payload is missing required claims") from exc

        if now >= claims.expires_at:
            raise TokenExpired("preview token has expired")
        return claims


def mint_for(
    signer: TokenSigner,
    *,
    project_id: str,
    tenant_id: str,
    lease_id: str,
    subject: str,
    now: float,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> str:
    """Convenience minting helper used by the control plane."""
    if ttl_seconds <= 0:
        raise ValueError("ttl_seconds must be positive")
    return signer.mint(
        PreviewClaims(
            project_id=project_id,
            tenant_id=tenant_id,
            lease_id=lease_id,
            subject=subject,
            expires_at=now + ttl_seconds,
        )
    )
