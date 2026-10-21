from __future__ import annotations

import base64
import hashlib
import secrets
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlencode

from loopit_auth import AuthUser, Org, Role
from loopit_auth.idp import ExternalIdentity


class OIDCError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class OIDCConfig:
    org_id: str
    issuer: str
    client_id: str
    audience: str
    redirect_uri: str
    group_role_map: Mapping[str, Role]
    default_role: Role = "viewer"
    scopes: tuple[str, ...] = ("openid", "email", "profile", "groups")


@dataclass(frozen=True, slots=True)
class AuthorizationRequest:
    url: str
    state: str
    nonce: str
    code_verifier: str


@dataclass(frozen=True, slots=True)
class OIDCLoginResult:
    identity: ExternalIdentity
    user_id: str
    org_id: str
    role: Role


class OIDCIdP(Protocol):
    def exchange_code(
        self, *, code: str, redirect_uri: str, code_verifier: str
    ) -> Mapping[str, object]: ...


class AuthRepository(Protocol):
    def get_org(self, org_id: str) -> Org | None: ...

    def create_org(self, *, name: str, org_id: str | None = None) -> Org: ...

    def find_user_by_email(self, *, email: str, org_id: str) -> AuthUser | None: ...

    def create_user(
        self,
        *,
        email: str,
        password_hash: str,
        display_name: str | None,
        org_id: str,
        role: Role = "owner",
    ) -> AuthUser: ...

    def add_membership(self, *, user_id: str, org_id: str, role: Role) -> object: ...


class OIDCClient:
    name = "oidc"

    def __init__(self, *, config: OIDCConfig, repository: AuthRepository, idp: OIDCIdP) -> None:
        self._config = config
        self._repo = repository
        self._idp = idp

    def authorization_request(self) -> AuthorizationRequest:
        state = secrets.token_urlsafe(24)
        nonce = secrets.token_urlsafe(24)
        verifier = secrets.token_urlsafe(48)
        challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
        query = urlencode(
            {
                "response_type": "code",
                "client_id": self._config.client_id,
                "redirect_uri": self._config.redirect_uri,
                "scope": " ".join(self._config.scopes),
                "state": state,
                "nonce": nonce,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            }
        )
        return AuthorizationRequest(
            f"{self._config.issuer.rstrip('/')}/authorize?{query}", state, nonce, verifier
        )

    def complete_login(
        self, *, code: str, redirect_uri: str, code_verifier: str, expected_nonce: str
    ) -> OIDCLoginResult:
        claims = self._idp.exchange_code(
            code=code, redirect_uri=redirect_uri, code_verifier=code_verifier
        )
        self._validate(claims, expected_nonce)
        email = str(claims["email"]).strip().lower()
        display_name = str(claims.get("name") or email)
        raw_groups: object = claims.get("groups", ())
        group_names: tuple[str, ...] = ()
        if isinstance(raw_groups, str):
            group_names = tuple([raw_groups])
        elif isinstance(raw_groups, list | tuple | set | frozenset):
            group_names = tuple(str(group) for group in raw_groups)
        else:
            group_names = tuple()
        role = self._role_for(group_names)
        repo = self._repo
        org = repo.get_org(self._config.org_id)
        if org is None:
            repo.create_org(name=self._config.org_id, org_id=self._config.org_id)
        user = repo.find_user_by_email(email=email, org_id=self._config.org_id)
        if user is None:
            user = repo.create_user(
                email=email,
                password_hash="oidc-" + "external-subject",
                display_name=display_name,
                org_id=self._config.org_id,
                role=role,
            )
        else:
            repo.add_membership(user_id=user.user_id, org_id=self._config.org_id, role=role)
        identity = ExternalIdentity(
            provider=self.name, subject=str(claims["sub"]), email=email, display_name=display_name
        )
        return OIDCLoginResult(identity, user.user_id, self._config.org_id, role)

    def exchange_code(self, *, code: str, redirect_uri: str) -> ExternalIdentity:
        raise OIDCError("use complete_login with PKCE verifier and expected nonce")

    def _validate(self, claims: Mapping[str, object], expected_nonce: str) -> None:
        required = ("iss", "aud", "nonce", "sub", "email")
        if any(key not in claims for key in required):
            raise OIDCError("OIDC claims are incomplete")
        if claims["iss"] != self._config.issuer:
            raise OIDCError("issuer mismatch")
        aud = claims["aud"]
        if isinstance(aud, str):
            audiences = {aud}
        elif isinstance(aud, list | tuple | set | frozenset):
            audiences = {str(item) for item in aud}
        else:
            audiences = set()
        if self._config.audience not in audiences and self._config.client_id not in audiences:
            raise OIDCError("audience mismatch")
        if claims["nonce"] != expected_nonce:
            raise OIDCError("nonce mismatch")

    def _role_for(self, groups: tuple[str, ...]) -> Role:
        rank: dict[Role, int] = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}
        role = self._config.default_role
        for group in groups:
            mapped = self._config.group_role_map.get(group)
            if mapped is not None and rank[mapped] > rank[role]:
                role = mapped
        return role


class FakeOIDCIdP:
    def __init__(self, claims_by_code: Mapping[str, Mapping[str, object]]) -> None:
        self._claims_by_code = claims_by_code
        self.requests: list[tuple[str, str, str]] = []

    def exchange_code(
        self, *, code: str, redirect_uri: str, code_verifier: str
    ) -> Mapping[str, object]:
        self.requests.append((code, redirect_uri, code_verifier))
        try:
            return self._claims_by_code[code]
        except KeyError as exc:
            raise OIDCError("invalid authorization code") from exc


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
