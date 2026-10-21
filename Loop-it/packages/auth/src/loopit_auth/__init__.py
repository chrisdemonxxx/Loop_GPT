"""Self-hosted auth for Loop-it's gateway and downstream services."""

from .guard import GuardDecision, PlanQuota, PreflightGuard
from .identity import IdentityTokenError, SignedIdentity, TokenSigner, VerifiedIdentity
from .idp import IdentityProvider, OIDCProviderStub
from .models import Actor, AuthUser, Membership, Org, Role
from .operator import (
    DEFAULT_OPERATOR_AUDIENCE,
    DEFAULT_OPERATOR_ISSUER,
    PLATFORM_OPERATOR_SCOPE,
    OperatorTokenIssuer,
    OperatorTokenSettings,
)
from .passwords import PasswordHasher
from .rbac import Action, Resource, authorize
from .repository import InMemoryAuthRepository, PostgresAuthRepository
from .service import AuthService, LoginError, RegistrationResult

__all__ = [
    "DEFAULT_OPERATOR_AUDIENCE",
    "DEFAULT_OPERATOR_ISSUER",
    "PLATFORM_OPERATOR_SCOPE",
    "Action",
    "Actor",
    "AuthService",
    "AuthUser",
    "GuardDecision",
    "IdentityProvider",
    "IdentityTokenError",
    "InMemoryAuthRepository",
    "LoginError",
    "Membership",
    "OIDCProviderStub",
    "OperatorTokenIssuer",
    "OperatorTokenSettings",
    "Org",
    "PasswordHasher",
    "PlanQuota",
    "PostgresAuthRepository",
    "PreflightGuard",
    "RegistrationResult",
    "Resource",
    "Role",
    "SignedIdentity",
    "TokenSigner",
    "VerifiedIdentity",
    "authorize",
]
