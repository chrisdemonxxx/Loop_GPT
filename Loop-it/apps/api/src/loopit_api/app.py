"""The local preview API (apps/api).

A thin HTTP surface over the real agent loop: start a run, watch it happen,
read the files it produced. It exists so the product can be *felt* before Phase
3 builds the durable orchestration behind it, and it is deliberately small — a
preview that grows its own business logic becomes a second implementation to
keep in sync with the real one.

Two things it will not do.

**It will not invent a model.** Without credentials the API refuses to start a
live run and says so, rather than falling back to a canned script dressed up as
a model. A demo that fakes the model is a demo of the UI, and mistaking one for
the other is how a team convinces itself the hard part is done. ``--offline``
exists for looking at the interface, and it labels every run it produces.

**Local preview never widens the agent sandbox.** In ``local`` mode the agent's
``run_shell`` tool always refuses (see :mod:`loopit_api.workspace`). In
``orchestrator`` mode shell runs inside a leased E2B sandbox via
workspace-dispatch. The operator terminal (:mod:`loopit_api.terminal`) is
admin-only on the API host unless a project lease is available, in which case
``/exec`` is routed into the sandbox.
"""

from __future__ import annotations

import json
import logging
import os
import posixpath
import secrets
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from loopit_agent_core.config import (
    UnsafeConfigurationError,
    has_production_marker,
    is_truthy,
    require_secret,
)
from loopit_auth import (
    Actor,
    AuthService,
    InMemoryAuthRepository,
    LoginError,
    PlanQuota,
    PostgresAuthRepository,
    PreflightGuard,
    Resource,
    TokenSigner,
    authorize,
)
from loopit_checkpoint import CheckpointError
from loopit_orchestrator import OrchestratorClient
from loopit_orchestrator.types import ApprovalSignal, RunStatus, RunWorkflowInput, WorkflowBudget
from loopit_preview.tokens import TokenSigner as PreviewTokenSigner
from loopit_preview.tokens import mint_for as mint_preview_token
from loopit_store import (
    AuditStore,
    InMemoryAuditStore,
    InMemoryProjectStore,
    InMemoryQuotaStore,
    InMemoryRunStore,
    PostgresAuditStore,
    PostgresProjectStore,
    PostgresQuotaStore,
    PostgresRunStore,
    ProjectRecord,
    ProjectStore,
    QuotaEntry,
    QuotaStore,
    RunStore,
)
from loopit_store.postgres import connect
from loopit_telemetry import add_loopit_telemetry, configure_telemetry
from pydantic import BaseModel, Field

from . import terminal
from .dispatch_client import DispatchClient, DispatchCommandRunner, DispatchError
from .domains_bridge import domains_from_env, meter_custom_domain_month
from .gitsync_bridge import gitsync_from_env
from .hosting import publish_via_hosting, read_hosted_file, rollback_via_hosting
from .metering import (
    CreditsExhausted,
    LoopGptUsageMeter,
    MeteringUnavailable,
    usage_meter_from_env,
)
from .sharing import SharingStore
from .analytics_bridge import AnalyticsStore
from .collab_bridge import CollabStore
from .connectors_bridge import ConnectorsStore
from .templates_gallery import get_template, load_templates
from .project_backend import (
    backend_from_env,
    browse_table,
    delete_secret,
    ensure_runtime,
    issue_dev_jwt,
    list_secret_names,
    list_tables,
    load_backend_meta,
    public_runtime_meta,
    put_secret,
    request_secret,
    sandbox_env_for,
)
from .reviews import ReviewStore
from .persist import (
    load_run_meta,
    persist_run_finished,
    persist_run_started,
    record_to_dict,
    write_run_meta_fields,
)
from .runs import RUN_FINISHED, RunManager, RunRequest, RunState, validate_task_dag_payload
from .scheduler_client import SchedulerClient, SchedulerError
from .preview_client import PreviewProxyClient, PreviewProxyError, default_backend_from_env
from .stacks import MODULE_CDN, REACT_STACK, uses_sandbox_runtime
from .terminal import TERMINAL_SCOPE
from .browser_test import get_browser_test, list_browser_tests, run_browser_test
from .security_scan import (
    latest_security_scan,
    publish_blocked_by_security,
    run_security_scan,
)
from .verify_bridge import record_console_error
from .user_edit import apply_user_file_edit, extract_html_seo
from .visual_edit import VisualEditRequest, apply_visual_edit
from .workspace import WorkspaceError, resolve_in_workspace

CREDENTIAL_REF = "secrets://models/hf-router"
#: Site tokens whose lease starts with this serve a published deployment's
#: pinned checkpoint; every other site token serves the live workspace.
DEPLOY_LEASE_PREFIX = "deploy-"
LOGGER = logging.getLogger(__name__)


def _deploys_path(projects_root: Path, project_id: str) -> Path:
    return projects_root / ".deploys" / f"{project_id}.json"


def _load_deployments(projects_root: Path, project_id: str) -> list[dict[str, Any]]:
    """Durable deployment history — survives the in-memory store's restart."""
    try:
        data = json.loads(_deploys_path(projects_root, project_id).read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _save_deployments(
    projects_root: Path, project_id: str, history: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    path = _deploys_path(projects_root, project_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(history, indent=2), encoding="utf-8")
    except OSError:
        LOGGER.warning("could not persist deployment for %s", project_id)
    return history


def _persist_deployment(projects_root: Path, project_id: str, record: dict[str, Any]) -> list[dict[str, Any]]:
    history = _load_deployments(projects_root, project_id)
    history.append(record)
    return _save_deployments(projects_root, project_id, history)


def _replace_deployment(
    projects_root: Path, project_id: str, record: dict[str, Any]
) -> list[dict[str, Any]]:
    """Overwrite one deployment row (unpublish / re-publish) by deployment_id."""
    history = _load_deployments(projects_root, project_id)
    deployment_id = record.get("deployment_id")
    replaced = False
    for index, item in enumerate(history):
        if item.get("deployment_id") == deployment_id:
            history[index] = record
            replaced = True
            break
    if not replaced:
        history.append(record)
    return _save_deployments(projects_root, project_id, history)


def _cors_origins() -> list[str]:
    raw = os.environ.get(
        "LOOPIT_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080,"
        "capacitor://localhost,http://localhost",
    )
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def _aup_required() -> bool:
    if is_truthy(os.environ.get("LOOPIT_REQUIRE_AUP")):
        return True
    environment = os.environ.get("LOOPIT_ENV", "").strip().lower()
    return environment in {"production", "prod", "staging"}


def _external_idp_enabled() -> bool:
    return is_truthy(os.environ.get("LOOPIT_EXTERNAL_IDP"))


_EXTERNAL_IDP_DETAIL = (
    "Local sign-in is disabled. Sign in with Loop-GPT; this API accepts LOOPIT-ID tokens only."
)


#: What the project server will hand back, and with which type. A list rather
#: than a lookup of the system's mime database: this is model-authored content,
#: so the set of things a browser is allowed to interpret is a decision, not a
#: default.
SERVABLE_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".mp4": "video/mp4",
}


class StartRunBody(BaseModel):
    """What the browser posts to begin a run."""

    # 200_000 chars is a transport sanity bound against accidental megabyte
    # payloads, not a budget: no prompt a person pastes is too long to build.
    prompt: str = Field(min_length=1, max_length=200_000)
    difficulty: str = "implementation"
    #: None (the default, and what the product UI sends) means elastic: the
    #: engine expands the prompt into a brief and sizes the budget from the
    #: derived complexity. An explicit value is an operator override.
    max_iterations: int | None = Field(default=None, ge=1, le=40)
    #: quick/standard/deep/max overrides the brief-derived budget. The brief
    #: still produces title/summary; the tier decides the recovery budget.
    tier: str | None = Field(default=None, pattern=r"^(quick|standard|deep|max)$")
    #: Continue an existing project. Omitted, a new one is created.
    project_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,64}$")
    #: Only consulted when the project is new: a project's stack is fixed by
    #: the run that created it.
    stack: str = REACT_STACK
    #: build (default) | chat (read-only) | plan (local DAG stub; no Temporal).
    mode: str = Field(default="build", pattern=r"^(build|chat|plan)$")
    #: Signed PrivateFile / https URLs from image paste (vision routing deferred).
    attachment_urls: list[str] = Field(default_factory=list, max_length=8)
    #: Phase 2.9: run detached; finish creates a pending Apply-changes review.
    background: bool = False


class RenameProjectBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class ProjectKnowledgeBody(BaseModel):
    """Write or clear project-root LOOP.md."""

    knowledge: str = Field(default="", max_length=50_000)


class VisibilityBody(BaseModel):
    visibility: str = Field(pattern=r"^(private|link|public_remix)$")
    title: str | None = Field(default=None, max_length=200)


class GitBindBody(BaseModel):
    owner: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    create: bool = True
    auto_push: bool = True
    access_token: str | None = Field(default=None, max_length=4000)


class GitPushBody(BaseModel):
    checkpoint_id: str = Field(min_length=1, max_length=128)
    access_token: str | None = Field(default=None, max_length=4000)


class GitWebhookBody(BaseModel):
    """GitHub push webhook subset, or offline ``files`` map for fakes."""

    after: str | None = None
    commit_sha: str | None = None
    conflict: bool = False
    label: str | None = Field(default=None, max_length=200)
    files: dict[str, str] | None = None


class CustomDomainBody(BaseModel):
    hostname: str = Field(min_length=3, max_length=253)


class DomainVerifyBody(BaseModel):
    """Offline: ``seed_txt=true`` pretends the TXT challenge is published."""

    seed_txt: bool = False


class TemplateRemixBody(BaseModel):
    confirmed: bool = True


class MessageBody(BaseModel):
    """A steering message sent to a live run."""

    message: str = Field(min_length=1, max_length=200_000)


class ExecBody(BaseModel):
    """A shell command to run in the user's project workspace."""

    command: str = Field(min_length=1, max_length=2048)
    timeout_seconds: int = Field(default=60, ge=1, le=300)


class RegisterBody(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=1024)
    org_name: str = Field(min_length=1, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    aup_accepted: bool = False


AUP_VERSION = "2026-09-05"
AUP_TEXT = (
    "Loop-it separates model-content policy from infrastructure-abuse policy. "
    "Open models are allowed; mining, third-party scanning, spam, C2, phishing, "
    "and DoS on platform compute are not. Full text: docs/legal/aup.md."
)


class LoginBody(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=1024)
    org_id: str = Field(min_length=1, max_length=128)


class DecisionBody(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)


class ConfirmedBody(BaseModel):
    confirmed: bool
    reason: str | None = Field(default=None, max_length=1000)


class DeployBody(ConfirmedBody):
    checkpoint_id: str = Field(min_length=1, max_length=128)
    #: Phase 2.8 — allow publish despite critical security findings.
    override_security: bool = False


class VisualEditBody(BaseModel):
    kind: str = Field(default="text", max_length=32)
    value: str = Field(min_length=1, max_length=4000)
    selector: str = Field(default="", max_length=1000)
    snippet: str = Field(default="", max_length=4000)
    loc: str | None = Field(default=None, max_length=512)
    tag: str | None = Field(default=None, max_length=64)
    text: str | None = Field(default=None, max_length=1000)


class ApplyPatchBody(BaseModel):
    """Phase 3.1 — Monaco (or raw) user edit applied through apply_patch + checkpoint."""

    path: str = Field(min_length=1, max_length=512)
    content: str | None = Field(default=None, max_length=2_000_000)
    patch: str | None = Field(default=None, max_length=2_000_000)
    label: str = Field(default="user edit", max_length=120)
    checkpoint: bool = True


class BrowserTestBody(BaseModel):
    preview_url: str | None = Field(default=None, max_length=2000)
    acceptance: list[str] = Field(default_factory=list)
    force_offline: bool | None = None


class SecurityScanBody(BaseModel):
    gate: str = Field(default="deploy", max_length=16)
    force_offline: bool | None = None


class SecretBody(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    value: str = Field(min_length=1, max_length=8192)
    environment: str = Field(default="build", max_length=16)


class SecretRequestBody(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    reason: str = Field(default="", max_length=1000)


class ConnectorEnableBody(BaseModel):
    kind: str = Field(pattern=r"^(stripe|resend|ai_router)$")
    enabled: bool = True


class CollabHeartbeatBody(BaseModel):
    display_name: str = Field(default="", max_length=80)


class CollabChatBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    display_name: str = Field(default="", max_length=80)


class AnalyticsSeedBody(BaseModel):
    """Offline/dev seed for page-view counters when edge billing is absent."""

    page_views: int = Field(default=0, ge=0, le=10_000_000)


class PreviewBody(BaseModel):
    path: str = Field(default="index.html", min_length=1, max_length=512)


@dataclass(frozen=True, slots=True)
class RequestActor:
    actor: Actor
    identity_token: str | None = None


def router_policy_from_env(credential_ref: str = CREDENTIAL_REF) -> Any:
    """The routing policy for live runs, chosen by LOOPIT_ROUTER_POLICY.

    Same contract as the router service's switch (server.py), with one
    difference: the default here is ``huggingface-unrestricted``, because the
    aligned public-router catalogue refuses whole classes of legitimate
    builds — a phishing toolkit was refused outright on 2026-10-10, at the
    brief stage and again in the loop. Only abliterated weights serve builds
    unless an operator opts back into the aligned catalogue explicitly.
    """
    from loopit_router import huggingface_router_policy, huggingface_unrestricted_policy

    name = os.environ.get("LOOPIT_ROUTER_POLICY", "").strip().lower()
    if name in {"", "huggingface-unrestricted", "hf-unrestricted", "unrestricted"}:
        return huggingface_unrestricted_policy(
            credential_ref,
            flash_base_url=os.environ.get("LOOPIT_ENDPOINT_GLM_FLASH_URL") or None,
            coder_base_url=os.environ.get("LOOPIT_ENDPOINT_QWEN38_URL") or None,
            planner_base_url=os.environ.get("LOOPIT_ENDPOINT_GLM53_URL") or None,
            vision_base_url=os.environ.get("LOOPIT_VISION_ENDPOINT_URL") or None,
            vision_model=os.environ.get("LOOPIT_VISION_MODEL") or None,
        )
    if name in {"huggingface", "hf", "hf-router"}:
        return huggingface_router_policy(credential_ref)
    raise ValueError(
        f"LOOPIT_ROUTER_POLICY {name!r} is not supported; expected "
        "'huggingface-unrestricted' (default) or 'huggingface'"
    )


def live_model_factory(*, base_url: str, bill_to: str | None, token: str) -> Any:
    """Build a factory that returns a router-backed client per run.

    Each run gets its own quota ledger entry so the credits shown in the UI are
    that run's spend, not a process-wide total that only ever climbs.
    """
    from loopit_router import (
        ModelRouter,
        OpenAICompatibleUpstream,
        QuotaLedger,
        RouterModelClient,
        TenantQuota,
        UpstreamEndpoint,
        max_output_tokens_from_env,
    )
    from loopit_router.upstream import StaticSecretResolver

    def factory(run_id: str, tenant_id: str) -> tuple[Any, Any]:
        from loopit_agent_core.audit import InMemoryAuditSink

        # The per-run ledger cap. The historical 2.0 default fits the offline
        # scripted client, not a live model loop; operators size it to their
        # plan with LOOPIT_RUN_CREDIT_LIMIT.
        credit_limit = float(os.environ.get("LOOPIT_RUN_CREDIT_LIMIT", "500.0"))
        ledger = QuotaLedger()
        ledger.set_quota(TenantQuota(tenant_id=tenant_id, credit_limit=credit_limit))
        router = ModelRouter(
            policy=router_policy_from_env(CREDENTIAL_REF),
            upstream=OpenAICompatibleUpstream(
                UpstreamEndpoint(base_url=base_url, bill_to=bill_to, scale_up_timeout_s=600)
            ),
            ledger=ledger,
            secrets=StaticSecretResolver({CREDENTIAL_REF: token}),
            audit=InMemoryAuditSink(),
        )
        # Output is unbounded by default: no max_tokens goes upstream, so a
        # patch is never cut mid-diff. LOOPIT_MAX_OUTPUT_TOKENS pins a cap for
        # spend control if an operator ever needs one.
        client = RouterModelClient(
            router,
            tenant_id=tenant_id,
            run_id=run_id,
            task_id="task-1",
            max_output_tokens=max_output_tokens_from_env(),
        )
        return client, ledger

    return factory


def offline_model_factory() -> Any:
    """A scripted client, for looking at the interface with no credentials.

    Every run it produces is labelled offline in the UI. The point of the label
    is that nobody should be able to screenshot this and call it a working
    product.
    """
    from loopit_agent_core.model import ModelResponse, ScriptedModelClient

    def factory(run_id: str, tenant_id: str) -> tuple[Any, Any]:
        offline_page = (
            "<!doctype html>\n"
            "<html>\n"
            "  <body>\n"
            "    <h1>Offline preview</h1>\n"
            "    <p>No model was called. Set HF_TOKEN for a real run.</p>\n"
            "  </body>\n"
            "</html>\n"
        )
        # Deliberately not index.html. A React project is scaffolded before the
        # agent runs, so a creation diff for index.html would fail against a
        # file that already exists — and a scripted client cannot notice that
        # and patch instead.
        creation = "--- /dev/null\n+++ b/offline.html\n@@ -0,0 +1,7 @@\n" + "".join(
            f"+{line}\n" for line in offline_page.splitlines()
        )
        script = [
            ModelResponse(
                # Content mirrors what a real client carries: the raw model
                # text the tool call was extracted from. Empty content would
                # make assistant turns invisible to the run's chat journal.
                content=json.dumps({"tool": "apply_patch", "args": {"patch": creation}}),
                model="offline-demo",
                tool_call={"tool": "apply_patch", "args": {"patch": creation}},
            ),
            ModelResponse(
                content=json.dumps({"tool": "read_file", "args": {"path": "offline.html"}}),
                model="offline-demo",
                tool_call={"tool": "read_file", "args": {"path": "offline.html"}},
            ),
        ]
        return ScriptedModelClient(script=script), None

    return factory


def create_app(
    *,
    projects_root: Path,
    model_factory: Any,
    offline: bool = False,
    execution_mode: str | None = None,
    orchestrator_client: OrchestratorClient | None = None,
    usage_meter: LoopGptUsageMeter | None = None,
) -> FastAPI:
    """Build the API.

    ``usage_meter`` bills model calls to Loop-GPT; when omitted it comes from
    ``LOOPIT_USAGE_URL`` and is off if that is unset.
    """
    configure_telemetry("api")
    app = FastAPI(title="Loop-it local preview", version="0.0.0")
    add_loopit_telemetry(app, "api")
    app.add_middleware(
        CORSMiddleware,
        # The Vite dev server is a different origin. Localhost only: this app
        # starts runs and reads files, so it is not something to expose.
        allow_origins=_cors_origins(),
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["*"],
    )
    dev_single_tenant = is_truthy(os.environ.get("LOOPIT_DEV_SINGLE_TENANT"))
    if dev_single_tenant and has_production_marker(os.environ):
        raise UnsafeConfigurationError(
            "LOOPIT_DEV_SINGLE_TENANT must be unset/0 when a production marker is present"
        )
    auth_dsn = os.environ.get("LOOPIT_STORE_DSN")
    auth_repo: Any
    audit_store: AuditStore
    quota_store: QuotaStore
    project_store: ProjectStore
    run_store: RunStore
    if auth_dsn:
        conn = connect(auth_dsn)
        auth_repo = PostgresAuthRepository(conn)
        audit_store = PostgresAuditStore(conn)
        quota_store = PostgresQuotaStore(conn)
        project_store = PostgresProjectStore(conn)
        run_store = PostgresRunStore(conn)
    else:
        auth_repo = InMemoryAuthRepository()
        audit_store = InMemoryAuditStore()
        quota_store = InMemoryQuotaStore()
        project_store = InMemoryProjectStore()
        run_store = InMemoryRunStore()

    def _on_run_finished(state: RunState) -> None:
        try:
            persist_run_finished(run_store, state, projects_root=projects_root)
        except Exception:
            LOGGER.exception("failed to persist finished run %s", state.run_id)

    resolved_execution_mode = (
        execution_mode
        or os.environ.get("LOOPIT_RUN_EXECUTION_MODE")
        or ("local" if offline else "orchestrator")
    ).lower()
    if resolved_execution_mode not in {"local", "orchestrator"}:
        raise ValueError("execution_mode must be 'local' or 'orchestrator'")
    if resolved_execution_mode == "local":
        LOGGER.warning(
            "apps/api is using explicit local RunManager fallback; "
            "Temporal orchestrator is bypassed"
        )
    identity_kid = os.environ.get("LOOPIT_IDENTITY_KID", "local-1")
    signer = TokenSigner(
        issuer=os.environ.get("LOOPIT_IDENTITY_ISSUER", "loopit-gateway"),
        audience=os.environ.get("LOOPIT_IDENTITY_AUDIENCE", "loopit-control-plane"),
        keys={identity_kid: require_secret(os.environ, "LOOPIT_IDENTITY_SECRET").encode()},
        current_kid=identity_kid,
    )
    if usage_meter is None:
        usage_meter = usage_meter_from_env(signer)
    if usage_meter is None and not offline:
        LOGGER.warning("LOOPIT_USAGE_URL is unset: build model usage is not billed to Loop-GPT")

    # Phase 2 bridges (gitsync / domains / sharing) — initialised after RunManager
    # so the verified-checkpoint hook can call into gitsync.
    sharing_store = SharingStore(projects_root)
    analytics_store = AnalyticsStore(projects_root)
    collab_store = CollabStore(projects_root)
    connectors_store = ConnectorsStore(projects_root)
    domains = domains_from_env()

    def _on_verified_checkpoint(checkpoint: Any, run_id: str) -> None:
        gitsync = getattr(app.state, "gitsync", None)
        if gitsync is None:
            return
        gitsync.maybe_auto_push(checkpoint, run_id=run_id)

    manager = RunManager(
        projects_root=projects_root,
        model_factory=model_factory,
        on_finished=_on_run_finished,
        # Offline mode runs a scripted client with a fixed script; there is no
        # answer for the brief call, so live prompt expansion is live-only.
        brief_enabled=not offline,
        usage_meter=usage_meter,
        sandbox_tools=resolved_execution_mode == "orchestrator",
        on_verified_checkpoint=_on_verified_checkpoint,
    )
    gitsync = gitsync_from_env(projects_root, manager._checkpoints)  # noqa: SLF001
    auth_service = AuthService(repository=auth_repo, audit=audit_store, signer=signer)
    preflight = PreflightGuard(quota=quota_store, audit=audit_store, plan=PlanQuota())
    preview_signer = PreviewTokenSigner(
        require_secret(os.environ, "LOOPIT_PREVIEW_SIGNING_KEY").encode()
    )
    if dev_single_tenant:
        LOGGER.warning(
            "LOOPIT_DEV_SINGLE_TENANT=1 is enabled: API auth is bypassed for local development"
        )
        quota_store.append(
            QuotaEntry(
                entry_id="quota_dev_seed",
                tenant_id="dev",
                amount=Decimal("1000"),
                kind="credit",
                source="dev-single-tenant",
                description="local development credit",
            )
        )
    app.state.auth_service = auth_service
    app.state.auth_repo = auth_repo
    app.state.audit_store = audit_store
    app.state.quota_store = quota_store
    app.state.project_store = project_store
    app.state.run_store = run_store
    app.state.identity_signer = signer
    app.state.preview_signer = preview_signer
    app.state.run_execution_mode = resolved_execution_mode
    app.state.orchestrator_client = orchestrator_client
    app.state.temporal_runs = {}
    app.state.deployments = {}
    app.state.run_manager = manager
    app.state.gitsync = gitsync
    app.state.domains = domains
    app.state.sharing = sharing_store
    app.state.analytics = analytics_store
    app.state.collab = collab_store
    app.state.connectors = connectors_store
    app.state.project_backend = backend_from_env()
    manager.project_backend = app.state.project_backend
    app.state.review_store = ReviewStore(projects_root)
    manager.review_store = app.state.review_store
    app.state.scheduler_client = SchedulerClient.from_env()
    app.state.preview_proxy_client = PreviewProxyClient.from_env()
    app.state.dispatch_client = DispatchClient.from_env()
    if resolved_execution_mode == "orchestrator" and app.state.scheduler_client is None:
        LOGGER.warning(
            "orchestrator mode without LOOPIT_SCHEDULER_URL/LOOPIT_SERVICE_TOKEN: "
            "project routes will not be lease-aware"
        )
    if resolved_execution_mode == "orchestrator" and app.state.dispatch_client is None:
        LOGGER.warning(
            "orchestrator mode without LOOPIT_WORKSPACE_DISPATCH_URL: "
            "sandboxed /exec and agent shell tools need workspace-dispatch"
        )

    def _verify_runner_for_project(tenant_id: str, project_id: str) -> DispatchCommandRunner | None:
        """Resolve a lease and return a dispatch-backed CommandRunner for L0–L2."""
        scheduler: SchedulerClient | None = app.state.scheduler_client
        dispatch: DispatchClient | None = app.state.dispatch_client
        if scheduler is None or dispatch is None:
            return None
        try:
            lease = scheduler.find_project_lease(tenant_id=tenant_id, project_id=project_id)
            if lease is None:
                lease = scheduler.ensure_project_lease(
                    tenant_id=tenant_id,
                    project_id=project_id,
                    run_id=f"verify-{project_id}",
                )
        except SchedulerError:
            return None
        if lease is None or not lease.lease_token:
            return None
        return DispatchCommandRunner(
            dispatch, lease_id=lease.lease_id, lease_token=lease.lease_token
        )

    manager._verify_runner_factory = (  # noqa: SLF001 — set after clients exist
        _verify_runner_for_project if resolved_execution_mode == "orchestrator" else None
    )

    def optional_actor(authorization: str | None = Header(default=None)) -> RequestActor | None:
        if dev_single_tenant:
            # The local operator is the admin of their own machine.
            return RequestActor(
                Actor(
                    subject="dev-user",
                    tenant_id="dev",
                    org_id="dev",
                    role="owner",
                    scopes=frozenset({TERMINAL_SCOPE}),
                )
            )
        if authorization is None or not authorization.startswith("Bearer "):
            return None
        token = authorization.removeprefix("Bearer ").strip()
        try:
            identity = signer.verify_identity(token)
        except Exception as error:
            raise HTTPException(status_code=401, detail="invalid identity token") from error
        # Identity-bridge orgs: the parent mints identity tokens for orgs that
        # never registered here. Ensure the tenant/org rows exist before the
        # first run's audit write hits the audit_log_tenant_id FK. When builds
        # are billed through LOOPIT_USAGE_URL the parent ledger is authoritative
        # — do not seed a parallel 2.0 engine credit that would let a run start
        # with no Loop-GPT balance.
        if auth_repo.ensure_org(identity.org_id) and usage_meter is None:
            quota_store.append(
                QuotaEntry(
                    entry_id=f"quota_seed_sso_{identity.org_id}",
                    tenant_id=identity.org_id,
                    amount=Decimal("2.0"),
                    kind="credit",
                    source="identity-bridge",
                    description="starter plan credit (identity bridge)",
                )
            )
        # The subject is a parent-side user id; projects.owner_user_id
        # references users(user_id), so ensure the row before first use.
        auth_repo.ensure_user(user_id=identity.subject, tenant_id=identity.org_id)
        return RequestActor(
            Actor(
                subject=identity.subject,
                tenant_id=identity.org_id,
                org_id=identity.org_id,
                role=identity.role,
                scopes=frozenset(identity.scopes),
            ),
            identity_token=token,
        )

    def current_actor(authorization: str | None = Header(default=None)) -> RequestActor:
        actor = optional_actor(authorization)
        if actor is None:
            raise HTTPException(status_code=401, detail="authentication required")
        return actor

    def require_action(
        request_actor: RequestActor, action: Any, resource: Resource
    ) -> RequestActor:
        if not authorize(request_actor.actor, action, resource):
            raise HTTPException(status_code=403, detail="forbidden")
        return request_actor

    actor_dependency = Depends(current_actor)

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        sandboxed_exec = (
            resolved_execution_mode == "orchestrator"
            and app.state.scheduler_client is not None
            and app.state.dispatch_client is not None
        )
        return {
            "status": "ok",
            "offline": offline,
            "exec_enabled": False,
            # Host terminal stays admin-only. When sandboxed_exec is true,
            # /exec prefers workspace-dispatch into the project lease.
            "terminal": "sandbox" if sandboxed_exec else "admin_only",
            "sandbox_exec": sandboxed_exec,
            "scheduler_configured": app.state.scheduler_client is not None,
            "workspace_dispatch_configured": app.state.dispatch_client is not None,
            "projects_root": str(projects_root),
            "auth_required": not dev_single_tenant,
            "run_execution_mode": resolved_execution_mode,
            "aup_version": AUP_VERSION,
            "hosting_provider": (os.environ.get("LOOPIT_DEPLOYER_PROVIDER") or "static").strip().lower(),
            "apps_base_domain": os.environ.get("LOOPIT_APPS_BASE_DOMAIN") or None,
            "domains_configured": bool(os.environ.get("LOOPIT_DOMAINS_URL")),
            "domains_mode": getattr(app.state.domains, "mode", "fake"),
            "gitsync_provider": getattr(app.state.gitsync, "provider_name", "fake"),
            "fly_configured": bool(os.environ.get("LOOPIT_FLY_API_TOKEN")),
            "provision_provider": (
                "postgres" if os.environ.get("LOOPIT_PROVISION_POSTGRES_DSN") else "memory"
            ),
            "local_gates": True,
            "background_builds": True,
            "dev_prod_databases": True,
        }

    @app.get("/api/legal/aup")
    def legal_aup() -> dict[str, Any]:
        return {"version": AUP_VERSION, "text": AUP_TEXT}

    @app.get("/api/legal/tos")
    def legal_tos() -> dict[str, str]:
        return {
            "version": AUP_VERSION,
            "text": (
                "Authorized organizations only. Generated code is owned by the customer. "
                "I1-I12 stay in force. Full text: docs/legal/tos.md."
            ),
        }

    @app.post("/api/auth/register")
    def register(body: RegisterBody) -> dict[str, Any]:
        if _external_idp_enabled():
            raise HTTPException(status_code=403, detail=_EXTERNAL_IDP_DETAIL)
        if _aup_required() and not body.aup_accepted:
            raise HTTPException(status_code=422, detail="acceptable use policy must be accepted")
        try:
            result = auth_service.register(
                email=body.email,
                password=body.password,
                org_name=body.org_name,
                display_name=body.display_name,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        quota_store.append(
            QuotaEntry(
                entry_id=f"quota_seed_{secrets.token_hex(8)}",
                tenant_id=result.org.org_id,
                amount=Decimal("2.0"),
                kind="credit",
                source="auth.register",
                description="starter plan credit",
            )
        )
        return {
            "access_token": result.identity_token,
            "token_type": "bearer",
            "user": {"user_id": result.user.user_id, "email": result.user.email},
            "org": {"org_id": result.org.org_id, "name": result.org.name},
            "role": result.membership.role,
        }

    @app.post("/api/auth/login")
    def login(body: LoginBody) -> dict[str, Any]:
        if _external_idp_enabled():
            raise HTTPException(status_code=403, detail=_EXTERNAL_IDP_DETAIL)
        try:
            token = auth_service.login(email=body.email, password=body.password, org_id=body.org_id)
        except LoginError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        return {"access_token": token, "token_type": "bearer"}

    @app.post("/api/auth/logout")
    def logout(request_actor: RequestActor = actor_dependency) -> dict[str, str]:
        audit_store.append(
            {
                "event_id": f"ev_{secrets.token_hex(8)}",
                "type": "auth.logout",
                "tenant_id": request_actor.actor.tenant_id,
                "actor": {"kind": "user", "id": request_actor.actor.subject},
                "outcome": "success",
                "detail": {},
            }
        )
        return {"status": "ok"}

    @app.get("/api/auth/me")
    def me(request_actor: RequestActor = actor_dependency) -> dict[str, Any]:
        user = auth_repo.get_user(request_actor.actor.subject)
        return {
            "user_id": request_actor.actor.subject,
            "email": user.email if user else None,
            "org_id": request_actor.actor.org_id,
            "role": request_actor.actor.role,
            "scopes": sorted(request_actor.actor.scopes),
        }

    @app.get("/api/auth/orgs")
    def orgs(request_actor: RequestActor = actor_dependency) -> list[dict[str, Any]]:
        memberships = auth_repo.memberships_for_user(request_actor.actor.subject)
        if not memberships and dev_single_tenant:
            return [{"org_id": "dev", "name": "Local development", "role": "owner"}]
        body: list[dict[str, Any]] = []
        for membership in memberships:
            org = auth_repo.get_org(membership.org_id)
            body.append(
                {
                    "org_id": membership.org_id,
                    "name": org.name if org else membership.org_id,
                    "role": membership.role,
                }
            )
        return body

    @app.get("/api/billing/balance")
    def billing_balance(request_actor: RequestActor = actor_dependency) -> dict[str, Any]:
        require_action(request_actor, "project:read", Resource(org_id=request_actor.actor.org_id))
        return {
            "tenant_id": request_actor.actor.tenant_id,
            "balance": str(quota_store.balance(request_actor.actor.tenant_id)),
            "plan": "free",
            "ledger": "packages/store quota entries; Stripe sync is services/billing",
        }

    async def _orchestrator() -> OrchestratorClient:
        client = app.state.orchestrator_client
        if client is None:
            try:
                client = await OrchestratorClient.connect()
            except Exception as error:
                LOGGER.exception("could not connect to Temporal orchestrator")
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "Temporal orchestrator is not available; set "
                        "LOOPIT_RUN_EXECUTION_MODE=local for the documented offline fallback"
                    ),
                ) from error
            app.state.orchestrator_client = client
        return cast(OrchestratorClient, client)

    @app.post("/api/runs")
    async def start_run(
        body: StartRunBody, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        require_action(request_actor, "run:start", Resource(org_id=request_actor.actor.org_id))
        run_id = f"run_{secrets.token_hex(6)}"
        if usage_meter is not None:
            # Parent credits are the source of truth when the usage bridge is on.
            try:
                usage_meter.ensure_credits(
                    tenant_id=request_actor.actor.tenant_id,
                    actor_id=request_actor.actor.subject,
                    minimum=1,
                )
            except CreditsExhausted as error:
                raise HTTPException(status_code=402, detail="hard_quota") from error
            except MeteringUnavailable as error:
                raise HTTPException(status_code=503, detail=str(error)) from error
        else:
            decision = preflight.check(
                actor=request_actor.actor,
                estimated_credits=Decimal("0.01"),
                run_id=run_id,
                project_id=body.project_id,
            )
            if not decision.allowed:
                raise HTTPException(
                    status_code=429 if decision.reason == "rate_limited" else 402,
                    detail=decision.reason,
                )

        def _catalog_start(*, project_id: str, prompt: str, stack: str, tier: str | None) -> None:
            try:
                persist_run_started(
                    projects=project_store,
                    runs=run_store,
                    tenant_id=request_actor.actor.tenant_id,
                    owner_user_id=request_actor.actor.subject,
                    project_id=project_id,
                    run_id=run_id,
                    prompt=prompt,
                    stack=stack,
                    max_iterations=body.max_iterations or 12,
                    difficulty=body.difficulty,
                )
            except Exception:
                LOGGER.exception("failed to persist started run %s", run_id)

        if resolved_execution_mode == "orchestrator":
            project_id = body.project_id or f"proj_{secrets.token_hex(6)}"
            _catalog_start(project_id=project_id, prompt=body.prompt, stack=body.stack, tier=body.tier)
            status = await (await _orchestrator()).start(
                RunWorkflowInput(
                    prompt=body.prompt,
                    tenant_id=request_actor.actor.tenant_id,
                    actor_id=request_actor.actor.subject,
                    project_id=project_id,
                    run_id=run_id,
                    difficulty=body.difficulty,  # type: ignore[arg-type]
                    budget=WorkflowBudget(max_iterations=body.max_iterations or 12),
                    stack=body.stack,
                )
            )
            metadata = {
                "tenant_id": request_actor.actor.tenant_id,
                "actor_id": request_actor.actor.subject,
                "prompt": body.prompt,
                "stack": body.stack,
                "tier": body.tier,
                "project_id": project_id,
                # Temporal workflows are already detached; pending Apply-review
                # merge is local-mode today (Phase 2.9).
                "background": bool(body.background),
            }
            app.state.temporal_runs[run_id] = metadata
            # Survive API restarts: board enrichment reads this sidecar when
            # temporal_runs is empty (B10).
            write_run_meta_fields(
                projects_root,
                run_id,
                {
                    "project_id": project_id,
                    "prompt": body.prompt,
                    "stack": body.stack,
                    "tier": body.tier,
                    "background": bool(body.background),
                    "tenant_id": request_actor.actor.tenant_id,
                    "actor_id": request_actor.actor.subject,
                    "execution_mode": "orchestrator",
                },
            )
            return _board_run_from_orchestrator(status, metadata, tenant_id=metadata["tenant_id"])
        try:
            attachments = tuple(
                url.strip()
                for url in body.attachment_urls
                if isinstance(url, str) and url.strip().startswith(("https://", "http://", "/"))
            )[:8]
            state = manager.start(
                RunRequest(
                    prompt=body.prompt,
                    tenant_id=request_actor.actor.tenant_id,
                    actor_id=request_actor.actor.subject,
                    difficulty=body.difficulty,
                    max_iterations=body.max_iterations,
                    tier=body.tier,
                    project_id=body.project_id,
                    stack=body.stack,
                    run_id=run_id,
                    mode=body.mode,
                    attachment_urls=attachments,
                    background=bool(body.background),
                )
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        _catalog_start(project_id=state.project_id, prompt=state.prompt, stack=state.stack, tier=state.tier)
        return state.to_dict()

    @app.get("/api/runs")
    def list_runs(request_actor: RequestActor = actor_dependency) -> list[dict[str, Any]]:
        require_action(request_actor, "project:read", Resource(org_id=request_actor.actor.org_id))
        tenant_id = request_actor.actor.tenant_id
        by_id: dict[str, dict[str, Any]] = {}
        for record in run_store.list_for_tenant(tenant_id):
            project = project_store.get(record.project_id, tenant_id=tenant_id)
            by_id[record.run_id] = record_to_dict(
                record, projects_root=projects_root, project=project
            )
        for state in manager.list_runs(tenant_id=tenant_id):
            by_id[state.run_id] = state.to_dict()
        return sorted(
            by_id.values(),
            key=lambda item: str(item.get("started_at") or ""),
            reverse=True,
        )

    @app.get("/api/runs/{run_id}")
    async def get_run(
        run_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        """Unify local and orchestrator board payloads (files / DAG / checkpoints)."""
        tenant_id = request_actor.actor.tenant_id
        metadata = app.state.temporal_runs.get(run_id)
        if metadata is None and resolved_execution_mode == "orchestrator":
            meta = load_run_meta(projects_root, run_id)
            if meta.get("execution_mode") == "orchestrator":
                metadata = {
                    "tenant_id": str(meta.get("tenant_id") or tenant_id),
                    "actor_id": str(meta.get("actor_id") or ""),
                    "prompt": str(meta.get("prompt") or ""),
                    "stack": meta.get("stack", REACT_STACK),
                    "tier": meta.get("tier"),
                    "project_id": str(meta.get("project_id") or ""),
                }

        if resolved_execution_mode == "orchestrator" and metadata is not None:
            require_action(
                request_actor, "project:read", Resource(org_id=str(metadata["tenant_id"]))
            )
            try:
                status = await (await _orchestrator()).get(run_id)
            except Exception:
                LOGGER.exception("orchestrator get failed for %s; falling back to store", run_id)
                status = None
            if status is not None:
                return _board_run_from_orchestrator(
                    status, metadata, tenant_id=str(metadata["tenant_id"])
                )

        state = manager.get(run_id)
        if state is None:
            record = run_store.get(run_id, tenant_id=tenant_id)
            if record is None:
                raise HTTPException(status_code=404, detail="no such run")
            require_action(request_actor, "project:read", Resource(org_id=record.tenant_id))
            project = project_store.get(record.project_id, tenant_id=record.tenant_id)
            payload = record_to_dict(record, projects_root=projects_root, project=project)
            return _enrich_board_payload(
                payload, project_id=record.project_id, tenant_id=record.tenant_id
            )
        require_action(request_actor, "project:read", Resource(org_id=state.tenant_id))
        return _enrich_board_payload(
            state.to_dict(), project_id=state.project_id, tenant_id=state.tenant_id
        )

    def _enrich_board_payload(
        payload: dict[str, Any], *, project_id: str, tenant_id: str
    ) -> dict[str, Any]:
        """Attach files / checkpoints / DAG from the store the same way for both modes."""
        workspace = manager.project(project_id, tenant_id=tenant_id)
        payload = dict(payload)
        payload["files"] = workspace.files() if workspace else list(payload.get("files") or [])
        payload["checkpoints"] = manager.list_checkpoints(project_id, tenant_id=tenant_id)
        if not payload.get("dag") and not payload.get("task_dag"):
            meta = load_run_meta(projects_root, str(payload.get("run_id") or ""))
            dag = meta.get("dag") or meta.get("task_dag")
            if isinstance(dag, dict):
                payload["dag"] = dag
                payload["task_dag"] = dag
        return payload

    def _board_run_from_orchestrator(
        status: Any, metadata: dict[str, Any], *, tenant_id: str
    ) -> dict[str, Any]:
        base = _workflow_status_to_run(status, metadata)
        project_id = str(status.project_id or metadata.get("project_id") or "")
        enriched = _enrich_board_payload(base, project_id=project_id, tenant_id=tenant_id)
        # Surface the workflow's current checkpoint id in the list when present.
        checkpoint_id = getattr(status, "checkpoint_id", None)
        if checkpoint_id and not any(
            str(item.get("checkpoint_id")) == str(checkpoint_id)
            for item in enriched.get("checkpoints") or []
        ):
            enriched["checkpoints"] = [
                *list(enriched.get("checkpoints") or []),
                {"checkpoint_id": checkpoint_id, "verified": False, "label": "workflow"},
            ]
        return enriched

    def _resolve_project_tenant(project_id: str, actor_tenant: str) -> str | None:
        tenant = manager.project_tenant(project_id)
        if tenant is not None:
            return tenant
        project = project_store.get(project_id, tenant_id=actor_tenant)
        if project is not None:
            return project.tenant_id
        if manager.project(project_id, tenant_id=actor_tenant) is not None:
            return actor_tenant
        return None

    def _ensure_project_lease(project_id: str, tenant_id: str):
        client: SchedulerClient | None = app.state.scheduler_client
        if client is None:
            raise HTTPException(
                status_code=503,
                detail="scheduler is not configured (set LOOPIT_SCHEDULER_URL)",
            )
        try:
            return client.ensure_project_lease(tenant_id=tenant_id, project_id=project_id)
        except SchedulerError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @app.get("/api/runs/{run_id}/dag")
    async def get_run_dag(
        run_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        run = await get_run(run_id, request_actor)
        dag = run.get("dag") or run.get("task_dag")
        if not isinstance(dag, dict):
            raise HTTPException(status_code=404, detail="run has no DAG")
        try:
            validate_task_dag_payload(dag)
        except ValueError as error:
            raise HTTPException(status_code=500, detail=str(error)) from error
        return dag

    @app.get("/api/runs/{run_id}/gates")
    async def list_gates(
        run_id: str, request_actor: RequestActor = actor_dependency
    ) -> list[dict[str, Any]]:
        run = await get_run(run_id, request_actor)
        return list(run.get("gates") or ([run["gate"]] if run.get("gate") else []))

    @app.post("/api/runs/{run_id}/gates/{gate_id}/approve")
    async def approve_gate(
        run_id: str,
        gate_id: str,
        body: DecisionBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, str]:
        await _decide_gate(run_id, gate_id, body.reason, True, request_actor)
        return {"status": "approved"}

    @app.post("/api/runs/{run_id}/gates/{gate_id}/reject")
    async def reject_gate(
        run_id: str,
        gate_id: str,
        body: DecisionBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, str]:
        await _decide_gate(run_id, gate_id, body.reason, False, request_actor)
        return {"status": "rejected"}

    async def _decide_gate(
        run_id: str,
        gate_id: str,
        reason: str,
        approved: bool,
        request_actor: RequestActor,
    ) -> None:
        run = await get_run(run_id, request_actor)
        require_action(
            request_actor,
            "run:approve",
            Resource(org_id=_run_tenant(run_id, run), project_id=str(run["project_id"])),
        )
        gate = _pending_gate(run, gate_id)
        if gate is None:
            raise HTTPException(status_code=404, detail="no such pending gate")
        if _gate_is_expired(gate):
            raise HTTPException(status_code=410, detail="gate expired")
        if resolved_execution_mode == "orchestrator":
            signal = ApprovalSignal(gate_id, approved, request_actor.actor.subject, reason)
            if approved:
                await (await _orchestrator()).approve(run_id, signal)
            else:
                await (await _orchestrator()).reject(
                    run_id, gate_id, actor_id=request_actor.actor.subject, reason=reason
                )
        else:
            # Local ApprovalSignal: resume (or cancel) the in-process run.
            ok = manager.decide_gate(
                run_id,
                gate_id,
                approved=approved,
                reason=reason,
                tenant_id=request_actor.actor.tenant_id,
                actor_id=request_actor.actor.subject,
            )
            if not ok:
                raise HTTPException(status_code=404, detail="no such pending gate")
        audit_store.append(
            _audit_payload(
                event_type="run.gate.approved" if approved else "run.gate.rejected",
                actor=request_actor.actor,
                project_id=str(run["project_id"]),
                run_id=run_id,
                outcome="success",
                detail={
                    "gate_id": gate_id,
                    "reason": reason,
                    "decision_actor_id": request_actor.actor.subject,
                },
            )
        )

    def _run_tenant(run_id: str, run: dict[str, Any]) -> str:
        if resolved_execution_mode == "orchestrator" and run_id in app.state.temporal_runs:
            return str(app.state.temporal_runs[run_id]["tenant_id"])
        state = manager.get(run_id)
        if state is not None:
            return state.tenant_id
        tenant = run.get("tenant_id")
        if not isinstance(tenant, str):
            raise HTTPException(status_code=404, detail="no such run")
        return tenant

    def _pending_gate(run: dict[str, Any], gate_id: str) -> dict[str, Any] | None:
        if run.get("status") not in {RunStatus.AWAITING_APPROVAL.value, "awaiting_gate"}:
            return None
        gates = list(run.get("gates") or ([run["gate"]] if run.get("gate") else []))
        for candidate in gates:
            if isinstance(candidate, dict) and candidate.get("gate_id") == gate_id:
                return candidate
        return None

    def _gate_is_expired(gate: dict[str, Any]) -> bool:
        expires_at = gate.get("expires_at")
        if expires_at is None:
            return False
        from datetime import UTC, datetime

        try:
            expires = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
        except ValueError:
            return True
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=UTC)
        return expires <= datetime.now(UTC)

    @app.get("/api/runs/{run_id}/cost")
    async def get_run_cost(
        run_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        run = await get_run(run_id, request_actor)
        return _run_cost(run)

    @app.post("/api/runs/{run_id}/messages")
    async def send_run_message(
        run_id: str,
        body: MessageBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        state = manager.get(run_id, tenant_id=request_actor.actor.tenant_id)
        if state is None:
            raise HTTPException(status_code=404, detail="no such run")
        if state.finished_at is not None:
            raise HTTPException(status_code=409, detail="run is not active")
        queued = manager.send_message(run_id, body.message, tenant_id=request_actor.actor.tenant_id)
        if not queued:
            raise HTTPException(status_code=409, detail="run is not active")
        return {"queued": True}

    @app.post("/api/runs/{run_id}/cancel")
    async def cancel_run(
        run_id: str,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        state = manager.get(run_id, tenant_id=request_actor.actor.tenant_id)
        if state is None:
            raise HTTPException(status_code=404, detail="no such run")
        if state.finished_at is not None:
            return {"cancelled": False, "reason": "already finished"}
        manager.cancel_run(run_id, tenant_id=request_actor.actor.tenant_id)
        return {"cancelled": True}

    @app.get("/api/runs/{run_id}/file")
    def get_file(
        run_id: str, path: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        state = manager.get(run_id)
        if state is not None:
            require_action(request_actor, "project:read", Resource(org_id=state.tenant_id))
        workspace = manager.workspace(run_id, tenant_id=request_actor.actor.tenant_id)
        if workspace is None and state is None:
            record = run_store.get(run_id, tenant_id=request_actor.actor.tenant_id)
            if record is not None:
                require_action(request_actor, "project:read", Resource(org_id=record.tenant_id))
                workspace = manager.project(record.project_id, tenant_id=record.tenant_id)
        if workspace is None:
            raise HTTPException(status_code=404, detail="no such run")
        try:
            return {"path": path, "content": workspace.read(path)}
        except WorkspaceError as error:
            # 404 rather than 400: a caller must not be able to tell a malformed
            # path from one that exists but is out of bounds.
            raise HTTPException(status_code=404, detail=str(error)) from error
        except OSError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    def _project_payload(record: Any, *, include_archived: bool = False) -> dict[str, Any] | None:
        if record.archived_at is not None and not include_archived:
            return None
        runs = run_store.list_for_project(record.project_id, tenant_id=record.tenant_id)
        knowledge = ""
        workspace = manager.project(record.project_id, tenant_id=record.tenant_id)
        if workspace is not None and "LOOP.md" in workspace.files():
            try:
                knowledge = workspace.read("LOOP.md")
            except (WorkspaceError, OSError):
                knowledge = ""
        share = app.state.sharing.get(record.project_id)
        return {
            "project_id": record.project_id,
            "name": record.name,
            "stack": record.stack,
            "current_checkpoint_id": record.current_checkpoint_id,
            "created_at": record.created_at.isoformat(),
            "updated_at": record.updated_at.isoformat(),
            "archived_at": record.archived_at.isoformat() if record.archived_at else None,
            "run_count": len(runs),
            "knowledge": knowledge,
            "visibility": share.visibility if share else "private",
            "share_id": share.share_id if share else None,
        }

    @app.get("/api/projects")
    def list_projects(
        request_actor: RequestActor = actor_dependency,
        include_archived: bool = False,
    ) -> list[dict[str, Any]]:
        require_action(request_actor, "project:read", Resource(org_id=request_actor.actor.org_id))
        out: list[dict[str, Any]] = []
        for record in project_store.list_for_tenant(request_actor.actor.tenant_id):
            payload = _project_payload(record, include_archived=include_archived)
            if payload is not None:
                out.append(payload)
        out.sort(key=lambda row: row.get("updated_at") or "", reverse=True)
        return out

    @app.get("/api/projects/{project_id}")
    def get_project(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        record = project_store.get(project_id, tenant_id=request_actor.actor.tenant_id)
        if record is None:
            # Disk-only project (rehydrate after restart before catalog write).
            tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
            if tenant != request_actor.actor.tenant_id:
                raise HTTPException(status_code=404, detail="no such project")
            require_action(request_actor, "project:read", Resource(org_id=tenant))
            workspace = manager.project(project_id, tenant_id=tenant)
            if workspace is None:
                raise HTTPException(status_code=404, detail="no such project")
            runs = [
                record_to_dict(r, projects_root=projects_root)
                for r in run_store.list_for_project(project_id, tenant_id=tenant)
            ]
            return {
                "project_id": project_id,
                "name": project_id,
                "stack": "react",
                "current_checkpoint_id": None,
                "created_at": None,
                "updated_at": None,
                "archived_at": None,
                "run_count": len(runs),
                "knowledge": workspace.read("LOOP.md") if "LOOP.md" in workspace.files() else "",
                "runs": runs,
                "files": workspace.files(),
                "checkpoints": manager.list_checkpoints(project_id, tenant_id=tenant),
            }
        require_action(request_actor, "project:read", Resource(org_id=record.tenant_id))
        payload = _project_payload(record, include_archived=True)
        assert payload is not None
        runs = [
            record_to_dict(r, projects_root=projects_root, project=record)
            for r in run_store.list_for_project(project_id, tenant_id=record.tenant_id)
        ]
        workspace = manager.project(project_id, tenant_id=record.tenant_id)
        payload["runs"] = runs
        payload["files"] = workspace.files() if workspace else []
        payload["checkpoints"] = manager.list_checkpoints(
            project_id, tenant_id=record.tenant_id
        )
        return payload

    @app.patch("/api/projects/{project_id}")
    def rename_project(
        project_id: str,
        body: RenameProjectBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        record = project_store.get(project_id, tenant_id=request_actor.actor.tenant_id)
        if record is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=record.tenant_id))
        try:
            updated = project_store.rename(
                project_id, tenant_id=record.tenant_id, name=body.name
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        payload = _project_payload(updated, include_archived=True)
        assert payload is not None
        return payload

    @app.put("/api/projects/{project_id}/knowledge")
    def put_project_knowledge(
        project_id: str,
        body: ProjectKnowledgeBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        record = project_store.get(project_id, tenant_id=request_actor.actor.tenant_id)
        tenant = record.tenant_id if record else _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant != request_actor.actor.tenant_id:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        workspace = manager.project(project_id, tenant_id=tenant)
        if workspace is None:
            raise HTTPException(status_code=404, detail="no such project")
        text = body.knowledge.strip()
        if text:
            workspace.write("LOOP.md", text if text.endswith("\n") else text + "\n")
        elif "LOOP.md" in workspace.files():
            try:
                resolve_in_workspace(workspace.root, "LOOP.md").unlink(missing_ok=True)
            except (WorkspaceError, OSError) as error:
                raise HTTPException(status_code=500, detail=str(error)) from error
        return {"project_id": project_id, "knowledge": text}

    @app.post("/api/projects/{project_id}/archive")
    def archive_project(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        record = project_store.get(project_id, tenant_id=request_actor.actor.tenant_id)
        if record is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=record.tenant_id))
        updated = project_store.archive(project_id, tenant_id=record.tenant_id)
        payload = _project_payload(updated, include_archived=True)
        assert payload is not None
        return payload

    @app.post("/api/projects/{project_id}/restore")
    def restore_project(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        record = project_store.get(project_id, tenant_id=request_actor.actor.tenant_id)
        if record is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=record.tenant_id))
        updated = project_store.restore(project_id, tenant_id=record.tenant_id)
        payload = _project_payload(updated, include_archived=True)
        assert payload is not None
        return payload

    @app.post("/api/projects/{project_id}/duplicate")
    def duplicate_project(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        record = project_store.get(project_id, tenant_id=request_actor.actor.tenant_id)
        tenant = record.tenant_id if record else _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant != request_actor.actor.tenant_id:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        checkpoints = manager.list_checkpoints(project_id, tenant_id=tenant)
        if not checkpoints:
            raise HTTPException(status_code=422, detail="project has no checkpoint to duplicate")
        live = next((c for c in checkpoints if c.get("live")), checkpoints[0])
        forked = manager.fork_checkpoint(
            project_id,
            str(live["checkpoint_id"]),
            tenant_id=tenant,
            actor_id=request_actor.actor.subject,
        )
        new_id = str(forked["project_id"])
        name = f"{record.name} copy" if record else f"{project_id} copy"
        try:
            project_store.create(
                ProjectRecord(
                    project_id=new_id,
                    tenant_id=tenant,
                    owner_user_id=request_actor.actor.subject,
                    name=name[:120],
                    stack=record.stack if record else REACT_STACK,
                    current_checkpoint_id=forked.get("checkpoint", {}).get("checkpoint_id"),
                )
            )
        except Exception:
            LOGGER.exception("could not catalog duplicated project %s", new_id)
        return {"project_id": new_id, "name": name, "checkpoint": forked.get("checkpoint")}

    @app.get("/api/projects/{project_id}/checkpoints/{checkpoint_id}/file")
    def get_checkpoint_file(
        project_id: str,
        checkpoint_id: str,
        path: str,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        try:
            checkpoint = manager.checkpoint(checkpoint_id, tenant_id=request_actor.actor.tenant_id)
            if checkpoint.project_id != project_id:
                raise HTTPException(status_code=404, detail="no such checkpoint")
            content = manager.read_checkpoint_file(checkpoint, path).decode("utf-8", errors="replace")
        except CheckpointError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except (OSError, ValueError) as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return {"path": path, "checkpoint_id": checkpoint_id, "content": content}

    @app.get("/api/projects/{project_id}/checkpoints")
    def list_checkpoints(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> list[dict[str, Any]]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        return manager.list_checkpoints(project_id, tenant_id=request_actor.actor.tenant_id)

    @app.post("/api/projects/{project_id}/checkpoints/{checkpoint_id}/rollback")
    def rollback_checkpoint(
        project_id: str,
        checkpoint_id: str,
        body: ConfirmedBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        if not body.confirmed:
            raise HTTPException(status_code=422, detail="explicit confirmation is required")
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        if manager.project_has_live_run(project_id, tenant_id=request_actor.actor.tenant_id):
            raise HTTPException(
                status_code=409,
                detail="cannot rollback while a run is live on this project",
            )
        try:
            checkpoint = manager.rollback(
                project_id, checkpoint_id, tenant_id=request_actor.actor.tenant_id
            )
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        audit_store.append(
            _audit_payload(
                event_type="checkpoint.rollback",
                actor=request_actor.actor,
                project_id=project_id,
                outcome="success",
                detail={"checkpoint_id": checkpoint_id, "reason": body.reason},
            )
        )
        return checkpoint

    @app.post("/api/projects/{project_id}/checkpoints/{checkpoint_id}/fork")
    def fork_checkpoint(
        project_id: str,
        checkpoint_id: str,
        body: ConfirmedBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        if not body.confirmed:
            raise HTTPException(status_code=422, detail="explicit confirmation is required")
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        try:
            result = manager.fork_checkpoint(
                project_id,
                checkpoint_id,
                tenant_id=request_actor.actor.tenant_id,
                actor_id=request_actor.actor.subject,
            )
        except Exception as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        audit_store.append(
            _audit_payload(
                event_type="checkpoint.fork",
                actor=request_actor.actor,
                project_id=project_id,
                outcome="success",
                detail={"checkpoint_id": checkpoint_id, "fork_project_id": result["project_id"]},
            )
        )
        return result

    @app.get("/api/projects/{project_id}/lease")
    def get_project_lease(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        """Resolve (and renew/acquire) the project's sandbox lease when orchestrator mode is on."""
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        if resolved_execution_mode != "orchestrator":
            return {
                "project_id": project_id,
                "mode": "local",
                "lease": None,
                "detail": "leases are only acquired in orchestrator mode",
            }
        lease = _ensure_project_lease(project_id, tenant)
        return {
            "project_id": project_id,
            "mode": "orchestrator",
            "lease": {
                "lease_id": lease.lease_id,
                "sandbox_id": lease.sandbox_id,
                "expires_at": lease.expires_at,
                "allowed_tools": list(lease.allowed_tools),
            },
        }

    @app.post("/api/projects/{project_id}/exec")
    def exec_project_command(
        project_id: str,
        body: ExecBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        # Prefer the sandboxed path when orchestrator + dispatch are configured.
        dispatch: DispatchClient | None = app.state.dispatch_client
        if (
            resolved_execution_mode == "orchestrator"
            and dispatch is not None
            and app.state.scheduler_client is not None
        ):
            if TERMINAL_SCOPE not in request_actor.actor.scopes:
                raise HTTPException(
                    status_code=403, detail="the build terminal is limited to admins"
                )
            lease = _ensure_project_lease(project_id, tenant)
            try:
                result = dispatch.execute(
                    lease_id=lease.lease_id,
                    lease_token=lease.lease_token,
                    tool="run_shell",
                    args={
                        "command": body.command,
                        "timeout_seconds": body.timeout_seconds,
                    },
                )
            except DispatchError as error:
                raise HTTPException(status_code=503, detail=str(error)) from error
            return {
                "command": body.command,
                "exit_code": 0 if result.ok else int(result.detail.get("exit_code") or 1),
                "stdout": result.output,
                "stderr": str(result.detail.get("stderr") or ""),
                "duration_seconds": float(result.detail.get("duration_seconds") or 0),
                "truncated": bool(result.detail.get("truncated")),
                "sandbox": True,
                "lease_id": lease.lease_id,
            }
        # Commands run on the API host itself until per-project sandboxes
        # exist, so being able to write the project is not enough.
        if TERMINAL_SCOPE not in request_actor.actor.scopes:
            raise HTTPException(status_code=403, detail="the build terminal is limited to admins")
        workspace = manager.project(project_id, tenant_id=request_actor.actor.tenant_id)
        if workspace is None:
            raise HTTPException(status_code=404, detail="no such project")
        return terminal.run_user_command(
            workspace.root,
            body.command,
            timeout_seconds=body.timeout_seconds,
        )

    @app.post("/api/projects/{project_id}/preview")
    def create_preview(
        project_id: str,
        body: PreviewBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        issued_at = time.time()
        expires_at = issued_at + 900
        path = body.path.lstrip("/") or "index.html"

        # HMR via preview-proxy when the project is a sandbox stack and a lease
        # (or env backend) can be bound. Offline/static stacks keep signed site URLs.
        stack = manager.project_stack(project_id, tenant_id=tenant) if hasattr(manager, "project_stack") else None
        if stack is None:
            try:
                workspace = manager.project(project_id, tenant_id=tenant)
                from .stacks import infer_stack_from_files

                stack = infer_stack_from_files(set(workspace.files())) if workspace else REACT_STACK
            except Exception:
                stack = REACT_STACK

        lease_id = f"preview-{project_id}"
        preview_client: PreviewProxyClient | None = app.state.preview_proxy_client
        if (
            uses_sandbox_runtime(stack)
            and preview_client is not None
            and resolved_execution_mode == "orchestrator"
        ):
            try:
                lease = _ensure_project_lease(project_id, tenant)
                lease_id = lease.lease_id
                backend_host, backend_port = default_backend_from_env()
                bound = preview_client.bind(
                    project_id=project_id,
                    tenant_id=tenant,
                    lease_id=lease_id,
                    backend_host=backend_host,
                    backend_port=backend_port,
                )
                token = mint_preview_token(
                    preview_signer,
                    project_id=project_id,
                    tenant_id=request_actor.actor.tenant_id,
                    lease_id=lease_id,
                    subject=request_actor.actor.subject,
                    now=issued_at,
                )
                # Path-based URL + query token (HMR websockets keep the query).
                url = f"{bound.public_url}?token={token}"
                return {
                    "url": url,
                    "expires_at": expires_at,
                    "expires_at_iso": datetime.fromtimestamp(expires_at, UTC).isoformat(),
                    "token_type": "signed_url",
                    "mode": "hmr",
                    "preview_host": bound.preview_host,
                }
            except (PreviewProxyError, SchedulerError, Exception) as error:
                LOGGER.info("HMR preview unavailable for %s: %s; using static", project_id, error)

        token = mint_preview_token(
            preview_signer,
            project_id=project_id,
            tenant_id=request_actor.actor.tenant_id,
            lease_id=lease_id,
            subject=request_actor.actor.subject,
            now=issued_at,
        )
        return {
            # The token sits in a path prefix rather than the query string so that relative
            # references inside the generated app (styles.css, ./App.js, a second page)
            # resolve to a URL that still carries it. With the token in the query only the
            # entry document authenticates and every subresource 401s, which renders the
            # preview blank -- defeating the reason this endpoint serves from a real origin.
            "url": f"/api/projects/{project_id}/site/t/{token}/{path}",
            # Unix seconds (number) for TTL math; ISO for display. Clients should
            # refetch around 80% of the remaining life.
            "expires_at": expires_at,
            "expires_at_iso": datetime.fromtimestamp(expires_at, UTC).isoformat(),
            "token_type": "signed_url",
            "mode": "static",
        }

    class ConsoleEventBody(BaseModel):
        level: str = "error"
        text: str = Field(min_length=1, max_length=8000)
        href: str | None = None

    @app.post("/api/projects/{project_id}/console")
    def ingest_console(
        project_id: str,
        body: ConsoleEventBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, str]:
        """Receive runtime console errors from the preview bridge (via parent)."""
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        if body.level in {"error", "warn"}:
            record_console_error(project_id, f"[{body.level}] {body.text}")
        return {"status": "ok"}

    @app.post("/api/projects/{project_id}/visual-edit")
    def apply_project_visual_edit(
        project_id: str,
        body: VisualEditBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        """Deterministic click-to-edit codemod, or LLM patch prompt (Phase 2.1)."""
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        workspace = manager.project(project_id, tenant_id=request_actor.actor.tenant_id)
        if workspace is None:
            raise HTTPException(status_code=404, detail="no such project")
        kind = body.kind if body.kind in {"text", "color", "spacing", "class"} else "text"
        result = apply_visual_edit(
            workspace,
            VisualEditRequest(
                kind=kind,  # type: ignore[arg-type]
                value=body.value,
                selector=body.selector,
                snippet=body.snippet,
                loc=body.loc,
                tag=body.tag,
                text=body.text,
            ),
        )
        return {
            "applied": result.applied,
            "mode": result.mode,
            "path": result.path,
            "message": result.message,
            "prompt": result.prompt,
        }

    @app.post("/api/projects/{project_id}/apply-patch")
    def apply_project_user_patch(
        project_id: str,
        body: ApplyPatchBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        """Apply a Monaco (or raw) edit via unified diff + optional checkpoint (Phase 3.1)."""
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        if manager.project_has_live_run(project_id, tenant_id=request_actor.actor.tenant_id):
            raise HTTPException(
                status_code=409,
                detail="stop the build before editing files manually",
            )
        workspace = manager.project(project_id, tenant_id=request_actor.actor.tenant_id)
        if workspace is None:
            raise HTTPException(status_code=404, detail="no such project")
        if body.content is None and not (body.patch and body.patch.strip()):
            raise HTTPException(status_code=422, detail="content or patch is required")
        edit = apply_user_file_edit(
            workspace,
            path=body.path,
            content=body.content if body.content is not None else "",
            patch=body.patch,
        )
        if not edit.ok:
            raise HTTPException(status_code=422, detail=edit.message or "apply_patch failed")
        checkpoint_payload: dict[str, Any] | None = None
        if body.checkpoint and edit.patch:
            checkpoint = manager._snapshot(  # noqa: SLF001 — same seam as run finish
                workspace,
                project_id=project_id,
                tenant_id=request_actor.actor.tenant_id,
                run_id=f"user-edit-{project_id}",
                verified=False,
                label=body.label or "user edit",
            )
            checkpoint_payload = manager._checkpoint_to_dict(checkpoint, live=True)  # noqa: SLF001
        return {
            "ok": True,
            "path": edit.path,
            "message": edit.message,
            "file_changes": edit.file_changes,
            "checkpoint": checkpoint_payload,
        }

    @app.get("/api/projects/{project_id}/preview-meta")
    def get_preview_meta(
        project_id: str,
        path: str = Query(default="index.html"),
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        """Basic social/SEO card fields from the preview HTML (Phase 3.3)."""
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        workspace = manager.project(project_id, tenant_id=request_actor.actor.tenant_id)
        if workspace is None:
            raise HTTPException(status_code=404, detail="no such project")
        relative = path.lstrip("/") or "index.html"
        try:
            html = workspace.read(relative)
        except Exception:
            # Fall back to index.html when the route is a SPA path.
            try:
                html = workspace.read("index.html")
                relative = "index.html"
            except Exception as error:
                raise HTTPException(status_code=404, detail="no preview html") from error
        seo = extract_html_seo(html)
        return {"project_id": project_id, "path": relative, **seo}

    @app.get("/api/projects/{project_id}/pty")
    def get_project_pty_info(
        project_id: str,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        """Describe whether an interactive terminal websocket is available (Phase 3.2)."""
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        sandboxed = (
            resolved_execution_mode == "orchestrator"
            and app.state.scheduler_client is not None
            and app.state.dispatch_client is not None
        )
        admin = TERMINAL_SCOPE in request_actor.actor.scopes
        if sandboxed and admin:
            mode = "sandbox"
            available = True
            detail = "websocket prefers workspace-dispatch into the project lease"
        elif admin:
            mode = "host"
            available = True
            detail = "websocket falls back to the admin host exec path (prefer sandbox when leased)"
        else:
            mode = "offline"
            available = False
            detail = "interactive PTY requires admin scope; use offline exec history when enabled"
        return {
            "project_id": project_id,
            "available": available,
            "mode": mode,
            "ws_path": f"/api/projects/{project_id}/pty/ws",
            "detail": detail,
        }

    @app.websocket("/api/projects/{project_id}/pty/ws")
    async def project_pty_ws(websocket: WebSocket, project_id: str) -> None:
        """Line-oriented PTY over websocket (Phase 3.2). Prefer sandbox when leased."""
        token = websocket.query_params.get("token") or ""
        auth_header = f"Bearer {token}" if token else websocket.headers.get("authorization")
        try:
            request_actor = optional_actor(auth_header)
        except HTTPException:
            await websocket.close(code=1008)
            return
        if request_actor is None:
            await websocket.close(code=1008)
            return
        if TERMINAL_SCOPE not in request_actor.actor.scopes:
            await websocket.close(code=1008)
            return
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            await websocket.close(code=1008)
            return
        await websocket.accept()
        dispatch: DispatchClient | None = app.state.dispatch_client
        sandboxed = (
            resolved_execution_mode == "orchestrator"
            and dispatch is not None
            and app.state.scheduler_client is not None
        )
        mode = "sandbox" if sandboxed else "host"
        await websocket.send_json({"type": "ready", "mode": mode, "project_id": project_id})

        def _run_line(command: str) -> dict[str, Any]:
            if sandboxed and dispatch is not None:
                lease = _ensure_project_lease(project_id, tenant)
                try:
                    result = dispatch.execute(
                        lease_id=lease.lease_id,
                        lease_token=lease.lease_token,
                        tool="run_shell",
                        args={"command": command, "timeout_seconds": 60},
                    )
                except DispatchError as error:
                    return {
                        "exit_code": 1,
                        "stdout": "",
                        "stderr": str(error),
                        "sandbox": True,
                    }
                return {
                    "exit_code": 0 if result.ok else int(result.detail.get("exit_code") or 1),
                    "stdout": result.output,
                    "stderr": str(result.detail.get("stderr") or ""),
                    "sandbox": True,
                }
            workspace = manager.project(project_id, tenant_id=request_actor.actor.tenant_id)
            if workspace is None:
                return {"exit_code": 1, "stdout": "", "stderr": "no such project", "sandbox": False}
            return terminal.run_user_command(workspace.root, command, timeout_seconds=60)

        try:
            while True:
                message = await websocket.receive_text()
                command = message
                try:
                    parsed = json.loads(message)
                    if isinstance(parsed, dict) and parsed.get("type") == "input":
                        command = str(parsed.get("data") or "")
                except json.JSONDecodeError:
                    pass
                command = command.strip()
                if not command:
                    continue
                if command in {"exit", "quit"}:
                    await websocket.send_json({"type": "exit"})
                    break
                outcome = _run_line(command)
                out = outcome.get("stdout") or ""
                err = outcome.get("stderr") or ""
                text = out + (("\n" + err) if err else "")
                if text and not text.endswith("\n"):
                    text += "\n"
                await websocket.send_json(
                    {
                        "type": "output",
                        "data": text,
                        "exit_code": outcome.get("exit_code", 0),
                        "sandbox": bool(outcome.get("sandbox")),
                    }
                )
        except WebSocketDisconnect:
            return
        except Exception:
            LOGGER.exception("pty websocket failed for %s", project_id)
            try:
                await websocket.close(code=1011)
            except Exception:
                pass

    @app.post("/api/projects/{project_id}/browser-tests")
    def start_browser_test(
        project_id: str,
        body: BrowserTestBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        """Run Playwright (or offline stub) against the preview URL (Phase 2.2)."""
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        preview_url = body.preview_url or f"/api/projects/{project_id}/site/"
        auth_ready = False
        try:
            from .project_backend import load_backend_meta, public_runtime_meta

            meta = public_runtime_meta(load_backend_meta(projects_root, project_id))
            auth_ready = bool(meta.get("auth_ready"))
        except Exception:
            auth_ready = False
        run = run_browser_test(
            projects_root=projects_root,
            project_id=project_id,
            preview_url=preview_url,
            acceptance=list(body.acceptance or []),
            auth_ready=auth_ready,
            force_offline=body.force_offline if body.force_offline is not None else True,
        )
        return run.to_dict()

    @app.get("/api/projects/{project_id}/browser-tests")
    def list_project_browser_tests(
        project_id: str,
        request_actor: RequestActor = actor_dependency,
    ) -> list[dict[str, Any]]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        return list_browser_tests(projects_root, project_id)

    @app.get("/api/projects/{project_id}/browser-tests/{test_id}")
    def get_project_browser_test(
        project_id: str,
        test_id: str,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        record = get_browser_test(projects_root, project_id, test_id)
        if record is None:
            raise HTTPException(status_code=404, detail="no such browser test")
        return record

    @app.post("/api/projects/{project_id}/security-scan")
    def run_project_security_scan(
        project_id: str,
        body: SecurityScanBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        """On-demand Semgrep/gitleaks/npm audit (offline stub OK) — Phase 2.8."""
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        workspace = manager.project(project_id, tenant_id=request_actor.actor.tenant_id)
        if workspace is None:
            raise HTTPException(status_code=404, detail="no such project")
        return run_security_scan(
            projects_root=projects_root,
            project_id=project_id,
            workspace_root=workspace.root,
            gate=body.gate if body.gate in {"build", "deploy"} else "deploy",
            force_offline=body.force_offline if body.force_offline is not None else True,
        )

    @app.get("/api/projects/{project_id}/security-scan")
    def get_project_security_scan(
        project_id: str,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        latest = latest_security_scan(projects_root, project_id)
        if latest is None:
            return {"findings": [], "passed": True, "summary": "No scan yet."}
        return latest

    @app.get("/api/projects/{project_id}/deployments")
    def list_deployments(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> list[dict[str, Any]]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        # In-memory first (this process's writes), durable store as the
        # fallback — restarts used to forget every deployment.
        live = app.state.deployments.get(project_id)
        if live:
            return list(live)
        return _load_deployments(projects_root, project_id)

    @app.post("/api/projects/{project_id}/deploy")
    def deploy_project(
        project_id: str,
        body: DeployBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        if not body.confirmed:
            raise HTTPException(status_code=422, detail="explicit confirmation is required")
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        checkpoints = manager.list_checkpoints(project_id, tenant_id=request_actor.actor.tenant_id)
        target = next(
            (item for item in checkpoints if str(item.get("checkpoint_id")) == body.checkpoint_id),
            None,
        )
        if target is None:
            raise HTTPException(status_code=404, detail="no such checkpoint")
        if not target.get("verified"):
            raise HTTPException(status_code=422, detail="only green checkpoints may be deployed")
        # Phase 2.8: block publish on critical security findings unless overridden.
        if not body.override_security:
            if latest_security_scan(projects_root, project_id) is None:
                workspace = manager.project(project_id, tenant_id=request_actor.actor.tenant_id)
                if workspace is not None:
                    run_security_scan(
                        projects_root=projects_root,
                        project_id=project_id,
                        workspace_root=workspace.root,
                        gate="deploy",
                        force_offline=True,
                    )
            blocked = publish_blocked_by_security(
                projects_root, project_id, override=False
            )
            if blocked is not None:
                raise HTTPException(status_code=409, detail=blocked)
        # Phase 0 immutable site URL (signed, 30-day) plus Phase 1.8 hosting
        # (static object root / Fly / opaque domain when configured).
        deployment_id = f"dep_{secrets.token_hex(6)}"
        token = mint_preview_token(
            preview_signer,
            project_id=project_id,
            tenant_id=request_actor.actor.tenant_id,
            lease_id=f"{DEPLOY_LEASE_PREFIX}{deployment_id}",
            subject=request_actor.actor.subject,
            now=time.time(),
            ttl_seconds=86400 * 30,
        )
        site_url = f"/api/projects/{project_id}/site/t/{token}/index.html"
        hosting_meta: dict[str, Any] = {}
        production_url = site_url
        try:
            checkpoint = manager.checkpoint(
                body.checkpoint_id, tenant_id=request_actor.actor.tenant_id
            )
            hosted = publish_via_hosting(
                checkpoint=checkpoint,
                checkpoints=manager._checkpoints,
                projects_root=projects_root,
                tenant_id=tenant,
                project_id=project_id,
                reason=body.reason or "publish",
                actor_id=request_actor.actor.subject,
                site_url=site_url,
                project_backend=app.state.project_backend,
            )
            production_url = hosted.production_url
            hosting_meta = {
                "hosting_provider": hosted.provider,
                "provider_release_id": hosted.provider_release_id,
                "hostname": hosted.hostname,
                "hosted_release_id": hosted.hosted_release_id,
                "site_url": site_url,
            }
            if hosted.prod_database:
                hosting_meta["prod_database"] = hosted.prod_database
        except Exception as error:
            LOGGER.warning("hosting publish fell back to signed site URL: %s", error)
            hosting_meta = {
                "hosting_provider": "signed_site",
                "site_url": site_url,
                "hosting_error": str(error),
            }
        # Mark prior live deployments rolled back in history (publish history).
        prior = _load_deployments(projects_root, project_id)
        for item in prior:
            if item.get("status") == "live":
                item["status"] = "superseded"
                item["superseded_at"] = datetime.now(UTC).isoformat()
        if prior:
            _save_deployments(projects_root, project_id, prior)
            app.state.deployments[project_id] = prior
        record = {
            "deployment_id": deployment_id,
            "project_id": project_id,
            "checkpoint_id": body.checkpoint_id,
            "status": "live",
            "production_url": production_url,
            "reason": body.reason,
            "created_at": datetime.now(UTC).isoformat(),
            **hosting_meta,
        }
        history = _persist_deployment(projects_root, project_id, record)
        app.state.deployments[project_id] = history
        audit_store.append(
            _audit_payload(
                event_type="project.deploy",
                actor=request_actor.actor,
                project_id=project_id,
                outcome="success",
                detail={
                    "checkpoint_id": body.checkpoint_id,
                    "deployment_id": record["deployment_id"],
                    "reason": body.reason,
                    "hosting_provider": hosting_meta.get("hosting_provider"),
                },
            )
        )
        return record

    @app.post("/api/projects/{project_id}/deployments/{deployment_id}/unpublish")
    def unpublish_deployment(
        project_id: str,
        deployment_id: str,
        body: ConfirmedBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        if not body.confirmed:
            raise HTTPException(status_code=422, detail="explicit confirmation is required")
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        record = _deployment(project_id, deployment_id)
        if record is None:
            raise HTTPException(status_code=404, detail="no such deployment")
        if record.get("status") == "unpublished":
            return record
        updated = {
            **record,
            "status": "unpublished",
            "unpublished_at": datetime.now(UTC).isoformat(),
            "reason": body.reason or record.get("reason"),
        }
        history = _replace_deployment(projects_root, project_id, updated)
        app.state.deployments[project_id] = history
        audit_store.append(
            _audit_payload(
                event_type="project.unpublish",
                actor=request_actor.actor,
                project_id=project_id,
                outcome="success",
                detail={"deployment_id": deployment_id, "reason": body.reason},
            )
        )
        return updated

    @app.post("/api/projects/{project_id}/deployments/{deployment_id}/republish")
    def republish_deployment(
        project_id: str,
        deployment_id: str,
        body: ConfirmedBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        """Re-publish a prior verified deployment without minting a new checkpoint.

        The production URL and checkpoint blob stay the same; only status flips
        back to ``live``. Serving always reads the immutable checkpoint.
        """
        if not body.confirmed:
            raise HTTPException(status_code=422, detail="explicit confirmation is required")
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        record = _deployment(project_id, deployment_id)
        if record is None:
            raise HTTPException(status_code=404, detail="no such deployment")
        checkpoint_id = str(record.get("checkpoint_id") or "")
        checkpoints = manager.list_checkpoints(project_id, tenant_id=request_actor.actor.tenant_id)
        target = next(
            (item for item in checkpoints if str(item.get("checkpoint_id")) == checkpoint_id),
            None,
        )
        if target is None or not target.get("verified"):
            raise HTTPException(
                status_code=422,
                detail="only deployments pinned to a green checkpoint may be re-published",
            )
        updated = {
            **record,
            "status": "live",
            "republished_at": datetime.now(UTC).isoformat(),
            "reason": body.reason or record.get("reason"),
        }
        updated.pop("unpublished_at", None)
        history = _replace_deployment(projects_root, project_id, updated)
        app.state.deployments[project_id] = history
        audit_store.append(
            _audit_payload(
                event_type="project.republish",
                actor=request_actor.actor,
                project_id=project_id,
                outcome="success",
                detail={
                    "deployment_id": deployment_id,
                    "checkpoint_id": checkpoint_id,
                    "reason": body.reason,
                },
            )
        )
        return updated

    @app.post("/api/projects/{project_id}/deployments/{deployment_id}/rollback")
    def rollback_deployment(
        project_id: str,
        deployment_id: str,
        body: ConfirmedBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        """Make a prior deployment live again (hosting rollback + status flip)."""
        if not body.confirmed:
            raise HTTPException(status_code=422, detail="explicit confirmation is required")
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        record = _deployment(project_id, deployment_id)
        if record is None:
            raise HTTPException(status_code=404, detail="no such deployment")
        checkpoint_id = str(record.get("checkpoint_id") or "")
        try:
            rollback_via_hosting(
                projects_root=projects_root,
                project_id=project_id,
                checkpoint_id=checkpoint_id,
            )
        except Exception as error:
            LOGGER.warning("hosting rollback warning: %s", error)
        history = _load_deployments(projects_root, project_id)
        for item in history:
            if item.get("status") == "live":
                item["status"] = "superseded"
                item["superseded_at"] = datetime.now(UTC).isoformat()
            if item.get("deployment_id") == deployment_id:
                item["status"] = "live"
                item["rolled_back_at"] = datetime.now(UTC).isoformat()
                item.pop("unpublished_at", None)
                record = item
        _save_deployments(projects_root, project_id, history)
        app.state.deployments[project_id] = history
        return record

    @app.get("/api/projects/{project_id}/database")
    def project_database(
        project_id: str,
        environment: str = Query(default="dev"),
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        env = (environment or "dev").strip().lower() or "dev"
        if env not in {"dev", "prod"}:
            raise HTTPException(status_code=422, detail="environment must be dev or prod")
        ensure_runtime(
            app.state.project_backend,
            projects_root=projects_root,
            tenant_id=tenant,
            project_id=project_id,
        )
        raw = load_backend_meta(projects_root, project_id)
        meta = public_runtime_meta(raw, environment=env)
        tables = list_tables(
            app.state.project_backend,
            projects_root=projects_root,
            tenant_id=tenant,
            project_id=project_id,
            environment=env,
        )
        return {**meta, "tables": tables}

    @app.get("/api/projects/{project_id}/database/tables/{table}")
    def project_database_table(
        project_id: str,
        table: str,
        environment: str = Query(default="dev"),
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        env = (environment or "dev").strip().lower() or "dev"
        if env not in {"dev", "prod"}:
            raise HTTPException(status_code=422, detail="environment must be dev or prod")
        return browse_table(
            app.state.project_backend,
            projects_root=projects_root,
            tenant_id=tenant,
            project_id=project_id,
            table=table,
            environment=env,
        )

    @app.post("/api/projects/{project_id}/auth/token")
    def project_dev_jwt(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        return issue_dev_jwt(
            app.state.project_backend,
            projects_root=projects_root,
            tenant_id=tenant,
            project_id=project_id,
            user_id=request_actor.actor.subject,
        )

    @app.get("/api/projects/{project_id}/secrets")
    def project_secrets(
        project_id: str,
        environment: str = Query(default="build"),
        request_actor: RequestActor = actor_dependency,
    ) -> list[dict[str, str]]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        return list_secret_names(
            app.state.project_backend,
            tenant_id=tenant,
            project_id=project_id,
            environment=environment,
        )

    @app.put("/api/projects/{project_id}/secrets")
    def put_project_secret(
        project_id: str,
        body: SecretBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, str]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        try:
            put_secret(
                app.state.project_backend,
                tenant_id=tenant,
                project_id=project_id,
                name=body.name,
                value=body.value,
                environment=body.environment,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return {"status": "stored", "name": body.name}

    @app.delete("/api/projects/{project_id}/secrets/{name}")
    def delete_project_secret(
        project_id: str,
        name: str,
        environment: str = Query(default="build"),
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, str]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        ok = delete_secret(
            app.state.project_backend,
            tenant_id=tenant,
            project_id=project_id,
            name=name,
            environment=environment,
        )
        if not ok:
            raise HTTPException(status_code=404, detail="no such secret")
        return {"status": "deleted", "name": name}

    @app.post("/api/projects/{project_id}/secrets/request")
    def request_project_secret(
        project_id: str,
        body: SecretRequestBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        try:
            return request_secret(
                app.state.project_backend,
                project_id=project_id,
                name=body.name,
                reason=body.reason,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/projects/{project_id}/runtime-env")
    def project_runtime_env_meta(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        """Non-secret env keys that would be injected into sandbox/deploy."""
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        ensure_runtime(
            app.state.project_backend,
            projects_root=projects_root,
            tenant_id=tenant,
            project_id=project_id,
        )
        env = sandbox_env_for(
            app.state.project_backend, tenant_id=tenant, project_id=project_id
        )
        return {"names": sorted(env.keys()), "count": len(env)}

    # -- Phase 3.7–3.9: connectors, analytics, collaboration -----------------

    def _secret_name_set(tenant_id: str, project_id: str) -> set[str]:
        ensure_runtime(
            app.state.project_backend,
            projects_root=projects_root,
            tenant_id=tenant_id,
            project_id=project_id,
        )
        rows = list_secret_names(
            app.state.project_backend, tenant_id=tenant_id, project_id=project_id
        )
        return {str(row.get("name") or "") for row in rows if row.get("name")}

    @app.get("/api/projects/{project_id}/connectors")
    def list_project_connectors(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        connectors = app.state.connectors.list_for_project(
            project_id, secret_names=_secret_name_set(tenant, project_id)
        )
        return {"connectors": connectors, "mode": "offline"}

    @app.put("/api/projects/{project_id}/connectors")
    def enable_project_connector(
        project_id: str,
        body: ConnectorEnableBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        try:
            row = app.state.connectors.set_enabled(
                project_id,
                body.kind,  # type: ignore[arg-type]
                body.enabled,
                secret_names=_secret_name_set(tenant, project_id),
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return row

    @app.get("/api/projects/{project_id}/analytics")
    def get_project_analytics(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        snap = app.state.analytics.get(project_id)
        return {**snap.as_dict(), "note": "Page views from published HTML serves (sidecar; edge billing.py not in stack)."}

    @app.post("/api/projects/{project_id}/analytics/seed")
    def seed_project_analytics(
        project_id: str,
        body: AnalyticsSeedBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        """Offline stub — seeds counters when app-proxy edge meters are absent."""
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        snap = app.state.analytics.seed_offline(project_id, body.page_views)
        return snap.as_dict()

    @app.get("/api/projects/{project_id}/collab")
    def get_project_collab(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        return app.state.collab.get(project_id)

    @app.post("/api/projects/{project_id}/collab/presence")
    def heartbeat_project_presence(
        project_id: str,
        body: CollabHeartbeatBody | None = None,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        actor = request_actor.actor
        user = auth_repo.get_user(actor.subject)
        display = (body.display_name if body else "") or (user.email if user else None) or actor.subject
        role = getattr(actor, "role", None) or "editor"
        return app.state.collab.heartbeat(
            project_id,
            actor_id=str(actor.subject),
            display_name=str(display),
            role=str(role),
        )

    @app.post("/api/projects/{project_id}/collab/chat")
    def post_project_collab_chat(
        project_id: str,
        body: CollabChatBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        actor = request_actor.actor
        user = auth_repo.get_user(actor.subject)
        display = body.display_name or (user.email if user else None) or actor.subject
        try:
            return app.state.collab.post_message(
                project_id,
                actor_id=str(actor.subject),
                display_name=str(display),
                text=body.text,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    # -- Phase 2.9: notifications + pending Apply-changes reviews -------------

    @app.get("/api/notifications")
    def list_notifications(
        unread_only: bool = Query(default=False),
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        require_action(request_actor, "project:read", Resource(org_id=request_actor.actor.org_id))
        tenant_id = request_actor.actor.tenant_id
        store: ReviewStore = app.state.review_store
        items = store.list_notifications(tenant_id, unread_only=unread_only)
        return {
            "notifications": items,
            "unread_count": store.unread_count(tenant_id),
        }

    @app.post("/api/notifications/read")
    def mark_notifications_read(
        body: dict[str, Any] | None = None,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        require_action(request_actor, "project:write", Resource(org_id=request_actor.actor.org_id))
        payload = body or {}
        notification_id = payload.get("notification_id")
        flipped = app.state.review_store.mark_read(
            request_actor.actor.tenant_id,
            str(notification_id) if notification_id else None,
        )
        return {
            "marked": flipped,
            "unread_count": app.state.review_store.unread_count(request_actor.actor.tenant_id),
        }

    @app.get("/api/reviews")
    def list_pending_reviews(
        project_id: str | None = Query(default=None),
        status: str | None = Query(default="pending"),
        request_actor: RequestActor = actor_dependency,
    ) -> list[dict[str, Any]]:
        require_action(request_actor, "project:read", Resource(org_id=request_actor.actor.org_id))
        return app.state.review_store.list_reviews(
            request_actor.actor.tenant_id, project_id=project_id, status=status
        )

    @app.get("/api/reviews/{review_id}")
    def get_pending_review(
        review_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        require_action(request_actor, "project:read", Resource(org_id=request_actor.actor.org_id))
        review = app.state.review_store.get_review(
            review_id, tenant_id=request_actor.actor.tenant_id
        )
        if review is None:
            raise HTTPException(status_code=404, detail="no such review")
        return review

    @app.post("/api/reviews/{review_id}/apply")
    def apply_pending_review(
        review_id: str,
        body: ConfirmedBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        """Merge a background-build checkpoint into the main line after diff review."""
        if not body.confirmed:
            raise HTTPException(status_code=422, detail="explicit confirmation is required")
        require_action(request_actor, "project:write", Resource(org_id=request_actor.actor.org_id))
        try:
            result = manager.apply_pending_review(
                review_id, tenant_id=request_actor.actor.tenant_id
            )
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        audit_store.append(
            _audit_payload(
                event_type="review.apply",
                actor=request_actor.actor,
                project_id=str((result.get("review") or {}).get("project_id") or ""),
                outcome="success",
                detail={"review_id": review_id, "reason": body.reason},
            )
        )
        return result

    @app.post("/api/reviews/{review_id}/dismiss")
    def dismiss_pending_review(
        review_id: str,
        body: ConfirmedBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        if not body.confirmed:
            raise HTTPException(status_code=422, detail="explicit confirmation is required")
        require_action(request_actor, "project:write", Resource(org_id=request_actor.actor.org_id))
        review = app.state.review_store.mark_dismissed(
            review_id, tenant_id=request_actor.actor.tenant_id
        )
        if review is None:
            raise HTTPException(status_code=404, detail="no such review")
        return review

    @app.get("/api/projects/{project_id}/site/h/{release_id}/{path:path}")
    def hosted_site(
        project_id: str,
        release_id: str,
        path: str = "index.html",
        request_actor: RequestActor = actor_dependency,
    ) -> Response:
        """Serve a static hosted release from ``.hosted/`` (offline CDN path)."""
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        relative = posixpath.normpath(path or "index.html")
        if relative.startswith(("../", "/")) or relative in {".", ".."}:
            raise HTTPException(status_code=404, detail="no such file")
        body = read_hosted_file(projects_root, release_id, relative)
        if body is None:
            raise HTTPException(status_code=404, detail="no such file")
        return _site_response(body, relative)

    def _serve_project_file(project_id: str, path: str, tenant_id: str) -> Response:
        workspace = manager.project(project_id, tenant_id=tenant_id)
        if workspace is None:
            raise HTTPException(status_code=404, detail="no such project")
        try:
            body = workspace.read_bytes(path or "index.html")
        except (WorkspaceError, OSError) as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return _site_response(body, path)

    def _deployment(project_id: str, deployment_id: str) -> dict[str, Any] | None:
        history = app.state.deployments.get(project_id) or _load_deployments(
            projects_root, project_id
        )
        return next(
            (item for item in history if item.get("deployment_id") == deployment_id), None
        )

    def _serve_deployment(project_id: str, claims: Any, path: str) -> Response:
        """Serve a published version from its checkpoint, never the live workspace."""
        reference = str(claims.lease_id).removeprefix(DEPLOY_LEASE_PREFIX)
        record = _deployment(project_id, reference)
        if record is None:
            if reference == project_id:
                # Links published before deployments were pinned name the
                # project, not a deployment, and have no snapshot to serve.
                # They keep their original live-workspace behaviour until
                # they expire (30 days); republishing issues a pinned link.
                return _serve_project_file(project_id, path, claims.tenant_id)
            raise HTTPException(status_code=404, detail="no such deployment")
        if record.get("status") == "unpublished":
            raise HTTPException(status_code=404, detail="deployment is unpublished")
        relative = posixpath.normpath(path or "index.html")
        if relative.startswith(("../", "/")) or relative in {".", ".."}:
            raise HTTPException(status_code=404, detail="no such file")
        try:
            checkpoint = manager.checkpoint(
                str(record.get("checkpoint_id")), tenant_id=claims.tenant_id
            )
            if checkpoint.project_id != project_id:
                raise HTTPException(status_code=404, detail="no such deployment")
            body = manager.read_checkpoint_file(checkpoint, relative)
        except CheckpointError as error:
            raise HTTPException(status_code=404, detail="no such file") from error
        # Phase 3.8: count published HTML page views (edge billing.py absent → sidecar).
        suffix = Path(relative).suffix.lower()
        if suffix in {".html", ".htm", ""}:
            try:
                app.state.analytics.record_view(project_id, relative, html=True)
            except Exception:
                LOGGER.debug("analytics record_view skipped", exc_info=True)
        return _site_response(body, relative)

    def _site_response(body: str | bytes, path: str) -> Response:
        suffix = Path(path or "index.html").suffix.lower()
        media_type = SERVABLE_TYPES.get(suffix)
        if media_type is None:
            # An unknown type is served as plain text rather than sniffed.
            # Letting the browser guess is how model-authored bytes become
            # model-authored behaviour.
            media_type = "text/plain; charset=utf-8"
        # Phase 1.5 / 2.1: inject console + inspector bridges into static HTML
        # previews (HMR path injects via preview-proxy).
        if suffix in {".html", ".htm"}:
            try:
                from loopit_preview.bridge import inject_preview_bridges

                body = inject_preview_bridges(body)
            except Exception:
                LOGGER.debug("preview bridge inject skipped", exc_info=True)
        return Response(
            content=body,
            media_type=media_type,
            headers={
                "X-Content-Type-Options": "nosniff",
                # The preview frame is sandboxed without `allow-same-origin`, so it runs on
                # an opaque ("null") origin. ES module scripts are always fetched in CORS
                # mode, so main.js is a cross-origin request from that frame and is blocked
                # without this header -- the entry page loads, the module never does, and
                # the preview renders blank.
                #
                # `*` carries no additional exposure here: these responses are anonymous
                # (authorised by the unguessable signed token in the path, never by a
                # cookie or an Authorization header), so a cross-origin reader must already
                # possess the URL, which is itself the credential. `*` and "credentials"
                # are mutually exclusive in CORS, which keeps that property enforced by the
                # browser rather than by convention.
                "Access-Control-Allow-Origin": "*",
                # The frame has no `allow-same-origin`, so this page sits on an
                # opaque origin and cannot reach the API or the parent no
                # matter what it runs. The CSP is the second layer: it says
                # where code may come from.
                #
                # `script-src` has to include the module CDN, because with no
                # build step that is where React itself arrives from. It is a
                # named origin, not a wildcard, and the versions it serves are
                # pinned in `stacks.py`.
                #
                # `connect-src 'none'` stays absolute. Loading a module is
                # governed by `script-src`, so the app still boots, but nothing
                # it does can call back out — including to this API.
                "Content-Security-Policy": (
                    f"default-src 'self'; img-src 'self' data: https:; "
                    f"style-src 'self' 'unsafe-inline' {MODULE_CDN}; "
                    f"font-src 'self' data: {MODULE_CDN}; "
                    f"script-src 'self' 'unsafe-inline' {MODULE_CDN}; "
                    "connect-src 'none'; form-action 'none'; base-uri 'none'"
                ),
            },
        )

    def _preview_claims(project_id: str, preview_token: str) -> Any:
        try:
            claims = preview_signer.verify(preview_token, now=time.time())
        except Exception as error:
            raise HTTPException(status_code=401, detail="invalid preview token") from error
        if claims.project_id != project_id:
            raise HTTPException(status_code=403, detail="forbidden")
        return claims

    def _serve_with_token(project_id: str, preview_token: str, path: str) -> Response:
        claims = _preview_claims(project_id, preview_token)
        if str(claims.lease_id).startswith(DEPLOY_LEASE_PREFIX):
            return _serve_deployment(project_id, claims, path)
        return _serve_project_file(project_id, path, claims.tenant_id)

    @app.get("/api/projects/{project_id}/site/t/{preview_token}/{path:path}")
    def serve_site_with_token(project_id: str, preview_token: str, path: str) -> Response:
        """Serve a project file under a token-prefixed path.

        Every subresource the generated app asks for resolves under this prefix, so the
        whole site authenticates, not just its entry document.
        """
        return _serve_with_token(project_id, preview_token, path)

    @app.get("/api/projects/{project_id}/site/{path:path}")
    def serve_site(
        project_id: str,
        path: str,
        authorization: str | None = Header(default=None),
        preview_token: str | None = Query(default=None),
    ) -> Response:
        """Serve a project file so a multi-file site renders as a site.

        ``srcDoc`` is enough for one self-contained page, but the moment the
        agent splits work across ``styles.css``, ``app.js`` and a second page —
        which is what building anything larger looks like — relative links have
        to resolve against a real origin. Serving from a path under this API
        gives them one.
        """
        if preview_token:
            return _serve_with_token(project_id, preview_token, path)
        actor = current_actor(authorization)
        tenant = _resolve_project_tenant(project_id, actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(actor, "project:read", Resource(org_id=tenant))
        return _serve_project_file(project_id, path, actor.actor.tenant_id)

    @app.get("/api/runs/{run_id}/events")
    async def stream_events(
        run_id: str,
        request_actor: RequestActor = actor_dependency,
        after: int | None = Query(
            default=None,
            ge=0,
            description="Skip journal events with _seq <= after (SSE reconnect resume).",
        ),
    ) -> StreamingResponse:
        if resolved_execution_mode == "orchestrator" and run_id in app.state.temporal_runs:
            metadata = app.state.temporal_runs[run_id]
            require_action(request_actor, "project:read", Resource(org_id=metadata["tenant_id"]))
        elif manager.get(run_id, tenant_id=request_actor.actor.tenant_id) is None:
            # The run may predate a process restart: the in-memory maps are
            # gone, but its durable journal can still answer the replay.
            if not manager.has_journal(run_id):
                raise HTTPException(status_code=404, detail="no such run")

        resume_after = after if after is not None else 0

        async def publish() -> AsyncIterator[str]:
            import anyio

            if resolved_execution_mode == "orchestrator":
                while True:
                    run = await get_run(run_id, request_actor)
                    yield f"data: {json.dumps({'kind': 'run', **run})}\n\n"
                    if run["status"] not in {
                        "queued",
                        "running",
                        "awaiting_approval",
                        "verifying",
                        "checkpointing",
                    }:
                        yield "event: end\ndata: {}\n\n"
                        return
                    await anyio.sleep(1)

            # Durable progress: replay the journal first (a finished run shows
            # its full history to anyone who was not watching live), then keep
            # draining the live queue, skipping what the journal covered.
            # ``?after=`` lets a reconnect skip the already-seen prefix.
            seen = resume_after
            for past in await anyio.to_thread.run_sync(manager.replay_events, run_id):
                seq = past.get("_seq")
                if isinstance(seq, int):
                    if seq <= resume_after:
                        seen = max(seen, seq)
                        continue
                    seen = max(seen, seq)
                yield f"data: {json.dumps(past)}\n\n"
            if await anyio.to_thread.run_sync(manager.finished, run_id):
                yield "event: end\ndata: {}\n\n"
                return

            while True:
                # One event at a time. Collecting the run first and sending the
                # list at the end would technically be an SSE response and would
                # show the user nothing until the work was already over.
                event = await anyio.to_thread.run_sync(manager.next_event, run_id)
                if event is RUN_FINISHED:
                    yield "event: end\ndata: {}\n\n"
                    return
                if event is None:
                    # Keep-alive. Proxies and browsers both drop a stream that
                    # goes quiet, and a model call can take longer than that.
                    yield ": keep-alive\n\n"
                    continue
                seq = event.get("_seq") if isinstance(event, dict) else None
                if isinstance(seq, int) and seq <= seen:
                    continue
                if isinstance(seq, int):
                    seen = seq
                yield f"data: {json.dumps(event)}\n\n"

        return StreamingResponse(
            publish(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # --- Phase 2.3 GitHub sync -------------------------------------------------

    @app.get("/api/projects/{project_id}/git")
    def git_status(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        return app.state.gitsync.status(project_id)

    @app.post("/api/projects/{project_id}/git/bind")
    def git_bind(
        project_id: str,
        body: GitBindBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        try:
            return app.state.gitsync.bind(
                project_id=project_id,
                tenant_id=tenant,
                owner=body.owner,
                name=body.name,
                create=body.create,
                auto_push=body.auto_push,
                access_token=body.access_token,
            )
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.delete("/api/projects/{project_id}/git")
    def git_unbind(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, str]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        app.state.gitsync.unbind(project_id)
        return {"status": "unbound"}

    @app.post("/api/projects/{project_id}/git/push")
    def git_push(
        project_id: str,
        body: GitPushBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        try:
            checkpoint = manager.checkpoint(body.checkpoint_id, tenant_id=tenant)
            if checkpoint.project_id != project_id:
                raise HTTPException(status_code=404, detail="no such checkpoint")
            return app.state.gitsync.push_checkpoint(
                checkpoint,
                run_id=f"manual_{project_id}",
                access_token=body.access_token,
            )
        except HTTPException:
            raise
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post("/api/projects/{project_id}/git/webhook")
    def git_webhook(
        project_id: str,
        body: GitWebhookBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        """Pull remote into a new checkpoint (+ workspace refresh). Conflict → backup branch."""
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))

        def write_workspace(tree: dict[str, bytes]) -> None:
            workspace = manager.project(project_id, tenant_id=tenant)
            if workspace is None:
                from .workspace import Workspace

                workspace = Workspace(projects_root / tenant / project_id)
            for path, content in tree.items():
                workspace.write_bytes(path, content)

        try:
            result = app.state.gitsync.handle_webhook_push(
                project_id=project_id,
                tenant_id=tenant,
                payload=body.model_dump(exclude_none=True),
                workspace_writer=write_workspace,
            )
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return result

    # --- Phase 2.4 Custom domains ---------------------------------------------

    @app.get("/api/projects/{project_id}/domains")
    def list_domains(
        project_id: str, request_actor: RequestActor = actor_dependency
    ) -> list[dict[str, Any]]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:read", Resource(org_id=tenant))
        return app.state.domains.list_for_project(tenant_id=tenant, project_id=project_id)

    @app.post("/api/projects/{project_id}/domains")
    def claim_domain(
        project_id: str,
        body: CustomDomainBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        try:
            return app.state.domains.claim(
                tenant_id=tenant,
                subject=request_actor.actor.subject,
                project_id=project_id,
                hostname=body.hostname,
            )
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post("/api/projects/{project_id}/domains/{hostname}/verify")
    def verify_domain(
        project_id: str,
        hostname: str,
        body: DomainVerifyBody | None = None,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        seed = bool(body.seed_txt) if body is not None else False
        try:
            claim = app.state.domains.verify(
                tenant_id=tenant,
                subject=request_actor.actor.subject,
                hostname=hostname,
                seed_txt=seed or offline,
            )
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        # Meter one custom-domain month when the usage bridge is on.
        token = request_actor.identity_token
        if token and claim.get("status") == "verified":
            meter_custom_domain_month(
                usage_url=os.environ.get("LOOPIT_USAGE_URL"),
                identity_token=token,
                project_id=project_id,
                hostname=hostname,
            )
        return claim

    # --- Phase 2.5 Sharing / remix --------------------------------------------

    @app.patch("/api/projects/{project_id}/visibility")
    def set_visibility(
        project_id: str,
        body: VisibilityBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        tenant = _resolve_project_tenant(project_id, request_actor.actor.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="no such project")
        require_action(request_actor, "project:write", Resource(org_id=tenant))
        record = project_store.get(project_id, tenant_id=tenant)
        title = body.title or (record.name if record else project_id)
        live = (_load_deployments(projects_root, project_id) or [])
        live_row = next((item for item in reversed(live) if item.get("status") == "live"), None)
        checkpoints = manager.list_checkpoints(project_id, tenant_id=tenant)
        green = next((c for c in reversed(checkpoints) if c.get("verified")), None)
        share = app.state.sharing.set_visibility(
            project_id=project_id,
            tenant_id=tenant,
            visibility=body.visibility,  # type: ignore[arg-type]
            title=title,
            production_url=(live_row or {}).get("production_url"),
            checkpoint_id=(green or {}).get("checkpoint_id") if green else None,
        )
        return share.as_dict()

    @app.get("/api/public/share/{share_id}")
    def public_share(share_id: str) -> dict[str, Any]:
        payload = app.state.sharing.public_payload(share_id)
        if payload is None:
            raise HTTPException(status_code=404, detail="share not found")
        return payload

    @app.post("/api/public/share/{share_id}/remix")
    def public_remix(
        share_id: str, request_actor: RequestActor = actor_dependency
    ) -> dict[str, Any]:
        """Fork latest checkpoint into the caller's tenant — no chat, no secrets."""
        payload = app.state.sharing.public_payload(share_id)
        if payload is None or not payload.get("remix_allowed"):
            raise HTTPException(status_code=404, detail="remix not available")
        source_project = str(payload["project_id"])
        share = app.state.sharing.get_by_share_id(share_id)
        if share is None:
            raise HTTPException(status_code=404, detail="share not found")
        checkpoint_id = payload.get("checkpoint_id")
        if not checkpoint_id:
            checkpoints = manager.list_checkpoints(
                source_project, tenant_id=share.tenant_id
            )
            green = next((c for c in reversed(checkpoints) if c.get("verified")), None)
            if green is None:
                raise HTTPException(status_code=422, detail="no verified checkpoint to remix")
            checkpoint_id = green["checkpoint_id"]
        # Remix always forks under the source tenant (checkpoint tenancy), then
        # catalogs the copy for the caller. Secrets and run journals are not copied.
        try:
            forked = manager.fork_checkpoint(
                source_project,
                str(checkpoint_id),
                tenant_id=share.tenant_id,
                actor_id=request_actor.actor.subject,
            )
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        new_id = str(forked["project_id"])
        dest_tenant = request_actor.actor.tenant_id
        name = f"Remix of {payload.get('title') or source_project}"[:120]
        try:
            project_store.create(
                ProjectRecord(
                    project_id=new_id,
                    tenant_id=dest_tenant if dest_tenant == share.tenant_id else share.tenant_id,
                    owner_user_id=request_actor.actor.subject,
                    name=name,
                    stack=REACT_STACK,
                    current_checkpoint_id=(forked.get("checkpoint") or {}).get("checkpoint_id"),
                )
            )
        except Exception:
            LOGGER.exception("could not catalog remixed project %s", new_id)
        app.state.sharing.set_visibility(
            project_id=new_id,
            tenant_id=share.tenant_id,
            visibility="private",
            title=name,
        )
        return {"project_id": new_id, "checkpoint": forked.get("checkpoint")}

    # --- Phase 2.6 Templates gallery ------------------------------------------

    @app.get("/api/templates")
    def list_templates() -> list[dict[str, Any]]:
        return load_templates()

    @app.get("/api/templates/{template_id}")
    def get_template_route(template_id: str) -> dict[str, Any]:
        item = get_template(template_id)
        if item is None:
            raise HTTPException(status_code=404, detail="no such template")
        return item

    @app.post("/api/templates/{template_id}/remix")
    def remix_template(
        template_id: str,
        body: TemplateRemixBody,
        request_actor: RequestActor = actor_dependency,
    ) -> dict[str, Any]:
        if not body.confirmed:
            raise HTTPException(status_code=422, detail="explicit confirmation is required")
        item = get_template(template_id)
        if item is None:
            raise HTTPException(status_code=404, detail="no such template")
        require_action(
            request_actor, "project:write", Resource(org_id=request_actor.actor.org_id)
        )
        # Start a Build run with the recipe prompt — creates a fresh project.
        run = manager.start(
            RunRequest(
                prompt=str(item["prompt_seed"]),
                tenant_id=request_actor.actor.tenant_id,
                actor_id=request_actor.actor.subject,
                stack=str(item.get("stack") or REACT_STACK),
                mode="build",
            )
        )
        try:
            project_store.create(
                ProjectRecord(
                    project_id=run.project_id,
                    tenant_id=request_actor.actor.tenant_id,
                    owner_user_id=request_actor.actor.subject,
                    name=str(item.get("title") or template_id)[:120],
                    stack=str(item.get("stack") or REACT_STACK),
                )
            )
        except Exception:
            LOGGER.exception("could not catalog template project %s", run.project_id)
        return {
            "project_id": run.project_id,
            "run_id": run.run_id,
            "template_id": template_id,
            "prompt": item["prompt_seed"],
        }

    return app


def _workflow_status_to_run(status: Any, metadata: dict[str, Any]) -> dict[str, Any]:
    started_at = status.started_at.isoformat() if status.started_at else datetime_now_iso()
    finished_at = status.finished_at.isoformat() if status.finished_at else None
    ui_status = (
        "verified"
        if str(status.status) in {"succeeded", "RunStatus.SUCCEEDED"}
        else str(status.status)
    )
    if ui_status in {"failed", "RunStatus.FAILED"}:
        ui_status = "error"
    gate = _gate_to_view(status.gate) if status.gate else None
    cost = {
        "iterations": status.iterations,
        "credits_spent": round(float(status.credits), 6),
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": int(status.tokens),
    }
    return {
        "run_id": status.run_id,
        "project_id": status.project_id,
        "prompt": metadata.get("prompt", ""),
        "status": ui_status,
        "started_at": started_at,
        "finished_at": finished_at,
        "iterations": status.iterations,
        "summary": status.summary,
        "credits_spent": round(float(status.credits), 6),
        "stack": metadata.get("stack", REACT_STACK),
        "dag": None,
        "task_dag": None,
        "gates": [gate] if gate else [],
        "gate": gate,
        "tier": metadata.get("tier"),
        "checkpoints": [],
        "cost": cost,
    }


def _gate_to_view(gate: Any) -> dict[str, Any]:
    return {
        "gate_id": gate.gate_id,
        "node_id": None,
        "action": gate.tool,
        "reason": gate.reason,
        "args": dict(gate.args),
        "args_hash": gate.args_hash,
        "expires_at": gate.expires_at,
        "destructive": True,
        "irreversible": True,
        "status": "pending",
    }


def _run_cost(run: dict[str, Any]) -> dict[str, Any]:
    cost = dict(run.get("cost") or {})
    cost.setdefault("iterations", run.get("iterations", 0))
    cost.setdefault("credits_spent", run.get("credits_spent", 0.0))
    cost.setdefault("total_tokens", 0)
    if value := os.environ.get("LOOPIT_COST_PER_SUCCESSFUL_DEPLOY"):
        cost["cost_per_successful_deploy"] = float(value)
    return cost


def _audit_payload(
    *,
    event_type: str,
    actor: Actor,
    project_id: str | None = None,
    run_id: str | None = None,
    outcome: str,
    detail: dict[str, Any],
) -> dict[str, Any]:
    return {
        "event_id": f"ev_{secrets.token_hex(8)}",
        "type": event_type,
        "tenant_id": actor.tenant_id,
        "actor": {"kind": "user", "id": actor.subject},
        "project_id": project_id,
        "run_id": run_id,
        "plane": "control",
        "outcome": outcome,
        "detail": detail,
    }


def datetime_now_iso() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat()


def build_default_app() -> FastAPI:
    """The app uvicorn imports when run without the CLI."""
    token = os.environ.get("HF_TOKEN")
    projects_root = Path(os.environ.get("LOOPIT_PROJECTS", ".loopit/projects"))
    if not token:
        raise ValueError(
            "HF_TOKEN is required — this is not an environment where an offline "
            "model factory can be used."
        )
    factory = live_model_factory(
        base_url=os.environ.get("HF_BASE_URL", "https://router.huggingface.co"),
        bill_to=os.environ.get("HF_BILL_TO"),
        token=token,
    )
    return create_app(
        projects_root=projects_root,
        model_factory=factory,
        execution_mode=os.environ.get("LOOPIT_RUN_EXECUTION_MODE") or "orchestrator",
    )


__all__ = [
    "CREDENTIAL_REF",
    "StartRunBody",
    "build_default_app",
    "create_app",
    "live_model_factory",
    "offline_model_factory",
]
