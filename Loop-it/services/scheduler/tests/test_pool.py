"""Tests for the warm pool.

The pool exists for latency, but its correctness property is one-way flow:
sandboxes leave the pool and never come back.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from loopit_sandbox_sdk.lease import ResourceCaps
from loopit_scheduler import InMemoryProvider, PoolExhausted, SandboxState, WarmPool


def test_refill_boots_to_target_size() -> None:
    provider = InMemoryProvider()
    pool = WarmPool(provider, target_size=3)

    assert pool.refill() == 3
    assert pool.warm_count == 3
    assert provider.created_count == 3


def test_refill_is_idempotent_at_target() -> None:
    pool = WarmPool(InMemoryProvider(), target_size=2)
    pool.refill()

    assert pool.refill() == 0
    assert pool.warm_count == 2


def test_take_serves_from_the_pool_without_a_cold_start() -> None:
    provider = InMemoryProvider()
    pool = WarmPool(provider, target_size=2)
    pool.refill()
    created_after_boot = provider.created_count

    sandbox = pool.take("tenant_a")

    assert sandbox.state is SandboxState.ASSIGNED
    assert sandbox.tenant_id == "tenant_a"
    # One replacement is created to restore target size, not one per request.
    assert provider.created_count == created_after_boot + 1


def test_take_cold_starts_when_the_pool_is_empty() -> None:
    """Better a slow start than a refused request that had capacity."""
    provider = InMemoryProvider()
    pool = WarmPool(provider, target_size=0, max_live=5)

    sandbox = pool.take("tenant_a")

    assert sandbox.tenant_id == "tenant_a"
    assert provider.created_count == 1


def test_a_taken_sandbox_never_returns_to_the_pool() -> None:
    provider = InMemoryProvider()
    pool = WarmPool(provider, target_size=1)
    pool.refill()

    sandbox = pool.take("tenant_a")
    pool.release(sandbox)

    assert sandbox.state is SandboxState.DESTROYED
    assert not provider.is_alive(sandbox.sandbox_id)
    assert pool.assigned_count == 0


def test_release_destroys_rather_than_recycling() -> None:
    provider = InMemoryProvider()
    pool = WarmPool(provider, target_size=1)
    pool.refill()

    first = pool.take("tenant_a")
    pool.release(first)
    second = pool.take("tenant_b")

    assert second.sandbox_id != first.sandbox_id
    assert provider.destroyed_count >= 1


def test_pool_refuses_to_oversubscribe_the_host() -> None:
    provider = InMemoryProvider()
    pool = WarmPool(provider, target_size=0, max_live=2)
    pool.take("tenant_a")
    pool.take("tenant_b")

    with pytest.raises(PoolExhausted, match="oversubscribe"):
        pool.take("tenant_c")


def test_capacity_frees_up_after_release() -> None:
    pool = WarmPool(InMemoryProvider(), target_size=0, max_live=1)
    sandbox = pool.take("tenant_a")
    pool.release(sandbox)

    assert pool.take("tenant_b").tenant_id == "tenant_b"


def test_refill_respects_the_live_ceiling() -> None:
    pool = WarmPool(InMemoryProvider(), target_size=5, max_live=5)
    pool.take("tenant_a")

    assert pool.live_count <= 5


def test_stale_warm_sandboxes_are_retired() -> None:
    """A long-idle machine has stale caches and a wider exposure window."""
    provider = InMemoryProvider()
    pool = WarmPool(provider, target_size=2, max_idle_seconds=900)
    pool.refill()
    original = {s.sandbox_id for s in pool._warm}

    later = datetime.now(UTC) + timedelta(seconds=901)
    pool.refill(now=later)

    assert pool.warm_count == 2
    assert original.isdisjoint({s.sandbox_id for s in pool._warm})


def test_fresh_warm_sandboxes_are_kept() -> None:
    pool = WarmPool(InMemoryProvider(), target_size=2, max_idle_seconds=900)
    pool.refill()

    assert pool.retire_stale(now=datetime.now(UTC) + timedelta(seconds=60)) == 0


def test_take_never_hands_out_a_stale_sandbox() -> None:
    provider = InMemoryProvider()
    pool = WarmPool(provider, target_size=1, max_idle_seconds=900)
    pool.refill()
    stale_id = pool._warm[0].sandbox_id

    sandbox = pool.take("tenant_a", now=datetime.now(UTC) + timedelta(seconds=901))

    assert sandbox.sandbox_id != stale_id
    assert not provider.is_alive(stale_id)


def test_drain_destroys_every_warm_sandbox() -> None:
    provider = InMemoryProvider()
    pool = WarmPool(provider, target_size=4)
    pool.refill()

    assert pool.drain() == 4
    assert pool.warm_count == 0
    assert provider.live_count == 0


def test_pool_rejects_incoherent_configuration() -> None:
    with pytest.raises(ValueError, match="negative"):
        WarmPool(InMemoryProvider(), target_size=-1)
    with pytest.raises(ValueError, match="at least target_size"):
        WarmPool(InMemoryProvider(), target_size=5, max_live=2)


def test_pool_applies_its_caps_to_created_sandboxes() -> None:
    pool = WarmPool(InMemoryProvider(), target_size=1, caps=ResourceCaps(memory_mib=512))
    pool.refill()

    assert pool._warm[0].caps.memory_mib == 512
