"""HTTP entrypoint for the workspace dispatch data plane.

Every request is denied until it proves lease ownership. Only after the lease is
known active does the service construct a sandbox workspace and call the normal
tool/verification adapters, preserving the invariant that generated code never
runs in the orchestration process.
"""

from __future__ import annotations

import logging
import os
import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from loopit_agent_core import AuditEvent, AuditSink, ToolRejected, redact, validate_tool_call
from loopit_agent_core.config import UnsafeConfigurationError, has_production_marker, require_secret
from loopit_checkpoint import (
    CheckpointError,
    ContentAddressedCheckpointStore,
    FileSystemBlobStore,
    InMemoryBlobStore,
)
from loopit_patch import PatchError, parse_patch
from loopit_store import (
    CheckpointRecord,
    CheckpointStore,
    InMemoryAuditStore,
    InMemoryCheckpointStore,
    PostgresAppendOnlyAuditSink,
    PostgresCheckpointStore,
)
from loopit_store.postgres import connect
from loopit_telemetry import add_loopit_telemetry, configure_telemetry
from loopit_tools import AuditContext, default_registry
from loopit_verify import (
    Check,
    VerificationPipeline,
    node_typescript_checks,
    python_checks,
    security_checks,
    smoke_check,
)
from pydantic import BaseModel, Field

from .auth import LeaseResolver, SchedulerLeaseResolver, lease_from_record
from .e2b_runtime import E2BRuntimeWorkspaceFactory, default_e2b_connect
from .workspace import (
    CheckpointableWorkspace,
    DockerRuntimeWorkspaceFactory,
    InMemoryWorkspaceFactory,
    RefusingWorkspaceFactory,
    WorkspaceCommandRunner,
    WorkspaceFactory,
    WorkspaceUnavailable,
)

LOG = logging.getLogger("loopit.workspace_dispatch")
SERVICE_NAME = "workspace-dispatch"
TOOL_NAMES = frozenset(
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
CONTROL_VERBS = frozenset({"verify"})
MAY_MUTATE_WORKSPACE = frozenset(
    {"apply_patch", "run_shell", "install_package", "start_dev_server"}
)


@dataclass(frozen=True, slots=True)
class DispatchSettings:
    host: str = "0.0.0.0"  # noqa: S104 - container listener; compose publishes loopback only.
    port: int = 8080
    lease_token_secret: str = ""
    service_token: str = ""
    scheduler_url: str = "http://scheduler:8004"
    sandbox_signing_key: str = ""
    audit_dsn: str = ""
    store_dsn: str = ""
    checkpoint_blob_dir: str = ""
    sandbox_provider: str = "docker"
    verify_stack: Literal["node", "python"] = "node"
    verify_smoke_url: str = "http://localhost:3000"

    @classmethod
    def from_env(cls) -> DispatchSettings:
        stack = os.environ.get("LOOPIT_VERIFY_STACK", "node").lower()
        if stack not in {"node", "python"}:
            stack = "node"
        return cls(
            host=os.environ.get("LOOPIT_WORKSPACE_DISPATCH_HOST", "0.0.0.0"),  # noqa: S104
            port=int(os.environ.get("LOOPIT_WORKSPACE_DISPATCH_PORT", "8080")),
            lease_token_secret=require_secret(os.environ, "LOOPIT_LEASE_TOKEN_SECRET"),
            service_token=require_secret(os.environ, "LOOPIT_SERVICE_TOKEN"),
            scheduler_url=os.environ.get("LOOPIT_SCHEDULER_URL", "http://scheduler:8004"),
            sandbox_signing_key=require_secret(os.environ, "LOOPIT_SANDBOX_SIGNING_KEY"),
            audit_dsn=os.environ.get("LOOPIT_AUDIT_DSN", ""),
            store_dsn=os.environ.get("LOOPIT_STORE_DSN", os.environ.get("DATABASE_URL", "")),
            checkpoint_blob_dir=os.environ.get("LOOPIT_CHECKPOINT_BLOB_DIR", ""),
            sandbox_provider=os.environ.get("LOOPIT_SANDBOX_PROVIDER", "docker").lower(),
            verify_stack="python" if stack == "python" else "node",
            verify_smoke_url=os.environ.get("LOOPIT_VERIFY_SMOKE_URL", "http://localhost:3000"),
        )


class DispatchRequest(BaseModel):
    lease_id: str | None = None
    tool: str | None = None
    args: dict[str, Any] = Field(default_factory=dict)

    run_id: str | None = None
    tenant_id: str | None = None
    project_id: str | None = None
    node_id: str | None = None
    node_goal: str | None = None
    base_checkpoint_id: str | None = None
    checkpoint_id: str | None = None
    expected_verification: tuple[str, ...] = ()
    destructive: bool | None = None


@dataclass(frozen=True, slots=True)
class VerificationChecks:
    checks: Sequence[Check] | None = None


class StoreAuditSink:
    def __init__(self, store: InMemoryAuditStore) -> None:
        self._store = store

    def emit(self, event: AuditEvent) -> None:
        self._store.append(event)


def create_app(
    *,
    settings: DispatchSettings | None = None,
    lease_resolver: LeaseResolver | None = None,
    workspace_factory: WorkspaceFactory | None = None,
    audit: AuditSink | None = None,
    verification: VerificationChecks | None = None,
    checkpoints: CheckpointStore | None = None,
) -> FastAPI:
    resolved = settings or DispatchSettings.from_env()
    logging.basicConfig(level=os.environ.get("LOOPIT_LOG_LEVEL", "INFO"), format="%(message)s")
    configure_telemetry(SERVICE_NAME)
    app = FastAPI(title="loopit-workspace-dispatch")
    add_loopit_telemetry(app, SERVICE_NAME)
    app.state.settings = resolved
    app.state.audit = audit if audit is not None else _audit_sink(resolved)
    app.state.lease_resolver = lease_resolver or SchedulerLeaseResolver(
        resolved.scheduler_url,
        _scheduler_settings(resolved),
    )
    app.state.workspace_factory = (
        workspace_factory if workspace_factory is not None else _workspace_factory(resolved)
    )
    app.state.verification = verification if verification is not None else VerificationChecks()
    app.state.checkpoints = checkpoints if checkpoints is not None else _checkpoint_store(resolved)

    @app.exception_handler(Exception)
    def handle_unexpected_exception(_request: Request, exc: Exception) -> JSONResponse:
        LOG.exception("unhandled workspace-dispatch exception")
        return JSONResponse(status_code=500, content={"detail": _redact_exception_text(exc)})

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/dispatch")
    def dispatch(
        payload: DispatchRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, Any]:
        if payload.lease_id is None:
            return _handle_dag_without_lease(payload, audit=app.state.audit)
        if payload.tool is None:
            raise HTTPException(status_code=400, detail="tool is required")

        record = app.state.lease_resolver.resolve(payload.lease_id, authorization=authorization)
        lease = lease_from_record(record)
        if payload.tool in CONTROL_VERBS:
            return _verify(record, lease, app=app)
        if payload.tool not in TOOL_NAMES:
            _emit_refusal(app.state.audit, record, payload.tool, "unknown_tool")
            raise HTTPException(status_code=403, detail="tool is not available")
        if not lease.permits(payload.tool):
            _emit_refusal(app.state.audit, record, payload.tool, "tool_not_allowed")
            raise HTTPException(status_code=403, detail="tool is not allowed by this lease")

        try:
            call = validate_tool_call({"tool": payload.tool, "args": payload.args})
        except ToolRejected as error:
            _emit_refusal(app.state.audit, record, payload.tool, "invalid_args")
            raise HTTPException(status_code=422, detail=error.observation) from error

        try:
            workspace = app.state.workspace_factory.create(
                lease=lease, sandbox_id=record.sandbox_id
            )
        except WorkspaceUnavailable as error:
            _emit(app.state.audit, record, "tool.dispatch.failed", "failure", {"error": str(error)})
            raise HTTPException(status_code=503, detail=str(error)) from error
        checkpoint_parent: CheckpointRecord | None = None
        checkpoint_before: Mapping[str, str] | None = None
        if payload.tool in MAY_MUTATE_WORKSPACE:
            checkpoint_parent = _ensure_checkpointable(
                app.state.checkpoints, record, workspace, store_dsn=resolved.store_dsn
            )
            checkpoint_before = _snapshot_state(workspace)
        context = AuditContext(
            tenant_id=record.tenant_id,
            project_id=record.project_id,
            run_id=record.run_id,
            task_id=record.run_id,
            sandbox_lease_id=record.lease_id,
        )
        registry = default_registry(workspace, audit=app.state.audit, audit_context=context)
        _emit(app.state.audit, record, "tool.dispatch.started", "pending", {"tool": payload.tool})
        try:
            result = registry.execute(call)
        except ToolRejected as error:
            _emit(
                app.state.audit, record, "tool.dispatch.refused", "denied", {"tool": payload.tool}
            )
            raise HTTPException(status_code=403, detail=error.observation) from error
        _emit(
            app.state.audit,
            record,
            "tool.dispatch.completed",
            "success" if result.ok else "failure",
            {"tool": payload.tool, "detail": dict(result.detail)},
        )
        checkpoint_id: str | None = None
        checkpoint_created = False
        changed_paths: tuple[str, ...] = ()
        if result.ok and payload.tool in MAY_MUTATE_WORKSPACE:
            if checkpoint_parent is None:
                raise HTTPException(status_code=503, detail="base checkpoint not found")
            checkpoint_id, detected_paths = _record_checkpoint_if_changed(
                app.state.checkpoints,
                record,
                workspace,
                parent=checkpoint_parent,
                before_state=checkpoint_before,
                verified=False,
                label=_checkpoint_label(payload, str(payload.tool)),
            )
            checkpoint_created = checkpoint_id is not None
            changed_paths = (
                _changed_paths_from_patch(payload.args.get("patch"))
                if payload.tool == "apply_patch" and checkpoint_created
                else detected_paths
            )
        return {
            "ok": result.ok,
            "output": result.output,
            "summary": result.output,
            "checkpoint_id": checkpoint_id,
            "checkpoint_created": checkpoint_created,
            "changed_paths": changed_paths,
        }

    @app.post("/")
    def root_dispatch(
        payload: DispatchRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, Any]:
        return dispatch(payload, authorization)

    return app


def _verify(record: Any, lease: Any, *, app: FastAPI) -> dict[str, Any]:
    if not lease.permits("run_shell"):
        _emit_refusal(app.state.audit, record, "verify", "run_shell_not_allowed")
        raise HTTPException(status_code=403, detail="verification requires run_shell in this lease")
    try:
        workspace = app.state.workspace_factory.create(lease=lease, sandbox_id=record.sandbox_id)
    except WorkspaceUnavailable as error:
        _emit(app.state.audit, record, "workspace.verify.failed", "failure", {"error": str(error)})
        raise HTTPException(status_code=503, detail=str(error)) from error
    _ensure_checkpointable(
        app.state.checkpoints,
        record,
        workspace,
        store_dsn=getattr(app.state.settings, "store_dsn", ""),
    )
    checks = app.state.verification.checks or _default_checks(
        app.state.settings, workspace=workspace
    )
    pipeline = VerificationPipeline(
        checks=checks,
        runner=WorkspaceCommandRunner(workspace),
        audit=app.state.audit,
    )
    report = pipeline.run(
        tenant_id=record.tenant_id,
        run_id=record.run_id,
        project_id=record.project_id,
    )
    summary = report.observation()
    _emit(
        app.state.audit,
        record,
        "workspace.verify.completed",
        "success" if report.passed else "failure",
        {"levels_run": [level.name for level in report.levels_run]},
    )
    checkpoint_id = (
        _record_checkpoint(
            app.state.checkpoints,
            record,
            workspace,
            verified=True,
            label="verify",
        )
        if report.passed
        else None
    )
    return {
        "ok": report.passed,
        "verified": report.passed,
        "passed": report.passed,
        "summary": summary,
        "output": summary,
        "tokens": 0,
        "credits": 0.0,
        "checkpoint_id": checkpoint_id,
        "checkpoint_created": checkpoint_id is not None,
        "changed_paths": (),
    }


def _handle_dag_without_lease(payload: DispatchRequest, *, audit: AuditSink) -> dict[str, Any]:
    if payload.node_goal is not None:
        if payload.tenant_id:
            audit.emit(
                AuditEvent(
                    type="dag.dispatch.refused",
                    tenant_id=payload.tenant_id,
                    actor_kind="service",
                    actor_service=SERVICE_NAME,
                    project_id=payload.project_id,
                    run_id=payload.run_id,
                    plane="data",
                    outcome="denied",
                    detail={"node_id": payload.node_id, "reason": "missing_lease"},
                )
            )
        raise HTTPException(status_code=401, detail="DAG node dispatch requires a lease_id")
    if payload.checkpoint_id is not None:
        return {"passed": False, "summary": "DAG verification requires a lease_id"}
    raise HTTPException(status_code=400, detail="lease_id is required")


_STATIC_WORKSPACE_CHECK_SCRIPT = (
    "import pathlib,sys; "
    "files=[p for p in pathlib.Path('.').rglob('*') "
    "if p.is_file() and not any(part.startswith('.') for part in p.parts)]; "
    "sys.exit(0 if files and all(p.stat().st_size > 0 for p in files "
    "if p.suffix in {'.html','.htm'}) else 1)"
)


def _default_checks(settings: DispatchSettings, workspace: Any = None) -> tuple[Check, ...]:
    if settings.verify_stack == "python":
        return python_checks()
    state = _snapshot_state(workspace) if workspace is not None else None
    if state is not None and "package.json" not in state:
        return (
            Check(
                name="static-files",
                level=Level.L0_STATIC,
                command=("python3", "-c", _STATIC_WORKSPACE_CHECK_SCRIPT),
                timeout_seconds=30,
            ),
        )
    return (
        *node_typescript_checks(package_manager="npm"),
        smoke_check(settings.verify_smoke_url),
        *security_checks(package_manager="npm"),
    )


def _workspace_factory(settings: DispatchSettings) -> WorkspaceFactory:
    if settings.sandbox_provider in {"memory", "inmemory", "in-memory"}:
        return InMemoryWorkspaceFactory()
    if settings.sandbox_provider == "docker":
        factory = DockerRuntimeWorkspaceFactory(
            root_signing_key=settings.sandbox_signing_key.encode("utf-8")
        )
        try:
            factory.validate()
        except WorkspaceUnavailable as error:
            raise UnsafeConfigurationError(
                "LOOPIT_SANDBOX_PROVIDER=docker is configured, but the Docker sandbox "
                f"provider is not reachable: {error}"
            ) from error
        return factory
    if settings.sandbox_provider == "e2b":
        factory = E2BRuntimeWorkspaceFactory(
            root_signing_key=settings.sandbox_signing_key.encode("utf-8"),
            connect=default_e2b_connect,
        )
        try:
            factory.validate()
        except WorkspaceUnavailable as error:
            raise UnsafeConfigurationError(
                "LOOPIT_SANDBOX_PROVIDER=e2b is configured, but the E2B SDK is "
                f"unavailable: {error}"
            ) from error
        return factory
    return RefusingWorkspaceFactory(
        f"workspace dispatch cannot attach to sandbox provider {settings.sandbox_provider!r}"
    )


def _audit_sink(settings: DispatchSettings) -> AuditSink:
    if not settings.audit_dsn:
        return StoreAuditSink(InMemoryAuditStore())
    return PostgresAppendOnlyAuditSink(connect(settings.audit_dsn))


def _checkpoint_store(settings: DispatchSettings) -> CheckpointStore:
    if not settings.store_dsn:
        if has_production_marker(os.environ):
            raise UnsafeConfigurationError(
                "LOOPIT_STORE_DSN or DATABASE_URL must be set for workspace-dispatch "
                "when a production marker is present"
            )
        records: Any = InMemoryCheckpointStore()
    else:
        blobs = _blob_store(settings)
        records = PostgresCheckpointStore(connect(settings.store_dsn))
        return ContentAddressedCheckpointStore(records, blobs)
    return ContentAddressedCheckpointStore(records, _blob_store(settings))


def _blob_store(settings: DispatchSettings) -> Any:
    if settings.checkpoint_blob_dir:
        return FileSystemBlobStore(Path(settings.checkpoint_blob_dir))
    if has_production_marker(os.environ):
        raise UnsafeConfigurationError(
            "LOOPIT_CHECKPOINT_BLOB_DIR must be set for workspace-dispatch when "
            "a production marker is present"
        )
    return InMemoryBlobStore()


def _scheduler_settings(settings: DispatchSettings) -> Any:
    from loopit_scheduler.server import ServerSettings

    return ServerSettings(
        lease_token_secret=settings.lease_token_secret,
        service_token=settings.service_token,
    )


def _record_checkpoint(
    checkpoints: Any,
    record: Any,
    workspace: Any,
    *,
    verified: bool,
    label: str,
) -> str:
    parent = _ensure_checkpointable(checkpoints, record, workspace)
    paths = _snapshot_state_paths(workspace)
    manifest = _manifest_from_workspace_contents(checkpoints, workspace, paths)
    return _create_checkpoint(
        checkpoints,
        record,
        parent=parent,
        manifest=manifest,
        verified=verified,
        label=label,
    )


def _record_checkpoint_if_changed(
    checkpoints: Any,
    record: Any,
    workspace: Any,
    *,
    parent: CheckpointRecord,
    before_state: Mapping[str, str] | None,
    verified: bool,
    label: str,
) -> tuple[str | None, tuple[str, ...]]:
    if before_state is not None and isinstance(workspace, CheckpointableWorkspace):
        after_state = _snapshot_state(workspace)
        if after_state is not None:
            changed_state_paths = _changed_paths_from_manifest(before_state, after_state)
            if not changed_state_paths:
                return None, ()
            manifest = _manifest_from_changed_paths(
                checkpoints, parent.manifest, workspace, changed_state_paths
            )
        else:
            paths = _snapshot_state_paths(workspace)
            manifest = _manifest_from_workspace_contents(checkpoints, workspace, paths)
    else:
        paths = _snapshot_state_paths(workspace)
        manifest = _manifest_from_workspace_contents(checkpoints, workspace, paths)
    changed_paths = _changed_paths_from_manifest(parent.manifest, manifest)
    if not changed_paths:
        return None, ()
    checkpoint_id = _create_checkpoint(
        checkpoints,
        record,
        parent=parent,
        manifest=manifest,
        verified=verified,
        label=label,
    )
    return checkpoint_id, changed_paths


def _snapshot_state(workspace: Any) -> Mapping[str, str] | None:
    if not isinstance(workspace, CheckpointableWorkspace):
        return None
    try:
        return dict(workspace.snapshot_state())
    except WorkspaceUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


def _snapshot_state_paths(workspace: Any) -> tuple[str, ...]:
    state = _snapshot_state(workspace)
    if state is None:
        raise HTTPException(status_code=503, detail="workspace cannot provide checkpoint content")
    return tuple(state)


def _manifest_from_changed_paths(
    checkpoints: Any,
    parent_manifest: Mapping[str, str],
    workspace: CheckpointableWorkspace,
    changed_paths: Sequence[str],
) -> dict[str, str]:
    manifest = dict(parent_manifest)
    changed_manifest = _manifest_from_workspace_contents(checkpoints, workspace, changed_paths)
    for path in changed_paths:
        manifest.pop(path, None)
    manifest.update(changed_manifest)
    return manifest


def _manifest_from_workspace_contents(
    checkpoints: Any, workspace: CheckpointableWorkspace, paths: Sequence[str]
) -> dict[str, str]:
    try:
        return dict(workspace.store_blobs_for_paths(checkpoints, paths))
    except (AttributeError, CheckpointError, OSError) as error:
        raise HTTPException(
            status_code=503, detail="workspace checkpoint blob storage failed"
        ) from error
    except WorkspaceUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


def _create_checkpoint(
    checkpoints: Any,
    record: Any,
    *,
    parent: CheckpointRecord,
    manifest: dict[str, str],
    verified: bool,
    label: str,
) -> str:
    # If a mutating tool succeeded but this write fails, the lease teardown will
    # destroy uncheckpointed work. Return an error instead of claiming success
    # with checkpoint_created=false or fabricating lineage the store does not own.
    try:
        checkpoint = checkpoints.commit_manifest(
            checkpoint_id=f"ckpt_{uuid.uuid4().hex}",
            tenant_id=record.tenant_id,
            project_id=record.project_id,
            files=manifest,
            parent_id=parent.checkpoint_id,
            verified=verified,
            label=label,
            created_by_run_id=record.run_id,
        )
    except (CheckpointError, KeyError, RuntimeError, OSError) as error:
        raise HTTPException(
            status_code=503, detail="workspace changed but checkpoint creation failed"
        ) from error
    try:
        checkpoints.set_current(
            str(record.project_id),
            tenant_id=record.tenant_id,
            checkpoint_id=str(checkpoint.checkpoint_id),
        )
    except (CheckpointError, KeyError, RuntimeError, OSError):
        # Pointer advancement is bookkeeping: losing it must not mask a
        # durable checkpoint commit already recorded for the run.
        pass
    return str(checkpoint.checkpoint_id)


_ROOT_SENTINELS = frozenset({"", "root"})


def _ensure_project_row(store_dsn: str, project_id: str, tenant_id: str, run_id: str) -> None:
    """Ensure tenant/project/run rows exist so checkpoint FKs resolve.

    The API persists run/project rows at start. This remains an idempotent
    fallback for races or older in-flight workflows whose catalog insert has
    not committed yet. ``projects.tenant_id`` references ``tenants``, and
    genesis checkpoints violate ``checkpoints_project_id_fkey`` /
    ``checkpoints_created_by_run_id_fkey`` without these rows. A missing tenant
    is not one of the caught checkpoint errors, so it surfaces as HTTP 500.
    """
    if not store_dsn:
        return
    with connect(store_dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO tenants (tenant_id, name) VALUES (%s, %s) "
            "ON CONFLICT (tenant_id) DO NOTHING",
            (tenant_id, tenant_id),
        )
        cur.execute(
            "INSERT INTO projects (project_id, tenant_id, name, stack) "
            "VALUES (%s, %s, %s, %s) ON CONFLICT (project_id) DO NOTHING",
            (project_id, tenant_id, f"Ephemeral {project_id}", "python"),
        )
        if run_id:
            cur.execute(
                "INSERT INTO runs (run_id, tenant_id, project_id, prompt, status, "
                "budget_max_iterations) VALUES (%s, %s, %s, %s, 'failed', 9999) "
                "ON CONFLICT (run_id) DO NOTHING",
                (
                    run_id,
                    tenant_id,
                    project_id,
                    "workspace-dispatch tracked run",
                ),
            )


def _ensure_checkpointable(
    checkpoints: Any, record: Any, workspace: Any, *, store_dsn: str = ""
) -> CheckpointRecord:
    base_id = record.base_checkpoint_id
    if base_id in _ROOT_SENTINELS:
        # Fresh lineage: the API expresses "no parent" with the root sentinel,
        # so resolve (or synthesize) the project's genesis anchor instead of
        # demanding a stored base that a brand-new project cannot have.
        parent = checkpoints.current(str(record.project_id), tenant_id=record.tenant_id)
        if parent is None:
            try:
                _ensure_project_row(
                    store_dsn,
                    str(record.project_id),
                    str(record.tenant_id),
                    str(getattr(record, "run_id", "") or ""),
                )
                parent = checkpoints.commit_manifest(
                    checkpoint_id=f"ckpt_{uuid.uuid4().hex}",
                    tenant_id=record.tenant_id,
                    project_id=record.project_id,
                    files={},
                    parent_id=None,
                    verified=True,
                    label="genesis",
                    created_by_run_id=getattr(record, "run_id", None),
                )
                checkpoints.set_current(
                    str(record.project_id),
                    tenant_id=record.tenant_id,
                    checkpoint_id=str(parent.checkpoint_id),
                )
            except (CheckpointError, KeyError, RuntimeError, OSError) as error:
                raise HTTPException(
                    status_code=503, detail="workspace genesis checkpoint creation failed"
                ) from error
    else:
        parent = checkpoints.get(str(base_id), tenant_id=record.tenant_id)
        if parent is None:
            raise HTTPException(status_code=503, detail="base checkpoint not found")
    if not isinstance(workspace, CheckpointableWorkspace):
        raise HTTPException(status_code=503, detail="workspace cannot produce checkpoints")
    parent_record = cast(CheckpointRecord, parent)
    return parent_record


def _changed_paths_from_patch(patch: object) -> tuple[str, ...]:
    if not isinstance(patch, str):
        return ()
    try:
        parsed = parse_patch(patch)
    except PatchError:
        return ()
    paths = {path for item in parsed for path in (item.old_path, item.new_path) if path is not None}
    return tuple(sorted(paths))


def _changed_paths_from_manifest(
    before: Mapping[str, str], after: Mapping[str, str]
) -> tuple[str, ...]:
    return tuple(
        sorted(path for path in before.keys() | after.keys() if before.get(path) != after.get(path))
    )


def _checkpoint_label(payload: DispatchRequest, fallback: str) -> str:
    if payload.node_id:
        return f"dag-node:{payload.node_id}"
    return fallback


_INLINE_SECRET_KV = re.compile(
    r"\b(secret|token|password|passwd|api[_-]?key|authorization|credential)\s*([:=])\s*(\S+)",
    re.IGNORECASE,
)
_URL_CREDENTIALS = re.compile(r"(://[^/\s:@]+:)([^@\s]+)(@)")


def _redact_exception_text(exc: BaseException) -> str:
    raw = str(redact(f"{type(exc).__name__}: {exc}"))
    scrubbed = _INLINE_SECRET_KV.sub(r"\1\2[REDACTED]", raw)
    scrubbed = _URL_CREDENTIALS.sub(r"\1[REDACTED]\3", scrubbed)
    return scrubbed[:400]


def _emit_refusal(audit: AuditSink, record: Any, tool: str | None, reason: str) -> None:
    _emit(audit, record, "tool.dispatch.refused", "denied", {"tool": tool, "reason": reason})


def _emit(
    audit: AuditSink,
    record: Any,
    event_type: str,
    outcome: Literal["allowed", "denied", "success", "failure", "pending"],
    detail: Mapping[str, Any],
) -> None:
    audit.emit(
        AuditEvent(
            type=event_type,
            tenant_id=record.tenant_id,
            actor_kind="service",
            actor_service=SERVICE_NAME,
            project_id=record.project_id,
            run_id=record.run_id,
            sandbox_lease_id=record.lease_id,
            plane="data",
            outcome=outcome,
            detail=detail,
        )
    )


app = create_app()


def main() -> None:
    settings = DispatchSettings.from_env()
    uvicorn.run(create_app(settings=settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
