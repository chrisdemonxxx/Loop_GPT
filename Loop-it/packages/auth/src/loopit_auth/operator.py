from __future__ import annotations

import os
from dataclasses import dataclass

from loopit_agent_core.config import require_secret

from .identity import TokenSigner, VerifiedIdentity

PLATFORM_OPERATOR_SCOPE = "platform:operate"
DEFAULT_OPERATOR_ISSUER = "loopit-operator"
DEFAULT_OPERATOR_AUDIENCE = "loopit-platform-operator"


@dataclass(frozen=True, slots=True)
class OperatorTokenSettings:
    issuer: str = DEFAULT_OPERATOR_ISSUER
    audience: str = DEFAULT_OPERATOR_AUDIENCE
    kid: str = "operator-1"
    secret: str = ""
    ttl_seconds: int = 900

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> OperatorTokenSettings:
        source = os.environ if env is None else env
        return cls(
            issuer=source.get("LOOPIT_OPERATOR_IDENTITY_ISSUER", DEFAULT_OPERATOR_ISSUER),
            audience=source.get("LOOPIT_OPERATOR_IDENTITY_AUDIENCE", DEFAULT_OPERATOR_AUDIENCE),
            kid=source.get("LOOPIT_OPERATOR_IDENTITY_KID", "operator-1"),
            secret=require_secret(source, "LOOPIT_OPERATOR_IDENTITY_SECRET"),
            ttl_seconds=int(source.get("LOOPIT_OPERATOR_TOKEN_TTL_SECONDS", "900")),
        )


class OperatorTokenIssuer:
    """Issues platform-operator credentials outside customer auth flows."""

    def __init__(self, settings: OperatorTokenSettings) -> None:
        if not settings.secret:
            raise ValueError("operator token signing secret is required")
        self._settings = settings
        self._signer = TokenSigner(
            issuer=settings.issuer,
            audience=settings.audience,
            keys={settings.kid: settings.secret.encode()},
            current_kid=settings.kid,
        )

    @property
    def audience(self) -> str:
        return self._settings.audience

    def mint(
        self,
        *,
        subject: str,
        ttl_seconds: int | None = None,
        now: int | None = None,
    ) -> str:
        return self._signer.mint_identity(
            subject=subject,
            org_id="platform",
            role="admin",
            scopes=(PLATFORM_OPERATOR_SCOPE,),
            ttl_seconds=ttl_seconds or self._settings.ttl_seconds,
            now=now,
        )

    def verify(self, token: str, *, now: int | None = None) -> VerifiedIdentity:
        identity = self._signer.verify_identity(token, now=now)
        if PLATFORM_OPERATOR_SCOPE not in identity.scopes:
            raise ValueError("operator token is missing platform scope")
        return identity
