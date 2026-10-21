from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any

from .models import Role


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode((data + padding).encode("ascii"))


class IdentityTokenError(Exception):
    """A gateway identity token was absent, malformed, expired, or untrusted."""


@dataclass(frozen=True, slots=True)
class SignedIdentity:
    subject: str
    org_id: str
    role: Role
    scopes: tuple[str, ...]
    audience: str
    expires_at: int
    kid: str


@dataclass(frozen=True, slots=True)
class VerifiedIdentity(SignedIdentity):
    issuer: str


class TokenSigner:
    """JWT-like HMAC signer used only by the gateway.

    Downstream services must call ``verify_identity`` and use only the returned
    claims; they must not re-read user or membership tables.
    """

    def __init__(
        self, *, issuer: str, audience: str, keys: dict[str, bytes], current_kid: str
    ) -> None:
        if current_kid not in keys:
            raise ValueError("current_kid must identify a configured signing key")
        self._issuer = issuer
        self._audience = audience
        self._keys = dict(keys)
        self._current_kid = current_kid

    @property
    def current_kid(self) -> str:
        return self._current_kid

    def mint_identity(
        self,
        *,
        subject: str,
        org_id: str,
        role: Role,
        scopes: tuple[str, ...],
        ttl_seconds: int = 900,
        now: int | None = None,
    ) -> str:
        issued = int(time.time() if now is None else now)
        header = {"alg": "HS256", "typ": "LOOPIT-ID", "kid": self._current_kid}
        payload = {
            "iss": self._issuer,
            "aud": self._audience,
            "sub": subject,
            "org": org_id,
            "role": role,
            "scopes": list(scopes),
            "iat": issued,
            "exp": issued + ttl_seconds,
        }
        signing_input = (
            _b64(json.dumps(header, sort_keys=True, separators=(",", ":")).encode())
            + "."
            + _b64(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
        )
        signature = _b64(
            hmac.new(
                self._keys[self._current_kid], signing_input.encode("ascii"), hashlib.sha256
            ).digest()
        )
        return signing_input + "." + signature

    def verify_identity(
        self, token: str, *, audience: str | None = None, now: int | None = None
    ) -> VerifiedIdentity:
        parts = token.split(".")
        if len(parts) != 3:
            raise IdentityTokenError("malformed identity token")
        encoded_header, encoded_payload, encoded_signature = parts
        try:
            header = json.loads(_unb64(encoded_header))
            payload: dict[str, Any] = json.loads(_unb64(encoded_payload))
        except Exception as exc:
            raise IdentityTokenError("malformed identity token") from exc
        if header.get("alg") != "HS256" or header.get("typ") != "LOOPIT-ID":
            raise IdentityTokenError("unsupported identity token")
        kid = str(header.get("kid", ""))
        key = self._keys.get(kid)
        if key is None:
            raise IdentityTokenError("unknown identity key")
        signing_input = encoded_header + "." + encoded_payload
        expected = _b64(hmac.new(key, signing_input.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(expected, encoded_signature):
            raise IdentityTokenError("bad identity signature")
        if payload.get("iss") != self._issuer:
            raise IdentityTokenError("bad identity issuer")
        expected_audience = audience or self._audience
        if payload.get("aud") != expected_audience:
            raise IdentityTokenError("bad identity audience")
        try:
            expires_at = int(payload.get("exp", 0))
            subject = str(payload["sub"])
            org_id = str(payload["org"])
        except (KeyError, TypeError, ValueError) as exc:
            raise IdentityTokenError("bad identity claims") from exc
        if expires_at <= int(time.time() if now is None else now):
            raise IdentityTokenError("identity token expired")
        role = payload.get("role")
        if role not in {"owner", "admin", "member", "viewer"}:
            raise IdentityTokenError("bad identity role")
        scopes = payload.get("scopes")
        if not isinstance(scopes, list) or not all(isinstance(scope, str) for scope in scopes):
            raise IdentityTokenError("bad identity scopes")
        return VerifiedIdentity(
            subject=subject,
            org_id=org_id,
            role=role,
            scopes=tuple(scopes),
            audience=expected_audience,
            expires_at=expires_at,
            kid=kid,
            issuer=str(payload["iss"]),
        )
