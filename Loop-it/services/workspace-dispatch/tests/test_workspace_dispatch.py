from __future__ import annotations

import secrets
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, cast

import pytest
from fastapi.testclient import TestClient
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_sandbox_sdk import Lease, ResourceCaps
from loopit_scheduler import InMemoryProvider
from loopit_store import LeaseRecord
from loopit_tools import CommandResult
from loopit_tools.transport import WorkspaceTransport
from loopit_verify import Check, Level

if TYPE_CHECKING:
    from loopit_workspace_dispatch.workspace import WorkspaceFactory


@dataclass(frozen=True, slots=True)
class SecretMaterial:
    service_token: str
    lease_secret: str
    sandbox_key: str


@pytest.fixture
def secret_material(monkeypatch: pytest.MonkeyPatch) -> SecretMaterial:
    material = SecretMaterial(
        service_token="svc-" + secrets.token_hex(24),
        lease_secret="lease-" + secrets.token_hex(24),
        sandbox_key="sandbox-" + secrets.token_hex(24),
    )
    monkeypatch.setenv("LOOPIT_SERVICE_TOKEN", material.service_token)
    monkeypatch.setenv("LOOPIT_LEASE_TOKEN_SECRET", material.lease_secret)
    monkeypatch.setenv("LOOPIT_SANDBOX_SIGNING_KEY", material.sandbox_key)
    monkeypatch.setenv("LOOPIT_ENV", "local")
    monkeypatch.setenv("LOOPIT_SANDBOX_PROVIDER", "memory")
    return material


def _record(
    lease_id: str = "lease_1",
    *,
    tenant_id: str = "tenant",
    allowed_tools: tuple[str, ...] = ("read_file", "search_code", "apply_patch", "run_shell"),
    status: str = "active",
    expires_at: datetime | None = None,
    base_checkpoint_id: str = "ckpt-1",
) -> LeaseRecord:
    provider = InMemoryProvider()
    sandbox = provider.create(ResourceCaps())
    sandbox.assign(tenant_id)
    return LeaseRecord(
        lease_id=lease_id,
        tenant_id=tenant_id,
        run_id="run-1",
        project_id="project-1",
        sandbox_id=sandbox.sandbox_id,
        base_checkpoint_id=base_checkpoint_id,
        expires_at=expires_at or datetime.now(UTC) + timedelta(minutes=10),
        caps={
            "cpu_millicores": 2000,
            "memory_mib": 4096,
            "disk_mib": 20480,
            "wall_clock_seconds": 1800,
            "max_processes": 512,
        },
        allowed_tools=allowed_tools,
        status=cast(Any, status),
    )


def _client(
    record: LeaseRecord,
    secret_material: SecretMaterial,
    *,
    workspace_factory: WorkspaceFactory | None = None,
    audit: InMemoryAuditSink | None = None,
    checks: tuple[Check, ...] | None = None,
    checkpoints: Any | None = None,
    store_dsn: str = "",
    raise_server_exceptions: bool = True,
) -> tuple[TestClient, str, WorkspaceFactory, InMemoryAuditSink]:
    from loopit_checkpoint import ContentAddressedCheckpointStore, InMemoryBlobStore
    from loopit_scheduler.server import ServerSettings, _token
    from loopit_store import CheckpointRecord, InMemoryCheckpointStore
    from loopit_workspace_dispatch.auth import StaticLeaseResolver
    from loopit_workspace_dispatch.server import DispatchSettings, VerificationChecks, create_app
    from loopit_workspace_dispatch.workspace import InMemoryWorkspaceFactory

    settings = DispatchSettings(
        lease_token_secret=secret_material.lease_secret,
        service_token=secret_material.service_token,
        sandbox_signing_key=secret_material.sandbox_key,
        store_dsn=store_dsn,
    )
    scheduler_settings = ServerSettings(
        lease_token_secret=secret_material.lease_secret,
        service_token=secret_material.service_token,
    )
    factory = workspace_factory or InMemoryWorkspaceFactory()
    sink = audit or InMemoryAuditSink()
    checkpoint_store = checkpoints or ContentAddressedCheckpointStore(
        InMemoryCheckpointStore(), InMemoryBlobStore()
    )
    checkpoint_store.create(
        CheckpointRecord(
            checkpoint_id=record.base_checkpoint_id,
            tenant_id=record.tenant_id,
            project_id=record.project_id,
            manifest={},
            verified=True,
            created_by_run_id=record.run_id,
        )
    )
    app = create_app(
        settings=settings,
        lease_resolver=StaticLeaseResolver({record.lease_id: record}, scheduler_settings),
        workspace_factory=factory,
        audit=sink,
        verification=VerificationChecks(checks),
        checkpoints=checkpoint_store,
    )
    return (
        TestClient(app, raise_server_exceptions=raise_server_exceptions),
        _token(record, scheduler_settings),
        factory,
        sink,
    )


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": "Bearer " + token}


def test_healthz(secret_material: SecretMaterial) -> None:
    client, _, _, _ = _client(_record(), secret_material)
    assert client.get("/healthz").status_code == 200


def test_production_construction_requires_durable_checkpoint_store(
    secret_material: SecretMaterial, monkeypatch: pytest.MonkeyPatch
) -> None:
    from loopit_agent_core.config import UnsafeConfigurationError
    from loopit_workspace_dispatch.server import DispatchSettings, create_app

    monkeypatch.setenv("LOOPIT_ENV", "production")
    monkeypatch.delenv("LOOPIT_STORE_DSN", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    with pytest.raises(UnsafeConfigurationError, match="LOOPIT_STORE_DSN or DATABASE_URL"):
        create_app(
            settings=DispatchSettings(
                lease_token_secret=secret_material.lease_secret,
                service_token=secret_material.service_token,
                sandbox_signing_key=secret_material.sandbox_key,
                sandbox_provider="memory",
            )
        )


def test_configured_docker_provider_is_validated_at_startup(
    secret_material: SecretMaterial, monkeypatch: pytest.MonkeyPatch
) -> None:
    from loopit_agent_core.config import UnsafeConfigurationError
    from loopit_workspace_dispatch import server
    from loopit_workspace_dispatch.workspace import (
        DockerRuntimeWorkspaceFactory,
        WorkspaceUnavailable,
    )

    called = False

    def fail_validation(self: object) -> None:
        nonlocal called
        called = True
        raise WorkspaceUnavailable("daemon unavailable")

    monkeypatch.setattr(DockerRuntimeWorkspaceFactory, "validate", fail_validation)

    with pytest.raises(UnsafeConfigurationError, match="daemon unavailable"):
        server.create_app(
            settings=server.DispatchSettings(
                lease_token_secret=secret_material.lease_secret,
                service_token=secret_material.service_token,
                sandbox_signing_key=secret_material.sandbox_key,
                sandbox_provider="docker",
            )
        )

    assert called is True


def test_docker_factory_refuses_option_like_container_id_and_uses_option_separator(
    secret_material: SecretMaterial, monkeypatch: pytest.MonkeyPatch
) -> None:
    import io

    from loopit_workspace_dispatch.workspace import (
        DockerRuntimeWorkspace,
        DockerRuntimeWorkspaceFactory,
        WorkspaceUnavailable,
    )

    class FakeProcess:
        stdin = io.StringIO()
        stdout = io.StringIO()
        stderr = io.StringIO()

    class FakeCompleted:
        returncode = 0
        stdout = "{}"
        stderr = ""

    popen_commands: list[list[str]] = []
    run_commands: list[list[str]] = []

    def fake_popen(command: list[str], **_: object) -> FakeProcess:
        popen_commands.append(command)
        return FakeProcess()

    def fake_run(command: list[str], **_: object) -> FakeCompleted:
        run_commands.append(command)
        return FakeCompleted()

    monkeypatch.setattr("loopit_workspace_dispatch.workspace.shutil.which", lambda _name: "docker")
    monkeypatch.setattr("loopit_workspace_dispatch.workspace.subprocess.Popen", fake_popen)
    monkeypatch.setattr("loopit_workspace_dispatch.workspace.subprocess.run", fake_run)
    factory = DockerRuntimeWorkspaceFactory(
        root_signing_key=secret_material.sandbox_key.encode("utf-8")
    )
    lease = lease_id_to_lease(_record())

    with pytest.raises(WorkspaceUnavailable, match="invalid docker sandbox container id"):
        factory.create(lease=lease, sandbox_id="docker_--privileged")

    assert popen_commands == []

    workspace = factory.create(lease=lease, sandbox_id="docker_abc123.DEF-ghi")

    assert isinstance(workspace, DockerRuntimeWorkspace)
    assert "--" in popen_commands[0]
    separator = popen_commands[0].index("--")
    assert popen_commands[0][separator + 1] == "abc123.DEF-ghi"
    assert workspace.snapshot_manifest() == {}
    assert run_commands[0][:4] == ["docker", "exec", "--", "abc123.DEF-ghi"]


def test_unknown_lease_is_refused_even_with_valid_token(secret_material: SecretMaterial) -> None:
    record = _record()
    client, token, _, _ = _client(record, secret_material)

    response = client.post(
        "/dispatch",
        headers=_headers(token),
        json={"lease_id": "lease_other", "tool": "read_file", "args": {"path": "README.md"}},
    )

    assert response.status_code == 404


def test_released_lease_is_refused(secret_material: SecretMaterial) -> None:
    record = _record(status="released")
    client, token, _, _ = _client(record, secret_material)

    response = client.post(
        "/dispatch",
        headers=_headers(token),
        json={"lease_id": record.lease_id, "tool": "read_file", "args": {"path": "README.md"}},
    )

    assert response.status_code == 404


def test_scheduler_reported_non_active_lease_is_refused(
    secret_material: SecretMaterial,
) -> None:
    from loopit_scheduler.server import ServerSettings, _token
    from loopit_workspace_dispatch.auth import SchedulerLeaseResolver
    from loopit_workspace_dispatch.server import DispatchSettings, create_app
    from loopit_workspace_dispatch.workspace import InMemoryWorkspaceFactory

    record = _record()
    scheduler_settings = ServerSettings(
        lease_token_secret=secret_material.lease_secret,
        service_token=secret_material.service_token,
    )

    class StubSchedulerLeaseResolver(SchedulerLeaseResolver):
        def _list_tenant_leases(self, tenant_id: str) -> dict[str, Any]:
            assert tenant_id == record.tenant_id
            return {
                "leases": [
                    {
                        "lease_id": record.lease_id,
                        "tenant_id": record.tenant_id,
                        "run_id": record.run_id,
                        "project_id": record.project_id,
                        "sandbox_id": record.sandbox_id,
                        "base_checkpoint_id": record.base_checkpoint_id,
                        "expires_at": record.expires_at.isoformat(),
                        "caps": record.caps,
                        "allowed_tools": record.allowed_tools,
                        "status": "released",
                    }
                ]
            }

    app = create_app(
        settings=DispatchSettings(
            lease_token_secret=secret_material.lease_secret,
            service_token=secret_material.service_token,
            sandbox_signing_key=secret_material.sandbox_key,
        ),
        lease_resolver=StubSchedulerLeaseResolver("http://scheduler.invalid", scheduler_settings),
        workspace_factory=InMemoryWorkspaceFactory(),
    )
    client = TestClient(app)

    response = client.post(
        "/dispatch",
        headers=_headers(_token(record, scheduler_settings)),
        json={"lease_id": record.lease_id, "tool": "read_file", "args": {"path": "README.md"}},
    )

    assert response.status_code == 404


def test_tool_not_in_lease_allowlist_is_refused(secret_material: SecretMaterial) -> None:
    record = _record(allowed_tools=("read_file",))
    client, token, _, audit = _client(record, secret_material)

    response = client.post(
        "/dispatch",
        headers=_headers(token),
        json={"lease_id": record.lease_id, "tool": "run_shell", "args": {"command": "echo hi"}},
    )

    assert response.status_code == 403
    assert audit.of_type("tool.dispatch.refused")[-1].detail["reason"] == "tool_not_allowed"


def test_unknown_tool_is_refused_before_execution(secret_material: SecretMaterial) -> None:
    record = _record()
    client, token, _, audit = _client(record, secret_material)

    response = client.post(
        "/dispatch",
        headers=_headers(token),
        json={"lease_id": record.lease_id, "tool": "overwrite_file", "args": {"path": "x"}},
    )

    assert response.status_code == 403
    assert audit.of_type("tool.dispatch.refused")[-1].detail["reason"] == "unknown_tool"


def test_end_to_end_apply_patch_then_read_against_in_memory_provider(
    secret_material: SecretMaterial,
) -> None:
    from loopit_workspace_dispatch.workspace import InMemoryWorkspace

    record = _record(allowed_tools=("read_file", "apply_patch"))
    client, token, factory, audit = _client(record, secret_material)
    workspace = cast(
        InMemoryWorkspace,
        factory.create(lease=lease_id_to_lease(record), sandbox_id=record.sandbox_id),
    )
    workspace.files["README.md"] = "hello\n"

    patch = "--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-hello\n+hello sandbox\n"
    patched = client.post(
        "/dispatch",
        headers=_headers(token),
        json={"lease_id": record.lease_id, "tool": "apply_patch", "args": {"patch": patch}},
    )
    read = client.post(
        "/dispatch",
        headers=_headers(token),
        json={"lease_id": record.lease_id, "tool": "read_file", "args": {"path": "README.md"}},
    )

    assert patched.status_code == 200
    assert patched.json()["ok"] is True
    assert patched.json()["checkpoint_created"] is True
    checkpoint_id = patched.json()["checkpoint_id"]
    checkpoint = cast(Any, client.app).state.checkpoints.get(
        checkpoint_id, tenant_id=record.tenant_id
    )
    assert checkpoint is not None
    assert checkpoint.parent_id == record.base_checkpoint_id
    assert checkpoint.verified is False
    assert checkpoint.created_by_run_id == record.run_id
    assert patched.json()["changed_paths"] == ["README.md"]
    assert read.status_code == 200
    assert read.json()["checkpoint_created"] is False
    assert read.json()["checkpoint_id"] is None
    assert "hello sandbox" in read.json()["output"]
    assert audit.of_type("tool.dispatch.completed")[-1].sandbox_lease_id == record.lease_id


def test_mutating_run_shell_checkpoints_changed_workspace(
    secret_material: SecretMaterial,
) -> None:
    import hashlib

    record = _record(allowed_tools=("run_shell",))
    client, token, factory, _ = _client(record, secret_material)

    response = client.post(
        "/dispatch",
        headers=_headers(token),
        json={
            "lease_id": record.lease_id,
            "tool": "run_shell",
            "args": {"command": "npm run build"},
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["checkpoint_created"] is True
    assert response.json()["checkpoint_id"] is not None
    assert response.json()["changed_paths"] == ["dist/index.html"]
    workspace = factory.create(lease=lease_id_to_lease(record), sandbox_id=record.sandbox_id)
    assert hasattr(workspace, "files")
    cast(Any, workspace).files.clear()
    checkpoint = cast(Any, client.app).state.checkpoints.get(
        response.json()["checkpoint_id"], tenant_id=record.tenant_id
    )
    assert checkpoint is not None
    assert checkpoint.parent_id == record.base_checkpoint_id
    assert checkpoint.manifest["dist/index.html"] == hashlib.sha256(b"built\n").hexdigest()
    assert (
        cast(Any, client.app).state.checkpoints.read_file(checkpoint, "dist/index.html")
        == b"built\n"
    )


def test_unchanged_blob_is_not_reuploaded_on_second_checkpoint(
    secret_material: SecretMaterial,
) -> None:
    from loopit_checkpoint import BlobStore, ContentAddressedCheckpointStore, InMemoryBlobStore
    from loopit_store import InMemoryCheckpointStore
    from loopit_workspace_dispatch.workspace import InMemoryWorkspace, InMemoryWorkspaceFactory

    class CountingBlobStore:
        def __init__(self) -> None:
            self._inner = InMemoryBlobStore()
            self.put_count = 0

        def put(self, content: bytes) -> str:
            self.put_count += 1
            return self._inner.put(content)

        def get(self, digest: str) -> bytes:
            return self._inner.get(digest)

        def has(self, digest: str) -> bool:
            return self._inner.has(digest)

    class TwoStageBuildWorkspace(InMemoryWorkspace):
        def run_shell(
            self, command: str, *, cwd: str | None, timeout_seconds: int, output_bytes: int
        ) -> CommandResult:
            del cwd, timeout_seconds, output_bytes
            if command == "npm run build" and "dist/index.html" not in self.files:
                self.files["dist/index.html"] = "built\n"
                return CommandResult(0, stdout="built index\n")
            if command == "npm run build":
                self.files["dist/chunk.js"] = "chunk\n"
                return CommandResult(0, stdout="built chunk\n")
            return CommandResult(127, stderr=f"unknown command: {command}\n")

    blobs = CountingBlobStore()
    checkpoint_store = ContentAddressedCheckpointStore(
        InMemoryCheckpointStore(), cast(BlobStore, blobs)
    )
    record = _record(allowed_tools=("run_shell",))
    client, token, factory, _ = _client(
        record,
        secret_material,
        workspace_factory=InMemoryWorkspaceFactory(),
        checkpoints=checkpoint_store,
    )
    workspace_factory = cast(InMemoryWorkspaceFactory, factory)
    workspace_factory._workspaces[record.sandbox_id] = TwoStageBuildWorkspace()

    first = client.post(
        "/dispatch",
        headers=_headers(token),
        json={
            "lease_id": record.lease_id,
            "tool": "run_shell",
            "args": {"command": "npm run build"},
        },
    )
    second = client.post(
        "/dispatch",
        headers=_headers(token),
        json={
            "lease_id": record.lease_id,
            "tool": "run_shell",
            "args": {"command": "npm run build"},
        },
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["changed_paths"] == ["dist/index.html"]
    assert second.json()["changed_paths"] == ["dist/chunk.js"]
    assert blobs.put_count == 2


def test_read_only_run_shell_does_not_create_noop_checkpoint(
    secret_material: SecretMaterial,
) -> None:
    from loopit_workspace_dispatch.workspace import InMemoryWorkspaceFactory

    record = _record(allowed_tools=("run_shell",))
    client, token, _, _ = _client(
        record,
        secret_material,
        workspace_factory=InMemoryWorkspaceFactory(
            command_results={"npm run test": CommandResult(0, stdout="ok\n")}
        ),
    )

    response = client.post(
        "/dispatch",
        headers=_headers(token),
        json={
            "lease_id": record.lease_id,
            "tool": "run_shell",
            "args": {"command": "npm run test"},
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["checkpoint_created"] is False
    assert response.json()["checkpoint_id"] is None
    assert response.json()["changed_paths"] == []
    current = cast(Any, client.app).state.checkpoints.current(
        record.project_id, tenant_id=record.tenant_id
    )
    assert current.checkpoint_id == record.base_checkpoint_id


def test_unchanged_run_shell_uses_metadata_fast_path(
    secret_material: SecretMaterial,
) -> None:
    from loopit_workspace_dispatch.workspace import InMemoryWorkspace

    class CountingWorkspace(InMemoryWorkspace):
        snapshot_manifest_calls = 0
        snapshot_manifest_for_paths_calls = 0
        snapshot_state_calls = 0

        def snapshot_manifest(self) -> dict[str, str]:
            self.snapshot_manifest_calls += 1
            return dict(super().snapshot_manifest())

        def snapshot_state(self) -> dict[str, str]:
            self.snapshot_state_calls += 1
            return dict(super().snapshot_state())

        def snapshot_manifest_for_paths(self, paths: Sequence[str]) -> dict[str, str]:
            self.snapshot_manifest_for_paths_calls += 1
            return dict(super().snapshot_manifest_for_paths(paths))

    class StaticWorkspaceFactory:
        workspace = CountingWorkspace(
            command_results={"npm run test": CommandResult(0, stdout="ok\n")}
        )

        def create(self, *, lease: Lease, sandbox_id: str) -> WorkspaceTransport:
            del lease, sandbox_id
            return self.workspace

    record = _record(allowed_tools=("run_shell",))
    factory = StaticWorkspaceFactory()
    client, token, _, _ = _client(record, secret_material, workspace_factory=factory)

    response = client.post(
        "/dispatch",
        headers=_headers(token),
        json={
            "lease_id": record.lease_id,
            "tool": "run_shell",
            "args": {"command": "npm run test"},
        },
    )

    assert response.status_code == 200
    assert response.json()["checkpoint_created"] is False
    assert factory.workspace.snapshot_state_calls == 2
    assert factory.workspace.snapshot_manifest_calls == 0
    assert factory.workspace.snapshot_manifest_for_paths_calls == 0


def test_mutating_run_shell_checkpoint_failure_is_not_reported_as_preserved(
    secret_material: SecretMaterial,
) -> None:
    from loopit_checkpoint import ContentAddressedCheckpointStore, InMemoryBlobStore
    from loopit_store import CheckpointRecord, InMemoryCheckpointStore

    class FailingChildCheckpointStore:
        def __init__(self) -> None:
            self._inner = InMemoryCheckpointStore()

        def create(self, checkpoint: CheckpointRecord) -> CheckpointRecord:
            if checkpoint.parent_id is not None:
                raise RuntimeError("checkpoint store unavailable")
            return self._inner.create(checkpoint)

        def get(self, checkpoint_id: str, *, tenant_id: str) -> CheckpointRecord | None:
            return self._inner.get(checkpoint_id, tenant_id=tenant_id)

        def current(self, project_id: str, *, tenant_id: str) -> CheckpointRecord | None:
            return self._inner.current(project_id, tenant_id=tenant_id)

        def ancestors(self, checkpoint_id: str, *, tenant_id: str) -> tuple[CheckpointRecord, ...]:
            return self._inner.ancestors(checkpoint_id, tenant_id=tenant_id)

        def set_current(self, project_id: str, *, tenant_id: str, checkpoint_id: str) -> None:
            self._inner.set_current(project_id, tenant_id=tenant_id, checkpoint_id=checkpoint_id)

        def pin(self, checkpoint_id: str, *, run_id: str) -> None:
            self._inner.pin(checkpoint_id, run_id=run_id)

        def unpin(self, checkpoint_id: str, *, run_id: str) -> None:
            self._inner.unpin(checkpoint_id, run_id=run_id)

        def is_pinned(self, checkpoint_id: str) -> bool:
            return self._inner.is_pinned(checkpoint_id)

    record = _record(allowed_tools=("run_shell",))
    checkpoint_store = ContentAddressedCheckpointStore(
        FailingChildCheckpointStore(), InMemoryBlobStore()
    )
    client, token, _, _ = _client(record, secret_material, checkpoints=checkpoint_store)

    response = client.post(
        "/dispatch",
        headers=_headers(token),
        json={
            "lease_id": record.lease_id,
            "tool": "run_shell",
            "args": {"command": "npm run build"},
        },
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "workspace changed but checkpoint creation failed"}
    current = cast(Any, client.app).state.checkpoints.current(
        record.project_id, tenant_id=record.tenant_id
    )
    assert current.checkpoint_id == record.base_checkpoint_id


def test_blob_store_failure_is_not_reported_as_preserved(
    secret_material: SecretMaterial,
) -> None:
    from loopit_checkpoint import BlobStore, CheckpointError, ContentAddressedCheckpointStore
    from loopit_store import InMemoryCheckpointStore

    class FailingBlobStore:
        def put(self, content: bytes) -> str:
            del content
            raise CheckpointError("blob backend unavailable")

        def get(self, digest: str) -> bytes:
            raise CheckpointError(f"blob {digest} unavailable")

        def has(self, digest: str) -> bool:
            del digest
            return False

    record = _record(allowed_tools=("run_shell",))
    checkpoint_store = ContentAddressedCheckpointStore(
        InMemoryCheckpointStore(), cast(BlobStore, FailingBlobStore())
    )
    client, token, _, _ = _client(record, secret_material, checkpoints=checkpoint_store)

    response = client.post(
        "/dispatch",
        headers=_headers(token),
        json={
            "lease_id": record.lease_id,
            "tool": "run_shell",
            "args": {"command": "npm run build"},
        },
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "workspace checkpoint blob storage failed"}
    current = cast(Any, client.app).state.checkpoints.current(
        record.project_id, tenant_id=record.tenant_id
    )
    assert current.checkpoint_id == record.base_checkpoint_id


class _SchemaDb:
    def __init__(self) -> None:
        self.tenants: set[str] = set()
        self.projects: set[str] = set()
        self.runs: set[str] = set()


class _ForeignKeyViolation(Exception):
    """Stand-in for the control-plane foreign keys in 001_initial_control_plane.sql."""


class _SchemaCursor:
    def __init__(self, db: _SchemaDb) -> None:
        self._db = db

    def __enter__(self) -> _SchemaCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, sql: str, params: tuple[object, ...] | None = None) -> None:
        statement = " ".join(sql.split()).lower()
        values = tuple(params or ())
        if statement.startswith("insert into tenants"):
            self._db.tenants.add(str(values[0]))
            return
        if statement.startswith("insert into projects"):
            tenant_id = str(values[1])
            if tenant_id not in self._db.tenants:
                raise _ForeignKeyViolation(
                    'insert or update on table "projects" violates foreign key '
                    'constraint "projects_tenant_id_fkey"'
                )
            self._db.projects.add(str(values[0]))
            return
        if statement.startswith("insert into runs"):
            tenant_id = str(values[1])
            project_id = str(values[2])
            if tenant_id not in self._db.tenants or project_id not in self._db.projects:
                raise _ForeignKeyViolation(
                    'insert or update on table "runs" violates foreign key constraint'
                )
            self._db.runs.add(str(values[0]))
            return
        raise AssertionError(f"unexpected SQL: {statement}")


class _SchemaConnection:
    def __init__(self, db: _SchemaDb) -> None:
        self._db = db

    def __enter__(self) -> _SchemaConnection:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def cursor(self) -> _SchemaCursor:
        return _SchemaCursor(self._db)


class _HiddenCurrentCheckpoints:
    """current() stays empty until genesis explicitly advances the pointer."""

    def __init__(self) -> None:
        from loopit_checkpoint import ContentAddressedCheckpointStore, InMemoryBlobStore
        from loopit_store import InMemoryCheckpointStore

        self._inner = ContentAddressedCheckpointStore(
            InMemoryCheckpointStore(), InMemoryBlobStore()
        )
        self.visible = False

    def current(self, project_id: str, *, tenant_id: str) -> Any:
        if not self.visible:
            return None
        return self._inner.current(project_id, tenant_id=tenant_id)

    def set_current(self, project_id: str, *, tenant_id: str, checkpoint_id: str) -> None:
        self.visible = True
        self._inner.set_current(project_id, tenant_id=tenant_id, checkpoint_id=checkpoint_id)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def test_root_lineage_seeds_tenant_before_project(
    secret_material: SecretMaterial, monkeypatch: pytest.MonkeyPatch
) -> None:
    from loopit_workspace_dispatch import server

    db = _SchemaDb()

    def connect(dsn: str) -> _SchemaConnection:
        assert dsn
        return _SchemaConnection(db)

    monkeypatch.setattr(server, "connect", connect)
    record = _record(allowed_tools=("run_shell",), base_checkpoint_id="root")
    client, token, _, _ = _client(
        record,
        secret_material,
        checkpoints=_HiddenCurrentCheckpoints(),
        store_dsn="postgresql://db.internal/loopit",
        raise_server_exceptions=False,
    )

    response = client.post(
        "/dispatch",
        headers=_headers(token),
        json={
            "lease_id": record.lease_id,
            "tool": "run_shell",
            "args": {"command": "npm run build"},
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["checkpoint_created"] is True
    assert record.tenant_id in db.tenants
    assert record.project_id in db.projects
    assert record.run_id in db.runs


def test_production_construction_requires_durable_checkpoint_blob_store(
    secret_material: SecretMaterial, monkeypatch: pytest.MonkeyPatch
) -> None:
    from loopit_agent_core.config import UnsafeConfigurationError
    from loopit_workspace_dispatch.server import DispatchSettings, create_app

    monkeypatch.setenv("LOOPIT_ENV", "production")

    with pytest.raises(UnsafeConfigurationError, match="LOOPIT_CHECKPOINT_BLOB_DIR"):
        create_app(
            settings=DispatchSettings(
                lease_token_secret=secret_material.lease_secret,
                service_token=secret_material.service_token,
                sandbox_signing_key=secret_material.sandbox_key,
                store_dsn="postgresql://db.internal/loopit",
                sandbox_provider="memory",
            )
        )


def test_verify_runs_pipeline_through_workspace_runner(secret_material: SecretMaterial) -> None:
    from loopit_workspace_dispatch.workspace import InMemoryWorkspaceFactory

    record = _record(allowed_tools=("run_shell",))
    command_results = {"echo verified": CommandResult(0, stdout="verified\n")}
    checks = (Check("scripted", Level.L0_STATIC, ("echo", "verified")),)
    client, token, _, _ = _client(
        record,
        secret_material,
        workspace_factory=InMemoryWorkspaceFactory(command_results=command_results),
        checks=checks,
    )

    response = client.post(
        "/dispatch",
        headers=_headers(token),
        json={"lease_id": record.lease_id, "tool": "verify", "args": {}},
    )

    assert response.status_code == 200
    assert response.json()["verified"] is True
    assert response.json()["passed"] is True
    assert response.json()["checkpoint_created"] is True
    checkpoint = cast(Any, client.app).state.checkpoints.get(
        response.json()["checkpoint_id"], tenant_id=record.tenant_id
    )
    assert checkpoint is not None
    assert checkpoint.verified is True
    assert checkpoint.parent_id == record.base_checkpoint_id
    assert "Verification passed" in response.json()["summary"]


def test_verify_requires_shell_permission(secret_material: SecretMaterial) -> None:
    record = _record(allowed_tools=("read_file",))
    client, token, _, _ = _client(record, secret_material)

    response = client.post(
        "/dispatch",
        headers=_headers(token),
        json={"lease_id": record.lease_id, "tool": "verify", "args": {}},
    )

    assert response.status_code == 403


def lease_id_to_lease(record: LeaseRecord) -> Lease:
    from loopit_workspace_dispatch.auth import lease_from_record

    return lease_from_record(record)
