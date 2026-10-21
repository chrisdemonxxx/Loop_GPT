"""The warm pool (Doc 02 §6, P1-1).

Cold-starting a microVM and then installing dependencies is the difference
between an agent that feels interactive and one that does not. The pool keeps a
few sandboxes booted and idle so a run can start immediately.

The pool holds only *never-assigned* sandboxes. Nothing is ever returned to it:
`take()` removes a sandbox permanently, and a finished sandbox is destroyed, not
recycled. That single rule is what makes cross-tenant reuse structurally
impossible rather than merely discouraged.

Warm sandboxes also expire. A machine that has been idle for an hour has stale
package caches and, worse, a longer window in which a host-level compromise
could have touched it.

Pause/resume of an *assigned* E2B sandbox (idle project cost control) is not
implemented here yet: release destroys the sandbox and ``refill()`` tops the
warm pool back up. Hooks for a future pause API live as no-op methods so
callers can wire without inventing a second seam.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from loopit_sandbox_sdk.lease import ResourceCaps

from .errors import PoolExhausted
from .provider import Sandbox, SandboxProvider, SandboxState


class WarmPool:
    """A bounded set of pre-booted, never-used sandboxes.

    Args:
        provider: creates and destroys the underlying sandboxes.
        target_size: how many warm sandboxes to keep ready.
        max_live: ceiling on sandboxes alive at once, warm plus assigned. The
            pool refuses rather than oversubscribing the host.
        max_idle_seconds: how long a warm sandbox may sit unused before it is
            retired and replaced.
    """

    def __init__(
        self,
        provider: SandboxProvider,
        *,
        target_size: int = 3,
        max_live: int = 50,
        max_idle_seconds: int = 900,
        caps: ResourceCaps | None = None,
    ) -> None:
        if target_size < 0:
            raise ValueError("target_size cannot be negative")
        if max_live < target_size:
            raise ValueError("max_live must be at least target_size")

        self._provider = provider
        self._target_size = target_size
        self._max_live = max_live
        self._max_idle = timedelta(seconds=max_idle_seconds)
        self._caps = caps or ResourceCaps()
        self._warm: list[Sandbox] = []
        self._assigned_count = 0

    # --- Capacity -------------------------------------------------------------

    @property
    def warm_count(self) -> int:
        return len(self._warm)

    @property
    def assigned_count(self) -> int:
        return self._assigned_count

    @property
    def live_count(self) -> int:
        return len(self._warm) + self._assigned_count

    # --- Lifecycle ------------------------------------------------------------

    def refill(self, *, now: datetime | None = None) -> int:
        """Retire stale sandboxes and top the pool back up.

        Returns the number of sandboxes created. Called after every take and
        release so the pool converges on target size without a background timer.
        """
        self.retire_stale(now=now)

        created = 0
        while len(self._warm) < self._target_size and self.live_count < self._max_live:
            self._warm.append(self._provider.create(self._caps))
            created += 1
        return created

    def retire_stale(self, *, now: datetime | None = None) -> int:
        """Destroy warm sandboxes that have been idle too long."""
        moment = now or datetime.now(UTC)
        fresh: list[Sandbox] = []
        retired = 0

        for sandbox in self._warm:
            if moment - sandbox.created_at >= self._max_idle:
                self._provider.destroy(sandbox.sandbox_id)
                retired += 1
            else:
                fresh.append(sandbox)

        self._warm = fresh
        return retired

    def take(self, tenant_id: str, *, now: datetime | None = None) -> Sandbox:
        """Remove one sandbox from the pool and bind it to a tenant.

        Falls back to creating one on demand — a cold start is slower than a warm
        one, but failing an available-capacity request to protect a cache would
        be the wrong trade.
        """
        self.retire_stale(now=now)

        if self._warm:
            sandbox = self._warm.pop()
        else:
            if self.live_count >= self._max_live:
                raise PoolExhausted(
                    f"{self.live_count} sandboxes are already live (max {self._max_live}); "
                    "refusing to oversubscribe the host"
                )
            sandbox = self._provider.create(self._caps)

        sandbox.assign(tenant_id)
        self._assigned_count += 1
        self.refill(now=now)
        return sandbox

    def release(self, sandbox: Sandbox) -> None:
        """Destroy a finished sandbox. It is never returned to the pool."""
        if sandbox.state is SandboxState.ASSIGNED:
            self._assigned_count -= 1
        self._provider.destroy(sandbox.sandbox_id)
        sandbox.state = SandboxState.DESTROYED
        sandbox.tenant_id = None
        self.refill()

    def pause_assigned(self, sandbox_id: str) -> None:
        """Pause an assigned sandbox to save idle cost (E2B beta_pause when available).

        Memory/docker providers raise :class:`NotImplementedError`; callers
        should release the lease instead. E2B uses the SDK pause API when the
        installed SDK exposes it.
        """
        pause = getattr(self._provider, "pause", None)
        if not callable(pause):
            raise NotImplementedError(
                f"pause_assigned({sandbox_id!r}) is not supported by this provider; "
                "release the lease instead"
            )
        pause(sandbox_id)

    def resume_assigned(self, sandbox_id: str) -> None:
        """Resume a previously paused assigned sandbox."""
        resume = getattr(self._provider, "resume", None)
        if not callable(resume):
            raise NotImplementedError(
                f"resume_assigned({sandbox_id!r}) is not supported by this provider; "
                "acquire a new lease instead"
            )
        resume(sandbox_id)

    def drain(self) -> int:
        """Destroy every warm sandbox. Used on shutdown and in tests."""
        count = len(self._warm)
        for sandbox in self._warm:
            self._provider.destroy(sandbox.sandbox_id)
        self._warm.clear()
        return count
