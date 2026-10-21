"""Environments and secret classes — the two axes the broker refuses to cross.

Two orthogonal facts about a secret decide whether a build step may ever see it,
and both are modelled as closed enumerations rather than free-form strings so a
typo or an injected string cannot widen access:

**Environment** is the build↔prod firewall axis (Doc 06 §4.3). A build sandbox
and the deployed app get *separate* databases, auth, storage, and secrets; a
compromised build must never reach production data. Enumerating the environment
lets the store partition on it and lets a broker bind to exactly one, which is
what makes the firewall structural in :mod:`loopit_secrets.store` rather than a
comparison someone can forget.

**SecretClass** is the ownership axis. Only :attr:`SecretClass.PROJECT` — a
user's own project secret — may ever be leased into that user's build step. Every
other class is platform-owned: model keys belong to the router (I5), cloud and
DB-admin creds belong to the control plane, and another tenant's secret is never
in scope. :data:`PLATFORM_OWNED` names them so both the store (at insert) and the
broker (at request) can refuse them, ensuring a project step cannot ask for one.
"""

from __future__ import annotations

from enum import Enum


class Environment(Enum):
    """The plane a secret and a broker belong to (Doc 06 §4.3).

    Membership is identity-checked (``is``) throughout, so a broker bound to
    :attr:`BUILD` can never be talked into resolving a :attr:`PROD` secret.
    """

    BUILD = "build"
    PREVIEW = "preview"
    PROD = "prod"


class SecretClass(Enum):
    """Who owns a secret, which decides whether a project step may lease it."""

    PROJECT = "project"
    MODEL_KEY = "model_key"
    CLOUD_CREDENTIAL = "cloud_credential"
    DB_ADMIN = "db_admin"
    FOREIGN_TENANT = "foreign_tenant"


#: Every class a build step may never hold. Model keys are excluded because the
#: sandbox reaches models only through the router (I5); the rest are control-plane
#: or cross-tenant material that has no business in any sandbox (Doc 06 §4.1).
PLATFORM_OWNED: frozenset[SecretClass] = frozenset(
    cls for cls in SecretClass if cls is not SecretClass.PROJECT
)

#: Well-known names for platform-owned material. A project step is refused if it
#: declares one of these even before any store lookup, so the router-only rule
#: for model keys is enforced at the request boundary and not merely by hoping
#: the key was never loaded into a project store. Names, not values.
PLATFORM_RESERVED_NAMES: frozenset[str] = frozenset(
    {
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "HF_TOKEN",
        "HUGGINGFACE_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "GCP_SERVICE_ACCOUNT_KEY",
        "AZURE_CLIENT_SECRET",
        "DATABASE_ADMIN_URL",
        "PLATFORM_ROOT_KEY",
    }
)
