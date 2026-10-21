"""Environment-driven scheduler/provider construction."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from loopit_agent_core.audit import AuditSink
from loopit_sandbox_sdk.lease import ResourceCaps

from .errors import ProviderConfigurationError
from .pool import WarmPool
from .provider import DockerProvider, E2BProvider, InMemoryProvider, SandboxProvider
from .scheduler import DEFAULT_TENANT_CONCURRENCY, CheckpointPinner, Scheduler


@dataclass(frozen=True, slots=True)
class SchedulerSettings:
    """Sandbox scheduler settings read from environment by default."""

    provider: str = "memory"
    e2b_template_id: str = ""
    docker_image: str = "loopit-sandbox:latest"
    docker_network: str = "none"
    pool_target_size: int = 3
    pool_max_live: int = 50
    pool_max_idle_seconds: int = 900
    tenant_concurrency: int = DEFAULT_TENANT_CONCURRENCY
    caps: ResourceCaps = field(default_factory=ResourceCaps)

    @classmethod
    def from_env(cls) -> SchedulerSettings:
        """Build settings from LOOPIT_* environment variables."""
        return cls(
            provider=os.environ.get("LOOPIT_SANDBOX_PROVIDER", "memory").lower(),
            e2b_template_id=os.environ.get("LOOPIT_E2B_TEMPLATE_ID", ""),
            docker_image=os.environ.get("LOOPIT_SANDBOX_IMAGE", "loopit-sandbox:latest"),
            docker_network=os.environ.get("LOOPIT_SANDBOX_DOCKER_NETWORK", "none"),
            pool_target_size=_env_int("LOOPIT_SANDBOX_POOL_TARGET_SIZE", 3),
            pool_max_live=_env_int("LOOPIT_SANDBOX_POOL_MAX_LIVE", 50),
            pool_max_idle_seconds=_env_int("LOOPIT_SANDBOX_POOL_MAX_IDLE_SECONDS", 900),
            tenant_concurrency=_env_int(
                "LOOPIT_SANDBOX_TENANT_CONCURRENCY", DEFAULT_TENANT_CONCURRENCY
            ),
            caps=ResourceCaps(
                cpu_millicores=_env_int("LOOPIT_SANDBOX_CPU_MILLICORES", 2000),
                memory_mib=_env_int("LOOPIT_SANDBOX_MEMORY_MIB", 4096),
                disk_mib=_env_int("LOOPIT_SANDBOX_DISK_MIB", 20480),
                wall_clock_seconds=_env_int("LOOPIT_SANDBOX_WALL_CLOCK_SECONDS", 1800),
                max_processes=_env_int("LOOPIT_SANDBOX_MAX_PROCESSES", 512),
            ),
        )


def create_sandbox_provider(settings: SchedulerSettings | None = None) -> SandboxProvider:
    """Create the configured provider: ``memory``, ``docker``, or ``e2b``."""
    resolved = settings or SchedulerSettings.from_env()
    match resolved.provider:
        case "memory" | "inmemory" | "in-memory":
            return InMemoryProvider()
        case "docker":
            return DockerProvider(image=resolved.docker_image, network=resolved.docker_network)
        case "e2b":
            return E2BProvider(template_id=resolved.e2b_template_id)
        case other:
            raise ProviderConfigurationError(
                f"unknown LOOPIT_SANDBOX_PROVIDER {other!r}; expected memory, docker, or e2b"
            )


def create_warm_pool(
    provider: SandboxProvider | None = None,
    settings: SchedulerSettings | None = None,
) -> WarmPool:
    """Create a warm pool using environment settings unless explicitly supplied."""
    resolved = settings or SchedulerSettings.from_env()
    return WarmPool(
        provider or create_sandbox_provider(resolved),
        target_size=resolved.pool_target_size,
        max_live=resolved.pool_max_live,
        max_idle_seconds=resolved.pool_max_idle_seconds,
        caps=resolved.caps,
    )


def create_scheduler(
    *,
    audit: AuditSink,
    settings: SchedulerSettings | None = None,
    provider: SandboxProvider | None = None,
    pin_checkpoints: CheckpointPinner | None = None,
) -> Scheduler:
    """Create a scheduler without callers hard-coding the provider."""
    resolved = settings or SchedulerSettings.from_env()
    return Scheduler(
        pool=create_warm_pool(provider, resolved),
        audit=audit,
        tenant_concurrency=resolved.tenant_concurrency,
        pin_checkpoints=pin_checkpoints,
    )


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ProviderConfigurationError(f"{name} must be an integer, got {raw!r}") from exc
