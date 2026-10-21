"""The broker's error taxonomy, split by *what went wrong and who caused it*.

The distinction that matters here is a denial (the request was well-formed but
policy forbids it — an undeclared name, a cross-plane reach, a platform-owned
class) versus an invalid redemption (a lease that no longer authorises anything —
expired, revoked, forged, or replayed from another step). Both are audited, but
they mean different things to a caller and to an investigator: a denial is a
policy event on a live request, an invalid redemption is an attempt to use a
capability that is already dead.

None of these exceptions carries a secret value; they carry names and lease ids,
matching Doc 08 §5.
"""

from __future__ import annotations


class SecretsBrokerError(Exception):
    """Base class for every broker failure."""


class EnvironmentMismatch(SecretsBrokerError):
    """A store was wired to a broker of a different environment, or a secret of
    the wrong environment was inserted. Fails closed rather than silently
    crossing the build↔prod firewall."""


class LeaseDenied(SecretsBrokerError):
    """A lease request was refused by policy before any lease was issued."""


class UndeclaredSecret(LeaseDenied):
    """The step asked for a name it did not declare it needed (least privilege)."""


class SecretNotFound(LeaseDenied):
    """No such secret exists for this tenant/project in this environment.

    This is also the firewall's answer to a build step reaching for a prod
    secret: the build store simply does not contain it.
    """


class PlatformSecretForbidden(LeaseDenied):
    """A platform-owned class (model key, cloud/DB-admin cred, another tenant's
    secret) was requested or inserted into a project store. A project step can
    never hold one — model keys reach models only via the router (I5)."""


class SecretStoreConfigurationError(SecretsBrokerError):
    """The encrypted persistent store cannot start safely.

    Missing, malformed, or too-short root keys fail closed before any secret is
    accepted or decrypted.
    """


class SecretStoreIntegrityError(SecretsBrokerError):
    """Stored ciphertext or metadata failed authenticated verification."""


class LeaseTooLong(LeaseDenied):
    """The requested time-to-live exceeds the short-lived cap, or is non-positive."""


class LeaseInvalid(SecretsBrokerError):
    """A redemption presented a lease that no longer authorises access."""


class UnknownLease(LeaseInvalid):
    """No live lease with this id exists — a forged or replayed-after-purge id."""


class LeaseExpired(LeaseInvalid):
    """The lease's expiry has passed; access lapsed on its own."""


class LeaseRevoked(LeaseInvalid):
    """The lease was revoked (step completed, run cancelled, or explicit revoke)."""


class LeaseMismatch(LeaseInvalid):
    """The presented handle does not match the recorded lease for its id — a
    tampered or replayed handle claiming another step's identity."""
