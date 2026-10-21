"""Real eval executor wiring scheduler, sandbox runtime, agent loop, and verify.

The harness keeps refusing to invent outcomes: this module only reports checks
that were produced by an actual model loop and an actual workspace transport.
When a live model, sandbox runtime, or provider bridge is absent it raises
``InfrastructureUnavailable`` so callers can skip or fail honestly.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import time
import uuid
from base64 import b64decode, b64encode
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from loopit_agent_core.audit import InMemoryAuditSink
from loopit_agent_core.budget import Budget
from loopit_agent_core.config import require_secret
from loopit_agent_core.loop import AgentLoop, LoopResult, format_tool_catalogue
from loopit_agent_core.model import Difficulty, ModelClient
from loopit_checkpoint import Checkpoint, CheckpointStore, InMemoryBlobStore
from loopit_sandbox_sdk import Envelope, derive_lease_signing_key, sign
from loopit_scheduler.factory import SchedulerSettings, create_scheduler
from loopit_scheduler.scheduler import Assignment, Scheduler
from loopit_tools import AuditContext, RemoteWorkspace, WorkspaceTransport, default_registry
from loopit_verify.checks import Check, Level
from loopit_verify.pipeline import VerificationPipeline
from loopit_verify.reflection import verification_hook
from loopit_verify.runner import CommandOutput, CommandRunner

from .runner import Attempt
from .scoring import CheckResult as EvalCheckResult
from .suite import Task

ROOT = Path(__file__).resolve().parents[4]
CRUD_SELF_CORRECTION_TAG = "phase1-exit-gate"


class InfrastructureUnavailable(RuntimeError):
    """The live executor lacks a required provider, model, or runtime bridge."""


@dataclass(frozen=True, slots=True)
class ExecutionMetrics:
    """Metrics required by the Phase 1 gate."""

    provider: str
    sandbox_id: str
    lease_id: str
    cold_start_seconds: float
    iterations: int
    tokens: int
    credits_spent: float
    checkpoint_id: str | None
    self_corrected: bool
    crud_success: bool
    checks: tuple[EvalCheckResult, ...]
    loop_outcome: str


@runtime_checkable
class WorkspaceFactory(Protocol):
    def __call__(
        self, assignment: Assignment, *, tenant_id: str, run_id: str
    ) -> WorkspaceTransport:
        """Create a workspace transport bound to the assigned sandbox."""


TaskSeeder = Callable[[Task, WorkspaceTransport], None]
ModelFactory = Callable[[str, str, str], ModelClient]


class WorkspaceCommandRunner(CommandRunner):
    """Run verification commands through the sandbox workspace transport."""

    def __init__(self, workspace: WorkspaceTransport) -> None:
        self._workspace = workspace

    def run(self, command: tuple[str, ...], *, timeout_seconds: int) -> CommandOutput:
        rendered = " ".join(shlex.quote(part) for part in command)
        result = self._workspace.run_shell(
            rendered, cwd=".", timeout_seconds=timeout_seconds, output_bytes=16_000
        )
        return CommandOutput(
            exit_code=result.exit_code if result.exit_code is not None else 124,
            stdout=result.stdout,
            stderr=result.stderr,
            duration_ms=int(result.duration_seconds * 1000),
            timed_out=result.timed_out,
        )


@dataclass(slots=True)
class JsonLineRuntimeClient:
    """RemoteWorkspaceClient for ``loopit_agent_runtime`` JSON-lines stdio."""

    process: subprocess.Popen[str]
    signing_key: bytes

    def send(self, envelope: Envelope) -> Mapping[str, Any]:
        from loopit_agent_runtime.serde import envelope_from_dict, envelope_to_dict

        if self.process.stdin is None or self.process.stdout is None:
            raise InfrastructureUnavailable("sandbox runtime stdio is not available")
        # The control plane signs every instruction; the runtime refuses
        # unsigned envelopes.
        signed = sign(envelope, self.signing_key)
        self.process.stdin.write(json.dumps(envelope_to_dict(signed), sort_keys=True) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise InfrastructureUnavailable("sandbox runtime closed the signed channel")
        response = envelope_from_dict(json.loads(line))
        payload = response.args
        if not bool(payload.get("ok", False)):
            error = payload.get("error", {})
            message = error.get("message") if isinstance(error, Mapping) else None
            return {"output": f"runtime REJECTED: {message or error}", "detail": {"ok": False}}
        result = payload.get("result", {})
        if not isinstance(result, Mapping):
            result = {}
        return _runtime_result_to_workspace_response(envelope.tool, result)

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()


@dataclass(frozen=True, slots=True)
class DockerRuntimeWorkspaceFactory:
    """Start the signed in-VM runtime in a DockerProvider sandbox via ``docker exec``."""

    root_signing_key: bytes
    workspace: str = "/workspace"

    def __call__(self, assignment: Assignment, *, tenant_id: str, run_id: str) -> RemoteWorkspace:
        docker = shutil.which("docker")
        if docker is None:
            raise InfrastructureUnavailable("docker CLI is not available for sandbox runtime exec")
        container_id = assignment.sandbox.sandbox_id.removeprefix("docker_")
        signing_key = b64encode(derive_lease_signing_key(self.root_signing_key, assignment.lease))
        env = {
            "LOOPIT_SANDBOX_SIGNING_KEY": signing_key.decode("ascii"),
            "LOOPIT_LEASE_ID": assignment.lease.lease_id,
            "LOOPIT_TENANT_ID": tenant_id,
            "LOOPIT_RUN_ID": run_id,
            "LOOPIT_BASE_CHECKPOINT_ID": assignment.lease.base_checkpoint_id,
            "LOOPIT_LEASE_EXPIRES_AT": assignment.lease.expires_at.isoformat(),
        }
        command = [docker, "exec", "-i"]
        for key, value in env.items():
            command += ["-e", f"{key}={value}"]
        command += [
            container_id,
            "python",
            "-m",
            "loopit_agent_runtime",
            "--workspace",
            self.workspace,
        ]
        process = subprocess.Popen(  # noqa: S603 - operator-selected live sandbox bridge.
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return RemoteWorkspace(
            lease=assignment.lease,
            tenant_id=tenant_id,
            run_id=run_id,
            signing_key=signing_key,
            client=JsonLineRuntimeClient(process, signing_key=b64decode(signing_key)),
        )


@dataclass(slots=True)
class RealTaskExecutor:
    """Execute eval tasks with the real scheduler/runtime/model/verify stack."""

    scheduler: Scheduler
    model_factory: ModelFactory
    workspace_factory: WorkspaceFactory
    provider: str
    checkpoint_store: CheckpointStore = field(
        default_factory=lambda: CheckpointStore(InMemoryBlobStore())
    )
    audit: InMemoryAuditSink = field(default_factory=InMemoryAuditSink)
    seeder: TaskSeeder | None = None
    tenant_id: str = "eval-tenant"
    project_id: str = "eval-project"
    difficulty: Difficulty = "implementation"
    last_metrics: ExecutionMetrics | None = None

    @classmethod
    def from_env(cls, *, provider: str | None = None) -> RealTaskExecutor:
        settings = SchedulerSettings.from_env()
        if provider is not None:
            settings = SchedulerSettings(
                provider=provider,
                e2b_template_id=settings.e2b_template_id,
                docker_image=settings.docker_image,
                docker_network=settings.docker_network,
                pool_target_size=settings.pool_target_size,
                pool_max_live=settings.pool_max_live,
                pool_max_idle_seconds=settings.pool_max_idle_seconds,
                tenant_concurrency=settings.tenant_concurrency,
                caps=settings.caps,
            )
        audit = InMemoryAuditSink()
        scheduler = create_scheduler(audit=audit, settings=settings)
        workspace_factory = _workspace_factory_for(settings.provider)
        return cls(
            scheduler=scheduler,
            model_factory=router_model_factory_from_env,
            workspace_factory=workspace_factory,
            provider=settings.provider,
            audit=audit,
            seeder=seed_phase1_crud_task,
        )

    def execute(self, task: Task) -> Attempt:
        run_id = f"eval_{uuid.uuid4().hex[:12]}"
        started = time.monotonic()
        base = self.checkpoint_store.snapshot(
            project_id=self.project_id,
            tenant_id=self.tenant_id,
            files={},
            verified=True,
            label="empty eval base",
        )
        assignment: Assignment | None = None
        workspace: WorkspaceTransport | None = None
        try:
            cold_start_started = time.monotonic()
            assignment = self.scheduler.acquire(
                tenant_id=self.tenant_id,
                run_id=run_id,
                project_id=self.project_id,
                base_checkpoint_id=base.checkpoint_id,
                ttl_seconds=task.max_wall_clock_seconds,
                allowed_tools=frozenset(
                    {"read_file", "search_code", "apply_patch", "run_shell", "browser"}
                ),
            )
            cold_start_seconds = time.monotonic() - cold_start_started
            workspace = self.workspace_factory(assignment, tenant_id=self.tenant_id, run_id=run_id)
            if self.seeder is not None:
                self.seeder(task, workspace)

            runner = WorkspaceCommandRunner(workspace)
            pipeline = VerificationPipeline(
                _checks_for(task),
                runner,
                audit=self.audit,
                max_level=Level.L2_RUNTIME,
            )
            registry = default_registry(
                workspace,
                audit=self.audit,
                audit_context=AuditContext(
                    tenant_id=self.tenant_id,
                    project_id=self.project_id,
                    run_id=run_id,
                    task_id=task.task_id,
                    sandbox_lease_id=assignment.lease.lease_id,
                ),
            )
            model = self.model_factory(self.tenant_id, run_id, task.task_id)
            loop = AgentLoop(
                model=model,
                executor=registry,
                audit=self.audit,
                tenant_id=self.tenant_id,
                project_id=self.project_id,
                run_id=run_id,
                task_id=task.task_id,
                budget=Budget(
                    max_iterations=12, max_wall_clock_seconds=task.max_wall_clock_seconds
                ),
                verify=verification_hook(
                    pipeline, tenant_id=self.tenant_id, run_id=run_id, project_id=self.project_id
                ),
                difficulty=self.difficulty,
            )
            loop_result = loop.run(_system_prompt(registry.tool_names), _task_goal(task))
            final_report = pipeline.run(
                tenant_id=self.tenant_id, run_id=run_id, project_id=self.project_id
            )
            checks = tuple(
                EvalCheckResult(result.name, result.passed, result.observation())
                for result in final_report.results
            )
            crud_success = final_report.passed
            self_corrected = _self_corrected(loop_result)
            checkpoint = (
                self._capture_checkpoint(
                    workspace,
                    parent_id=base.checkpoint_id,
                    verified=True,
                    label=f"{task.task_id} verified",
                )
                if crud_success
                else None
            )
            credits = float(loop_result.usage.get("credits", 0.0))
            tokens = int(loop_result.usage.get("tokens", 0))
            # Evals measure effort in gross turns: net (recovery-priced) plus
            # the refunded working turns, so iteration counts stay comparable
            # across the budget-accounting change.
            gross_iterations = loop_result.iterations + int(loop_result.usage.get("refunded_iterations", 0))
            self.last_metrics = ExecutionMetrics(
                provider=self.provider,
                sandbox_id=assignment.sandbox.sandbox_id,
                lease_id=assignment.lease.lease_id,
                cold_start_seconds=cold_start_seconds,
                iterations=gross_iterations,
                tokens=tokens,
                credits_spent=credits,
                checkpoint_id=checkpoint.checkpoint_id if checkpoint is not None else None,
                self_corrected=self_corrected,
                crud_success=crud_success,
                checks=checks,
                loop_outcome=loop_result.outcome.value,
            )
            return Attempt(
                checks=checks,
                credits_spent=credits,
                wall_clock_seconds=time.monotonic() - started,
                error=None if loop_result.succeeded else loop_result.summary,
            )
        except InfrastructureUnavailable:
            raise
        except Exception as exc:
            raise InfrastructureUnavailable(f"real executor could not complete: {exc}") from exc
        finally:
            if assignment is not None:
                self.scheduler.release(
                    assignment.lease.lease_id,
                    tenant_id=assignment.lease.tenant_id,
                    reason="eval_finished",
                )
            _close_workspace(workspace)

    def _capture_checkpoint(
        self,
        workspace: WorkspaceTransport,
        *,
        parent_id: str,
        verified: bool,
        label: str,
    ) -> Checkpoint:
        output, _ = workspace.list_files(".", max_entries=500)
        files: dict[str, bytes] = {}
        capture_errors: list[str] = []
        for path in _parse_file_listing(output):
            try:
                content, _ = workspace.read_file(path, max_bytes=1_000_000)
            except Exception as exc:
                capture_errors.append(f"{path}: {type(exc).__name__}: {exc}")
                continue
            files[path] = content.encode("utf-8", errors="replace")
        if capture_errors:
            files["CHECKPOINT_CAPTURE_ERRORS.txt"] = "\n".join(capture_errors).encode()
        if not files:
            files["CHECKPOINT_EMPTY.txt"] = b"No files could be captured from the sandbox.\n"
        return self.checkpoint_store.snapshot(
            project_id=self.project_id,
            tenant_id=self.tenant_id,
            files=files,
            parent_id=parent_id,
            verified=verified,
            label=label,
        )


def router_model_factory_from_env(tenant_id: str, run_id: str, task_id: str) -> ModelClient:
    """Build the live router-backed ModelClient, matching the smoke scripts."""
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise InfrastructureUnavailable("HF_TOKEN is not set; live model calls are unavailable")
    from loopit_router import (
        ModelRouter,
        OpenAICompatibleUpstream,
        QuotaLedger,
        RouterModelClient,
        TenantQuota,
        UpstreamEndpoint,
        huggingface_router_policy,
    )
    from loopit_router.upstream import StaticSecretResolver

    credential_ref = "secrets://models/hf-router"
    ledger = QuotaLedger()
    ledger.set_quota(
        TenantQuota(
            tenant_id=tenant_id,
            credit_limit=float(os.getenv("LOOPIT_EVAL_CREDIT_LIMIT", "5")),
        )
    )
    router = ModelRouter(
        policy=huggingface_router_policy(credential_ref),
        upstream=OpenAICompatibleUpstream(
            UpstreamEndpoint(
                base_url=os.getenv("LOOPIT_ROUTER_BASE_URL", "https://router.huggingface.co"),
                bill_to=os.getenv("HF_BILL_TO") or None,
                scale_up_timeout_s=600,
                max_attempts=3,
            )
        ),
        ledger=ledger,
        secrets=StaticSecretResolver({credential_ref: token}),
        audit=InMemoryAuditSink(),
    )
    return RouterModelClient(router, tenant_id=tenant_id, run_id=run_id, task_id=task_id)


def seed_phase1_crud_task(task: Task, workspace: WorkspaceTransport) -> None:
    """Scaffold the React/Postgres template and introduce the browser-visible bug."""
    if CRUD_SELF_CORRECTION_TAG not in task.tags:
        return
    commands = [
        _python_command(
            """
from pathlib import Path
Path("README.eval.md").write_text("Phase 1 CRUD self-correction eval\\n")
"""
        ),
        _python_command(
            """
from pathlib import Path
import shutil

src = Path("/opt/loopit/stack-templates/react-postgres")
if not src.exists():
    raise SystemExit(f"react-postgres template missing in sandbox image at {src}")
for child in src.iterdir():
    if child.name == "node_modules":
        continue
    dest = Path(child.name)
    if child.is_dir():
        shutil.copytree(child, dest, dirs_exist_ok=True)
    elif child.is_file():
        shutil.copy2(child, dest)
"""
        ),
        _python_command(
            """
from pathlib import Path

path = Path("src/client/App.tsx")
text = path.read_text()
bug = "// BUG: create succeeds but the read-back list is not refreshed.\\n  };"
path.write_text(text.replace("await refresh();\\n  };", bug, 1))
"""
        ),
        _python_command(
            """
from pathlib import Path

Path("tests/e2e").mkdir(parents=True, exist_ok=True)
Path("tests/e2e/create-read-back.spec.ts").write_text(
    "import { test, expect } from '@playwright/test';\\n\\n"
    "test('create then read back task', async ({ page }) => {\\n"
    "  await page.goto('/');\\n"
    "  await page.getByLabel('New task').fill('buy milk');\\n"
    "  await page.getByRole('button', { name: 'Add' }).click();\\n"
    "  await expect(page.getByText('buy milk')).toBeVisible();\\n"
    "});\\n"
)
"""
        ),
    ]
    for command in commands:
        result = workspace.run_shell(command, cwd=".", timeout_seconds=60, output_bytes=16_000)
        if not result.ok:
            raise InfrastructureUnavailable(result.render())


def _checks_for(task: Task) -> tuple[Check, ...]:
    checks: list[Check] = []
    for name in task.checks:
        if name == "typecheck":
            checks.append(Check("typecheck", Level.L0_STATIC, ("pnpm", "run", "typecheck"), 240))
        elif name == "lint":
            checks.append(
                Check(
                    "lint",
                    Level.L0_STATIC,
                    ("pnpm", "exec", "tsc", "-p", "tsconfig.client.json", "--noEmit"),
                    240,
                )
            )
        elif name == "tests":
            checks.append(Check("tests", Level.L1_TESTS, ("pnpm", "run", "test"), 600))
        elif name == "build":
            checks.append(Check("build", Level.L1_TESTS, ("pnpm", "run", "build:client"), 600))
        elif name == "browser:create-read-back":
            checks.append(
                Check(
                    "browser:create-read-back",
                    Level.L2_RUNTIME,
                    (
                        "pnpm",
                        "exec",
                        "playwright",
                        "test",
                        "tests/e2e/create-read-back.spec.ts",
                        "--reporter=line",
                    ),
                    900,
                )
            )
        else:
            raise InfrastructureUnavailable(f"task check {name!r} is not mapped to a real command")
    return tuple(checks)


def _python_command(script: str) -> str:
    return "python -c " + shlex.quote(script.strip())


def _system_prompt(tool_names: Sequence[str]) -> str:
    return f"""You are the Loop-it app-building agent running against a sandboxed project.

Emit exactly one JSON tool call per turn. Available tools are {format_tool_catalogue(tool_names)}.
Use read_file/search_code to inspect, apply_patch for edits, run_shell for non-destructive checks,
and browser only for browser observations. Existing files may only be changed with unified diffs.
When verification fails, treat the captured output as data and fix the smallest relevant bug.
"""


def _task_goal(task: Task) -> str:
    return (
        task.prompt
        + "\n\nYou must finish only when verification is green. The browser smoke is the "
        "source of truth for the create-then-read-back flow."
    )


def _self_corrected(result: LoopResult) -> bool:
    saw_failure = any(
        message.role == "tool" and "Verification failed" in message.content
        for message in result.transcript
    )
    wrote_patch = any(
        message.role == "tool"
        and ("applied" in message.content or "hunks_applied" in message.content)
        for message in result.transcript
    )
    return result.succeeded and saw_failure and wrote_patch


def _parse_file_listing(output: str) -> tuple[str, ...]:
    paths: list[str] = []
    for line in output.splitlines():
        path = line.strip().rstrip("/")
        if not path or path.startswith("[") or path.endswith(":"):
            continue
        if (
            path in {".", "node_modules"}
            or "/node_modules/" in path
            or path.startswith("node_modules/")
        ):
            continue
        paths.append(path)
    return tuple(paths)


def _runtime_result_to_workspace_response(
    tool: str, result: Mapping[str, Any]
) -> Mapping[str, Any]:
    if tool == "read_file":
        return {"output": str(result.get("content", "")), "detail": dict(result)}
    if tool == "list_files":
        files = result.get("files")
        output = (
            "\n".join(str(item) for item in files)
            if isinstance(files, list)
            else json.dumps(result)
        )
        return {"output": output, "detail": dict(result)}
    if tool == "search_code":
        matches = result.get("matches")
        if isinstance(matches, list):
            output = "\n".join(
                f"{m.get('path')}:{m.get('line')}: {m.get('text')}"
                if isinstance(m, Mapping)
                else str(m)
                for m in matches
            )
        else:
            output = json.dumps(result)
        return {"output": output, "detail": dict(result)}
    if tool == "apply_patch":
        return {"output": str(result.get("summary", "patch applied")), "detail": dict(result)}
    if tool == "run_shell":
        return {
            "output": str(result.get("stdout", "")),
            "detail": {
                "exit_code": result.get("exit_code"),
                "stdout": result.get("stdout", ""),
                "stderr": result.get("stderr", ""),
                "timed_out": result.get("timed_out", False),
                "duration_seconds": result.get("duration_seconds", 0.0),
                "truncated": result.get("output_truncated", False),
            },
        }
    if tool == "browser":
        return {
            "output": json.dumps(result, sort_keys=True),
            "detail": {"ok": result.get("healthy", False), **dict(result)},
        }
    return {"output": json.dumps(result, sort_keys=True), "detail": dict(result)}


def _workspace_factory_for(provider: str) -> WorkspaceFactory:
    if provider in {"memory", "inmemory", "in-memory"}:
        raise InfrastructureUnavailable(
            "the real eval executor refuses the in-memory provider; choose docker or e2b"
        )
    if provider == "docker":
        root_key = require_secret(os.environ, "LOOPIT_SANDBOX_SIGNING_KEY").encode("utf-8")
        return DockerRuntimeWorkspaceFactory(root_signing_key=root_key)
    if provider == "e2b":
        raise InfrastructureUnavailable(
            "E2B runtime attachment is not configured in this repository yet; provide a "
            "WorkspaceFactory that starts loopit_agent_runtime inside the E2B template"
        )
    raise InfrastructureUnavailable(f"unknown sandbox provider {provider!r}")


def _close_workspace(workspace: WorkspaceTransport | None) -> None:
    if workspace is None or not isinstance(workspace, RemoteWorkspace):
        return
    close = getattr(workspace.client, "close", None)
    if callable(close):
        close()
