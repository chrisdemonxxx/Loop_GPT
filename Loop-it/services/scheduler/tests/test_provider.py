"""Tests for the sandbox provider boundary and lifecycle."""

from __future__ import annotations

from typing import ClassVar, cast

import pytest
from loopit_sandbox_sdk.lease import ResourceCaps
from loopit_scheduler import (
    DockerProvider,
    E2BProvider,
    InMemoryProvider,
    Sandbox,
    SandboxProvider,
    SandboxReuseRefused,
    SandboxState,
)
from loopit_scheduler.provider import DockerClient


def test_in_memory_provider_satisfies_the_protocol() -> None:
    assert isinstance(InMemoryProvider(), SandboxProvider)


def test_a_new_sandbox_is_warm_and_unowned() -> None:
    sandbox = InMemoryProvider().create(ResourceCaps())

    assert sandbox.state is SandboxState.WARM
    assert sandbox.tenant_id is None


def test_assign_binds_a_sandbox_to_one_tenant() -> None:
    sandbox = InMemoryProvider().create(ResourceCaps())
    sandbox.assign("tenant_a")

    assert sandbox.state is SandboxState.ASSIGNED
    assert sandbox.tenant_id == "tenant_a"


def test_an_assigned_sandbox_cannot_be_reassigned() -> None:
    """Reuse across tenants is a data leak, not an optimisation."""
    sandbox = InMemoryProvider().create(ResourceCaps())
    sandbox.assign("tenant_a")

    with pytest.raises(SandboxReuseRefused, match="tenant_a"):
        sandbox.assign("tenant_b")


def test_a_destroyed_sandbox_cannot_be_assigned() -> None:
    provider = InMemoryProvider()
    sandbox = provider.create(ResourceCaps())
    provider.destroy(sandbox.sandbox_id)

    with pytest.raises(SandboxReuseRefused):
        sandbox.assign("tenant_b")


def test_there_is_no_reset_operation() -> None:
    """A reset path is the reuse path; the interface must not offer one."""
    provider = InMemoryProvider()

    for forbidden in ("reset", "clean", "recycle", "reuse", "release_to_pool"):
        assert not hasattr(provider, forbidden)
        assert not hasattr(Sandbox, forbidden)


def test_destroy_clears_tenant_ownership() -> None:
    provider = InMemoryProvider()
    sandbox = provider.create(ResourceCaps())
    sandbox.assign("tenant_a")

    provider.destroy(sandbox.sandbox_id)

    assert sandbox.state is SandboxState.DESTROYED
    assert sandbox.tenant_id is None


def test_destroy_is_idempotent() -> None:
    """Destruction runs on the failure path; raising there hides the real fault."""
    provider = InMemoryProvider()
    sandbox = provider.create(ResourceCaps())

    provider.destroy(sandbox.sandbox_id)
    provider.destroy(sandbox.sandbox_id)
    provider.destroy("sbx_never_existed")

    assert provider.destroyed_count == 1


def test_is_alive_tracks_destruction() -> None:
    provider = InMemoryProvider()
    sandbox = provider.create(ResourceCaps())

    assert provider.is_alive(sandbox.sandbox_id)
    provider.destroy(sandbox.sandbox_id)
    assert not provider.is_alive(sandbox.sandbox_id)
    assert not provider.is_alive("sbx_unknown")


def test_sandbox_ids_are_unique() -> None:
    provider = InMemoryProvider()
    ids = {provider.create(ResourceCaps()).sandbox_id for _ in range(50)}

    assert len(ids) == 50


def test_caps_are_carried_onto_the_sandbox() -> None:
    caps = ResourceCaps(cpu_millicores=500, memory_mib=1024)
    sandbox = InMemoryProvider().create(caps)

    assert sandbox.caps.cpu_millicores == 500
    assert sandbox.caps.memory_mib == 1024


class FakeE2BSandbox:
    created: ClassVar[list[dict[str, object]]] = []

    def __init__(self, sandbox_id: str) -> None:
        self.sandbox_id = sandbox_id
        self.running = True
        self.killed = False

    @classmethod
    def create(cls, **kwargs: object) -> FakeE2BSandbox:
        cls.created.append(kwargs)
        return cls(f"e2b_{len(cls.created)}")

    def kill(self) -> None:
        self.killed = True
        self.running = False

    def is_running(self) -> bool:
        return self.running


def test_e2b_provider_creates_a_fresh_timeout_capped_sandbox() -> None:
    FakeE2BSandbox.created = []
    provider = E2BProvider(template_id="tmpl_loopit", sandbox_factory=FakeE2BSandbox)
    caps = ResourceCaps(wall_clock_seconds=123, memory_mib=768)

    sandbox = provider.create(caps)

    assert sandbox.sandbox_id == "e2b_1"
    assert sandbox.state is SandboxState.WARM
    assert sandbox.caps is caps
    assert FakeE2BSandbox.created == [{"template": "tmpl_loopit", "timeout": 123}]
    assert provider.is_alive(sandbox.sandbox_id)


def test_e2b_provider_kills_and_never_reuses_sandboxes() -> None:
    FakeE2BSandbox.created = []
    provider = E2BProvider(template_id="tmpl_loopit", sandbox_factory=FakeE2BSandbox)
    first = provider.create(ResourceCaps())
    provider.destroy(first.sandbox_id)
    second = provider.create(ResourceCaps())

    assert first.state is SandboxState.DESTROYED
    assert not provider.is_alive(first.sandbox_id)
    assert second.sandbox_id != first.sandbox_id


class FakeContainer:
    def __init__(self, container_id: str) -> None:
        self.id = container_id
        self.status = "running"
        self.removed = False
        self.reloaded = False

    def reload(self) -> None:
        self.reloaded = True

    def remove(self, *, force: bool) -> None:
        assert force is True
        self.removed = True
        self.status = "exited"


class FakeContainers:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.last_container: FakeContainer | None = None
        self.created = 0

    def run(self, image: str, **kwargs: object) -> FakeContainer:
        self.calls.append({"image": image, **kwargs})
        self.created += 1
        self.last_container = FakeContainer(f"abcdef123456789{self.created}")
        return self.last_container


class FakeDockerClient:
    def __init__(self) -> None:
        self.containers = FakeContainers()


def test_docker_provider_starts_container_with_no_network_and_resource_caps() -> None:
    client = FakeDockerClient()
    provider = DockerProvider(image="loopit-sandbox:test", client=cast(DockerClient, client))
    caps = ResourceCaps(
        cpu_millicores=750,
        memory_mib=1024,
        disk_mib=4096,
        wall_clock_seconds=60,
        max_processes=64,
    )

    sandbox = provider.create(caps)

    call = client.containers.calls[0]
    assert sandbox.sandbox_id == "docker_abcdef1234567891"
    assert call["image"] == "loopit-sandbox:test"
    assert call["network"] == "none"
    assert call["environment"] == {}
    assert call["mem_limit"] == "1024m"
    assert call["nano_cpus"] == 750_000_000
    assert call["pids_limit"] == 64
    assert call["storage_opt"] == {"size": "4096m"}
    assert provider.is_alive(sandbox.sandbox_id)
    assert client.containers.last_container is not None
    assert client.containers.last_container.reloaded


def test_docker_provider_removes_containers_on_destroy() -> None:
    client = FakeDockerClient()
    provider = DockerProvider(image="loopit-sandbox:test", client=cast(DockerClient, client))
    first = provider.create(ResourceCaps())
    container = client.containers.last_container

    provider.destroy(first.sandbox_id)
    second = provider.create(ResourceCaps())

    assert container is not None
    assert container.removed
    assert first.state is SandboxState.DESTROYED
    assert not provider.is_alive(first.sandbox_id)
    assert second.sandbox_id != first.sandbox_id
    assert second is not first
