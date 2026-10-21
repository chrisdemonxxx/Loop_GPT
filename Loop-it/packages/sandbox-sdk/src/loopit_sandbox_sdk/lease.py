"""Sandbox leases and their resource caps (Doc 02 §2, §6).

Sandboxes are cattle, not pets. One project or one fork gets a fresh sandbox; it
is destroyed afterwards and never returned to the pool for another tenant,
because dirty state is a cross-tenant leak. Durable state lives in the
copy-on-write project filesystem, not on the VM.

Caps are set at lease time, not negotiated at runtime: a capped miner is still a
miner, but an uncapped one starves the host.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta


class LeaseError(ValueError):
    """A lease is invalid and must not be issued."""


@dataclass(frozen=True, slots=True)
class ResourceCaps:
    """Hard limits applied to a sandbox at lease time.

    Every field has a bounded default: an unset cap is how a single tenant ends
    up owning the host.
    """

    cpu_millicores: int = 2000
    memory_mib: int = 4096
    disk_mib: int = 20480
    wall_clock_seconds: int = 1800
    max_processes: int = 512

    def __post_init__(self) -> None:
        for name, value in (
            ("cpu_millicores", self.cpu_millicores),
            ("memory_mib", self.memory_mib),
            ("disk_mib", self.disk_mib),
            ("wall_clock_seconds", self.wall_clock_seconds),
            ("max_processes", self.max_processes),
        ):
            if value <= 0:
                raise LeaseError(f"{name} must be positive, got {value!r}")


@dataclass(frozen=True, slots=True)
class Lease:
    """One sandbox, bound to exactly one run and one tenant.

    Attributes:
        lease_id: identifies this sandbox instance.
        tenant_id: the single tenant this sandbox may ever serve.
        run_id: the single run it is bound to.
        base_checkpoint_id: the immutable checkpoint its CoW view forks from.
            Runs never execute against mutable "current" files.
        expires_at: hard TTL. No lease is open-ended.
        caps: resource limits applied at lease time.
        allowed_tools: the least-privilege tool surface for this lease. A tool
            absent here cannot be invoked, whatever the model asks for.
    """

    lease_id: str
    tenant_id: str
    run_id: str
    base_checkpoint_id: str
    expires_at: datetime
    caps: ResourceCaps = ResourceCaps()
    allowed_tools: frozenset[str] = frozenset(
        {
            "read_file",
            "search_code",
            "apply_patch",
            "run_shell",
            "install_package",
            "start_dev_server",
            "read_logs",
            "browser",
        }
    )

    def __post_init__(self) -> None:
        for name in ("lease_id", "tenant_id", "run_id", "base_checkpoint_id"):
            if not getattr(self, name):
                raise LeaseError(f"{name} is required")
        if self.expires_at.tzinfo is None:
            raise LeaseError("expires_at must be timezone-aware")
        if "deploy" in self.allowed_tools:
            raise LeaseError(
                "deploy is never part of a build lease; it is a separate, gated action "
                "with its own credentials (invariant I7, Doc 06 §5)"
            )

    @classmethod
    def issue(
        cls,
        *,
        lease_id: str,
        tenant_id: str,
        run_id: str,
        base_checkpoint_id: str,
        ttl_seconds: int = 1800,
        caps: ResourceCaps | None = None,
        allowed_tools: frozenset[str] | None = None,
    ) -> Lease:
        """Issue a lease expiring ``ttl_seconds`` from now."""
        if ttl_seconds <= 0:
            raise LeaseError("ttl_seconds must be positive")
        return cls(
            lease_id=lease_id,
            tenant_id=tenant_id,
            run_id=run_id,
            base_checkpoint_id=base_checkpoint_id,
            expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
            caps=caps or ResourceCaps(),
            allowed_tools=allowed_tools
            or frozenset(
                {
                    "read_file",
                    "search_code",
                    "apply_patch",
                    "run_shell",
                    "install_package",
                    "start_dev_server",
                    "read_logs",
                    "browser",
                }
            ),
        )

    def is_expired(self, now: datetime | None = None) -> bool:
        return (now or datetime.now(UTC)) >= self.expires_at

    def permits(self, tool: str) -> bool:
        """Whether this lease's tool surface includes ``tool``."""
        return tool in self.allowed_tools
