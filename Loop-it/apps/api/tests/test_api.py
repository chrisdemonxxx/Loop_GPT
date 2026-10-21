"""Tests for the local preview API (apps/api).

Weighted towards the two things a preview can quietly get wrong: reaching
outside the workspace, and executing model-authored code on the host.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient
from loopit_agent_core.config import SecretConfigurationError
from loopit_agent_core.reflection import VerificationVerdict
from loopit_agent_core.tools import ToolCall
from loopit_api.app import create_app, live_model_factory, offline_model_factory
from loopit_api.runs import PreviewVerifier
from loopit_api.stacks import MODULE_CDN, REACT_VERSION
from loopit_api.workspace import Workspace, WorkspaceError, resolve_in_workspace
from loopit_orchestrator.types import GateRequest, RunStatus, WorkflowStatus

IDENTITY_SECRET = "api-identity-secret-with-at-least-thirty-two-bytes"
PREVIEW_SECRET = "api-preview-secret-with-at-least-thirty-two-bytes"


@pytest.fixture(autouse=True)
def api_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", IDENTITY_SECRET)
    monkeypatch.setenv("LOOPIT_PREVIEW_SIGNING_KEY", PREVIEW_SECRET)


@dataclass(frozen=True)
class _Observed:
    """The shape the verifier reads: an observation is duck-typed by `.content`."""

    content: str


class _FakeOrchestrator:
    def __init__(self, statuses: dict[str, WorkflowStatus]) -> None:
        self.statuses = statuses
        self.approvals: list[tuple[str, str, str, str]] = []
        self.rejections: list[tuple[str, str, str]] = []

    async def get(self, run_id: str) -> WorkflowStatus:
        return self.statuses[run_id]

    async def approve(self, run_id: str, signal: Any) -> None:
        self.approvals.append((run_id, signal.gate_id, signal.actor_id, signal.reason))

    async def reject(self, run_id: str, gate_id: str, *, actor_id: str, reason: str = "") -> None:
        self.rejections.append((run_id, gate_id, actor_id))


def _gate(gate_id: str = "gate_pending", *, expires_at: str | None = None) -> GateRequest:
    return GateRequest(
        gate_id=gate_id,
        tool="deploy",
        args={"target": "managed", "environment": "prod"},
        reason="destructive deploy",
        requested_at="2026-09-03T10:00:00+00:00",
        args_hash="hash",
        expires_at=expires_at or "2099-01-01T00:00:00+00:00",
    )


def _workflow_status(
    run_id: str,
    *,
    status: RunStatus = RunStatus.AWAITING_APPROVAL,
    gate: GateRequest | None = None,
) -> WorkflowStatus:
    return WorkflowStatus(
        run_id=run_id,
        project_id="proj_1",
        status=status,
        gate=gate if gate is not None else _gate(),
    )


@pytest.fixture()
def workspace(tmp_path: Path) -> Workspace:
    return Workspace(root=tmp_path / "project")


class TestContainment:
    def test_a_relative_path_resolves_inside(self, workspace: Workspace) -> None:
        target = resolve_in_workspace(workspace.root, "src/app.py")
        assert workspace.root in target.parents

    @pytest.mark.parametrize(
        "candidate",
        ["../secrets.env", "../../.ssh/id_rsa", "src/../../escape.txt", "~/notes.txt"],
    )
    def test_traversal_is_refused(self, workspace: Workspace, candidate: str) -> None:
        # Tool arguments are model-authored strings; traversal is an ordinary
        # input, not an attack requiring ingenuity.
        with pytest.raises(WorkspaceError):
            resolve_in_workspace(workspace.root, candidate)

    def test_an_absolute_path_is_refused(self, workspace: Workspace) -> None:
        with pytest.raises(WorkspaceError, match="project-relative"):
            resolve_in_workspace(workspace.root, str(Path.cwd()))

    def test_a_symlink_out_of_the_workspace_is_refused(
        self, workspace: Workspace, tmp_path: Path
    ) -> None:
        # A prefix check on the *unresolved* path would pass this.
        outside = tmp_path / "outside"
        outside.mkdir()
        link = workspace.root / "escape"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            pytest.skip("symlinks not permitted on this machine")
        with pytest.raises(WorkspaceError, match="outside"):
            resolve_in_workspace(workspace.root, "escape/loot.txt")

    def test_reading_a_missing_file_is_an_error_not_a_crash(self, workspace: Workspace) -> None:
        from loopit_agent_core.tools import ToolCall

        result = workspace.read_file(ToolCall(tool="read_file", args={"path": "nope.txt"}))
        assert not result.ok
        assert "no such file" in result.output


class TestExecutionIsImpossible:
    def test_run_shell_always_refuses(self, workspace: Workspace) -> None:
        from loopit_agent_core.tools import ToolCall

        result = workspace.run_shell(ToolCall(tool="run_shell", args={"command": "echo hi"}))
        assert not result.ok
        assert "I1" in result.output

    def test_the_refusal_does_not_fabricate_a_pass(self, workspace: Workspace) -> None:
        # Reporting "tests passed" here would make the preview lie about the one
        # thing the verification layers exist to establish.
        from loopit_agent_core.tools import ToolCall

        result = workspace.run_shell(ToolCall(tool="run_shell", args={"command": "pytest -q"}))
        assert "passed" not in result.output

    def test_there_is_no_way_to_turn_execution_on(self) -> None:
        # An invariant with a local-preview exemption is not an invariant, and
        # the repository's own I1 guard fails the build on a subprocess call in
        # a control-plane service. Checked by import rather than by scanning the
        # text, so the module can still explain itself in its docstring.
        import ast
        import inspect

        from loopit_api import workspace as module

        tree = ast.parse(inspect.getsource(module))
        imported = {
            alias.name.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        } | {
            node.module.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module
        }
        assert "subprocess" not in imported
        assert "os" not in imported


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    app = create_app(
        projects_root=tmp_path / "projects",
        model_factory=offline_model_factory(),
        offline=True,
    )
    test_client = TestClient(app)
    response = test_client.post(
        "/api/auth/register",
        json={
            "email": "owner@example.com",
            "password": "correct horse battery staple",
            "org_name": "Acme",
        },
    )
    token = response.json()["access_token"]
    test_client.headers.update({"Authorization": f"Bearer {token}"})
    return test_client


class TestApi:
    def test_health_declares_its_limitations(self, client: TestClient) -> None:
        body = client.get("/api/health").json()
        assert body["offline"] is True
        assert body["exec_enabled"] is False
        assert body["auth_required"] is True

    def test_auth_is_required_by_default(self, tmp_path: Path) -> None:
        app = create_app(
            projects_root=tmp_path / "projects",
            model_factory=offline_model_factory(),
            offline=True,
        )
        unauthenticated = TestClient(app)
        assert unauthenticated.get("/api/runs").status_code == 401

    def test_dev_single_tenant_escape_hatch_is_explicit(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LOOPIT_ENV", "dev")
        monkeypatch.setenv("LOOPIT_DEV_SINGLE_TENANT", "1")
        app = create_app(
            projects_root=tmp_path / "projects",
            model_factory=offline_model_factory(),
            offline=True,
        )
        dev_client = TestClient(app)
        assert dev_client.get("/api/health").json()["auth_required"] is False
        assert dev_client.get("/api/runs").status_code == 200

    @pytest.mark.parametrize(
        ("marker_name", "marker_value"),
        [
            ("LOOPIT_ENV", "prod"),
            ("LOOPIT_ENV", "test"),
            ("LOOPIT_ENV", "ci"),
            ("LOOPIT_ENV", ""),
            ("LOOPIT_PUBLIC_URL", "https://loopit.example.com"),
            ("LOOPIT_STORE_DSN", "postgresql://loopit@db.example.com:5432/loopit"),
            ("LOOPIT_STORE_DSN", "host=db.example.com user=loopit dbname=loopit"),
            ("LOOPIT_STORE_DSN", "postgresql:///loopit"),
        ],
    )
    def test_dev_single_tenant_refuses_to_start_with_production_marker(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        marker_name: str,
        marker_value: str,
    ) -> None:
        monkeypatch.setenv("LOOPIT_ENV", "dev")
        monkeypatch.setenv(marker_name, marker_value)
        monkeypatch.setenv("LOOPIT_DEV_SINGLE_TENANT", "1")

        with pytest.raises(RuntimeError, match="LOOPIT_DEV_SINGLE_TENANT"):
            app = create_app(
                projects_root=tmp_path / "projects",
                model_factory=offline_model_factory(),
                offline=True,
            )
            TestClient(app)

    @pytest.mark.parametrize("name", ["LOOPIT_IDENTITY_SECRET", "LOOPIT_PREVIEW_SIGNING_KEY"])
    @pytest.mark.parametrize("bad_value", [None, "too-short", "dev-api-key-change-me"])
    def test_create_app_rejects_missing_short_or_placeholder_secrets(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, bad_value: str | None
    ) -> None:
        if bad_value is None:
            monkeypatch.delenv(name)
        else:
            monkeypatch.setenv(name, bad_value)

        with pytest.raises(SecretConfigurationError):
            create_app(
                projects_root=tmp_path / "projects",
                model_factory=offline_model_factory(),
                offline=True,
            )

    def test_auth_routes_register_login_me_and_orgs(self, client: TestClient) -> None:
        me = client.get("/api/auth/me").json()
        assert me["email"] == "owner@example.com"
        orgs = client.get("/api/auth/orgs").json()
        assert orgs[0]["role"] == "owner"
        login = client.post(
            "/api/auth/login",
            json={
                "email": "owner@example.com",
                "password": "correct horse battery staple",
                "org_id": orgs[0]["org_id"],
            },
        )
        assert login.status_code == 200
        assert client.post("/api/auth/logout").status_code == 200

    def test_external_idp_disables_local_register_and_login(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LOOPIT_EXTERNAL_IDP", "1")
        app = create_app(
            projects_root=tmp_path / "projects",
            model_factory=offline_model_factory(),
            offline=True,
        )
        guest = TestClient(app)
        register = guest.post(
            "/api/auth/register",
            json={
                "email": "external@example.com",
                "password": "correct horse battery staple",
                "org_name": "External",
            },
        )
        login = guest.post(
            "/api/auth/login",
            json={
                "email": "external@example.com",
                "password": "correct horse battery staple",
                "org_id": "org_any",
            },
        )
        assert register.status_code == 403
        assert login.status_code == 403
        assert "Loop-GPT" in register.json()["detail"]
        assert register.json()["detail"] == login.json()["detail"]

    def test_bad_login_is_401(self, client: TestClient) -> None:
        org_id = client.get("/api/auth/me").json()["org_id"]
        response = client.post(
            "/api/auth/login",
            json={"email": "owner@example.com", "password": "wrong-password", "org_id": org_id},
        )
        assert response.status_code == 401

    def test_viewer_cannot_start_runs(self, client: TestClient) -> None:
        me = client.get("/api/auth/me").json()
        app = cast(Any, client.app)
        token = app.state.identity_signer.mint_identity(
            subject=me["user_id"],
            org_id=me["org_id"],
            role="viewer",
            scopes=("api",),
        )
        response = client.post(
            "/api/runs",
            json={"prompt": "build a page"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 403

    def test_cross_org_run_read_is_denied(self, tmp_path: Path) -> None:
        app = create_app(
            projects_root=tmp_path / "projects",
            model_factory=offline_model_factory(),
            offline=True,
        )
        acme = TestClient(app)
        acme_token = acme.post(
            "/api/auth/register",
            json={"email": "a@example.com", "password": "password-123", "org_name": "Acme"},
        ).json()["access_token"]
        acme.headers.update({"Authorization": f"Bearer {acme_token}"})
        run_id = acme.post("/api/runs", json={"prompt": "build a page"}).json()["run_id"]

        other = TestClient(app)
        other_token = other.post(
            "/api/auth/register",
            json={"email": "b@example.com", "password": "password-456", "org_name": "Other"},
        ).json()["access_token"]
        other.headers.update({"Authorization": f"Bearer {other_token}"})
        assert other.get(f"/api/runs/{run_id}").status_code == 403

    def test_a_run_starts_and_finishes(self, client: TestClient) -> None:
        run_id = client.post("/api/runs", json={"prompt": "build a page"}).json()["run_id"]
        for _ in range(100):
            body = client.get(f"/api/runs/{run_id}").json()
            if body["status"] != "running":
                break
            time.sleep(0.05)
        assert body["status"] != "running"
        assert "offline.html" in body["files"]

    def test_the_file_the_run_wrote_can_be_read_back(self, client: TestClient) -> None:
        run_id = client.post("/api/runs", json={"prompt": "build a page"}).json()["run_id"]
        for _ in range(100):
            if client.get(f"/api/runs/{run_id}").json()["status"] != "running":
                break
            time.sleep(0.05)
        body = client.get(f"/api/runs/{run_id}/file", params={"path": "offline.html"}).json()
        assert "Offline preview" in body["content"]

    def test_traversal_through_the_api_is_a_404(self, client: TestClient) -> None:
        # 404 rather than 400: a caller must not distinguish a malformed path
        # from one that exists but is out of bounds.
        run_id = client.post("/api/runs", json={"prompt": "x"}).json()["run_id"]
        response = client.get(f"/api/runs/{run_id}/file", params={"path": "../../pyproject.toml"})
        assert response.status_code == 404

    def test_an_unknown_run_is_a_404(self, client: TestClient) -> None:
        assert client.get("/api/runs/run_nope").status_code == 404
        assert client.get("/api/runs/run_nope/events").status_code == 404

    def test_an_empty_prompt_is_refused(self, client: TestClient) -> None:
        assert client.post("/api/runs", json={"prompt": ""}).status_code == 422

    def test_starting_a_run_persists_project_and_run_rows(self, client: TestClient) -> None:
        body = client.post("/api/runs", json={"prompt": "build a page"}).json()
        store = client.app.state.run_store
        projects = client.app.state.project_store
        tenant_id = client.get("/api/auth/me").json()["org_id"]
        record = store.get(body["run_id"], tenant_id=tenant_id)
        assert record is not None
        assert record.project_id == body["project_id"]
        assert record.status in {"queued", "running", "succeeded", "failed"}
        assert projects.get(body["project_id"], tenant_id=tenant_id) is not None
        listed = {item["run_id"] for item in client.get("/api/runs").json()}
        assert body["run_id"] in listed

    def test_the_event_stream_emits_audit_records(self, client: TestClient) -> None:
        run_id = client.post("/api/runs", json={"prompt": "build a page"}).json()["run_id"]
        with client.stream("GET", f"/api/runs/{run_id}/events") as response:
            assert response.status_code == 200
            payload = "".join(line for line in response.iter_lines())
        assert "task.started" in payload

    def test_new_run_integration_endpoints_match_web_contract(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        finished = _finish(client, run["run_id"])

        dag = client.get(f"/api/runs/{run['run_id']}/dag").json()
        assert dag["plan_id"]
        assert dag["nodes"][0]["dag_parents"] == []
        assert dag["nodes"][0]["expected_verification"]

        assert client.get(f"/api/runs/{run['run_id']}/gates").json() == []

        checkpoints = client.get(f"/api/projects/{run['project_id']}/checkpoints").json()
        assert checkpoints
        assert any(checkpoint["live"] for checkpoint in checkpoints)

        cost = client.get(f"/api/runs/{run['run_id']}/cost").json()
        assert cost["iterations"] == finished["iterations"]
        assert "credits_spent" in cost

    def test_gate_decisions_validate_payload_and_missing_gate(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        assert (
            client.post(f"/api/runs/{run['run_id']}/gates/g1/approve", json={}).status_code == 422
        )
        response = client.post(
            f"/api/runs/{run['run_id']}/gates/g1/reject",
            json={"reason": "not safe"},
        )
        assert response.status_code == 404

    def test_viewer_cannot_approve_or_reject_confirmation_gate(self, tmp_path: Path) -> None:
        orchestrator = _FakeOrchestrator({"run_approve": _workflow_status("run_approve")})
        app = create_app(
            projects_root=tmp_path / "projects",
            model_factory=offline_model_factory(),
            execution_mode="orchestrator",
            orchestrator_client=cast(Any, orchestrator),
        )
        cast(Any, app).state.temporal_runs["run_approve"] = {
            "tenant_id": "org_1",
            "actor_id": "owner",
            "prompt": "deploy",
            "stack": "react",
            "project_id": "proj_1",
        }
        token = cast(Any, app).state.identity_signer.mint_identity(
            subject="viewer", org_id="org_1", role="viewer", scopes=("api",)
        )
        readonly = TestClient(app)

        approve = readonly.post(
            "/api/runs/run_approve/gates/gate_pending/approve",
            json={"reason": "ship"},
            headers={"Authorization": f"Bearer {token}"},
        )
        reject = readonly.post(
            "/api/runs/run_approve/gates/gate_pending/reject",
            json={"reason": "stop"},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert approve.status_code == 403
        assert reject.status_code == 403
        assert orchestrator.approvals == []
        assert orchestrator.rejections == []

    def test_orchestrator_gate_decision_requires_pending_gate_on_that_run(
        self, tmp_path: Path
    ) -> None:
        orchestrator = _FakeOrchestrator(
            {
                "run_a": _workflow_status("run_a", gate=_gate("gate_a")),
                "run_b": _workflow_status("run_b", gate=_gate("gate_b")),
                "run_done": _workflow_status(
                    "run_done", status=RunStatus.SUCCEEDED, gate=_gate("gate_a")
                ),
            }
        )
        app = create_app(
            projects_root=tmp_path / "projects",
            model_factory=offline_model_factory(),
            execution_mode="orchestrator",
            orchestrator_client=cast(Any, orchestrator),
        )
        for run_id in orchestrator.statuses:
            cast(Any, app).state.temporal_runs[run_id] = {
                "tenant_id": "org_1",
                "actor_id": "owner",
                "prompt": "deploy",
                "stack": "react",
                "project_id": "proj_1",
            }
        token = cast(Any, app).state.identity_signer.mint_identity(
            subject="owner", org_id="org_1", role="owner", scopes=("api",)
        )
        owner = TestClient(app)
        headers = {"Authorization": f"Bearer {token}"}

        wrong_run = owner.post(
            "/api/runs/run_b/gates/gate_a/approve", json={"reason": "ship"}, headers=headers
        )
        not_pending = owner.post(
            "/api/runs/run_done/gates/gate_a/approve", json={"reason": "ship"}, headers=headers
        )

        assert wrong_run.status_code == 404
        assert not_pending.status_code == 404
        assert orchestrator.approvals == []

    def test_cross_tenant_and_expired_gate_approval_are_denied(self, tmp_path: Path) -> None:
        orchestrator = _FakeOrchestrator(
            {
                "run_tenant": _workflow_status("run_tenant"),
                "run_expired": _workflow_status(
                    "run_expired", gate=_gate(expires_at="2000-01-01T00:00:00+00:00")
                ),
            }
        )
        app = create_app(
            projects_root=tmp_path / "projects",
            model_factory=offline_model_factory(),
            execution_mode="orchestrator",
            orchestrator_client=cast(Any, orchestrator),
        )
        cast(Any, app).state.temporal_runs["run_tenant"] = {
            "tenant_id": "org_1",
            "actor_id": "owner",
            "prompt": "deploy",
            "stack": "react",
            "project_id": "proj_1",
        }
        cast(Any, app).state.temporal_runs["run_expired"] = {
            "tenant_id": "org_1",
            "actor_id": "owner",
            "prompt": "deploy",
            "stack": "react",
            "project_id": "proj_1",
        }
        other_token = cast(Any, app).state.identity_signer.mint_identity(
            subject="other", org_id="org_2", role="owner", scopes=("api",)
        )
        owner_token = cast(Any, app).state.identity_signer.mint_identity(
            subject="owner", org_id="org_1", role="owner", scopes=("api",)
        )
        api = TestClient(app)

        cross_tenant = api.post(
            "/api/runs/run_tenant/gates/gate_pending/approve",
            json={"reason": "ship"},
            headers={"Authorization": f"Bearer {other_token}"},
        )
        expired = api.post(
            "/api/runs/run_expired/gates/gate_pending/approve",
            json={"reason": "ship"},
            headers={"Authorization": f"Bearer {owner_token}"},
        )

        assert cross_tenant.status_code == 403
        assert expired.status_code == 410
        assert orchestrator.approvals == []

    def test_checkpoint_rollback_fork_and_preview_are_authenticated(
        self, client: TestClient
    ) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        checkpoints = client.get(f"/api/projects/{run['project_id']}/checkpoints").json()
        checkpoint_id = checkpoints[-1]["checkpoint_id"]

        assert client.get(f"/api/projects/{run['project_id']}/checkpoints").status_code == 200
        assert (
            client.post(
                f"/api/projects/{run['project_id']}/checkpoints/{checkpoint_id}/rollback",
                json={"confirmed": False},
            ).status_code
            == 422
        )
        assert (
            client.post(
                f"/api/projects/{run['project_id']}/checkpoints/{checkpoint_id}/rollback",
                json={"confirmed": True, "reason": "test rollback"},
            ).status_code
            == 200
        )
        forked = client.post(
            f"/api/projects/{run['project_id']}/checkpoints/{checkpoint_id}/fork",
            json={"confirmed": True},
        ).json()
        assert forked["project_id"] != run["project_id"]

        preview = client.post(
            f"/api/projects/{run['project_id']}/preview", json={"path": "offline.html"}
        ).json()
        anonymous = TestClient(client.app)
        response = anonymous.get(preview["url"])
        assert response.status_code == 200
        assert "Offline preview" in response.text

    def test_new_endpoints_auth_and_not_found_paths(self, tmp_path: Path) -> None:
        app = create_app(
            projects_root=tmp_path / "projects",
            model_factory=offline_model_factory(),
            offline=True,
        )
        unauthenticated = TestClient(app)
        assert unauthenticated.get("/api/runs/run_nope/dag").status_code == 401
        assert unauthenticated.post("/api/projects/proj_nope/preview", json={}).status_code == 401

        client = TestClient(app)
        token = client.post(
            "/api/auth/register",
            json={"email": "owner2@example.com", "password": "password-123", "org_name": "Acme"},
        ).json()["access_token"]
        client.headers.update({"Authorization": f"Bearer {token}"})
        assert client.get("/api/runs/run_nope/dag").status_code == 404
        assert client.get("/api/projects/proj_nope/checkpoints").status_code == 404


def _finish(client: TestClient, run_id: str) -> dict[str, Any]:
    for _ in range(200):
        body: dict[str, Any] = client.get(f"/api/runs/{run_id}").json()
        if body["status"] != "running":
            return body
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} never finished")


class TestProjectsOutliveRuns:
    """Anything bigger than one file gets built by asking repeatedly, so a run
    that always started in an empty directory capped the product at whatever a
    single prompt could produce."""

    def test_a_second_run_can_continue_the_first(self, client: TestClient) -> None:
        first = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, first["run_id"])

        second = client.post(
            "/api/runs",
            json={"prompt": "now add a menu", "project_id": first["project_id"]},
        ).json()
        body = _finish(client, second["run_id"])

        assert second["project_id"] == first["project_id"]
        # The point is the file survived: the follow-up saw the earlier work.
        assert "offline.html" in body["files"]

    def test_omitting_the_project_starts_a_new_one(self, client: TestClient) -> None:
        first = client.post("/api/runs", json={"prompt": "build a page"}).json()
        second = client.post("/api/runs", json={"prompt": "build a page"}).json()
        assert first["project_id"] != second["project_id"]

    @pytest.mark.parametrize("candidate", ["../escape", "a/b", "", "x" * 65, "no spaces"])
    def test_a_project_id_that_is_a_path_is_refused(
        self, client: TestClient, candidate: str
    ) -> None:
        # The id becomes a directory name, so it is a path and gets treated as
        # one. Rejecting beats sanitising: a caller who sent "../.." should be
        # told no, not quietly handed somewhere else.
        response = client.post("/api/runs", json={"prompt": "x", "project_id": candidate})
        assert response.status_code == 422


class TestReferencesMustResolve:
    """Every file parsing is a weak claim once a project has more than one of
    them. A page linking a stylesheet that was never written parses perfectly
    and is broken in the browser, and reporting that as `verified` is worse
    than reporting nothing."""

    @staticmethod
    def _verdict(workspace: Workspace, files: dict[str, str]) -> Any:
        for relative, body in files.items():
            workspace.write(relative, body)
        verifier = PreviewVerifier(workspace)
        verifier(ToolCall(tool="apply_patch", args={"patch": "x"}), _Observed("apply_patch OK"))
        return verifier(ToolCall(tool="read_file", args={"path": "index.html"}), _Observed(""))

    def test_a_link_to_a_missing_file_fails_verification(self, workspace: Workspace) -> None:
        verdict = self._verdict(workspace, {"index.html": '<script src="app.js"></script>'})

        assert isinstance(verdict, VerificationVerdict)
        assert not verdict.verified
        assert "app.js" in (verdict.observation or "")

    def test_a_link_that_resolves_passes(self, workspace: Workspace) -> None:
        verdict = self._verdict(
            workspace,
            {"index.html": '<link href="styles.css" rel="stylesheet">', "styles.css": "body{}"},
        )

        assert verdict == "the project parses and its files resolve"

    @pytest.mark.parametrize(
        "target",
        ["https://cdn.example.com/x.css", "//cdn.example.com/x.css", "#main", "mailto:a@b.c"],
    )
    def test_what_the_project_does_not_own_is_not_its_problem(
        self, workspace: Workspace, target: str
    ) -> None:
        verdict = self._verdict(workspace, {"index.html": f'<a href="{target}">x</a>'})

        assert verdict == "the project parses and its files resolve"

    def test_a_link_into_a_subdirectory_resolves(self, workspace: Workspace) -> None:
        verdict = self._verdict(
            workspace,
            {"index.html": '<link href="css/site.css" rel="stylesheet">', "css/site.css": "body{}"},
        )

        assert verdict == "the project parses and its files resolve"

    def test_a_fragment_or_query_does_not_break_the_lookup(self, workspace: Workspace) -> None:
        verdict = self._verdict(
            workspace,
            {"index.html": '<a href="books.html#top">b</a>', "books.html": "<html></html>"},
        )

        assert verdict == "the project parses and its files resolve"


class TestTheProjectIsServedAsASite:
    """`srcDoc` renders one self-contained page. A real project splits across
    styles.css, app.js and further pages, and those load by relative path."""

    def test_a_page_is_served_from_the_project(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])

        response = client.get(f"/api/projects/{run['project_id']}/site/offline.html")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
        assert "Offline preview" in response.text

    def test_the_type_is_declared_and_not_sniffed(self, client: TestClient) -> None:
        # Letting a browser guess is how model-authored bytes become
        # model-authored behaviour.
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])

        response = client.get(f"/api/projects/{run['project_id']}/site/offline.html")

        assert response.headers["x-content-type-options"] == "nosniff"
        assert "default-src 'self'" in response.headers["content-security-policy"]

    def test_traversal_out_of_the_project_is_a_404(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])

        response = client.get(f"/api/projects/{run['project_id']}/site/../../pyproject.toml")

        assert response.status_code == 404

    def test_an_unknown_project_is_a_404(self, client: TestClient) -> None:
        assert client.get("/api/projects/nope/site/offline.html").status_code == 404

    def test_relative_subresources_of_a_preview_stay_authenticated(
        self, client: TestClient
    ) -> None:
        # The whole point of serving from a real origin is that styles.css and main.js
        # load by relative path. If only the entry document carries the credential, every
        # subresource 401s and the preview renders blank.
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        url = client.post(f"/api/projects/{run['project_id']}/preview", json={}).json()["url"]

        entry = client.get(url)
        # Resolve "styles.css" the way a browser resolves it against the entry document.
        sibling = client.get(url.rsplit("/", 1)[0] + "/styles.css")

        assert entry.status_code == 200
        assert sibling.status_code == 200
        assert sibling.headers["content-type"].startswith("text/css")

    def test_a_preview_token_is_scoped_to_its_project(self, client: TestClient) -> None:
        first = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, first["run_id"])
        second = client.post("/api/runs", json={"prompt": "build another page"}).json()
        _finish(client, second["run_id"])
        url = client.post(f"/api/projects/{first['project_id']}/preview", json={}).json()["url"]
        token = url.split("/site/t/", 1)[1].split("/", 1)[0]

        crossed = client.get(f"/api/projects/{second['project_id']}/site/t/{token}/index.html")

        assert crossed.status_code == 403

    def test_a_tampered_preview_token_is_rejected(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        url = client.post(f"/api/projects/{run['project_id']}/preview", json={}).json()["url"]
        token = url.split("/site/t/", 1)[1].split("/", 1)[0]

        forged = client.get(
            f"/api/projects/{run['project_id']}/site/t/{token[:-6]}AAAAAA/index.html"
        )

        assert forged.status_code == 401

    def test_module_scripts_are_loadable_from_the_sandboxed_preview_frame(
        self, client: TestClient
    ) -> None:
        # The preview iframe is sandboxed without allow-same-origin, so it runs on a
        # "null" origin, and ES module scripts are always fetched in CORS mode. Without
        # this header main.js is blocked and the preview renders blank even though every
        # request returns 200.
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        url = client.post(f"/api/projects/{run['project_id']}/preview", json={}).json()["url"]

        module = client.get(url.rsplit("/", 1)[0] + "/main.js")

        assert module.status_code == 200
        assert module.headers["access-control-allow-origin"] == "*"


class TestAReactProjectIsScaffolded:
    """A generated app is only as good as its first file. An import map that is
    slightly wrong renders a blank page with no readable error, so the entry
    point is frozen and tested rather than written from memory each time."""

    def test_a_new_react_project_starts_from_the_template(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build an app"}).json()
        body = _finish(client, run["run_id"])

        assert run["stack"] == "react"
        assert {"index.html", "main.js", "App.js", "styles.css"} <= set(body["files"])

    def test_the_import_map_is_pinned(self, client: TestClient) -> None:
        # A project that renders today and not tomorrow because a CDN moved a
        # major version looks exactly like the agent having written something
        # broken.
        run = client.post("/api/runs", json={"prompt": "build an app"}).json()
        _finish(client, run["run_id"])

        page = client.get(f"/api/projects/{run['project_id']}/site/index.html").text

        assert 'type="importmap"' in page
        assert f"react@{REACT_VERSION}" in page
        assert "@latest" not in page

    def test_the_module_cdn_is_allowed_to_serve_scripts(self, client: TestClient) -> None:
        # With no build step the CDN is where React itself comes from, so a
        # policy that forbids it is a policy that forbids the app booting.
        run = client.post("/api/runs", json={"prompt": "build an app"}).json()
        _finish(client, run["run_id"])

        policy = client.get(f"/api/projects/{run['project_id']}/site/index.html").headers[
            "content-security-policy"
        ]

        assert f"script-src 'self' 'unsafe-inline' {MODULE_CDN}" in policy
        # Loading a module is script-src, not connect-src, so the app boots and
        # still cannot call anything — including back into this API.
        assert "connect-src 'none'" in policy

    def test_a_static_project_is_not_scaffolded(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page", "stack": "static"}).json()
        body = _finish(client, run["run_id"])

        assert run["stack"] == "static"
        assert body["files"] == ["offline.html"]

    def test_the_stack_is_fixed_by_the_run_that_created_the_project(
        self, client: TestClient
    ) -> None:
        # Writing React into a static site is not an edit, it is two
        # incompatible projects sharing a directory.
        first = client.post("/api/runs", json={"prompt": "build a page", "stack": "static"}).json()
        _finish(client, first["run_id"])

        second = client.post(
            "/api/runs",
            json={"prompt": "more", "project_id": first["project_id"], "stack": "react"},
        ).json()

        assert second["stack"] == "static"

    def test_an_unknown_stack_is_refused(self, client: TestClient) -> None:
        response = client.post("/api/runs", json={"prompt": "x", "stack": "svelte"})
        assert response.status_code == 422

    def test_legal_aup_is_public(self, client: TestClient) -> None:
        body = client.get("/api/legal/aup").json()
        assert body["version"]
        assert "infrastructure" in body["text"].lower()

    def test_billing_balance_uses_quota_store(self, client: TestClient) -> None:
        body = client.get("/api/billing/balance").json()
        assert Decimal(body["balance"]) >= 0
        assert body["plan"] == "free"

    def test_production_register_requires_aup(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LOOPIT_REQUIRE_AUP", "1")
        app = create_app(
            projects_root=tmp_path / "projects",
            model_factory=offline_model_factory(),
            offline=True,
        )
        unauthenticated = TestClient(app)
        denied = unauthenticated.post(
            "/api/auth/register",
            json={
                "email": "aup@example.com",
                "password": "correct horse battery staple",
                "org_name": "AUP Org",
            },
        )
        assert denied.status_code == 422
        accepted = unauthenticated.post(
            "/api/auth/register",
            json={
                "email": "aup@example.com",
                "password": "correct horse battery staple",
                "org_name": "AUP Org",
                "aup_accepted": True,
            },
        )
        assert accepted.status_code == 200

    def test_deploy_requires_confirmation_and_green_checkpoint(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        checkpoints = client.get(f"/api/projects/{run['project_id']}/checkpoints").json()
        assert checkpoints
        checkpoint_id = checkpoints[0]["checkpoint_id"]
        refused = client.post(
            f"/api/projects/{run['project_id']}/deploy",
            json={"checkpoint_id": checkpoint_id, "confirmed": False, "reason": "nope"},
        )
        assert refused.status_code == 422
        live = client.post(
            f"/api/projects/{run['project_id']}/deploy",
            json={"checkpoint_id": checkpoint_id, "confirmed": True, "reason": "promote preview"},
        )
        assert live.status_code == 200
        assert live.json()["status"] == "live"
        assert live.json()["production_url"].startswith("/api/projects/")
        listed = client.get(f"/api/projects/{run['project_id']}/deployments").json()
        assert listed[-1]["deployment_id"] == live.json()["deployment_id"]

    def test_published_link_serves_the_published_version_not_the_live_workspace(
        self, client: TestClient
    ) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        project_id = run["project_id"]
        published_url = _publish_latest_green(client, project_id)
        page = published_url.replace("/index.html", "/offline.html")
        assert "Offline preview" in client.get(page).text

        # Keep editing after publishing: the preview follows, the published link must not.
        tenant = client.get("/api/auth/me").json()["org_id"]
        workspace = cast(Any, client.app).state.run_manager.project(project_id, tenant_id=tenant)
        workspace.write("offline.html", "<h1>edited after publish</h1>")
        workspace.write("extra.html", "<p>new file</p>")

        published = client.get(page)
        assert published.status_code == 200
        assert "Offline preview" in published.text
        assert "edited after publish" not in published.text
        assert client.get(published_url.replace("/index.html", "/extra.html")).status_code == 404
        preview = client.post(
            f"/api/projects/{project_id}/preview", json={"path": "offline.html"}
        ).json()["url"]
        assert "edited after publish" in client.get(preview).text

    def test_published_link_cannot_escape_its_snapshot(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        published_url = _publish_latest_green(client, run["project_id"])
        escaped = published_url.replace("/index.html", "/a/../../offline.html")
        assert client.get(escaped).status_code == 404


def _publish_latest_green(client: TestClient, project_id: str) -> str:
    checkpoints = client.get(f"/api/projects/{project_id}/checkpoints").json()
    green = [item for item in checkpoints if item["verified"]][-1]
    response = client.post(
        f"/api/projects/{project_id}/deploy",
        json={"checkpoint_id": green["checkpoint_id"], "confirmed": True, "reason": "ship it"},
    )
    assert response.status_code == 200
    return str(response.json()["production_url"])


class TestRestart:
    """Everything a person can reach from a build must still work after the API
    process restarts on the same projects volume."""

    def test_versions_preview_rollback_and_published_site_survive_a_restart(
        self, tmp_path: Path
    ) -> None:
        root = tmp_path / "projects"
        before = create_app(projects_root=root, model_factory=offline_model_factory(), offline=True)
        first = TestClient(before)
        token = first.post(
            "/api/auth/register",
            json={"email": "restart@example.com", "password": "password-123", "org_name": "Acme"},
        ).json()["access_token"]
        first.headers.update({"Authorization": f"Bearer {token}"})
        run = first.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(first, run["run_id"])
        project_id = run["project_id"]
        versions = first.get(f"/api/projects/{project_id}/checkpoints").json()
        published_url = _publish_latest_green(first, project_id)

        after = create_app(projects_root=root, model_factory=offline_model_factory(), offline=True)
        second = TestClient(after)
        second.headers.update({"Authorization": f"Bearer {token}"})

        reloaded = second.get(f"/api/projects/{project_id}/checkpoints")
        assert reloaded.status_code == 200
        assert [item["checkpoint_id"] for item in reloaded.json()] == [
            item["checkpoint_id"] for item in versions
        ]
        preview = second.post(f"/api/projects/{project_id}/preview", json={"path": "offline.html"})
        assert preview.status_code == 200
        assert "Offline preview" in second.get(preview.json()["url"]).text
        published = second.get(published_url.replace("/index.html", "/offline.html"))
        assert published.status_code == 200
        assert "Offline preview" in published.text
        assert second.get(f"/api/projects/{project_id}/deployments").json()

        scaffold = versions[0]["checkpoint_id"]
        rolled = second.post(
            f"/api/projects/{project_id}/checkpoints/{scaffold}/rollback",
            json={"confirmed": True},
        )
        assert rolled.status_code == 200
        after_rollback = second.get(f"/api/projects/{project_id}/checkpoints").json()
        live = [item["checkpoint_id"] for item in after_rollback if item["live"]]
        assert live == [scaffold]

    def test_a_restarted_api_still_isolates_tenants(self, tmp_path: Path) -> None:
        root = tmp_path / "projects"
        before = TestClient(
            create_app(projects_root=root, model_factory=offline_model_factory(), offline=True)
        )
        token = before.post(
            "/api/auth/register",
            json={"email": "owner2@example.com", "password": "password-123", "org_name": "Acme"},
        ).json()["access_token"]
        before.headers.update({"Authorization": f"Bearer {token}"})
        run = before.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(before, run["run_id"])

        after = create_app(projects_root=root, model_factory=offline_model_factory(), offline=True)
        intruder = cast(Any, after).state.identity_signer.mint_identity(
            subject="someone-else", org_id="org_other", role="owner", scopes=("api", "runs")
        )
        other = TestClient(after)
        other.headers.update({"Authorization": f"Bearer {intruder}"})
        project = f"/api/projects/{run['project_id']}"
        assert other.get(f"{project}/checkpoints").status_code == 403
        assert other.post(f"{project}/preview", json={"path": "index.html"}).status_code == 403


class TestJsxIsCaughtBeforeItIsABlankPage:
    """There is no build step, so JSX does not fail loudly — it fails as a blank
    page with an error nobody is looking at."""

    @staticmethod
    def _verdict(workspace: Workspace, files: dict[str, str]) -> Any:
        for relative, body in files.items():
            workspace.write(relative, body)
        verifier = PreviewVerifier(workspace)
        verifier(ToolCall(tool="apply_patch", args={"patch": "x"}), _Observed("apply_patch OK"))
        return verifier(ToolCall(tool="read_file", args={"path": "App.js"}), _Observed(""))

    @pytest.mark.parametrize(
        "source",
        [
            "export function App() { return <div>hi</div>; }",
            "const App = () => <Header />;",
            "function App() {\n  return (\n    <main>\n      <p>x</p>\n    </main>\n  );\n}",
        ],
    )
    def test_jsx_fails_verification(self, workspace: Workspace, source: str) -> None:
        verdict = self._verdict(workspace, {"App.js": source})

        assert isinstance(verdict, VerificationVerdict)
        assert "htm" in (verdict.observation or "")

    @pytest.mark.parametrize(
        "source",
        [
            "export const ok = (a, b) => a < b;",
            "function f() { return a < b && c > d; }",
            'import { html } from "htm/react";\nexport const App = () => html`<div>hi</div>`;',
        ],
    )
    def test_ordinary_javascript_is_left_alone(self, workspace: Workspace, source: str) -> None:
        # An `a < b` comparison reported as JSX would send the agent editing
        # code that was already correct.
        assert self._verdict(workspace, {"App.js": source}) == (
            "the project parses and its files resolve"
        )

    def test_a_module_importing_a_missing_sibling_fails(self, workspace: Workspace) -> None:
        # Once components live in their own files this is the likelier bug.
        verdict = self._verdict(workspace, {"App.js": 'import { Header } from "./Header.js";'})

        assert isinstance(verdict, VerificationVerdict)
        assert "./Header.js" in (verdict.observation or "")

    def test_a_bare_specifier_is_the_import_maps_business(self, workspace: Workspace) -> None:
        assert self._verdict(workspace, {"App.js": 'import { html } from "htm/react";'}) == (
            "the project parses and its files resolve"
        )


class TestJavaScriptHasToParse:
    """JavaScript is what the generated app is actually written in, so leaving
    it unchecked meant the one thing that had to parse was the one thing nobody
    parsed. A run went green on an App.js that stopped in the middle of a
    template literal, and the page rendered nothing at all."""

    @staticmethod
    def _verdict(workspace: Workspace, files: dict[str, str]) -> Any:
        for relative, body in files.items():
            workspace.write(relative, body)
        verifier = PreviewVerifier(workspace)
        verifier(ToolCall(tool="apply_patch", args={"patch": "x"}), _Observed("apply_patch OK"))
        return verifier(ToolCall(tool="read_file", args={"path": "App.js"}), _Observed(""))

    def test_a_file_cut_off_mid_template_fails(self, workspace: Workspace) -> None:
        # Exactly the shape that shipped as `verified`.
        cut_off = 'import { html } from "htm/react";\nexport function App() {\n  return html`\n'
        verdict = self._verdict(workspace, {"App.js": cut_off})

        assert isinstance(verdict, VerificationVerdict)
        assert "App.js" in (verdict.observation or "")

    def test_the_message_points_at_what_was_never_closed(self, workspace: Workspace) -> None:
        # tree-sitter's outermost ERROR node starts at byte zero, so the naive
        # report said "line 1". The agent rewrote the file unchanged and was
        # told the same thing again, three times, and the run stalled.
        source = (
            'import { html } from "htm/react";\n'  # 1
            "\n"  # 2
            "export function App() {\n"  # 3
            "  return html`\n"  # 4
            "    <div>\n"  # 5
            "      ${items.map(\n"  # 6
            "        (i) => html`<li>${i}</li>`\n"  # 7
        )
        verdict = self._verdict(workspace, {"App.js": source})

        assert isinstance(verdict, VerificationVerdict)
        observation = verdict.observation or ""
        # The innermost thing still open is the `(` on line 6, and the report
        # names the enclosing `{` too so the agent can see the whole nest.
        assert "'(' opened at line 6" in observation
        assert "line 3" in observation
        assert "line 1" not in observation

    def test_the_message_names_the_closers_to_add(self, workspace: Workspace) -> None:
        # "It is incomplete, the content was never written" sent the agent off
        # to rewrite a file that was actually finished bar one backtick, and it
        # made the same omission twice more. Naming the closer is the fix.
        source = (
            'import { html } from "htm/react";\n'  # 1
            "export function App() {\n"  # 2
            "  return html`<main class='app'>\n"  # 3
            "    <div class='board'>\n"  # 4
            "    </div>\n"  # 5
            "}\n"  # 6
        )
        verdict = self._verdict(workspace, {"App.js": source})

        assert isinstance(verdict, VerificationVerdict)
        assert "is never closed" in (verdict.observation or "")

    @pytest.mark.parametrize(
        "source",
        [
            "function a() { return 1;",
            "const x = [1, 2,",
            "function App(] { return 1; }",
        ],
    )
    def test_unclosed_syntax_fails(self, workspace: Workspace, source: str) -> None:
        assert isinstance(self._verdict(workspace, {"App.js": source}), VerificationVerdict)

    @pytest.mark.parametrize(
        "source",
        [
            "const a = b?.c ?? d;",
            "const { x, ...rest } = y;",
            "class A { #p = 1; get p() { return this.#p; } }",
            "const f = async () => { for await (const x of y) { console.log(x); } };",
            'import { html } from "htm/react";\nexport const App = () => html`<div>${1}</div>`;',
        ],
    )
    def test_modern_javascript_is_not_a_false_alarm(
        self, workspace: Workspace, source: str
    ) -> None:
        # A parser that rejects optional chaining would send the agent
        # "fixing" code that was already correct, forever.
        assert self._verdict(workspace, {"App.js": source}) == (
            "the project parses and its files resolve"
        )

    def test_only_the_first_error_is_reported(self, workspace: Workspace) -> None:
        # A recovering parser invents cascading errors after the real one, and
        # an agent handed thirty complaints about one missing brace fixes the
        # wrong thing.
        verdict = self._verdict(workspace, {"App.js": "function a( { const x = ; const y = ;"})

        assert isinstance(verdict, VerificationVerdict)
        assert (verdict.observation or "").count("App.js") == 1


class TestPropsReactWillReject:
    """A string ``style`` parses, resolves every reference, and still renders an
    empty page: React throws on it rather than ignoring it, so nothing mounts.
    Three runs went green this way and only a screenshot disagreed."""

    @staticmethod
    def _verdict(workspace: Workspace, files: dict[str, str]) -> Any:
        for relative, body in files.items():
            workspace.write(relative, body)
        verifier = PreviewVerifier(workspace)
        verifier(ToolCall(tool="apply_patch", args={"patch": "x"}), _Observed("apply_patch OK"))
        return verifier(ToolCall(tool="read_file", args={"path": "A.js"}), _Observed(""))

    def test_a_string_style_is_rejected(self, workspace: Workspace) -> None:
        source = (
            'import { html } from "htm/react";\n'
            "export const A = () => html`\n"
            '  <div style="background: red"></div>\n'
            "`;\n"
        )
        verdict = self._verdict(workspace, {"A.js": source})

        assert isinstance(verdict, VerificationVerdict)
        observation = verdict.observation or ""
        assert "A.js:3" in observation
        assert "style=" in observation

    def test_an_object_style_is_fine(self, workspace: Workspace) -> None:
        source = (
            'import { html } from "htm/react";\n'
            "export const A = () => html`\n"
            "  <div style=${{ background: 'red' }}></div>\n"
            "`;\n"
        )
        assert self._verdict(workspace, {"A.js": source}) == (
            "the project parses and its files resolve"
        )


class TestEveryModuleIsReachable:
    """A component written into its own file and never imported is a run that
    reports success and a page that looks unchanged. Seen live: a FilterBar the
    agent built, verified, and never rendered."""

    @staticmethod
    def _verdict(workspace: Workspace, files: dict[str, str]) -> Any:
        for relative, body in files.items():
            workspace.write(relative, body)
        verifier = PreviewVerifier(workspace)
        verifier(ToolCall(tool="apply_patch", args={"patch": "x"}), _Observed("apply_patch OK"))
        return verifier(ToolCall(tool="read_file", args={"path": "main.js"}), _Observed(""))

    def test_an_orphan_module_fails(self, workspace: Workspace) -> None:
        verdict = self._verdict(
            workspace,
            {
                "index.html": '<script type="module" src="./main.js"></script>',
                "main.js": 'import { App } from "./App.js";\nApp();\n',
                "App.js": "export const App = () => 1;\n",
                "FilterBar.js": "export const FilterBar = () => 2;\n",
            },
        )

        assert isinstance(verdict, VerificationVerdict)
        observation = verdict.observation or ""
        assert "FilterBar.js is never imported" in observation
        assert "App.js" not in observation

    def test_transitive_imports_count_as_reachable(self, workspace: Workspace) -> None:
        assert self._verdict(
            workspace,
            {
                "index.html": '<script type="module" src="./main.js"></script>',
                "main.js": 'import { App } from "./App.js";\nApp();\n',
                "App.js": 'import { Row } from "./Row.js";\nexport const App = () => Row();\n',
                "Row.js": "export const Row = () => 3;\n",
            },
        ) == ("the project parses and its files resolve")

    def test_no_html_entry_point_means_no_claim(self, workspace: Workspace) -> None:
        # Reachability that can find no entry must not declare everything dead.
        assert self._verdict(workspace, {"main.js": "export const x = 1;\n"}) == (
            "the project parses and its files resolve"
        )


class TestMarkupHasToBeStyled:
    """A run that writes a full component tree and never opens the stylesheet
    passed every other check and rendered as black text on white. A class with
    no rule is a reference to something that was never written."""

    @staticmethod
    def _verdict(workspace: Workspace, files: dict[str, str]) -> Any:
        for relative, body in files.items():
            workspace.write(relative, body)
        verifier = PreviewVerifier(workspace)
        verifier(ToolCall(tool="apply_patch", args={"patch": "x"}), _Observed("apply_patch OK"))
        return verifier(ToolCall(tool="read_file", args={"path": "App.js"}), _Observed(""))

    def test_a_class_with_no_rule_fails(self, workspace: Workspace) -> None:
        verdict = self._verdict(
            workspace,
            {
                "styles.css": ".app { margin: 0; }\n",
                "App.js": (
                    "export const A = () => `"
                    '<div class="app"><b class="tag"></b><i class="row"></i>'
                    '<u class="cell"></u></div>`;\n'
                ),
            },
        )

        assert isinstance(verdict, VerificationVerdict)
        observation = verdict.observation or ""
        assert "tag" in observation
        assert "styles.css" in observation

    def test_a_few_unstyled_utility_classes_are_tolerated(self, workspace: Workspace) -> None:
        # Blocking on these turned a working app into a stalled run.
        assert self._verdict(
            workspace,
            {
                "styles.css": ".app { margin: 0; }\n.row { display: flex; }\n.cell { flex: 1; }\n",
                "App.js": (
                    "export const A = () => `"
                    '<div class="app"><b class="tag"></b><i class="row"></i>'
                    '<u class="cell"></u></div>`;\n'
                ),
            },
        ) == ("the project parses and its files resolve")

    def test_styled_markup_passes(self, workspace: Workspace) -> None:
        assert self._verdict(
            workspace,
            {
                "styles.css": ".app { margin: 0; }\n.tag { color: red; }\n",
                "App.js": 'export const A = () => `<div class="app"><b class="tag"></b></div>`;\n',
            },
        ) == ("the project parses and its files resolve")

    def test_a_composed_class_name_is_not_a_claim(self, workspace: Workspace) -> None:
        # `class="card ${priority}"` says nothing about any literal token, and
        # a check that guesses here would block correct work.
        assert self._verdict(
            workspace,
            {
                "styles.css": ".app { margin: 0; }\n",
                "App.js": 'export const A = (p) => `<i class="card ${p}"></i>`;\n',
            },
        ) == ("the project parses and its files resolve")

    def test_no_stylesheet_at_all_is_not_this_check_s_business(self, workspace: Workspace) -> None:
        assert self._verdict(
            workspace, {"App.js": 'export const A = () => `<div class="app"></div>`;\n'}
        ) == ("the project parses and its files resolve")


def test_live_model_factory_leaves_output_unbounded_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No output cap unless the operator pins one — a capped budget is what
    truncated patches mid-diff and stalled builds with finish_reason=length."""
    monkeypatch.delenv("LOOPIT_MAX_OUTPUT_TOKENS", raising=False)
    factory = live_model_factory(
        base_url="https://router.huggingface.co", bill_to=None, token="k"
    )
    client, _ledger = factory("run-1", "tenant-1")
    assert client._max_output_tokens is None


class TestTierOverride:
    def test_tier_quick_gives_smaller_budget_than_standard(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page", "tier": "quick"}).json()
        assert run["tier"] == "quick"
        assert run["cost"]["iterations"] <= 8

    def test_tier_max_gives_larger_budget(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page", "tier": "max"}).json()
        finished = _finish(client, run["run_id"])
        assert finished["tier"] == "max"
        assert finished["cost"]["iterations"] <= 40

    def test_max_iterations_pin_still_overrides_tier(self, client: TestClient) -> None:
        run = client.post(
            "/api/runs", json={"prompt": "build a page", "tier": "max", "max_iterations": 3}
        ).json()
        assert run["tier"] == "max"
        assert run["cost"]["iterations"] <= 3

    def test_invalid_tier_is_refused(self, client: TestClient) -> None:
        assert client.post("/api/runs", json={"prompt": "x", "tier": "huge"}).status_code == 422


class TestOperatorControl:
    def test_steering_message_is_queued_for_active_run(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        response = client.post(
            f"/api/runs/{run['run_id']}/messages", json={"message": "make it blue"}
        )
        assert response.status_code == 200
        assert response.json()["queued"] is True

    def test_steering_a_finished_run_is_a_409(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        assert (
            client.post(
                f"/api/runs/{run['run_id']}/messages", json={"message": "make it blue"}
            ).status_code
            == 409
        )

    def test_cancel_returns_queued_then_eventually_stops(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        response = client.post(f"/api/runs/{run['run_id']}/cancel")
        assert response.status_code == 200
        assert response.json()["cancelled"] is True
        body = _finish(client, run["run_id"])
        assert body["status"] == "cancelled"

    def test_cancel_unknown_run_is_404(self, client: TestClient) -> None:
        assert client.post("/api/runs/run_nope/cancel").status_code == 404


def _grant_terminal(client: TestClient) -> None:
    """Swap the client's token for one carrying the admin-only terminal scope."""
    me = client.get("/api/auth/me").json()
    token = cast(Any, client.app).state.identity_signer.mint_identity(
        subject=me["user_id"],
        org_id=me["org_id"],
        role=me["role"],
        scopes=("api", "runs", "build:terminal"),
    )
    client.headers.update({"Authorization": f"Bearer {token}"})


class TestTerminal:
    def test_exec_is_refused_without_the_terminal_scope(self, client: TestClient) -> None:
        # An org owner is still not a platform admin: the command would run on
        # the API host, so project write access must not be enough.
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        response = client.post(f"/api/projects/{run['project_id']}/exec", json={"command": "ls"})
        assert response.status_code == 403
        assert response.json()["detail"] == "the build terminal is limited to admins"

    def test_health_reports_the_terminal_as_admin_only(self, client: TestClient) -> None:
        assert client.get("/api/health").json()["terminal"] == "admin_only"

    def test_exec_runs_a_command_in_the_project_workspace(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        _grant_terminal(client)
        response = client.post(
            f"/api/projects/{run['project_id']}/exec",
            json={"command": "python -c \"import os; [print(f) for f in os.listdir()]\""},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["exit_code"] == 0
        assert "offline.html" in body["stdout"]

    def test_exec_respects_timeout(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        _grant_terminal(client)
        response = client.post(
            f"/api/projects/{run['project_id']}/exec",
            json={
                "command": "python -c \"import time; time.sleep(2)\"",
                "timeout_seconds": 1,
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["exit_code"] == -1
        assert "timed out" in body["stderr"]

    def test_exec_is_denied_for_other_tenants(self, tmp_path: Path) -> None:
        app = create_app(
            projects_root=tmp_path / "projects",
            model_factory=offline_model_factory(),
            offline=True,
        )
        acme = TestClient(app)
        acme_token = acme.post(
            "/api/auth/register",
            json={"email": "term@example.com", "password": "password-123", "org_name": "Acme"},
        ).json()["access_token"]
        acme.headers.update({"Authorization": f"Bearer {acme_token}"})
        run = acme.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(acme, run["run_id"])

        other = TestClient(app)
        other_token = other.post(
            "/api/auth/register",
            json={"email": "other-term@example.com", "password": "password-456", "org_name": "Other"},
        ).json()["access_token"]
        other.headers.update({"Authorization": f"Bearer {other_token}"})
        # Even an admin-scoped token stays inside its own tenant.
        _grant_terminal(other)
        assert (
            other.post(
                f"/api/projects/{run['project_id']}/exec", json={"command": "ls"}
            ).status_code
            == 403
        )


class TestStrictFidelity:
    def test_brief_system_prompt_forbids_fabrication(self) -> None:
        from loopit_api.brief import _BRIEF_SYSTEM

        assert "STRICT SCOPE RULE" in _BRIEF_SYSTEM
        assert "Do NOT invent" in _BRIEF_SYSTEM
        assert "Do not add scope" in _BRIEF_SYSTEM

    def test_goal_carries_raw_prompt_as_authority(self, workspace: Workspace) -> None:
        from loopit_api.runs import _goal_for

        goal = _goal_for("just a timer", "brief: timer with settings", workspace)
        assert "THE USER'S REQUEST (binding" in goal
        assert "just a timer" in goal
        assert "INTERPRETATION NOTES" in goal
        assert "brief: timer with settings" in goal


class TestNoPresetLimits:
    """Builds died twice on invented ceilings: the DAG schema's 2000-char node
    goal rejected a detailed spec outright, and the output budget cut patches
    mid-diff. Neither is a real constraint, so neither survives."""

    def test_a_long_prompt_is_accepted(self, client: TestClient) -> None:
        prompt = "Build an intake form. " + ("Every detail matters and stays. " * 700)
        assert len(prompt) > 20_000
        run = client.post("/api/runs", json={"prompt": prompt}).json()
        assert run["run_id"]
        finished = _finish(client, run["run_id"])
        assert finished["status"] in {"verified", "succeeded"}

    def test_the_dag_schema_accepts_a_long_goal(self) -> None:
        from loopit_api.runs import validate_task_dag_payload

        validate_task_dag_payload(
            {
                "plan_id": "plan-x",
                "goal": "g" * 50_000,
                "nodes": [
                    {
                        "id": "build-preview",
                        "kind": "add_ui_page",
                        "goal": "g" * 50_000,
                        "dag_parents": [],
                        "expected_verification": ["L0_typecheck_lint"],
                        "destructive": False,
                    }
                ],
            }
        )

    def test_interpretation_notes_are_capped_in_the_goal(
        self, workspace: Workspace
    ) -> None:
        from loopit_api.runs import BRIEF_GOAL_BUDGET_CHARS, _goal_for

        brief = "\n\n".join(f"Detail section {i}. " + "padding " * 80 for i in range(12))
        assert len(brief) > BRIEF_GOAL_BUDGET_CHARS
        goal = _goal_for("the binding request", brief, workspace)
        assert "the binding request" in goal
        assert "notes truncated" in goal
        notes_section = goal.split("INTERPRETATION NOTES", 1)[1]
        assert len(notes_section) < BRIEF_GOAL_BUDGET_CHARS + 400

    def test_the_cap_prefers_a_paragraph_boundary(self) -> None:
        from loopit_api.runs import BRIEF_GOAL_BUDGET_CHARS, _cap_brief

        brief = ("first paragraph. " + "x " * 400 + "\n\nsecond paragraph. " + "y " * 400)
        cut = _cap_brief(brief)
        assert len(cut) <= BRIEF_GOAL_BUDGET_CHARS + 60
        assert "notes truncated" in cut

    def test_assistant_turns_are_journaled_to_the_event_stream(
        self, client: TestClient
    ) -> None:
        run_id = client.post("/api/runs", json={"prompt": "build a page"}).json()["run_id"]
        with client.stream("GET", f"/api/runs/{run_id}/events") as response:
            assert response.status_code == 200
            payload = "".join(response.iter_lines())
        assert '"role": "assistant"' in payload or '"role":"assistant"' in payload
        assert '"kind": "chat"' in payload or '"kind":"chat"' in payload

    def test_token_chunks_are_journaled_to_the_event_stream(
        self, client: TestClient
    ) -> None:
        run_id = client.post("/api/runs", json={"prompt": "build a page"}).json()["run_id"]
        with client.stream("GET", f"/api/runs/{run_id}/events") as response:
            assert response.status_code == 200
            payload = "".join(response.iter_lines())
        assert '"kind": "chat_chunk"' in payload or '"kind":"chat_chunk"' in payload

class TestPhase0EngineParity:
    """Remaining Phase 0 engine contracts: resume, binary MIME, unpublish, locks."""

    def test_events_after_skips_already_seen_journal_prefix(self, client: TestClient) -> None:
        import json

        run_id = client.post("/api/runs", json={"prompt": "build a page"}).json()["run_id"]
        _finish(client, run_id)
        with client.stream("GET", f"/api/runs/{run_id}/events") as response:
            lines = [line for line in response.iter_lines() if line.startswith("data: ")]
        assert lines
        first = json.loads(lines[0].removeprefix("data: "))
        mid_seq = first.get("_seq")
        assert isinstance(mid_seq, int)
        # Resume after the first event: that event must not appear again.
        with client.stream("GET", f"/api/runs/{run_id}/events?after={mid_seq}") as response:
            resumed = [line for line in response.iter_lines() if line.startswith("data: ")]
        assert resumed
        resumed_first = json.loads(resumed[0].removeprefix("data: "))
        assert resumed_first.get("_seq", 0) > mid_seq

    def test_preview_returns_expires_at(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        preview = client.post(
            f"/api/projects/{run['project_id']}/preview", json={"path": "index.html"}
        ).json()
        assert isinstance(preview["expires_at"], (int, float))
        assert preview["expires_at"] > time.time()
        assert "T" in preview["expires_at_iso"]

    def test_binary_assets_are_served_with_their_mime_type(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        project_id = run["project_id"]
        tenant = client.get("/api/auth/me").json()["org_id"]
        workspace = cast(Any, client.app).state.run_manager.project(project_id, tenant_id=tenant)
        png = bytes(
            [
                0x89,
                0x50,
                0x4E,
                0x47,
                0x0D,
                0x0A,
                0x1A,
                0x0A,
                0x00,
                0x00,
                0x00,
                0x0D,
            ]
        )
        workspace.write_bytes("logo.png", png)
        preview = client.post(
            f"/api/projects/{project_id}/preview", json={"path": "logo.png"}
        ).json()
        response = client.get(preview["url"])
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("image/png")
        assert response.content == png

    def test_goal_file_listing_is_sorted(self, tmp_path: Path) -> None:
        from loopit_api.runs import _goal_for

        workspace = Workspace(tmp_path / "goal-list")
        workspace.write("z.js", "export default 1")
        workspace.write("a.js", "export default 2")
        workspace.write("m/b.js", "export default 3")
        goal = _goal_for("build", "notes", workspace)
        listing = [
            line.removeprefix("- ")
            for line in goal.splitlines()
            if line.startswith("- ")
        ]
        assert listing == sorted(listing)
        assert listing == ["a.js", "m/b.js", "z.js"]

    def test_unpublish_and_republish_toggle_serving(self, client: TestClient) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        project_id = run["project_id"]
        published_url = _publish_latest_green(client, project_id)
        page = published_url.replace("/index.html", "/offline.html")
        deployments = client.get(f"/api/projects/{project_id}/deployments").json()
        deployment_id = deployments[-1]["deployment_id"]
        assert "Offline preview" in client.get(page).text

        unpublished = client.post(
            f"/api/projects/{project_id}/deployments/{deployment_id}/unpublish",
            json={"confirmed": True, "reason": "take down"},
        )
        assert unpublished.status_code == 200
        assert unpublished.json()["status"] == "unpublished"
        assert client.get(page).status_code == 404

        live_again = client.post(
            f"/api/projects/{project_id}/deployments/{deployment_id}/republish",
            json={"confirmed": True, "reason": "bring back"},
        )
        assert live_again.status_code == 200
        assert live_again.json()["status"] == "live"
        assert "Offline preview" in client.get(page).text

    def test_rollback_refused_while_a_run_is_live(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        project_id = run["project_id"]
        checkpoints = client.get(f"/api/projects/{project_id}/checkpoints").json()
        checkpoint_id = checkpoints[0]["checkpoint_id"]

        manager = cast(Any, client.app).state.run_manager
        monkeypatch.setattr(manager, "project_has_live_run", lambda *args, **kwargs: True)
        refused = client.post(
            f"/api/projects/{project_id}/checkpoints/{checkpoint_id}/rollback",
            json={"confirmed": True, "reason": "during build"},
        )
        assert refused.status_code == 409
