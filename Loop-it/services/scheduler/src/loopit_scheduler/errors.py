"""Scheduler refusals.

Each of these is a deliberate stop. The alternative to refusing — handing back a
sandbox that is expired, over quota, or previously used by another tenant — is
how isolation quietly stops being isolation.
"""

from __future__ import annotations


class SchedulerError(Exception):
    """Base class for scheduler failures."""


class PoolExhausted(SchedulerError):
    """No sandbox capacity is available right now.

    Refusing is correct: exceeding the host's capacity rather than queueing
    turns one tenant's burst into every tenant's outage.
    """


class LeaseNotFound(SchedulerError):
    """No such active lease."""


class TenantConcurrencyExceeded(SchedulerError):
    """The tenant already holds its maximum number of concurrent sandboxes."""


class SandboxReuseRefused(SchedulerError):
    """Something tried to hand a used sandbox to a second tenant.

    A used sandbox holds the previous tenant's files, caches, environment and
    process residue. Reuse across tenants is a data leak, not an optimisation
    (Doc 02 §2, invariant I1).
    """


class LeaseExpired(SchedulerError):
    """The lease's TTL has passed and it can no longer be used."""


class MissingProviderDependency(SchedulerError):
    """A real sandbox provider was selected but its optional SDK is not installed."""


class ProviderConfigurationError(SchedulerError):
    """A real sandbox provider is missing required configuration."""
