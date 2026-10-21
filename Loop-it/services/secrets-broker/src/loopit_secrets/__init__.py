"""The control-plane secrets broker — JIT, per-step secret injection (Doc 08 §5).

The cardinal rule is stated the same way in three handbooks and it is the reason
this service exists: **there are no ambient credentials in the sandbox.** A
user's project secret reaches a build step *only* when that step genuinely needs
that specific key, and never a moment longer than the step that needs it. The
sandbox never holds a model API key at all — model access is proxied by the
router (invariant I5), so those keys are refused here structurally.

Five design commitments carry that rule, and each is deliberately structural
rather than a runtime ``if`` that prompt injection could flip:

1. **A lease, not a copy** (:mod:`loopit_secrets.lease`). A secret is released as
   a short-lived, single-step lease bound to one run and one step, with an
   explicit expiry. The plaintext never lives in the lease handle; every read
   goes back through the broker, which can therefore revoke and expire access.
2. **Least privilege by declaration** (:class:`~loopit_secrets.broker.StepContext`).
   A step declares the secret *names* it needs. There is no "give me everything"
   call; a request for an undeclared name is denied and audited.
3. **A structural build↔prod firewall** (:mod:`loopit_secrets.store`). Secrets
   are partitioned by :class:`~loopit_secrets.environment.Environment`, and a
   broker is wired to exactly one environment's store. A build-plane broker holds
   no reference to prod secrets and has no parameter that could name one, so it
   *cannot* resolve a prod key — there is no code path, not merely a guard.
4. **Values never enter logs, audits, or errors**
   (:mod:`loopit_secrets.values`). Plaintext is wrapped in
   :class:`~loopit_secrets.values.SecretValue`, whose ``repr``/``str`` redact;
   audit records and exceptions carry secret *names* and lease ids only.
5. **Platform-owned classes are refused** (:mod:`loopit_secrets.environment`).
   Model keys, cloud creds, DB-admin creds, and other tenants' secrets can never
   enter a project store and are refused at request time, so a project step
   cannot ask for them at all.
"""

from __future__ import annotations

from .broker import MAX_LEASE_TTL, SecretsBroker, StepContext
from .environment import (
    PLATFORM_OWNED,
    PLATFORM_RESERVED_NAMES,
    Environment,
    SecretClass,
)
from .errors import (
    EnvironmentMismatch,
    LeaseDenied,
    LeaseExpired,
    LeaseInvalid,
    LeaseMismatch,
    LeaseRevoked,
    LeaseTooLong,
    PlatformSecretForbidden,
    SecretNotFound,
    SecretsBrokerError,
    SecretStoreConfigurationError,
    SecretStoreIntegrityError,
    UndeclaredSecret,
    UnknownLease,
)
from .lease import Lease, LeaseState
from .store import (
    EncryptedSecretRecord,
    EnvelopeSecretCodec,
    InMemoryEncryptedSecretRepository,
    PersistentSecretStore,
    PostgresSecretStore,
    RootKey,
    SecretStore,
    StoredSecret,
    VaultSecretStore,
    load_root_key_from_env,
    store_from_env,
)
from .values import SecretValue

__all__ = [
    "MAX_LEASE_TTL",
    "PLATFORM_OWNED",
    "PLATFORM_RESERVED_NAMES",
    "EncryptedSecretRecord",
    "EnvelopeSecretCodec",
    "Environment",
    "EnvironmentMismatch",
    "InMemoryEncryptedSecretRepository",
    "Lease",
    "LeaseDenied",
    "LeaseExpired",
    "LeaseInvalid",
    "LeaseMismatch",
    "LeaseRevoked",
    "LeaseState",
    "LeaseTooLong",
    "PersistentSecretStore",
    "PlatformSecretForbidden",
    "PostgresSecretStore",
    "RootKey",
    "SecretClass",
    "SecretNotFound",
    "SecretStore",
    "SecretStoreConfigurationError",
    "SecretStoreIntegrityError",
    "SecretValue",
    "SecretsBroker",
    "SecretsBrokerError",
    "StepContext",
    "StoredSecret",
    "UndeclaredSecret",
    "UnknownLease",
    "VaultSecretStore",
    "load_root_key_from_env",
    "store_from_env",
]
