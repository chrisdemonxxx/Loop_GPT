from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class ExternalIdentity:
    provider: str
    subject: str
    email: str
    display_name: str | None = None


class IdentityProvider(Protocol):
    name: str

    def exchange_code(self, *, code: str, redirect_uri: str) -> ExternalIdentity: ...


@dataclass(frozen=True, slots=True)
class OIDCProviderStub:
    name: str
    issuer_url: str
    client_id: str
    scopes: tuple[str, ...] = ("openid", "email", "profile")

    def exchange_code(self, *, code: str, redirect_uri: str) -> ExternalIdentity:
        raise NotImplementedError("OIDC is configured but not wired to a live provider yet")
