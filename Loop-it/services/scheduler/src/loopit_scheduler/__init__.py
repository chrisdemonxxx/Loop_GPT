"""Sandbox scheduling (Doc 02 §2 §6, ADR-0009, P1-1).

The scheduler is where the isolation model becomes operational. Sandboxes are
cattle: booted warm, leased to exactly one tenant and one run, capped at lease
time, and destroyed when the run ends or its TTL passes. Nothing is reset and
reused, because a reset sandbox still carries the last tenant's caches, and that
is a data leak wearing the costume of an optimisation.
"""

from .errors import (
    LeaseExpired,
    LeaseNotFound,
    MissingProviderDependency,
    PoolExhausted,
    ProviderConfigurationError,
    SandboxReuseRefused,
    SchedulerError,
    TenantConcurrencyExceeded,
)
from .factory import SchedulerSettings, create_sandbox_provider, create_scheduler, create_warm_pool
from .pool import WarmPool
from .provider import (
    DockerProvider,
    E2BProvider,
    InMemoryProvider,
    Sandbox,
    SandboxProvider,
    SandboxState,
)
from .scheduler import (
    DEFAULT_TENANT_CONCURRENCY,
    Assignment,
    CheckpointPinner,
    Scheduler,
)

__all__ = [
    "DEFAULT_TENANT_CONCURRENCY",
    "Assignment",
    "CheckpointPinner",
    "DockerProvider",
    "E2BProvider",
    "InMemoryProvider",
    "LeaseExpired",
    "LeaseNotFound",
    "MissingProviderDependency",
    "PoolExhausted",
    "ProviderConfigurationError",
    "Sandbox",
    "SandboxProvider",
    "SandboxReuseRefused",
    "SandboxState",
    "Scheduler",
    "SchedulerError",
    "SchedulerSettings",
    "TenantConcurrencyExceeded",
    "WarmPool",
    "create_sandbox_provider",
    "create_scheduler",
    "create_warm_pool",
]
