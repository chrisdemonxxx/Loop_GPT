"""The sandbox provider boundary (Doc 02 §1, ADR-0009).

The scheduler must not know whether a sandbox is a Firecracker microVM, a gVisor
container, or a fake in a test. Everything above this boundary — pooling,
leasing, tenant isolation, recycling — is provider-independent, which is what
lets the isolation policy be tested without a hypervisor and lets the provider
be swapped without touching the policy.

Providers do exactly three things: create a sandbox, destroy it, and report
whether it is alive. Deliberately no `reset` or `clean` operation exists: a
"cleaned" sandbox is the reuse path, and reuse across tenants is the leak this
design exists to prevent.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from importlib import import_module
from typing import Any, ClassVar, Protocol, cast, runtime_checkable

from loopit_sandbox_sdk.lease import ResourceCaps

from .errors import MissingProviderDependency, ProviderConfigurationError, SandboxReuseRefused


class SandboxState(StrEnum):
    """Where a sandbox is in its one-way lifecycle.

    The lifecycle is deliberately one-way: WARM → ASSIGNED → DESTROYED. There is
    no edge back to WARM, so no code path can return a used sandbox to the pool.
    """

    WARM = "warm"
    ASSIGNED = "assigned"
    DESTROYED = "destroyed"


@dataclass(slots=True)
class Sandbox:
    """A single isolated execution environment."""

    sandbox_id: str
    caps: ResourceCaps
    state: SandboxState = SandboxState.WARM
    tenant_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def assign(self, tenant_id: str) -> None:
        if self.state is not SandboxState.WARM:
            raise SandboxReuseRefused(
                f"sandbox {self.sandbox_id} is {self.state}, not warm; only a never-used "
                f"sandbox may be assigned (previous tenant: {self.tenant_id!r})"
            )
        self.state = SandboxState.ASSIGNED
        self.tenant_id = tenant_id


@runtime_checkable
class SandboxProvider(Protocol):
    """Creates and destroys isolated sandboxes."""

    def create(self, caps: ResourceCaps) -> Sandbox: ...

    def destroy(self, sandbox_id: str) -> None: ...

    def is_alive(self, sandbox_id: str) -> bool: ...


class InMemoryProvider:
    """A provider that models sandbox lifecycle without any hypervisor.

    Used by tests and local development. It enforces the same lifecycle rules as
    a real provider, so isolation tests written against it stay meaningful — a
    fake that permits what the real thing forbids tests nothing.
    """

    def __init__(self) -> None:
        self._sandboxes: dict[str, Sandbox] = {}
        self.created_count = 0
        self.destroyed_count = 0

    def create(self, caps: ResourceCaps) -> Sandbox:
        sandbox = Sandbox(sandbox_id=f"sbx_{uuid.uuid4().hex[:16]}", caps=caps)
        self._sandboxes[sandbox.sandbox_id] = sandbox
        self.created_count += 1
        return sandbox

    def destroy(self, sandbox_id: str) -> None:
        """Destroy a sandbox. Idempotent — a double-destroy must never raise.

        Destruction runs on the failure path, so an exception here would leave a
        live sandbox behind precisely when cleanup matters most.
        """
        sandbox = self._sandboxes.get(sandbox_id)
        if sandbox is None or sandbox.state is SandboxState.DESTROYED:
            return
        sandbox.state = SandboxState.DESTROYED
        sandbox.tenant_id = None
        self.destroyed_count += 1

    def is_alive(self, sandbox_id: str) -> bool:
        sandbox = self._sandboxes.get(sandbox_id)
        return sandbox is not None and sandbox.state is not SandboxState.DESTROYED

    def get(self, sandbox_id: str) -> Sandbox | None:
        return self._sandboxes.get(sandbox_id)

    @property
    def live_count(self) -> int:
        return sum(1 for s in self._sandboxes.values() if s.state is not SandboxState.DESTROYED)


@runtime_checkable
class E2BSandboxHandle(Protocol):
    """The subset of the E2B SDK sandbox object this provider needs."""

    sandbox_id: str

    def kill(self) -> None: ...

    def is_running(self) -> bool: ...


@runtime_checkable
class E2BSandboxFactory(Protocol):
    """The sync E2B Sandbox class."""

    @classmethod
    def create(cls, **kwargs: object) -> E2BSandboxHandle: ...


class E2BProvider:
    """Provision one-shot E2B sandboxes.

    The E2B SDK is optional and loaded only when this provider is selected. Each
    :meth:`create` call boots a new sandbox with a bounded timeout; :meth:`destroy`
    kills it and no API exists to reset or reuse it for another tenant.
    """

    def __init__(
        self,
        *,
        template_id: str,
        sandbox_factory: type[E2BSandboxFactory] | None = None,
    ) -> None:
        if not template_id:
            raise ProviderConfigurationError(
                "E2BProvider requires a template_id (set LOOPIT_E2B_TEMPLATE_ID)"
            )
        self._template_id = template_id
        self._sandbox_factory = sandbox_factory
        self._handles: dict[str, E2BSandboxHandle] = {}
        self._sandboxes: dict[str, Sandbox] = {}

    def create(self, caps: ResourceCaps) -> Sandbox:
        factory = self._sandbox_factory or _load_e2b_sandbox_factory()
        # Pin package/registry traffic through egress-proxy (I3). Operators set
        # LOOPIT_EGRESS_PROXY_URL to the proxy the sandbox can reach.
        create_kwargs: dict[str, object] = {
            "template": self._template_id,
            "timeout": caps.wall_clock_seconds,
        }
        proxy_envs = _egress_proxy_envs()
        if proxy_envs:
            create_kwargs["envs"] = proxy_envs
        handle = factory.create(**create_kwargs)
        sandbox_id = _sandbox_handle_id(handle)
        sandbox = Sandbox(sandbox_id=sandbox_id, caps=caps)
        self._handles[sandbox_id] = handle
        self._sandboxes[sandbox_id] = sandbox
        return sandbox

    def pause(self, sandbox_id: str) -> None:
        handle = self._handles.get(sandbox_id)
        if handle is None:
            raise ProviderConfigurationError(f"unknown sandbox {sandbox_id!r}")
        pause_fn = getattr(handle, "beta_pause", None) or getattr(handle, "pause", None)
        if not callable(pause_fn):
            raise NotImplementedError(
                "E2B SDK pause is unavailable; upgrade e2b or release the lease instead"
            )
        pause_fn()

    def resume(self, sandbox_id: str) -> None:
        handle = self._handles.get(sandbox_id)
        if handle is None:
            # Reconnect by id — pause may have dropped the in-process handle.
            factory = self._sandbox_factory or _load_e2b_sandbox_factory()
            connect = getattr(factory, "connect", None)
            if not callable(connect):
                raise NotImplementedError(
                    "E2B SDK connect/resume is unavailable; acquire a new lease instead"
                )
            handle = connect(sandbox_id)
            self._handles[sandbox_id] = handle
            return
        resume_fn = getattr(handle, "beta_resume", None) or getattr(handle, "resume", None)
        if callable(resume_fn):
            resume_fn()
            return
        # Some SDK versions resume implicitly on the next command after connect.
        return

    def destroy(self, sandbox_id: str) -> None:
        sandbox = self._sandboxes.get(sandbox_id)
        if sandbox is None or sandbox.state is SandboxState.DESTROYED:
            return
        handle = self._handles.pop(sandbox_id, None)
        if handle is not None:
            try:
                handle.kill()
            except Exception as exc:
                if not _is_not_found_error(exc):
                    raise
        sandbox.state = SandboxState.DESTROYED
        sandbox.tenant_id = None

    def is_alive(self, sandbox_id: str) -> bool:
        sandbox = self._sandboxes.get(sandbox_id)
        if sandbox is None or sandbox.state is SandboxState.DESTROYED:
            return False
        handle = self._handles.get(sandbox_id)
        if handle is None:
            return False
        try:
            return handle.is_running()
        except Exception as exc:
            if _is_not_found_error(exc):
                return False
            raise


@runtime_checkable
class DockerContainerHandle(Protocol):
    """The subset of docker.models.containers.Container this provider needs."""

    id: str
    status: str

    def reload(self) -> None: ...

    def remove(self, *, force: bool) -> None: ...


@runtime_checkable
class DockerContainers(Protocol):
    """The container collection on a Docker SDK client."""

    def run(self, image: str, **kwargs: object) -> DockerContainerHandle: ...


@runtime_checkable
class DockerClient(Protocol):
    """The subset of the Docker SDK client used by the provider."""

    containers: DockerContainers


class DockerProvider:
    """Provision one-shot local containers for development and CI.

    Containers are started with no host environment, no network by default, and
    resource caps mapped to Docker limits. This is a local fallback, not a
    production isolation boundary: every lease still gets a fresh container that
    is removed on release.
    """

    IMAGE_ENV: ClassVar[str] = "LOOPIT_SANDBOX_IMAGE"

    def __init__(
        self,
        *,
        image: str,
        client: DockerClient | None = None,
        network: str = "none",
    ) -> None:
        if not image:
            raise ProviderConfigurationError(
                f"DockerProvider requires an image (set {self.IMAGE_ENV})"
            )
        if not network:
            raise ProviderConfigurationError("DockerProvider network cannot be empty")
        self._image = image
        self._client = client
        self._network = network
        self._containers: dict[str, DockerContainerHandle] = {}
        self._sandboxes: dict[str, Sandbox] = {}

    def create(self, caps: ResourceCaps) -> Sandbox:
        container = self._docker.containers.run(
            self._image,
            command=["sleep", "infinity"],
            detach=True,
            environment={},
            network=self._network,
            mem_limit=f"{caps.memory_mib}m",
            nano_cpus=caps.cpu_millicores * 1_000_000,
            pids_limit=caps.max_processes,
            storage_opt={"size": f"{caps.disk_mib}m"},
            labels={"loopit.role": "sandbox", "loopit.reuse": "never"},
        )
        sandbox_id = f"docker_{container.id[:16]}"
        sandbox = Sandbox(sandbox_id=sandbox_id, caps=caps)
        self._containers[sandbox_id] = container
        self._sandboxes[sandbox_id] = sandbox
        return sandbox

    def destroy(self, sandbox_id: str) -> None:
        sandbox = self._sandboxes.get(sandbox_id)
        if sandbox is None or sandbox.state is SandboxState.DESTROYED:
            return
        container = self._containers.pop(sandbox_id, None)
        if container is not None:
            try:
                container.remove(force=True)
            except Exception as exc:
                if not _is_not_found_error(exc):
                    raise
        sandbox.state = SandboxState.DESTROYED
        sandbox.tenant_id = None

    def is_alive(self, sandbox_id: str) -> bool:
        sandbox = self._sandboxes.get(sandbox_id)
        if sandbox is None or sandbox.state is SandboxState.DESTROYED:
            return False
        container = self._containers.get(sandbox_id)
        if container is None:
            return False
        try:
            container.reload()
        except Exception as exc:
            if _is_not_found_error(exc):
                return False
            raise
        return container.status in {"created", "running"}

    @property
    def _docker(self) -> DockerClient:
        if self._client is None:
            self._client = _load_docker_client()
        return self._client


def _load_e2b_sandbox_factory() -> type[E2BSandboxFactory]:
    try:
        module: Any = import_module("e2b_code_interpreter")
    except ModuleNotFoundError:
        try:
            module = import_module("e2b")
        except ModuleNotFoundError as exc:
            raise MissingProviderDependency(
                "E2BProvider requires optional dependency 'e2b-code-interpreter' "
                "(install loopit-scheduler[e2b])"
            ) from exc
    return cast(type[E2BSandboxFactory], module.Sandbox)


def _load_docker_client() -> DockerClient:
    try:
        module: Any = import_module("docker")
    except ModuleNotFoundError as exc:
        raise MissingProviderDependency(
            "DockerProvider requires optional dependency 'docker' "
            "(install loopit-scheduler[docker])"
        ) from exc
    return cast(DockerClient, module.from_env())


def _sandbox_handle_id(handle: object) -> str:
    sandbox_id = getattr(handle, "sandbox_id", None)
    if isinstance(sandbox_id, str) and sandbox_id:
        return sandbox_id
    fallback_id = getattr(handle, "id", None)
    if isinstance(fallback_id, str) and fallback_id:
        return fallback_id
    raise ProviderConfigurationError("E2B sandbox handle did not expose sandbox_id")


def _is_not_found_error(exc: Exception) -> bool:
    return exc.__class__.__name__ in {"NotFound", "NotFoundException"}


def _egress_proxy_envs() -> dict[str, str]:
    """Env vars that pin sandbox HTTP(S) through the egress proxy (I3).

    ``LOOPIT_EGRESS_PROXY_URL`` is the URL the *sandbox* uses (often a public
    or VPC address of egress-proxy), not necessarily the compose-internal
    hostname the API sees.
    """
    proxy = (os.environ.get("LOOPIT_EGRESS_PROXY_URL") or "").strip()
    if not proxy:
        return {}
    no_proxy = (os.environ.get("LOOPIT_EGRESS_NO_PROXY") or "localhost,127.0.0.1").strip()
    return {
        "HTTP_PROXY": proxy,
        "HTTPS_PROXY": proxy,
        "ALL_PROXY": proxy,
        "http_proxy": proxy,
        "https_proxy": proxy,
        "all_proxy": proxy,
        "NO_PROXY": no_proxy,
        "no_proxy": no_proxy,
    }
