"""JWT issuance helpers for generated apps.

The React/Postgres stack verifies HS256 bearer tokens and reads ``sub`` plus
``org_id`` from the payload. These helpers issue exactly those claims and expose
the Postgres ``set_config`` call the stack must make before touching RLS tables.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any


class JwtError(ValueError):
    """A generated-app JWT is malformed or unverifiable."""


@dataclass(frozen=True, slots=True)
class GeneratedAppJwtIssuer:
    """Small HS256 issuer compatible with ``stack-templates/react-postgres``."""

    secret: str
    issuer: str = "loopit-provisioner"

    def issue_token(
        self,
        *,
        user_id: str,
        org_id: str | None = None,
        ttl_seconds: int = 3600,
        now: int | None = None,
    ) -> str:
        issued_at = int(time.time()) if now is None else now
        payload: dict[str, Any] = {
            "iss": self.issuer,
            "sub": user_id,
            "iat": issued_at,
            "exp": issued_at + ttl_seconds,
        }
        if org_id is not None:
            payload["org_id"] = org_id
        return _encode({"alg": "HS256", "typ": "JWT"}, payload, self.secret)

    def verify_token(self, token: str, *, now: int | None = None) -> dict[str, Any]:
        header, payload, signature = _split(token)
        if header.get("alg") != "HS256":
            raise JwtError("generated-app JWT must use HS256")
        expected = _signature(token.rsplit(".", 1)[0], self.secret)
        if not hmac.compare_digest(signature, expected):
            raise JwtError("generated-app JWT signature is invalid")
        subject = payload.get("sub")
        if not isinstance(subject, str) or not subject:
            raise JwtError("generated-app JWT is missing sub")
        exp = payload.get("exp")
        if not isinstance(exp, int):
            raise JwtError("generated-app JWT is missing exp")
        current = int(time.time()) if now is None else now
        if current >= exp:
            raise JwtError("generated-app JWT has expired")
        return payload


def postgres_claims_payload(*, user_id: str, org_id: str | None = None) -> str:
    """JSON value for ``request.jwt.claims`` used by RLS policies."""

    return json.dumps({"sub": user_id, "org_id": org_id}, separators=(",", ":"), sort_keys=True)


def set_local_claims_sql() -> tuple[str, tuple[str]]:
    """Return the parameterised statement shape the stack should execute."""

    return ("SELECT set_config('request.jwt.claims', $1, true)", ("claims_json",))


def _encode(header: dict[str, Any], payload: dict[str, Any], secret: str) -> str:
    signing_input = ".".join((_b64json(header), _b64json(payload)))
    return signing_input + "." + _signature(signing_input, secret)


def _split(token: str) -> tuple[dict[str, Any], dict[str, Any], str]:
    try:
        encoded_header, encoded_payload, signature = token.split(".")
    except ValueError as exc:
        raise JwtError("generated-app JWT must have three parts") from exc
    header = _decode_json(encoded_header)
    payload = _decode_json(encoded_payload)
    return header, payload, signature


def _b64json(value: dict[str, Any]) -> str:
    return _b64(json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def _decode_json(value: str) -> dict[str, Any]:
    decoded = json.loads(_unb64(value))
    if not isinstance(decoded, dict):
        raise JwtError("generated-app JWT section must be an object")
    return decoded


def _signature(signing_input: str, secret: str) -> str:
    digest = hmac.new(
        secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256
    ).digest()
    return _b64(digest)


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> str:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding).decode("utf-8")


__all__ = [
    "GeneratedAppJwtIssuer",
    "JwtError",
    "postgres_claims_payload",
    "set_local_claims_sql",
]
