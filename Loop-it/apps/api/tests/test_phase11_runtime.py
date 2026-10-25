"""Phase 1.1–1.2: orchestrator get_run enrichment, lease client, sandbox prompts."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from loopit_orchestrator.types import RunStatus

from loopit_api.app import create_app, offline_model_factory
from loopit_api.persist import load_run_meta, write_run_meta_fields
from loopit_api.runs import SANDBOX_SYSTEM_PROMPT, SYSTEM_PROMPT, system_prompt_for
from loopit_api.scheduler_client import LeaseHandle, SchedulerClient


def _workflow_status(run_id: str, *, project_id: str = "proj_1") -> Any:
    status = MagicMock()
    status.run_id = run_id
    status.project_id = project_id
    status.status = RunStatus.RUNNING
    status.iterations = 2
    status.tokens = 10
    status.credits = 0.01
    status.summary = "working"
    status.checkpoint_id = "cp_workflow"
    status.gate = None
    status.started_at = None
    status.finished_at = None
    return status


class _FakeOrchestrator:
    def __init__(self, statuses: dict[str, Any]) -> None:
        self.statuses = statuses

    async def get(self, run_id: str) -> Any:
        return self.statuses[run_id]

    async def start(self, request: Any) -> Any:
        raise AssertionError("start not used in these tests")


class TestSystemPromptSandboxSplit:
    def test_local_prompt_still_forbids_shell(self) -> None:
        assert "no shell" in SYSTEM_PROMPT
        assert system_prompt_for(shell_enabled=False) is SYSTEM_PROMPT

    def test_sandbox_prompt_lists_shell_tools(self) -> None:
        prompt = system_prompt_for(shell_enabled=True)
        assert prompt is SANDBOX_SYSTEM_PROMPT
        for tool in ("run_shell", "install_package", "start_dev_server", "read_logs"):
            assert tool in prompt


class TestOrchestratorGetRunEnrichment:
    def test_get_run_returns_files_and_checkpoints_from_store(self, tmp_path: Path) -> None:
        projects = tmp_path / "projects"
        projects.mkdir()
        # Seed a project workspace on disk so enrichment finds files.
        project_dir = projects / "org_1" / "proj_1"
        project_dir.mkdir(parents=True)
        (project_dir / "index.html").write_text("<html></html>", encoding="utf-8")

        orchestrator = _FakeOrchestrator(
            {"run_orch": _workflow_status("run_orch", project_id="proj_1")}
        )
        app = create_app(
            projects_root=projects,
            model_factory=offline_model_factory(),
            execution_mode="orchestrator",
            orchestrator_client=cast(Any, orchestrator),
        )
        cast(Any, app).state.temporal_runs["run_orch"] = {
            "tenant_id": "org_1",
            "actor_id": "owner",
            "prompt": "build a page",
            "stack": "react",
            "tier": "standard",
            "project_id": "proj_1",
        }
        # Ensure project_tenant can resolve via project_store or disk.
        manager = cast(Any, app).state.run_manager
        manager.project("proj_1", tenant_id="org_1")

        token = cast(Any, app).state.identity_signer.mint_identity(
            subject="owner", org_id="org_1", role="owner", scopes=("api",)
        )
        client = TestClient(app)
        response = client.get(
            "/api/runs/run_orch",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        body = response.json()
        assert "index.html" in body.get("files", [])
        assert isinstance(body.get("checkpoints"), list)
        # Workflow checkpoint id is surfaced when not already listed.
        assert any(
            str(item.get("checkpoint_id")) == "cp_workflow" for item in body["checkpoints"]
        )

    def test_orchestrator_meta_sidecar_survives_missing_temporal_runs(
        self, tmp_path: Path
    ) -> None:
        projects = tmp_path / "projects"
        projects.mkdir()
        write_run_meta_fields(
            projects,
            "run_meta",
            {
                "execution_mode": "orchestrator",
                "tenant_id": "org_1",
                "project_id": "proj_meta",
                "prompt": "hello",
                "stack": "react",
            },
        )
        assert load_run_meta(projects, "run_meta")["execution_mode"] == "orchestrator"

        orchestrator = _FakeOrchestrator(
            {"run_meta": _workflow_status("run_meta", project_id="proj_meta")}
        )
        app = create_app(
            projects_root=projects,
            model_factory=offline_model_factory(),
            execution_mode="orchestrator",
            orchestrator_client=cast(Any, orchestrator),
        )
        # Intentionally leave temporal_runs empty — rehydrate from sidecar.
        token = cast(Any, app).state.identity_signer.mint_identity(
            subject="owner", org_id="org_1", role="owner", scopes=("api",)
        )
        client = TestClient(app)
        response = client.get(
            "/api/runs/run_meta",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        assert response.json()["project_id"] == "proj_meta"

    def test_a_finished_orchestrator_run_is_not_listed_as_running(self, tmp_path: Path) -> None:
        from loopit_api.persist import persist_run_started

        projects = tmp_path / "projects"
        projects.mkdir()
        failed = _workflow_status("run_err", project_id="proj_err")
        failed.status = RunStatus.FAILED
        failed.summary = "ActivityError: dispatch failed"
        orchestrator = _FakeOrchestrator({"run_err": failed})
        app = create_app(
            projects_root=projects,
            model_factory=offline_model_factory(),
            execution_mode="orchestrator",
            orchestrator_client=cast(Any, orchestrator),
        )
        persist_run_started(
            projects=cast(Any, app).state.project_store,
            runs=cast(Any, app).state.run_store,
            tenant_id="org_1",
            owner_user_id="owner",
            project_id="proj_err",
            run_id="run_err",
            prompt="A single page that says Audit ready.",
            stack="react",
            max_iterations=1,
            difficulty="implementation",
        )
        cast(Any, app).state.temporal_runs["run_err"] = {
            "execution_mode": "orchestrator",
            "tenant_id": "org_1",
            "project_id": "proj_err",
            "prompt": "A single page that says Audit ready.",
            "stack": "react",
        }
        token = cast(Any, app).state.identity_signer.mint_identity(
            subject="owner", org_id="org_1", role="owner", scopes=("api",)
        )
        client = TestClient(app)
        response = client.get("/api/runs", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 200
        row = next(item for item in response.json() if item["run_id"] == "run_err")
        assert row["status"] in {"error", "failed"}


class TestProjectLeaseLocalMode:
    def test_lease_endpoint_reports_local_without_scheduler(self, tmp_path: Path) -> None:
        projects = tmp_path / "projects"
        app = create_app(
            projects_root=projects,
            model_factory=offline_model_factory(),
            execution_mode="local",
        )
        # Create a project via a local run so project_tenant resolves.
        token = cast(Any, app).state.identity_signer.mint_identity(
            subject="owner", org_id="org_1", role="owner", scopes=("api", "build:terminal")
        )
        client = TestClient(app)
        started = client.post(
            "/api/runs",
            json={"prompt": "hi", "stack": "react"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert started.status_code == 200
        project_id = started.json()["project_id"]
        lease = client.get(
            f"/api/projects/{project_id}/lease",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert lease.status_code == 200
        assert lease.json()["mode"] == "local"
        assert lease.json()["lease"] is None


class TestSchedulerClientEnsure:
    def test_ensure_reuses_existing_lease(self) -> None:
        client = SchedulerClient("http://scheduler.test", service_token="tok")
        existing = LeaseHandle(
            lease_id="lease_1",
            lease_token="t1",
            sandbox_id="sbx_1",
            project_id="proj_1",
            expires_at="2099-01-01T00:00:00+00:00",
            allowed_tools=("run_shell",),
        )
        renewed = LeaseHandle(
            lease_id="lease_1",
            lease_token="t2",
            sandbox_id="sbx_1",
            project_id="proj_1",
            expires_at="2099-01-01T01:00:00+00:00",
            allowed_tools=("run_shell",),
        )
        client.find_project_lease = MagicMock(return_value=existing)  # type: ignore[method-assign]
        client.renew = MagicMock(return_value=renewed)  # type: ignore[method-assign]
        client.acquire = MagicMock()  # type: ignore[method-assign]

        handle = client.ensure_project_lease(tenant_id="org_1", project_id="proj_1")
        assert handle.lease_token == "t2"
        client.renew.assert_called_once()
        client.acquire.assert_not_called()
