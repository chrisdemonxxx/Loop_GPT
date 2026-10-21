from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from loopit_agent_core.audit import AuditEvent, Outcome
from loopit_store import AuditStore

from .identity import TokenSigner
from .models import AuthUser, Membership, Org, now_utc
from .passwords import PasswordHasher


class LoginError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class RegistrationResult:
    user: AuthUser
    org: Org
    membership: Membership
    identity_token: str


class AuthService:
    def __init__(
        self,
        *,
        repository: Any,
        audit: AuditStore,
        signer: TokenSigner,
        password_hasher: PasswordHasher | None = None,
        max_failures: int = 5,
        lockout_seconds: int = 900,
    ) -> None:
        self._repo = repository
        self._audit = audit
        self._signer = signer
        self._hasher = password_hasher or PasswordHasher()
        self._max_failures = max_failures
        self._lockout = timedelta(seconds=lockout_seconds)

    def register(
        self, *, email: str, password: str, org_name: str, display_name: str | None = None
    ) -> RegistrationResult:
        org = self._repo.create_org(name=org_name)
        user = self._repo.create_user(
            email=email,
            password_hash=self._hasher.hash(password),
            display_name=display_name,
            org_id=org.org_id,
            role="owner",
        )
        membership = self._repo.membership(user_id=user.user_id, org_id=org.org_id)
        if membership is None:
            raise RuntimeError("membership was not created")
        self._audit_auth("auth.register", user=user, org_id=org.org_id, outcome="success")
        token = self._signer.mint_identity(
            subject=user.user_id, org_id=org.org_id, role=membership.role, scopes=("api", "runs")
        )
        return RegistrationResult(user=user, org=org, membership=membership, identity_token=token)

    def login(self, *, email: str, password: str, org_id: str) -> str:
        user = self._repo.find_user_by_email(email=email, org_id=org_id)
        if user is None:
            self._audit_unknown(
                "auth.login", org_id=org_id, outcome="denied", reason="unknown_user"
            )
            raise LoginError("invalid credentials")
        failures, lock_until = self._repo.failure_state(user.user_id)
        if lock_until is not None and lock_until > now_utc():
            self._audit_auth(
                "auth.login", user=user, org_id=org_id, outcome="denied", reason="locked"
            )
            raise LoginError("account locked")
        encoded = self._repo.password_hash_for(user.user_id)
        if encoded is None or not self._hasher.verify(password, encoded):
            next_count = failures + 1
            self._repo.record_failure(
                user.user_id,
                lock_until=now_utc() + self._lockout if next_count >= self._max_failures else None,
            )
            self._audit_auth(
                "auth.login", user=user, org_id=org_id, outcome="denied", reason="bad_credentials"
            )
            raise LoginError("invalid credentials")
        membership = self._repo.membership(user_id=user.user_id, org_id=org_id)
        if membership is None:
            self._audit_auth(
                "auth.login", user=user, org_id=org_id, outcome="denied", reason="not_member"
            )
            raise LoginError("not a member of org")
        self._repo.clear_failures(user.user_id)
        self._audit_auth("auth.login", user=user, org_id=org_id, outcome="success")
        return self._signer.mint_identity(
            subject=user.user_id, org_id=org_id, role=membership.role, scopes=("api", "runs")
        )

    def issue_password_reset(self, *, email: str, org_id: str) -> None:
        user = self._repo.find_user_by_email(email=email, org_id=org_id)
        if user is None:
            self._audit_unknown(
                "auth.password_reset", org_id=org_id, outcome="denied", reason="unknown_user"
            )
            return
        self._repo.create_reset_token(user_id=user.user_id, ttl=timedelta(minutes=30))
        self._audit_auth(
            "auth.password_reset",
            user=user,
            org_id=org_id,
            outcome="pending",
            reason="issued",
        )

    def _audit_auth(
        self,
        event_type: str,
        *,
        user: AuthUser,
        org_id: str,
        outcome: Outcome,
        reason: str | None = None,
    ) -> None:
        self._audit.append(
            AuditEvent(
                type=event_type,
                tenant_id=org_id,
                actor_kind="user",
                actor_id=user.user_id,
                plane="control",
                outcome=outcome,
                detail={"reason": reason} if reason else {},
            )
        )

    def _audit_unknown(
        self, event_type: str, *, org_id: str, outcome: Outcome, reason: str
    ) -> None:
        self._audit.append(
            AuditEvent(
                type=event_type,
                tenant_id=org_id,
                actor_kind="user",
                actor_id=None,
                plane="control",
                outcome=outcome,
                detail={"reason": reason},
            )
        )
