"""Deploy generated apps from green checkpoints to Fly-class hosts.

The deployer builds and ships immutable checkpoint artifacts through a hosting
provider seam. It never executes generated code in the control-plane process:
provider implementations build/run on the remote host or a data-plane builder.
"""

from __future__ import annotations

import hashlib
import logging
import re
from asyncio import CancelledError
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal, Protocol, cast, runtime_checkable
from urllib.parse import urlsplit

from loopit_checkpoint import Checkpoint, CheckpointStore
from loopit_gitsync import GitTreeEntry, materialize_checkpoint_tree
from loopit_orchestrator import ApprovalSignal
from loopit_policy import ActionKind, GateRequirement, ProposedAction, classify_action
from loopit_provision import ProvisionedDatabase, StorageBucket
from loopit_secrets import Environment, LeaseDenied, SecretsBroker, StepContext

LOG = logging.getLogger("loopit.deployer")


class DeploymentAborted(RuntimeError):
    """Deploy stopped before live traffic changed."""


class HealthCheckFailed(DeploymentAborted):
    """Candidate failed health checks."""


class MigrationFailed(DeploymentAborted):
    """Candidate migrations failed before cutover."""


class DeploymentStatus(StrEnum):
    STAGED = "staged"
    LIVE = "live"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


class VpsPlacementFailed(DeploymentAborted):
    """No owned VPS slice can safely host the candidate."""


class TenantIsolationRefused(DeploymentAborted):
    """A VPS candidate asked for a posture that would break tenant isolation."""


@dataclass(frozen=True, slots=True)
class RuntimeAttachment:
    database: ProvisionedDatabase
    storage: StorageBucket
    production_url: str | None = None


@dataclass(frozen=True, slots=True)
class DeploymentRecord:
    deployment_id: str
    tenant_id: str
    project_id: str
    checkpoint_id: str
    run_id: str
    status: DeploymentStatus
    production_url: str
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    previous_checkpoint_id: str | None = None
    provider_release_id: str | None = None
    reason: str = ""


@dataclass(frozen=True, slots=True)
class PromotionGate:
    gate_id: str
    verdict_gate: GateRequirement
    approved: bool
    reason: str


@dataclass(frozen=True, slots=True)
class StagedRelease:
    release_id: str
    url: str
    app_name: str = ""
    checkpoint_id: str = ""
    hostname: str = ""
    backend_url: str = ""
    slice_id: str = ""


@runtime_checkable
class HostingProvider(Protocol):
    """Fly-class host adapter. Real network implementations are optional/lazy."""

    def stage(
        self,
        *,
        project_id: str,
        checkpoint_id: str,
        tree: tuple[GitTreeEntry, ...],
        runtime: RuntimeAttachment,
        env: dict[str, str],
    ) -> StagedRelease: ...

    def run_migrations(self, release: StagedRelease) -> None: ...

    def health_check(self, release: StagedRelease) -> bool: ...

    def promote(self, release: StagedRelease) -> str: ...

    def rollback(self, project_id: str, checkpoint_id: str) -> str: ...

    def stop_candidate(self, release: StagedRelease) -> None: ...


class DeploymentBillingClient(Protocol):
    def reserve_always_on(
        self,
        *,
        tenant_id: str,
        project_id: str,
        run_id: str,
        idempotency_key: str,
        active_always_on_apps: int,
    ) -> None: ...

    def meter_hosting_seconds(
        self,
        *,
        tenant_id: str,
        project_id: str,
        seconds: int,
        run_id: str,
        idempotency_key: str,
        hosting_size: str = "small",
    ) -> None: ...


class NoopDeploymentBillingClient:
    def reserve_always_on(
        self,
        *,
        tenant_id: str,
        project_id: str,
        run_id: str,
        idempotency_key: str,
        active_always_on_apps: int,
    ) -> None:
        del tenant_id, project_id, run_id, idempotency_key, active_always_on_apps

    def meter_hosting_seconds(
        self,
        *,
        tenant_id: str,
        project_id: str,
        seconds: int,
        run_id: str,
        idempotency_key: str,
        hosting_size: str = "small",
    ) -> None:
        del tenant_id, project_id, seconds, run_id, idempotency_key, hosting_size


@runtime_checkable
class DeploymentRepository(Protocol):
    """Deployment records must survive control-plane restarts for rollback."""

    def append(self, record: DeploymentRecord) -> None: ...

    def history(self, project_id: str) -> tuple[DeploymentRecord, ...]: ...

    def live(self, project_id: str) -> DeploymentRecord | None: ...


@dataclass(frozen=True, slots=True)
class VpsCleanupTask:
    release_id: str
    slice_id: str
    project_id: str
    checkpoint_id: str
    backend_url: str
    attempts: int = 0
    last_error: str = ""


@runtime_checkable
class VpsCleanupRepository(Protocol):
    """Retryable VPS candidate cleanup work that must survive restarts."""

    def record_pending_cleanup(self, task: VpsCleanupTask) -> None: ...

    def delete_pending_cleanup(self, release_id: str) -> None: ...

    def pending_cleanups(self) -> tuple[VpsCleanupTask, ...]: ...


class InMemoryDeploymentRepository:
    """Test repository; production uses the Postgres-backed implementation."""

    def __init__(self) -> None:
        self._records: dict[str, list[DeploymentRecord]] = {}

    def append(self, record: DeploymentRecord) -> None:
        self._records.setdefault(record.project_id, []).append(record)

    def history(self, project_id: str) -> tuple[DeploymentRecord, ...]:
        return tuple(self._records.get(project_id, ()))

    def live(self, project_id: str) -> DeploymentRecord | None:
        for record in reversed(self._records.get(project_id, ())):
            if record.status is DeploymentStatus.LIVE:
                return record
        return None


class InMemoryVpsCleanupRepository:
    def __init__(self) -> None:
        self._tasks: dict[str, VpsCleanupTask] = {}

    def record_pending_cleanup(self, task: VpsCleanupTask) -> None:
        existing = self._tasks.get(task.release_id)
        attempts = (existing.attempts if existing else task.attempts) + 1
        self._tasks[task.release_id] = VpsCleanupTask(
            release_id=task.release_id,
            slice_id=task.slice_id,
            project_id=task.project_id,
            checkpoint_id=task.checkpoint_id,
            backend_url=task.backend_url,
            attempts=attempts,
            last_error=task.last_error,
        )

    def delete_pending_cleanup(self, release_id: str) -> None:
        self._tasks.pop(release_id, None)

    def pending_cleanups(self) -> tuple[VpsCleanupTask, ...]:
        return tuple(self._tasks.values())


class PostgresDeploymentRepository:
    """Deployment history stored in the same Postgres database as packages/store.

    Rollback depends on old LIVE rows after the deployer restarts, so this class
    creates a narrow service-owned table when the store migrations have not yet
    learned about deployments. Pending VPS cleanup tasks live beside deployment
    records so orphaned candidates can be reaped after control-plane restarts.
    The connection is injected to keep transaction ownership with the service
    process.
    """

    def __init__(self, conn: Any, *, ensure_schema: bool = True) -> None:
        self._conn = conn
        if ensure_schema:
            self.ensure_schema()

    @classmethod
    def from_dsn(cls, dsn: str, *, ensure_schema: bool = True) -> PostgresDeploymentRepository:
        from loopit_store.postgres import connect

        return cls(connect(dsn), ensure_schema=ensure_schema)

    def ensure_schema(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS deployment_records (
                deployment_id text PRIMARY KEY,
                tenant_id text NOT NULL,
                project_id text NOT NULL,
                checkpoint_id text NOT NULL,
                run_id text NOT NULL,
                status text NOT NULL CHECK (
                    status IN ('staged', 'live', 'failed', 'rolled_back')
                ),
                production_url text NOT NULL,
                created_at timestamptz NOT NULL,
                previous_checkpoint_id text,
                provider_release_id text,
                reason text NOT NULL DEFAULT ''
            )
            """
        )
        self._conn.execute(
            """
            CREATE INDEX IF NOT EXISTS deployment_records_project_created_idx
            ON deployment_records (project_id, created_at, deployment_id)
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS vps_cleanup_tasks (
                release_id text PRIMARY KEY,
                slice_id text NOT NULL,
                project_id text NOT NULL,
                checkpoint_id text NOT NULL,
                backend_url text NOT NULL,
                first_seen_at timestamptz NOT NULL,
                updated_at timestamptz NOT NULL,
                attempts integer NOT NULL DEFAULT 0,
                last_error text NOT NULL DEFAULT ''
            )
            """
        )
        self._conn.execute(
            """
            CREATE INDEX IF NOT EXISTS vps_cleanup_tasks_updated_idx
            ON vps_cleanup_tasks (updated_at, release_id)
            """
        )
        commit = getattr(self._conn, "commit", None)
        if callable(commit):
            commit()

    def append(self, record: DeploymentRecord) -> None:
        self._conn.execute(
            """
            INSERT INTO deployment_records (
                deployment_id, tenant_id, project_id, checkpoint_id, run_id, status,
                production_url, created_at, previous_checkpoint_id, provider_release_id, reason
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                record.deployment_id,
                record.tenant_id,
                record.project_id,
                record.checkpoint_id,
                record.run_id,
                record.status.value,
                record.production_url,
                record.created_at,
                record.previous_checkpoint_id,
                record.provider_release_id,
                record.reason,
            ),
        )
        commit = getattr(self._conn, "commit", None)
        if callable(commit):
            commit()

    def history(self, project_id: str) -> tuple[DeploymentRecord, ...]:
        rows = self._conn.execute(
            """
            SELECT * FROM deployment_records
            WHERE project_id = %s
            ORDER BY created_at, deployment_id
            """,
            (project_id,),
        ).fetchall()
        return tuple(_deployment_record(row) for row in rows)

    def live(self, project_id: str) -> DeploymentRecord | None:
        rows = self._conn.execute(
            """
            SELECT * FROM deployment_records
            WHERE project_id = %s AND status = 'live'
            ORDER BY created_at DESC, deployment_id DESC
            LIMIT 1
            """,
            (project_id,),
        ).fetchall()
        return _deployment_record(rows[0]) if rows else None

    def record_pending_cleanup(self, task: VpsCleanupTask) -> None:
        now = datetime.now(UTC)
        self._conn.execute(
            """
            INSERT INTO vps_cleanup_tasks (
                release_id, slice_id, project_id, checkpoint_id, backend_url,
                first_seen_at, updated_at, attempts, last_error
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, 1, %s)
            ON CONFLICT (release_id) DO UPDATE SET
                slice_id = EXCLUDED.slice_id,
                project_id = EXCLUDED.project_id,
                checkpoint_id = EXCLUDED.checkpoint_id,
                backend_url = EXCLUDED.backend_url,
                updated_at = EXCLUDED.updated_at,
                attempts = vps_cleanup_tasks.attempts + 1,
                last_error = EXCLUDED.last_error
            """,
            (
                task.release_id,
                task.slice_id,
                task.project_id,
                task.checkpoint_id,
                task.backend_url,
                now,
                now,
                task.last_error,
            ),
        )
        commit = getattr(self._conn, "commit", None)
        if callable(commit):
            commit()

    def delete_pending_cleanup(self, release_id: str) -> None:
        self._conn.execute(
            "DELETE FROM vps_cleanup_tasks WHERE release_id = %s",
            (release_id,),
        )
        commit = getattr(self._conn, "commit", None)
        if callable(commit):
            commit()

    def pending_cleanups(self) -> tuple[VpsCleanupTask, ...]:
        rows = self._conn.execute(
            """
            SELECT * FROM vps_cleanup_tasks
            ORDER BY updated_at, release_id
            """
        ).fetchall()
        return tuple(_vps_cleanup_task(row) for row in rows)


class FakeHostingProvider:
    """Provider fake that records ordering and can fail migrations/health."""

    def __init__(self) -> None:
        self.events: list[str] = []
        self.live_checkpoint: dict[str, str] = {}
        self.fail_migrations = False
        self.fail_health = False

    def stage(
        self,
        *,
        project_id: str,
        checkpoint_id: str,
        tree: tuple[GitTreeEntry, ...],
        runtime: RuntimeAttachment,
        env: dict[str, str],
    ) -> StagedRelease:
        del env
        self.events.append(f"stage:{checkpoint_id}")
        digest = hashlib.sha256("".join(entry.digest for entry in tree).encode()).hexdigest()[:12]
        return StagedRelease(digest, runtime.production_url or f"https://{project_id}.example.test")

    def run_migrations(self, release: StagedRelease) -> None:
        self.events.append(f"migrate:{release.release_id}")
        if self.fail_migrations:
            raise MigrationFailed("migrations failed")

    def health_check(self, release: StagedRelease) -> bool:
        self.events.append(f"health:{release.release_id}")
        return not self.fail_health

    def promote(self, release: StagedRelease) -> str:
        self.events.append(f"promote:{release.release_id}")
        return release.release_id

    def rollback(self, project_id: str, checkpoint_id: str) -> str:
        self.events.append(f"rollback:{checkpoint_id}")
        self.live_checkpoint[project_id] = checkpoint_id
        return f"rollback-{checkpoint_id}"

    def stop_candidate(self, release: StagedRelease) -> None:
        self.events.append(f"stop:{release.release_id}")


class StaticObjectHostingProvider:
    """Static-site hosting via object storage / local CDN root.

    Offline-friendly stub of the R2/S3+CDN path. When ``public_base_domain`` is
    set, promote returns ``https://{opaque}.{domain}``. Otherwise the URL is a
    relative ``/hosted/{release_id}/…`` path the control-plane API can serve.
    Full-stack apps should use :class:`FlyHostingProvider` or
    :class:`VpsHostingProvider` instead.
    """

    def __init__(
        self,
        storage_root: Any,
        *,
        public_base_domain: str | None = None,
        allocate_label: Callable[[str], str] | None = None,
        write_object: Callable[[str, bytes], None] | None = None,
    ) -> None:
        from pathlib import Path as _Path

        self._root = _Path(storage_root)
        self._root.mkdir(parents=True, exist_ok=True)
        self._public_base_domain = (public_base_domain or "").strip() or None
        self._allocate_label = allocate_label or (
            lambda project_id: f"p-{hashlib.sha256(project_id.encode()).hexdigest()[:10]}"
        )
        self._write_object = write_object
        self.events: list[str] = []
        self._labels: dict[str, str] = {}
        self.live_checkpoint: dict[str, str] = {}

    def stage(
        self,
        *,
        project_id: str,
        checkpoint_id: str,
        tree: tuple[GitTreeEntry, ...],
        runtime: RuntimeAttachment,
        env: dict[str, str],
    ) -> StagedRelease:
        del env
        release_id = hashlib.sha256(f"{project_id}:{checkpoint_id}".encode()).hexdigest()[:16]
        dest = self._root / release_id
        dest.mkdir(parents=True, exist_ok=True)
        for entry in tree:
            body = entry.content if isinstance(entry.content, (bytes, bytearray)) else b""
            if isinstance(entry.content, str):
                body = entry.content.encode("utf-8")
            relative = entry.path.lstrip("/")
            if self._write_object is not None:
                self._write_object(f"{release_id}/{relative}", bytes(body))
            else:
                target = dest / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(bytes(body))
            self.events.append(f"put:{release_id}:{relative}")
        label = self._labels.get(project_id) or self._allocate_label(project_id)
        self._labels[project_id] = label
        if runtime.production_url:
            url = runtime.production_url
        elif self._public_base_domain:
            url = f"https://{label}.{self._public_base_domain}"
        else:
            url = f"/hosted/{release_id}/index.html"
        self.events.append(f"stage:{checkpoint_id}")
        return StagedRelease(
            release_id=release_id,
            url=url,
            app_name=label,
            checkpoint_id=checkpoint_id,
            hostname=(
                f"{label}.{self._public_base_domain}" if self._public_base_domain else label
            ),
        )

    def run_migrations(self, release: StagedRelease) -> None:
        self.events.append(f"migrate:{release.release_id}:noop")

    def health_check(self, release: StagedRelease) -> bool:
        self.events.append(f"health:{release.release_id}")
        return (self._root / release.release_id).is_dir()

    def promote(self, release: StagedRelease) -> str:
        self.events.append(f"promote:{release.release_id}")
        return release.release_id

    def rollback(self, project_id: str, checkpoint_id: str) -> str:
        self.events.append(f"rollback:{checkpoint_id}")
        self.live_checkpoint[project_id] = checkpoint_id
        return f"rollback-{checkpoint_id}"

    def stop_candidate(self, release: StagedRelease) -> None:
        self.events.append(f"stop:{release.release_id}")


METADATA_DENY_CIDRS = frozenset({"169.254.0.0/16", "169.254.169.254/32", "fd00:ec2::/32"})
METADATA_DENY_HOSTNAMES = frozenset({"metadata.google.internal"})


@dataclass(frozen=True, slots=True)
class AllocatedHostname:
    project_id: str
    hostname: str
    url: str


@runtime_checkable
class ProjectHostnameAllocator(Protocol):
    """Dependency-free seam expected from services/domains."""

    def ensure_project_hostname(self, *, tenant_id: str, project_id: str) -> AllocatedHostname:
        """Idempotently allocate or return the public hostname for a project."""

    def hostname_for_project(self, project_id: str) -> AllocatedHostname | None:
        """Return the existing hostname used during rollback."""


@runtime_checkable
class AppProxyRegistrar(Protocol):
    """Dependency-free seam expected from services/app-proxy."""

    def register_backend(
        self,
        *,
        hostname: str,
        backend_url: str,
        project_id: str,
        checkpoint_id: str,
        release_id: str,
    ) -> None:
        """Atomically route public traffic for hostname to the healthy backend."""


@dataclass(frozen=True, slots=True)
class VpsResourceSpec:
    cpu_millicores: int = 500
    memory_mib: int = 512

    def fits(self, slice_status: VpsSliceStatus) -> bool:
        return (
            slice_status.alive
            and slice_status.used_cpu_millicores + self.cpu_millicores
            <= slice_status.total_cpu_millicores
            and slice_status.used_memory_mib + self.memory_mib <= slice_status.total_memory_mib
        )


@dataclass(frozen=True, slots=True)
class VpsSliceStatus:
    slice_id: str
    base_url: str
    total_cpu_millicores: int
    total_memory_mib: int
    used_cpu_millicores: int = 0
    used_memory_mib: int = 0
    alive: bool = True


@dataclass(frozen=True, slots=True)
class VpsNetworkPosture:
    """Runtime network posture for deployed apps, separate from build sandboxes.

    Deployed apps receive real inbound and outbound connectivity, but never host
    networking, privileged containers, shared tenant networks, or metadata
    endpoints. This protects against ordinary cross-tenant and control-plane
    reachability mistakes; it is not a VM boundary and does not claim to survive
    kernel/container-runtime escape vulnerabilities on shared hardware.
    """

    network_name: str
    metadata_deny_cidrs: frozenset[str] = METADATA_DENY_CIDRS
    metadata_deny_hostnames: frozenset[str] = METADATA_DENY_HOSTNAMES
    per_tenant_network: bool = True
    deny_private_neighbors: bool = True
    no_host_mounts: bool = True
    no_privileged: bool = True
    no_new_privileges: bool = True
    run_in_data_plane: bool = True
    outbound: Literal["internet-with-metadata-deny"] = "internet-with-metadata-deny"

    def validate(self) -> None:
        missing_cidrs = METADATA_DENY_CIDRS - self.metadata_deny_cidrs
        missing_hosts = METADATA_DENY_HOSTNAMES - self.metadata_deny_hostnames
        if missing_cidrs or missing_hosts:
            raise TenantIsolationRefused(
                "metadata endpoints must be denied and cannot be allowlisted"
            )
        if not self.run_in_data_plane:
            raise TenantIsolationRefused("generated apps must run only in the data plane")
        if not self.per_tenant_network:
            raise TenantIsolationRefused("each tenant app needs an isolated VPS network")
        if not self.deny_private_neighbors:
            raise TenantIsolationRefused("deployed apps may not route to peer tenant networks")
        if not self.no_host_mounts or not self.no_privileged or not self.no_new_privileges:
            raise TenantIsolationRefused("VPS containers must not receive host-level privileges")


@dataclass(frozen=True, slots=True)
class VpsBackend:
    release_id: str
    slice_id: str
    backend_url: str
    project_id: str
    checkpoint_id: str


@dataclass(frozen=True, slots=True)
class VpsContainerSpec:
    release_id: str
    tenant_id: str
    project_id: str
    checkpoint_id: str
    image: str
    env: dict[str, str]
    resources: VpsResourceSpec
    network: VpsNetworkPosture
    database_schema: str
    storage_bucket: str
    storage_prefix: str


@runtime_checkable
class VpsControlClient(Protocol):
    """Narrow data-plane control API implemented by the VPS slice agent."""

    def slice_status(self, slice_id: str) -> VpsSliceStatus: ...

    def ensure_network(self, slice_id: str, posture: VpsNetworkPosture) -> None: ...

    def start_candidate(self, slice_id: str, spec: VpsContainerSpec) -> VpsBackend: ...

    def run_migration(self, slice_id: str, release_id: str, command: tuple[str, ...]) -> int: ...

    def health_check(self, backend: VpsBackend) -> bool: ...

    def mark_live(self, slice_id: str, release_id: str) -> None: ...

    def find_release(self, project_id: str, checkpoint_id: str) -> VpsBackend | None: ...

    def stop_candidate(self, slice_id: str, release_id: str) -> None: ...


class VpsHostingProvider:
    """Deploy to owner-operated VPS slices through a small slice-agent API.

    The provider builds one immutable image from the checkpoint tree, starts it
    as a candidate container on a slice with spare capacity, runs migrations
    against the candidate before traffic changes, then asks the edge proxy to
    atomically switch the project's hostname. Old releases stay addressable so
    rollback can restore the previous LIVE checkpoint after a deployer restart.
    """

    def __init__(
        self,
        *,
        image_for_tree: Callable[[tuple[GitTreeEntry, ...]], str],
        hostname_allocator: ProjectHostnameAllocator,
        proxy: AppProxyRegistrar,
        client: VpsControlClient,
        slices: tuple[str, ...],
        resources: VpsResourceSpec | None = None,
        migration_command: tuple[str, ...] = ("npm", "run", "migrate"),
        cleanup_repository: VpsCleanupRepository | None = None,
    ) -> None:
        if not slices:
            raise ValueError("at least one VPS slice is required")
        self._image_for_tree = image_for_tree
        self._hostname_allocator = hostname_allocator
        self._proxy = proxy
        self._client = client
        self._slices = slices
        self._resources = resources or VpsResourceSpec()
        self._migration_command = migration_command
        self._cleanup_repository = cleanup_repository or InMemoryVpsCleanupRepository()
        self._staged: dict[str, VpsBackend] = {}

    def stage(
        self,
        *,
        project_id: str,
        checkpoint_id: str,
        tree: tuple[GitTreeEntry, ...],
        runtime: RuntimeAttachment,
        env: dict[str, str],
    ) -> StagedRelease:
        allocation = self._hostname_allocator.ensure_project_hostname(
            tenant_id=runtime.database.tenant_id,
            project_id=project_id,
        )
        image = self._image_for_tree(tree)
        release_id = (
            "vps_"
            + hashlib.sha256(f"{project_id}:{checkpoint_id}:{image}".encode()).hexdigest()[:20]
        )
        posture = VpsNetworkPosture(
            network_name=f"loopit-{runtime.database.tenant_id}-{project_id}"
        )
        posture.validate()
        spec = VpsContainerSpec(
            release_id=release_id,
            tenant_id=runtime.database.tenant_id,
            project_id=project_id,
            checkpoint_id=checkpoint_id,
            image=image,
            env=env
            | {
                "DATABASE_SCHEMA": runtime.database.names.schema,
                "S3_BUCKET": runtime.storage.bucket,
                "S3_PREFIX": runtime.storage.prefix,
                "LOOPIT_PUBLIC_URL": allocation.url,
            },
            resources=self._resources,
            network=posture,
            database_schema=runtime.database.names.schema,
            storage_bucket=runtime.storage.bucket,
            storage_prefix=runtime.storage.prefix,
        )
        backend = self._place_and_start(spec)
        self._staged[release_id] = backend
        return StagedRelease(
            release_id=release_id,
            url=allocation.url,
            app_name=project_id,
            checkpoint_id=checkpoint_id,
            hostname=allocation.hostname,
            backend_url=backend.backend_url,
            slice_id=backend.slice_id,
        )

    def run_migrations(self, release: StagedRelease) -> None:
        backend = self._backend_for_release(release)
        code = self._client.run_migration(
            backend.slice_id, release.release_id, self._migration_command
        )
        if code != 0:
            raise MigrationFailed("VPS migration command failed")

    def health_check(self, release: StagedRelease) -> bool:
        return self._client.health_check(self._backend_for_release(release))

    def promote(self, release: StagedRelease) -> str:
        backend = self._backend_for_release(release)
        self._proxy.register_backend(
            hostname=release.hostname,
            backend_url=backend.backend_url,
            project_id=backend.project_id,
            checkpoint_id=backend.checkpoint_id,
            release_id=release.release_id,
        )
        self._client.mark_live(backend.slice_id, release.release_id)
        return release.release_id

    def rollback(self, project_id: str, checkpoint_id: str) -> str:
        backend = self._client.find_release(project_id, checkpoint_id)
        if backend is None:
            raise DeploymentAborted("target VPS release is not available for rollback")
        allocation = self._hostname_allocator.hostname_for_project(project_id)
        if allocation is None:
            raise DeploymentAborted("project hostname is not available for rollback")
        self._proxy.register_backend(
            hostname=allocation.hostname,
            backend_url=backend.backend_url,
            project_id=project_id,
            checkpoint_id=checkpoint_id,
            release_id=backend.release_id,
        )
        self._client.mark_live(backend.slice_id, backend.release_id)
        return backend.release_id

    def stop_candidate(self, release: StagedRelease) -> None:
        backend = self._staged.get(release.release_id)
        if backend is None:
            backend = self._client.find_release(release.app_name, release.checkpoint_id)
        if backend is None:
            self._cleanup_repository.delete_pending_cleanup(release.release_id)
            return
        try:
            self._client.stop_candidate(backend.slice_id, backend.release_id)
        except Exception as exc:
            self._cleanup_repository.record_pending_cleanup(
                _vps_cleanup_task_from_backend(backend, last_error=str(exc))
            )
            raise
        self._staged.pop(release.release_id, None)
        self._cleanup_repository.delete_pending_cleanup(backend.release_id)

    def reconcile_pending_cleanups(self) -> int:
        """Retry orphaned VPS candidate deletions after earlier cleanup failures."""

        reaped = 0
        for task in self._cleanup_repository.pending_cleanups():
            try:
                self._client.stop_candidate(task.slice_id, task.release_id)
            except Exception as exc:
                self._cleanup_repository.record_pending_cleanup(
                    VpsCleanupTask(
                        release_id=task.release_id,
                        slice_id=task.slice_id,
                        project_id=task.project_id,
                        checkpoint_id=task.checkpoint_id,
                        backend_url=task.backend_url,
                        attempts=task.attempts,
                        last_error=str(exc),
                    )
                )
                LOG.warning(
                    "candidate cleanup retry failed",
                    extra={
                        "project_id": task.project_id,
                        "checkpoint_id": task.checkpoint_id,
                        "release_id": task.release_id,
                        "slice_id": task.slice_id,
                    },
                    exc_info=True,
                )
                continue
            self._staged.pop(task.release_id, None)
            self._cleanup_repository.delete_pending_cleanup(task.release_id)
            reaped += 1
        return reaped

    def _place_and_start(self, spec: VpsContainerSpec) -> VpsBackend:
        refusals: list[str] = []
        for slice_id in self._slices:
            status = self._client.slice_status(slice_id)
            if not spec.resources.fits(status):
                refusals.append(slice_id)
                continue
            self._client.ensure_network(slice_id, spec.network)
            return self._client.start_candidate(slice_id, spec)
        raise VpsPlacementFailed(
            "no healthy VPS slice has enough spare capacity: " + ",".join(refusals)
        )

    def _backend_for_release(self, release: StagedRelease) -> VpsBackend:
        backend = self._staged.get(release.release_id)
        if backend is None:
            backend = self._client.find_release(release.app_name, release.checkpoint_id)
        if backend is None:
            raise DeploymentAborted("staged VPS release disappeared before cutover")
        return backend


class HttpVpsControlClient:
    """HTTP implementation for the slice-agent seam; httpx is imported lazily."""

    def __init__(self, api_base: str, bearer_token: str) -> None:
        self._api_base = api_base.rstrip("/")
        self._bearer_token = bearer_token

    def slice_status(self, slice_id: str) -> VpsSliceStatus:
        response = _httpx().get(
            f"{self._api_base}/slices/{slice_id}", headers=self._headers(), timeout=10
        )
        response.raise_for_status()
        data = response.json()
        return VpsSliceStatus(
            slice_id=str(data["slice_id"]),
            base_url=str(data["base_url"]),
            total_cpu_millicores=int(data["total_cpu_millicores"]),
            total_memory_mib=int(data["total_memory_mib"]),
            used_cpu_millicores=int(data.get("used_cpu_millicores", 0)),
            used_memory_mib=int(data.get("used_memory_mib", 0)),
            alive=bool(data.get("alive", True)),
        )

    def ensure_network(self, slice_id: str, posture: VpsNetworkPosture) -> None:
        posture.validate()
        response = _httpx().put(
            f"{self._api_base}/slices/{slice_id}/networks/{posture.network_name}",
            headers=self._headers(),
            json={
                "metadata_deny_cidrs": sorted(posture.metadata_deny_cidrs),
                "metadata_deny_hostnames": sorted(posture.metadata_deny_hostnames),
                "per_tenant_network": posture.per_tenant_network,
                "deny_private_neighbors": posture.deny_private_neighbors,
            },
            timeout=15,
        )
        response.raise_for_status()

    def start_candidate(self, slice_id: str, spec: VpsContainerSpec) -> VpsBackend:
        spec.network.validate()
        response = _httpx().post(
            f"{self._api_base}/slices/{slice_id}/releases",
            headers=self._headers(),
            json={
                "release_id": spec.release_id,
                "tenant_id": spec.tenant_id,
                "project_id": spec.project_id,
                "checkpoint_id": spec.checkpoint_id,
                "image": spec.image,
                "env": spec.env,
                "resources": {
                    "cpu_millicores": spec.resources.cpu_millicores,
                    "memory_mib": spec.resources.memory_mib,
                },
                "network_name": spec.network.network_name,
                "security": {
                    "cap_drop": ["ALL"],
                    "no_new_privileges": True,
                    "privileged": False,
                    "host_network": False,
                    "host_mounts": [],
                    "read_only_root": True,
                },
            },
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()
        return VpsBackend(
            release_id=str(data.get("release_id", spec.release_id)),
            slice_id=slice_id,
            backend_url=str(data["backend_url"]),
            project_id=spec.project_id,
            checkpoint_id=spec.checkpoint_id,
        )

    def run_migration(self, slice_id: str, release_id: str, command: tuple[str, ...]) -> int:
        response = _httpx().post(
            f"{self._api_base}/slices/{slice_id}/releases/{release_id}/exec",
            headers=self._headers(),
            json={"command": list(command)},
            timeout=120,
        )
        if response.status_code >= 400:
            return 1
        data = response.json()
        return int(data.get("exit_code", 0))

    def health_check(self, backend: VpsBackend) -> bool:
        response = _httpx().get(f"{backend.backend_url.rstrip('/')}/healthz", timeout=10)
        return 200 <= int(response.status_code) < 300

    def mark_live(self, slice_id: str, release_id: str) -> None:
        response = _httpx().post(
            f"{self._api_base}/slices/{slice_id}/releases/{release_id}/live",
            headers=self._headers(),
            timeout=15,
        )
        response.raise_for_status()

    def stop_candidate(self, slice_id: str, release_id: str) -> None:
        response = _httpx().delete(
            f"{self._api_base}/slices/{slice_id}/releases/{release_id}",
            headers=self._headers(),
            timeout=15,
        )
        if response.status_code not in {200, 202, 204, 404}:
            response.raise_for_status()

    def find_release(self, project_id: str, checkpoint_id: str) -> VpsBackend | None:
        response = _httpx().get(
            f"{self._api_base}/releases",
            headers=self._headers(),
            params={"project_id": project_id, "checkpoint_id": checkpoint_id},
            timeout=10,
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        data = response.json()
        return VpsBackend(
            release_id=str(data["release_id"]),
            slice_id=str(data["slice_id"]),
            backend_url=str(data["backend_url"]),
            project_id=project_id,
            checkpoint_id=checkpoint_id,
        )

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._bearer_token}", "Content-Type": "application/json"}


class HttpDomainsProjectHostnameAllocator:
    """HTTP implementation of the project hostname seam backed by domains."""

    def __init__(self, domains_url: str, service_token: str, *, timeout: float = 5.0) -> None:
        self._domains_url = domains_url.rstrip("/")
        self._service_token = service_token
        self._timeout = timeout

    def ensure_project_hostname(self, *, tenant_id: str, project_id: str) -> AllocatedHostname:
        response = _http_request(
            "post",
            f"{self._domains_url}/internal/projects/{project_id}/subdomain",
            headers=self._headers(),
            json={"tenant_id": tenant_id, "org_id": tenant_id},
            timeout=self._timeout,
        )
        response.raise_for_status()
        return _allocated_hostname(project_id, response.json())

    def hostname_for_project(self, project_id: str) -> AllocatedHostname | None:
        response = _http_request(
            "get",
            f"{self._domains_url}/internal/projects/{project_id}/subdomain",
            headers=self._headers(),
            timeout=self._timeout,
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return _allocated_hostname(project_id, response.json())

    def _headers(self) -> dict[str, str]:
        return {"X-Loopit-Service-Token": self._service_token, "Content-Type": "application/json"}


class HttpDomainsAppProxyRegistrar:
    """Registers live VPS backends with domains, the routing source of truth."""

    def __init__(self, domains_url: str, service_token: str, *, timeout: float = 5.0) -> None:
        self._domains_url = domains_url.rstrip("/")
        self._service_token = service_token
        self._timeout = timeout

    def register_backend(
        self,
        *,
        hostname: str,
        backend_url: str,
        project_id: str,
        checkpoint_id: str,
        release_id: str,
    ) -> None:
        backend_host, backend_port = _backend_host_port(backend_url)
        response = _http_request(
            "post",
            f"{self._domains_url}/routes/{hostname}/backend",
            headers=self._headers(),
            json={
                "project_id": project_id,
                "backend_host": backend_host,
                "backend_port": backend_port,
                "checkpoint_id": checkpoint_id,
                "release_id": release_id,
            },
            timeout=self._timeout,
        )
        response.raise_for_status()

    def _headers(self) -> dict[str, str]:
        return {"X-Loopit-Service-Token": self._service_token, "Content-Type": "application/json"}


class HttpDeploymentBillingClient:
    """Service-authenticated billing producer for hosting reservations and meters."""

    def __init__(self, billing_url: str, service_token: str, *, timeout: float = 5.0) -> None:
        self._billing_url = billing_url.rstrip("/")
        self._service_token = service_token
        self._timeout = timeout

    def reserve_always_on(
        self,
        *,
        tenant_id: str,
        project_id: str,
        run_id: str,
        idempotency_key: str,
        active_always_on_apps: int,
    ) -> None:
        del project_id
        response = _http_request(
            "post",
            f"{self._billing_url}/v1/billing/reservations",
            headers=self._headers(tenant_id),
            json={
                "estimated_cost": "0",
                "idempotency_key": idempotency_key,
                "run_id": run_id,
                "quota_request": {"always_on_apps": 1},
                "usage": {"active_always_on_apps": active_always_on_apps},
            },
            timeout=self._timeout,
        )
        if response.status_code == 429:
            detail = _response_detail(response) or "always_on_apps quota exceeded"
            raise DeploymentAborted(detail)
        response.raise_for_status()

    def meter_hosting_seconds(
        self,
        *,
        tenant_id: str,
        project_id: str,
        seconds: int,
        run_id: str,
        idempotency_key: str,
        hosting_size: str = "small",
    ) -> None:
        del project_id
        if seconds <= 0:
            return
        response = _http_request(
            "post",
            f"{self._billing_url}/v1/billing/meter",
            headers=self._headers(tenant_id),
            json={
                "tenant_id": tenant_id,
                "idempotency_key": idempotency_key,
                "kind": "hosting_seconds",
                "hosting_seconds": seconds,
                "hosting_size": hosting_size,
                "run_id": run_id,
            },
            timeout=self._timeout,
        )
        if response.status_code == 429:
            raise DeploymentAborted(_response_detail(response) or "quota exceeded")
        response.raise_for_status()

    def _headers(self, tenant_id: str) -> dict[str, str]:
        return {
            "X-Loopit-Service-Token": self._service_token,
            "X-Loopit-Tenant": tenant_id,
            "Authorization": f"Bearer {self._service_token}",
            "Content-Type": "application/json",
        }


class FakeDeploymentBillingClient:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.fail_reservation_reason: str = ""

    def reserve_always_on(
        self,
        *,
        tenant_id: str,
        project_id: str,
        run_id: str,
        idempotency_key: str,
        active_always_on_apps: int,
    ) -> None:
        del tenant_id, run_id, idempotency_key
        self.events.append(f"reserve:{project_id}:{active_always_on_apps}")
        if self.fail_reservation_reason:
            raise DeploymentAborted(self.fail_reservation_reason)

    def meter_hosting_seconds(
        self,
        *,
        tenant_id: str,
        project_id: str,
        seconds: int,
        run_id: str,
        idempotency_key: str,
        hosting_size: str = "small",
    ) -> None:
        del tenant_id, run_id, idempotency_key, hosting_size
        self.events.append(f"meter:{project_id}:{seconds}")


class FakeProjectHostnameAllocator:
    def __init__(self, base_domain: str = "apps.example.test") -> None:
        self._base_domain = base_domain
        self._allocations: dict[str, AllocatedHostname] = {}

    def ensure_project_hostname(self, *, tenant_id: str, project_id: str) -> AllocatedHostname:
        del tenant_id
        existing = self._allocations.get(project_id)
        if existing is not None:
            return existing
        label = re.sub(r"[^a-z0-9-]+", "-", project_id.lower()).strip("-") or "app"
        hostname = f"{label}.{self._base_domain}"
        allocation = AllocatedHostname(
            project_id=project_id, hostname=hostname, url=f"https://{hostname}"
        )
        self._allocations[project_id] = allocation
        return allocation

    def hostname_for_project(self, project_id: str) -> AllocatedHostname | None:
        return self._allocations.get(project_id)


class FakeAppProxyRegistrar:
    def __init__(self) -> None:
        self.routes: dict[str, VpsBackend] = {}
        self.events: list[str] = []

    def register_backend(
        self,
        *,
        hostname: str,
        backend_url: str,
        project_id: str,
        checkpoint_id: str,
        release_id: str,
    ) -> None:
        self.routes[hostname] = VpsBackend(
            release_id, "fake", backend_url, project_id, checkpoint_id
        )
        self.events.append(f"route:{hostname}:{checkpoint_id}:{release_id}")


class FakeVpsControlClient:
    def __init__(self, statuses: tuple[VpsSliceStatus, ...]) -> None:
        self._statuses = {status.slice_id: status for status in statuses}
        self.releases: dict[tuple[str, str], VpsBackend] = {}
        self._release_resources: dict[str, VpsResourceSpec] = {}
        self.events: list[str] = []
        self.fail_migration = False
        self.fail_health = False
        self.fail_stop = False

    def slice_status(self, slice_id: str) -> VpsSliceStatus:
        return self._statuses[slice_id]

    def ensure_network(self, slice_id: str, posture: VpsNetworkPosture) -> None:
        posture.validate()
        self.events.append(f"network:{slice_id}:{posture.network_name}")

    def start_candidate(self, slice_id: str, spec: VpsContainerSpec) -> VpsBackend:
        spec.network.validate()
        status = self._statuses[slice_id]
        if not spec.resources.fits(status):
            raise VpsPlacementFailed(f"slice {slice_id} is full")
        self._statuses[slice_id] = VpsSliceStatus(
            slice_id=status.slice_id,
            base_url=status.base_url,
            total_cpu_millicores=status.total_cpu_millicores,
            total_memory_mib=status.total_memory_mib,
            used_cpu_millicores=status.used_cpu_millicores + spec.resources.cpu_millicores,
            used_memory_mib=status.used_memory_mib + spec.resources.memory_mib,
            alive=status.alive,
        )
        backend = VpsBackend(
            release_id=spec.release_id,
            slice_id=slice_id,
            backend_url=f"{status.base_url.rstrip('/')}/releases/{spec.release_id}",
            project_id=spec.project_id,
            checkpoint_id=spec.checkpoint_id,
        )
        self.releases[(spec.project_id, spec.checkpoint_id)] = backend
        self._release_resources[spec.release_id] = spec.resources
        self.events.append(f"start:{slice_id}:{spec.checkpoint_id}")
        return backend

    def run_migration(self, slice_id: str, release_id: str, command: tuple[str, ...]) -> int:
        del command
        self.events.append(f"migrate:{slice_id}:{release_id}")
        return 1 if self.fail_migration else 0

    def health_check(self, backend: VpsBackend) -> bool:
        self.events.append(f"health:{backend.release_id}")
        return not self.fail_health

    def mark_live(self, slice_id: str, release_id: str) -> None:
        self.events.append(f"live:{slice_id}:{release_id}")

    def find_release(self, project_id: str, checkpoint_id: str) -> VpsBackend | None:
        return self.releases.get((project_id, checkpoint_id))

    def stop_candidate(self, slice_id: str, release_id: str) -> None:
        if self.fail_stop:
            self.events.append(f"stop-failed:{slice_id}:{release_id}")
            raise TimeoutError("slice agent timed out while stopping candidate")
        resources = self._release_resources.pop(release_id, None)
        self.releases = {
            key: backend
            for key, backend in self.releases.items()
            if backend.release_id != release_id
        }
        if resources is None:
            return
        status = self._statuses[slice_id]
        self._statuses[slice_id] = VpsSliceStatus(
            slice_id=status.slice_id,
            base_url=status.base_url,
            total_cpu_millicores=status.total_cpu_millicores,
            total_memory_mib=status.total_memory_mib,
            used_cpu_millicores=max(0, status.used_cpu_millicores - resources.cpu_millicores),
            used_memory_mib=max(0, status.used_memory_mib - resources.memory_mib),
            alive=status.alive,
        )
        self.events.append(f"stop:{slice_id}:{release_id}")


class FlyHostingProvider:
    """Fly.io implementation shell with lazy httpx import."""

    def __init__(
        self,
        api_token: str,
        *,
        org_slug: str,
        image_for_tree: Callable[[tuple[GitTreeEntry, ...]], str],
        public_base_domain: str = "fly.dev",
        app_prefix: str = "loopit-gen",
        api_base: str = "https://api.machines.dev",
    ) -> None:
        self._api_token = api_token
        self._org_slug = org_slug
        self._image_for_tree = image_for_tree
        self._public_base_domain = public_base_domain
        self._app_prefix = app_prefix
        self._api_base = api_base.rstrip("/")

    def stage(
        self,
        *,
        project_id: str,
        checkpoint_id: str,
        tree: tuple[GitTreeEntry, ...],
        runtime: RuntimeAttachment,
        env: dict[str, str],
    ) -> StagedRelease:
        httpx = _httpx()
        app_name = self._app_name(project_id)
        image = self._image_for_tree(tree)
        create = httpx.post(
            f"{self._api_base}/v1/apps",
            headers=self._headers(),
            json={"app_name": app_name, "org_slug": self._org_slug},
            timeout=15,
        )
        if create.status_code not in {200, 201, 409}:
            create.raise_for_status()
        response = httpx.post(
            f"{self._api_base}/v1/apps/{app_name}/machines",
            headers=self._headers(),
            json={
                "name": f"candidate-{checkpoint_id[:12]}",
                "config": {
                    "image": image,
                    "env": env
                    | {
                        "DATABASE_SCHEMA": runtime.database.names.schema,
                        "S3_BUCKET": runtime.storage.bucket,
                        "S3_PREFIX": runtime.storage.prefix,
                    },
                    "metadata": {
                        "loopit_project_id": project_id,
                        "loopit_checkpoint_id": checkpoint_id,
                        "loopit_stage": "candidate",
                    },
                    "services": [],
                },
            },
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()
        release_id = str(data.get("id") or data.get("name") or checkpoint_id)
        url = runtime.production_url or f"https://{app_name}.{self._public_base_domain}"
        return StagedRelease(
            release_id=release_id,
            url=url,
            app_name=app_name,
            checkpoint_id=checkpoint_id,
            hostname=f"{app_name}.{self._public_base_domain}",
        )

    def run_migrations(self, release: StagedRelease) -> None:
        httpx = _httpx()
        response = httpx.post(
            f"{self._api_base}/v1/apps/{release.app_name}/machines/{release.release_id}/exec",
            headers=self._headers(),
            json={"cmd": "npm run migrate"},
            timeout=120,
        )
        if response.status_code >= 400:
            raise MigrationFailed("Fly migration command failed")

    def health_check(self, release: StagedRelease) -> bool:
        httpx = _httpx()
        response = httpx.get(f"{release.url.rstrip('/')}/healthz", timeout=10)
        status_code = int(response.status_code)
        return 200 <= status_code < 300

    def promote(self, release: StagedRelease) -> str:
        httpx = _httpx()
        response = httpx.post(
            f"{self._api_base}/v1/apps/{release.app_name}/machines/{release.release_id}/metadata",
            headers=self._headers(),
            json={"loopit_stage": "live", "loopit_checkpoint_id": release.checkpoint_id},
            timeout=15,
        )
        response.raise_for_status()
        return release.release_id

    def rollback(self, project_id: str, checkpoint_id: str) -> str:
        httpx = _httpx()
        app_name = self._app_name(project_id)
        response = httpx.post(
            f"{self._api_base}/v1/apps/{app_name}/rollback",
            headers=self._headers(),
            json={"checkpoint_id": checkpoint_id},
            timeout=30,
        )
        response.raise_for_status()
        return checkpoint_id

    def stop_candidate(self, release: StagedRelease) -> None:
        httpx = _httpx()
        response = httpx.delete(
            f"{self._api_base}/v1/apps/{release.app_name}/machines/{release.release_id}",
            headers=self._headers(),
            timeout=15,
        )
        if response.status_code not in {200, 202, 204, 404}:
            response.raise_for_status()

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_token}", "Content-Type": "application/json"}

    def _app_name(self, project_id: str) -> str:
        safe = re.sub(r"[^a-z0-9-]+", "-", project_id.lower()).strip("-")
        return f"{self._app_prefix}-{safe}"[:63]


def deploy_checkpoint(
    *,
    checkpoint: Checkpoint,
    checkpoints: CheckpointStore,
    provider: HostingProvider,
    runtime: RuntimeAttachment,
    repository: DeploymentRepository,
    run_id: str,
    prod_broker: SecretsBroker,
    approval: ApprovalSignal | None,
    billing: DeploymentBillingClient | None = None,
    clock: Callable[[], datetime] | None = None,
) -> DeploymentRecord:
    now = clock or (lambda: datetime.now(UTC))
    billing_client = billing or NoopDeploymentBillingClient()
    if not checkpoint.verified:
        raise DeploymentAborted("only green checkpoints may be deployed")
    gate = require_promotion_gate(approval)
    if not gate.approved:
        raise DeploymentAborted("promotion gate rejected")
    previous = repository.live(checkpoint.project_id)
    if previous is not None:
        elapsed_seconds = max(0, int((now() - previous.created_at).total_seconds()))
        if elapsed_seconds > 0:
            billing_client.meter_hosting_seconds(
                tenant_id=previous.tenant_id,
                project_id=previous.project_id,
                seconds=elapsed_seconds,
                run_id=run_id,
                idempotency_key=(
                    f"hosting-seconds:{previous.deployment_id}:{checkpoint.checkpoint_id}"
                ),
            )
    billing_client.reserve_always_on(
        tenant_id=checkpoint.tenant_id,
        project_id=checkpoint.project_id,
        run_id=run_id,
        idempotency_key=f"always-on:{checkpoint.project_id}:{checkpoint.checkpoint_id}:{run_id}",
        active_always_on_apps=1 if previous is not None else 0,
    )
    context = StepContext(
        run_id=run_id,
        step_id="production-deploy",
        tenant_id=checkpoint.tenant_id,
        project_id=checkpoint.project_id,
        declared_secrets=frozenset(
            {
                "GENERATED_DATABASE_URL",
                "GENERATED_JWT_SECRET",
                "S3_ACCESS_KEY_ID",
                "S3_SECRET_ACCESS_KEY",
            }
        ),
    )
    env = _runtime_env(prod_broker, context)
    tree = materialize_checkpoint_tree(checkpoint, checkpoints)
    release = provider.stage(
        project_id=checkpoint.project_id,
        checkpoint_id=checkpoint.checkpoint_id,
        tree=tree,
        runtime=runtime,
        env=env,
    )
    try:
        provider.run_migrations(release)
        if not provider.health_check(release):
            raise HealthCheckFailed("candidate failed health check")
        provider_release_id = provider.promote(release)
    except (Exception, CancelledError) as exc:
        try:
            provider.stop_candidate(release)
        except Exception:
            LOG.warning(
                "candidate cleanup failed after deployment abort",
                extra={
                    "project_id": checkpoint.project_id,
                    "checkpoint_id": checkpoint.checkpoint_id,
                    "release_id": release.release_id,
                },
                exc_info=True,
            )
        failed = _record(
            checkpoint,
            run_id,
            DeploymentStatus.FAILED,
            release.url,
            previous,
            release.release_id,
            str(exc),
            created_at=now(),
        )
        repository.append(failed)
        raise
    live = _record(
        checkpoint,
        run_id,
        DeploymentStatus.LIVE,
        release.url,
        previous,
        provider_release_id,
        gate.reason,
        created_at=now(),
    )
    repository.append(live)
    return live


def rollback_project(
    *,
    tenant_id: str,
    project_id: str,
    run_id: str,
    provider: HostingProvider,
    repository: DeploymentRepository,
) -> DeploymentRecord:
    history = repository.history(project_id)
    live = repository.live(project_id)
    if live is None:
        raise DeploymentAborted("no live deployment to roll back")
    candidates = [record for record in history if record.status is DeploymentStatus.LIVE]
    if len(candidates) < 2:
        raise DeploymentAborted("no previous live checkpoint to roll back to")
    target = candidates[-2]
    release_id = provider.rollback(project_id, target.checkpoint_id)
    rolled = DeploymentRecord(
        deployment_id=(
            "dep_"
            + hashlib.sha256((project_id + run_id + target.checkpoint_id).encode()).hexdigest()[:16]
        ),
        tenant_id=tenant_id,
        project_id=project_id,
        checkpoint_id=target.checkpoint_id,
        run_id=run_id,
        status=DeploymentStatus.ROLLED_BACK,
        production_url=target.production_url,
        previous_checkpoint_id=live.checkpoint_id,
        provider_release_id=release_id,
        reason="rollback to previous released checkpoint",
    )
    repository.append(rolled)
    return rolled


def require_promotion_gate(approval: ApprovalSignal | None) -> PromotionGate:
    verdict = classify_action(ProposedAction(ActionKind.DEPLOY, tool="deploy"))
    if verdict.required_gate is not GateRequirement.HUMAN_CONFIRM:
        raise DeploymentAborted("deploy policy did not require human confirmation")
    if approval is None or not approval.approved:
        return PromotionGate("deploy-promote", verdict.required_gate, False, verdict.reason)
    return PromotionGate(
        approval.gate_id, verdict.required_gate, True, approval.reason or verdict.reason
    )


def preview_secret_is_unreachable(
    preview_broker: SecretsBroker,
    context: StepContext,
    name: str = "GENERATED_DATABASE_URL",
) -> bool:
    from datetime import timedelta

    try:
        preview_broker.issue(context, name, ttl=timedelta(minutes=1))
    except LeaseDenied:
        return True
    return False


def _runtime_env(prod_broker: SecretsBroker, context: StepContext) -> dict[str, str]:
    if prod_broker.environment is not Environment.PROD:
        raise DeploymentAborted("production deploys require a prod secrets broker")
    from datetime import timedelta

    names = sorted(context.declared_secrets)
    leases = {name: prod_broker.issue(context, name, ttl=timedelta(minutes=5)) for name in names}
    return {name: prod_broker.reveal(lease) for name, lease in leases.items()}


def _record(
    checkpoint: Checkpoint,
    run_id: str,
    status: DeploymentStatus,
    url: str,
    previous: DeploymentRecord | None,
    release_id: str | None,
    reason: str,
    created_at: datetime | None = None,
) -> DeploymentRecord:
    deployment_id = hashlib.sha256(
        f"{checkpoint.project_id}:{checkpoint.checkpoint_id}:{run_id}:{status.value}".encode()
    ).hexdigest()[:16]
    return DeploymentRecord(
        deployment_id=f"dep_{deployment_id}",
        tenant_id=checkpoint.tenant_id,
        project_id=checkpoint.project_id,
        checkpoint_id=checkpoint.checkpoint_id,
        run_id=run_id,
        status=status,
        production_url=url,
        created_at=created_at or datetime.now(UTC),
        previous_checkpoint_id=previous.checkpoint_id if previous else None,
        provider_release_id=release_id,
        reason=reason,
    )


def _deployment_record(row: Any) -> DeploymentRecord:
    data = cast(dict[str, Any], row)
    created_raw = data["created_at"]
    created_at = (
        created_raw
        if isinstance(created_raw, datetime)
        else datetime.fromisoformat(str(created_raw).replace("Z", "+00:00"))
    )
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=UTC)
    return DeploymentRecord(
        deployment_id=str(data["deployment_id"]),
        tenant_id=str(data["tenant_id"]),
        project_id=str(data["project_id"]),
        checkpoint_id=str(data["checkpoint_id"]),
        run_id=str(data["run_id"]),
        status=DeploymentStatus(str(data["status"])),
        production_url=str(data["production_url"]),
        created_at=created_at,
        previous_checkpoint_id=cast(str | None, data.get("previous_checkpoint_id")),
        provider_release_id=cast(str | None, data.get("provider_release_id")),
        reason=str(data.get("reason", "")),
    )


def _vps_cleanup_task(row: Any) -> VpsCleanupTask:
    data = cast(dict[str, Any], row)
    return VpsCleanupTask(
        release_id=str(data["release_id"]),
        slice_id=str(data["slice_id"]),
        project_id=str(data["project_id"]),
        checkpoint_id=str(data["checkpoint_id"]),
        backend_url=str(data["backend_url"]),
        attempts=int(data.get("attempts", 0)),
        last_error=str(data.get("last_error", "")),
    )


def _vps_cleanup_task_from_backend(backend: VpsBackend, *, last_error: str = "") -> VpsCleanupTask:
    return VpsCleanupTask(
        release_id=backend.release_id,
        slice_id=backend.slice_id,
        project_id=backend.project_id,
        checkpoint_id=backend.checkpoint_id,
        backend_url=backend.backend_url,
        last_error=last_error,
    )


def _allocated_hostname(project_id: str, data: dict[str, Any]) -> AllocatedHostname:
    hostname = str(data["hostname"])
    return AllocatedHostname(project_id=project_id, hostname=hostname, url=f"https://{hostname}")


def _backend_host_port(backend_url: str) -> tuple[str, int]:
    parsed = urlsplit(backend_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.port is None:
        raise DeploymentAborted("VPS backend URL must include http(s), host, and port")
    return parsed.hostname, parsed.port


def _http_request(method: str, url: str, **kwargs: Any) -> Any:
    httpx = _httpx()
    last_error: Exception | None = None
    for _ in range(2):
        try:
            return getattr(httpx, method)(url, **kwargs)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last_error = exc
    raise DeploymentAborted("domains service request failed") from last_error


def _response_detail(response: Any) -> str:
    try:
        data = response.json()
    except Exception:
        return ""
    if not isinstance(data, dict):
        return ""
    detail = data.get("detail")
    return str(detail) if detail is not None else ""


def _httpx() -> Any:
    try:
        import httpx
    except ImportError as exc:
        raise DeploymentAborted("install httpx to use FlyHostingProvider") from exc
    return httpx
