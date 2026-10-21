from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_checkpoint import Checkpoint, CheckpointStore, InMemoryBlobStore
from loopit_deployer import (
    DeploymentAborted,
    DeploymentRecord,
    DeploymentStatus,
    FakeAppProxyRegistrar,
    FakeDeploymentBillingClient,
    FakeHostingProvider,
    FakeProjectHostnameAllocator,
    FakeVpsControlClient,
    HttpDomainsAppProxyRegistrar,
    HttpDomainsProjectHostnameAllocator,
    InMemoryDeploymentRepository,
    InMemoryVpsCleanupRepository,
    MigrationFailed,
    PostgresDeploymentRepository,
    RuntimeAttachment,
    TenantIsolationRefused,
    VpsCleanupTask,
    VpsHostingProvider,
    VpsNetworkPosture,
    VpsResourceSpec,
    VpsSliceStatus,
    deploy_checkpoint,
    preview_secret_is_unreachable,
    rollback_project,
)
from loopit_gitsync import GitTreeEntry
from loopit_orchestrator import ApprovalSignal
from loopit_provision import ProjectDatabaseNames, ProvisionedDatabase, StorageBucket
from loopit_secrets import (
    Environment,
    SecretClass,
    SecretsBroker,
    SecretStore,
    SecretValue,
    StepContext,
    StoredSecret,
)

TENANT = "tenant_alpha"
PROJECT = "project_alpha"
RUN = "run_alpha"


class FixedClock:
    def __call__(self) -> datetime:
        return datetime(2026, 1, 1, tzinfo=UTC)


def files() -> dict[str, bytes]:
    return {
        "package.json": (
            b'{"scripts":{"start":"node dist/server/index.js",'
            b'"migrate":"node scripts/migrate.mjs"}}'
        ),
        ".env.example": b"DATABASE_URL=\nJWT_SECRET=\nS3_BUCKET=\n",
        "migrations/0001_bootstrap.sql": b"create table schema_migrations(id text primary key);",
        "src/server/index.ts": b"console.log('server');",
    }


def checkpoint_store() -> tuple[CheckpointStore, Checkpoint]:
    store = CheckpointStore(InMemoryBlobStore())
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=files(),
        verified=True,
    )
    return store, checkpoint


def runtime(production_url: str | None = "https://project-alpha.example.com") -> RuntimeAttachment:
    return RuntimeAttachment(
        database=ProvisionedDatabase(
            tenant_id=TENANT,
            project_id=PROJECT,
            names=ProjectDatabaseNames("p_demo", "p_demo_owner", "p_demo_app", "p_demo_migrator"),
            applied_migrations=("0001",),
            verified_tables=("tasks",),
        ),
        storage=StorageBucket("bucket", f"{TENANT}/{PROJECT}/"),
        production_url=production_url,
    )


def prod_broker() -> SecretsBroker:
    store = SecretStore(Environment.PROD)
    for name, value in {
        "GENERATED_DATABASE_URL": "postgres://project-db",
        "GENERATED_JWT_SECRET": "runtime-jwt-value",
        "S3_ACCESS_KEY_ID": "storage-access-id",
        "S3_SECRET_ACCESS_KEY": "storage-secret-value",
    }.items():
        store.put(
            StoredSecret(
                name=name,
                environment=Environment.PROD,
                secret_class=SecretClass.PROJECT,
                tenant_id=TENANT,
                project_id=PROJECT,
                value=SecretValue(value),
            )
        )
    return SecretsBroker(store, audit=InMemoryAuditSink(), clock=FixedClock())


def approval() -> ApprovalSignal:
    return ApprovalSignal("gate_1", True, "operator", "approved production deploy")


def deploy_one(
    provider: FakeHostingProvider,
    repository: InMemoryDeploymentRepository,
    checkpoint: Checkpoint,
    store: CheckpointStore,
) -> DeploymentRecord:
    return deploy_checkpoint(
        checkpoint=checkpoint,
        checkpoints=store,
        provider=provider,
        runtime=runtime(),
        repository=repository,
        run_id=RUN,
        prod_broker=prod_broker(),
        approval=approval(),
    )


def test_fake_hosting_provider_deploy_and_rollback() -> None:
    store, first = checkpoint_store()
    second = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=files() | {"src/server/feature.ts": b"export const ok = true;"},
        parent_id=first.checkpoint_id,
        verified=True,
    )
    provider = FakeHostingProvider()
    repo = InMemoryDeploymentRepository()

    deploy_one(provider, repo, first, store)
    deploy_one(provider, repo, second, store)
    rolled = rollback_project(
        tenant_id=TENANT,
        project_id=PROJECT,
        run_id="rollback-run",
        provider=provider,
        repository=repo,
    )

    assert rolled.status is DeploymentStatus.ROLLED_BACK
    assert rolled.checkpoint_id == first.checkpoint_id
    assert provider.events[-1] == f"rollback:{first.checkpoint_id}"


def test_migrations_run_before_cutover() -> None:
    store, checkpoint = checkpoint_store()
    provider = FakeHostingProvider()
    repo = InMemoryDeploymentRepository()

    deploy_one(provider, repo, checkpoint, store)

    assert [event.split(":", 1)[0] for event in provider.events] == [
        "stage",
        "migrate",
        "health",
        "promote",
    ]


def test_health_failure_aborts_cutover_and_keeps_previous_live() -> None:
    store, first = checkpoint_store()
    second = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=files() | {"src/server/new.ts": b"export const version = 2;"},
        parent_id=first.checkpoint_id,
        verified=True,
    )
    provider = FakeHostingProvider()
    repo = InMemoryDeploymentRepository()
    deploy_one(provider, repo, first, store)
    provider.fail_health = True

    with pytest.raises(DeploymentAborted):
        deploy_one(provider, repo, second, store)

    assert repo.live(PROJECT).checkpoint_id == first.checkpoint_id  # type: ignore[union-attr]
    assert repo.history(PROJECT)[-1].status is DeploymentStatus.FAILED
    assert not any(event.startswith("promote:") for event in provider.events[4:])


def test_gate_rejection_blocks_promotion() -> None:
    store, checkpoint = checkpoint_store()
    provider = FakeHostingProvider()

    with pytest.raises(DeploymentAborted):
        deploy_checkpoint(
            checkpoint=checkpoint,
            checkpoints=store,
            provider=provider,
            runtime=runtime(),
            repository=InMemoryDeploymentRepository(),
            run_id=RUN,
            prod_broker=prod_broker(),
            approval=ApprovalSignal("gate_1", False, "operator", "no"),
        )

    assert provider.events == []


def test_prod_secrets_unreachable_from_preview_context() -> None:
    preview_store = SecretStore(Environment.PREVIEW)
    preview_broker = SecretsBroker(preview_store, audit=InMemoryAuditSink(), clock=FixedClock())
    context = StepContext(
        run_id=RUN,
        step_id="preview",
        tenant_id=TENANT,
        project_id=PROJECT,
        declared_secrets=frozenset({"GENERATED_DATABASE_URL"}),
    )

    assert preview_secret_is_unreachable(preview_broker, context)


def test_deployment_history_records_previous_checkpoint() -> None:
    store, first = checkpoint_store()
    second = replace(
        store.snapshot(
            project_id=PROJECT,
            tenant_id=TENANT,
            files=files() | {"src/server/other.ts": b"export const version = 3;"},
            parent_id=first.checkpoint_id,
            verified=True,
        ),
        label="release-candidate",
    )
    provider = FakeHostingProvider()
    repo = InMemoryDeploymentRepository()

    first_record = deploy_one(provider, repo, first, store)
    second_record = deploy_one(provider, repo, second, store)

    assert repo.history(PROJECT) == (first_record, second_record)
    assert second_record.previous_checkpoint_id == first.checkpoint_id
    assert repo.live(PROJECT) == second_record


def image_for_tree(entries: tuple[GitTreeEntry, ...]) -> str:
    return f"registry.local/loopit:{len(entries)}"


def vps_provider(
    client: FakeVpsControlClient | None = None,
    proxy: FakeAppProxyRegistrar | None = None,
    allocator: FakeProjectHostnameAllocator | None = None,
    cleanup_repository: InMemoryVpsCleanupRepository | None = None,
) -> tuple[
    VpsHostingProvider, FakeVpsControlClient, FakeAppProxyRegistrar, FakeProjectHostnameAllocator
]:
    fake_client = client or FakeVpsControlClient(
        (
            VpsSliceStatus(
                "slice-full",
                "http://slice-full.internal",
                total_cpu_millicores=500,
                total_memory_mib=512,
                used_cpu_millicores=500,
                used_memory_mib=512,
            ),
            VpsSliceStatus("slice-a", "http://slice-a.internal", 2000, 2048),
        )
    )
    fake_proxy = proxy or FakeAppProxyRegistrar()
    fake_allocator = allocator or FakeProjectHostnameAllocator("apps.loopit.test")
    return (
        VpsHostingProvider(
            image_for_tree=image_for_tree,
            hostname_allocator=fake_allocator,
            proxy=fake_proxy,
            client=fake_client,
            slices=("slice-full", "slice-a"),
            resources=VpsResourceSpec(cpu_millicores=500, memory_mib=512),
            cleanup_repository=cleanup_repository,
        ),
        fake_client,
        fake_proxy,
        fake_allocator,
    )


def test_vps_promotes_only_after_health_pass_and_derives_hostname() -> None:
    store, checkpoint = checkpoint_store()
    provider, client, proxy, _allocator = vps_provider()
    repo = InMemoryDeploymentRepository()

    record = deploy_checkpoint(
        checkpoint=checkpoint,
        checkpoints=store,
        provider=provider,
        runtime=runtime(production_url=None),
        repository=repo,
        run_id=RUN,
        prod_broker=prod_broker(),
        approval=approval(),
    )

    assert record.production_url == "https://project-alpha.apps.loopit.test"
    assert [event.split(":", 1)[0] for event in client.events] == [
        "network",
        "start",
        "migrate",
        "health",
        "live",
    ]
    assert proxy.events == [
        f"route:project-alpha.apps.loopit.test:{checkpoint.checkpoint_id}:{record.provider_release_id}"
    ]


def test_http_domains_adapters_allocate_hostname_and_register_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, dict[str, Any]]] = []

    class Response:
        status_code = 200

        def __init__(self, data: dict[str, Any]) -> None:
            self._data = data

        def json(self) -> dict[str, Any]:
            return self._data

        def raise_for_status(self) -> None:
            return None

    class Http:
        TimeoutException = TimeoutError
        TransportError = OSError

        @staticmethod
        def post(url: str, **kwargs: Any) -> Response:
            calls.append(("post", url, kwargs))
            if url.endswith("/subdomain"):
                return Response({"hostname": "alpha.loopit.app", "label": "alpha"})
            return Response({"status": "registered"})

        @staticmethod
        def get(url: str, **kwargs: Any) -> Response:
            calls.append(("get", url, kwargs))
            return Response({"hostname": "alpha.loopit.app", "label": "alpha"})

    import loopit_deployer.core as core

    monkeypatch.setattr(core, "_httpx", lambda: Http)

    allocator = HttpDomainsProjectHostnameAllocator("http://domains:8008", "service-token")
    allocation = allocator.ensure_project_hostname(tenant_id="tenant-a", project_id="project-a")
    registrar = HttpDomainsAppProxyRegistrar("http://domains:8008", "service-token")
    registrar.register_backend(
        hostname=allocation.hostname,
        backend_url="http://slice-a.internal:8080/releases/r1",
        project_id="project-a",
        checkpoint_id="checkpoint-a",
        release_id="release-a",
    )

    assert allocation.url == "https://alpha.loopit.app"
    assert calls[0][2]["headers"]["X-Loopit-Service-Token"] == "service-token"
    assert calls[1][2]["json"]["backend_host"] == "slice-a.internal"
    assert calls[1][2]["json"]["backend_port"] == 8080


def test_vps_migration_failure_aborts_before_cutover() -> None:
    store, checkpoint = checkpoint_store()
    failing_client = FakeVpsControlClient(
        (
            VpsSliceStatus(
                "slice-full",
                "http://slice-full.internal",
                500,
                512,
                used_cpu_millicores=500,
                used_memory_mib=512,
            ),
            VpsSliceStatus("slice-a", "http://slice-a.internal", 2000, 2048),
        )
    )
    failing_client.fail_migration = True
    provider, _client, proxy, _allocator = vps_provider(client=failing_client)
    repo = InMemoryDeploymentRepository()

    with pytest.raises(MigrationFailed):
        deploy_checkpoint(
            checkpoint=checkpoint,
            checkpoints=store,
            provider=provider,
            runtime=runtime(production_url=None),
            repository=repo,
            run_id=RUN,
            prod_broker=prod_broker(),
            approval=approval(),
        )

    assert proxy.events == []
    assert repo.history(PROJECT)[-1].status is DeploymentStatus.FAILED
    assert failing_client.slice_status("slice-a").used_cpu_millicores == 0
    assert any(event.startswith("stop:slice-a:") for event in failing_client.events)


def test_vps_health_failure_releases_candidate_capacity_without_masking_error() -> None:
    store, checkpoint = checkpoint_store()
    failing_client = FakeVpsControlClient(
        (VpsSliceStatus("slice-a", "http://slice-a.internal", 500, 512),)
    )
    failing_client.fail_health = True
    provider = VpsHostingProvider(
        image_for_tree=image_for_tree,
        hostname_allocator=FakeProjectHostnameAllocator("apps.loopit.test"),
        proxy=FakeAppProxyRegistrar(),
        client=failing_client,
        slices=("slice-a",),
        resources=VpsResourceSpec(cpu_millicores=500, memory_mib=512),
    )

    with pytest.raises(DeploymentAborted, match="health check"):
        deploy_checkpoint(
            checkpoint=checkpoint,
            checkpoints=store,
            provider=provider,
            runtime=runtime(production_url=None),
            repository=InMemoryDeploymentRepository(),
            run_id=RUN,
            prod_broker=prod_broker(),
            approval=approval(),
        )

    assert failing_client.slice_status("slice-a").used_cpu_millicores == 0
    assert failing_client.slice_status("slice-a").used_memory_mib == 0


def test_vps_failed_cleanup_is_recorded_and_reconciled_to_reclaim_capacity() -> None:
    store, checkpoint = checkpoint_store()
    failing_client = FakeVpsControlClient(
        (
            VpsSliceStatus(
                "slice-a",
                "http://slice-a.internal",
                1000,
                1024,
                used_cpu_millicores=250,
                used_memory_mib=256,
            ),
        )
    )
    failing_client.fail_health = True
    failing_client.fail_stop = True
    cleanup_repo = InMemoryVpsCleanupRepository()
    provider = VpsHostingProvider(
        image_for_tree=image_for_tree,
        hostname_allocator=FakeProjectHostnameAllocator("apps.loopit.test"),
        proxy=FakeAppProxyRegistrar(),
        client=failing_client,
        slices=("slice-a",),
        resources=VpsResourceSpec(cpu_millicores=500, memory_mib=512),
        cleanup_repository=cleanup_repo,
    )
    baseline_cpu = failing_client.slice_status("slice-a").used_cpu_millicores
    baseline_memory = failing_client.slice_status("slice-a").used_memory_mib

    with pytest.raises(DeploymentAborted, match="health check"):
        deploy_checkpoint(
            checkpoint=checkpoint,
            checkpoints=store,
            provider=provider,
            runtime=runtime(production_url=None),
            repository=InMemoryDeploymentRepository(),
            run_id=RUN,
            prod_broker=prod_broker(),
            approval=approval(),
        )

    pending = cleanup_repo.pending_cleanups()
    staged_release_ids = set(provider._staged)
    assert failing_client.slice_status("slice-a").used_cpu_millicores == baseline_cpu + 500
    assert failing_client.slice_status("slice-a").used_memory_mib == baseline_memory + 512

    failing_client.fail_stop = False

    reaped = provider.reconcile_pending_cleanups()
    assert failing_client.slice_status("slice-a").used_cpu_millicores == baseline_cpu
    assert failing_client.slice_status("slice-a").used_memory_mib == baseline_memory
    assert cleanup_repo.pending_cleanups() == ()
    assert reaped == 1
    assert len(pending) == 1
    assert pending[0].release_id in staged_release_ids
    assert pending[0].release_id not in provider._staged
    assert pending[0].last_error == "slice agent timed out while stopping candidate"

    assert provider.reconcile_pending_cleanups() == 0
    assert failing_client.slice_status("slice-a").used_cpu_millicores == baseline_cpu
    assert failing_client.slice_status("slice-a").used_memory_mib == baseline_memory


def test_vps_cancelled_deploy_still_cleans_up_candidate_capacity() -> None:
    class CancellingClient(FakeVpsControlClient):
        def run_migration(self, slice_id: str, release_id: str, command: tuple[str, ...]) -> int:
            del slice_id, release_id, command
            raise asyncio.CancelledError

    store, checkpoint = checkpoint_store()
    client = CancellingClient((VpsSliceStatus("slice-a", "http://slice-a.internal", 500, 512),))
    provider = VpsHostingProvider(
        image_for_tree=image_for_tree,
        hostname_allocator=FakeProjectHostnameAllocator("apps.loopit.test"),
        proxy=FakeAppProxyRegistrar(),
        client=client,
        slices=("slice-a",),
        resources=VpsResourceSpec(cpu_millicores=500, memory_mib=512),
    )

    with pytest.raises(asyncio.CancelledError):
        deploy_checkpoint(
            checkpoint=checkpoint,
            checkpoints=store,
            provider=provider,
            runtime=runtime(production_url=None),
            repository=InMemoryDeploymentRepository(),
            run_id=RUN,
            prod_broker=prod_broker(),
            approval=approval(),
        )

    assert client.slice_status("slice-a").used_cpu_millicores == 0
    assert client.slice_status("slice-a").used_memory_mib == 0
    assert any(event.startswith("stop:slice-a:") for event in client.events)


def test_deploy_reserves_hosting_quota_before_vps_capacity_side_effects() -> None:
    store, checkpoint = checkpoint_store()
    provider, client, _proxy, _allocator = vps_provider()
    billing = FakeDeploymentBillingClient()

    deploy_checkpoint(
        checkpoint=checkpoint,
        checkpoints=store,
        provider=provider,
        runtime=runtime(production_url=None),
        repository=InMemoryDeploymentRepository(),
        run_id=RUN,
        prod_broker=prod_broker(),
        approval=approval(),
        billing=billing,
    )

    assert billing.events[0] == f"reserve:{PROJECT}:0"
    assert client.events[0].startswith("network:")


def test_deploy_blocks_over_quota_before_vps_capacity_side_effects() -> None:
    store, checkpoint = checkpoint_store()
    provider, client, _proxy, _allocator = vps_provider()
    billing = FakeDeploymentBillingClient()
    billing.fail_reservation_reason = "always_on_apps quota exceeded"

    with pytest.raises(DeploymentAborted, match="always_on_apps quota exceeded"):
        deploy_checkpoint(
            checkpoint=checkpoint,
            checkpoints=store,
            provider=provider,
            runtime=runtime(production_url=None),
            repository=InMemoryDeploymentRepository(),
            run_id=RUN,
            prod_broker=prod_broker(),
            approval=approval(),
            billing=billing,
        )

    assert client.events == []


def test_deploy_meters_previous_live_hosting_seconds_on_replacement() -> None:
    store, first = checkpoint_store()
    second = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=files() | {"src/server/replacement.ts": b"export const version = 2;"},
        parent_id=first.checkpoint_id,
        verified=True,
    )
    provider = FakeHostingProvider()
    repo = InMemoryDeploymentRepository()
    billing = FakeDeploymentBillingClient()
    deployed_at = datetime(2026, 1, 1, tzinfo=UTC)
    replaced_at = datetime(2026, 1, 1, 0, 15, tzinfo=UTC)

    deploy_checkpoint(
        checkpoint=first,
        checkpoints=store,
        provider=provider,
        runtime=runtime(),
        repository=repo,
        run_id="run-1",
        prod_broker=prod_broker(),
        approval=approval(),
        billing=billing,
        clock=lambda: deployed_at,
    )
    deploy_checkpoint(
        checkpoint=second,
        checkpoints=store,
        provider=provider,
        runtime=runtime(),
        repository=repo,
        run_id="run-2",
        prod_broker=prod_broker(),
        approval=approval(),
        billing=billing,
        clock=lambda: replaced_at,
    )

    assert f"meter:{PROJECT}:900" in billing.events


def test_vps_rollback_restores_previous_live_route() -> None:
    store, first = checkpoint_store()
    second = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=files() | {"src/server/v2.ts": b"export const version = 2;"},
        parent_id=first.checkpoint_id,
        verified=True,
    )
    provider, _client, proxy, _allocator = vps_provider()
    repo = InMemoryDeploymentRepository()
    deploy_checkpoint(
        checkpoint=first,
        checkpoints=store,
        provider=provider,
        runtime=runtime(production_url=None),
        repository=repo,
        run_id="run-1",
        prod_broker=prod_broker(),
        approval=approval(),
    )
    deploy_checkpoint(
        checkpoint=second,
        checkpoints=store,
        provider=provider,
        runtime=runtime(production_url=None),
        repository=repo,
        run_id="run-2",
        prod_broker=prod_broker(),
        approval=approval(),
    )

    rolled = rollback_project(
        tenant_id=TENANT,
        project_id=PROJECT,
        run_id="rollback-run",
        provider=provider,
        repository=repo,
    )

    assert rolled.checkpoint_id == first.checkpoint_id
    assert proxy.routes["project-alpha.apps.loopit.test"].checkpoint_id == first.checkpoint_id


def test_vps_tenant_isolation_refuses_missing_metadata_denial() -> None:
    posture = VpsNetworkPosture(
        network_name="loopit-tenant-project",
        metadata_deny_cidrs=frozenset({"169.254.0.0/16"}),
    )

    with pytest.raises(TenantIsolationRefused):
        posture.validate()


class MemoryDeploymentConnection:
    def __init__(
        self,
        rows: list[dict[str, Any]] | None = None,
        cleanup_rows: list[dict[str, Any]] | None = None,
    ) -> None:
        self.rows = rows if rows is not None else []
        self.cleanup_rows = cleanup_rows if cleanup_rows is not None else []
        self.result: list[dict[str, Any]] = []

    def execute(self, query: str, params: tuple[object, ...] = ()) -> MemoryDeploymentConnection:
        normalized = " ".join(query.lower().split())
        if normalized.startswith("insert into deployment_records"):
            self.rows.append(
                {
                    "deployment_id": params[0],
                    "tenant_id": params[1],
                    "project_id": params[2],
                    "checkpoint_id": params[3],
                    "run_id": params[4],
                    "status": params[5],
                    "production_url": params[6],
                    "created_at": params[7],
                    "previous_checkpoint_id": params[8],
                    "provider_release_id": params[9],
                    "reason": params[10],
                }
            )
            self.result = []
        elif normalized.startswith("insert into vps_cleanup_tasks"):
            release_id = str(params[0])
            existing = next(
                (row for row in self.cleanup_rows if row["release_id"] == release_id),
                None,
            )
            row = {
                "release_id": release_id,
                "slice_id": params[1],
                "project_id": params[2],
                "checkpoint_id": params[3],
                "backend_url": params[4],
                "updated_at": params[6],
                "attempts": (int(existing["attempts"]) if existing else 0) + 1,
                "last_error": params[7],
            }
            if existing is None:
                self.cleanup_rows.append(row)
            else:
                existing.update(row)
            self.result = []
        elif normalized.startswith("delete from vps_cleanup_tasks"):
            release_id = str(params[0])
            self.cleanup_rows[:] = [
                row for row in self.cleanup_rows if row["release_id"] != release_id
            ]
            self.result = []
        elif normalized.startswith("select * from vps_cleanup_tasks"):
            self.result = sorted(
                self.cleanup_rows,
                key=lambda row: (row["updated_at"], row["release_id"]),
            )
        elif "where project_id = %s and status = 'live'" in normalized:
            project_id = str(params[0])
            self.result = [
                row
                for row in reversed(self.rows)
                if row["project_id"] == project_id and row["status"] == "live"
            ][:1]
        elif "where project_id = %s" in normalized:
            project_id = str(params[0])
            self.result = [row for row in self.rows if row["project_id"] == project_id]
        else:
            self.result = []
        return self

    def fetchall(self) -> list[dict[str, Any]]:
        return self.result

    def commit(self) -> None:
        return None


def test_postgres_deployment_records_survive_repository_restart() -> None:
    shared_rows: list[dict[str, Any]] = []
    first_repo = PostgresDeploymentRepository(MemoryDeploymentConnection(shared_rows))
    record = DeploymentRecord(
        deployment_id="dep_persist",
        tenant_id=TENANT,
        project_id=PROJECT,
        checkpoint_id="ckpt_persist",
        run_id=RUN,
        status=DeploymentStatus.LIVE,
        production_url="https://persist.example.test",
        provider_release_id="release-persist",
    )
    first_repo.append(record)

    restarted_repo = PostgresDeploymentRepository(MemoryDeploymentConnection(shared_rows))

    assert restarted_repo.live(PROJECT) == record
    assert restarted_repo.history(PROJECT) == (record,)


def test_postgres_vps_cleanup_tasks_survive_repository_restart() -> None:
    shared_rows: list[dict[str, Any]] = []
    shared_cleanup_rows: list[dict[str, Any]] = []
    first_repo = PostgresDeploymentRepository(
        MemoryDeploymentConnection(shared_rows, shared_cleanup_rows)
    )
    task = VpsCleanupTask(
        release_id="release-persist",
        slice_id="slice-a",
        project_id=PROJECT,
        checkpoint_id="ckpt-persist",
        backend_url="http://slice-a.internal/releases/release-persist",
        last_error="timeout",
    )

    first_repo.record_pending_cleanup(task)
    restarted_repo = PostgresDeploymentRepository(
        MemoryDeploymentConnection(shared_rows, shared_cleanup_rows)
    )

    pending = restarted_repo.pending_cleanups()
    assert len(pending) == 1
    assert pending[0] == VpsCleanupTask(
        release_id=task.release_id,
        slice_id=task.slice_id,
        project_id=task.project_id,
        checkpoint_id=task.checkpoint_id,
        backend_url=task.backend_url,
        attempts=1,
        last_error=task.last_error,
    )

    restarted_repo.delete_pending_cleanup(task.release_id)

    assert first_repo.pending_cleanups() == ()
