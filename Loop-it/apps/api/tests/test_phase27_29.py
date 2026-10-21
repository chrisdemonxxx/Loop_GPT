"""Phase 2.7 (dev/prod DB) and 2.9 (background builds + apply review)."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from loopit_api.app import create_app, offline_model_factory
from loopit_api.project_backend import (
    apply_migrations_at_publish,
    backend_from_env,
    dump_db_snapshot_stub,
    ensure_prod_database,
    load_db_snapshot,
)
from loopit_api.reviews import ReviewStore, diff_checkpoint_files
from loopit_provision import project_database_names

IDENTITY_SECRET = "api-identity-secret-with-at-least-thirty-two-bytes"
PREVIEW_SECRET = "api-preview-secret-with-at-least-thirty-two-bytes"


@pytest.fixture(autouse=True)
def api_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", IDENTITY_SECRET)
    monkeypatch.setenv("LOOPIT_PREVIEW_SIGNING_KEY", PREVIEW_SECRET)


def _client(tmp_path: Path) -> TestClient:
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


def _finish(client: TestClient, run_id: str) -> dict[str, Any]:
    for _ in range(200):
        body: dict[str, Any] = client.get(f"/api/runs/{run_id}").json()
        if body["status"] != "running" and body["status"] != "planning":
            return body
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} never finished")


class TestDevProdDatabases:
    def test_prod_schema_differs_from_dev(self) -> None:
        dev = project_database_names("t1", "proj_a", environment="dev")
        prod = project_database_names("t1", "proj_a", environment="prod")
        assert dev.schema != prod.schema
        # Dev digest stays stable with the historic tenant:project key.
        legacy = project_database_names("t1", "proj_a")
        assert legacy.schema == dev.schema

    def test_ensure_prod_and_migrate_at_publish(self, tmp_path: Path) -> None:
        state = backend_from_env()
        root = tmp_path / "projects"
        # Seed a fake table on the dev side.
        state.tables["proj_x"] = [{"name": "tasks", "schema": "p_dev", "rls": True}]
        first = ensure_prod_database(
            state, projects_root=root, tenant_id="tenant_a", project_id="proj_x"
        )
        assert first["created"] is True
        second = ensure_prod_database(
            state, projects_root=root, tenant_id="tenant_a", project_id="proj_x"
        )
        assert second["created"] is False
        assert second["schema"] == first["schema"]

        migrated = apply_migrations_at_publish(
            state, projects_root=root, tenant_id="tenant_a", project_id="proj_x"
        )
        assert migrated["environment"] == "prod"
        assert any(item["name"] == "tasks" for item in migrated["tables"])
        assert state.prod_tables["proj_x"]

    def test_db_snapshot_stub(self, tmp_path: Path) -> None:
        state = backend_from_env()
        root = tmp_path / "projects"
        snap = dump_db_snapshot_stub(
            state,
            projects_root=root,
            tenant_id="tenant_a",
            project_id="proj_y",
            environment="dev",
        )
        assert snap.startswith("dbsnap_")
        loaded = load_db_snapshot(root, "proj_y", snap)
        assert loaded is not None
        assert loaded["kind"] == "stub"
        assert loaded["environment"] == "dev"

    def test_deploy_records_prod_database(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        project_id = run["project_id"]
        checkpoints = client.get(f"/api/projects/{project_id}/checkpoints").json()
        green = [item for item in checkpoints if item["verified"]][-1]
        response = client.post(
            f"/api/projects/{project_id}/deploy",
            json={"checkpoint_id": green["checkpoint_id"], "confirmed": True, "reason": "ship"},
        )
        assert response.status_code == 200
        body = response.json()
        prod = body.get("prod_database")
        assert isinstance(prod, dict)
        assert prod.get("environment") == "prod"
        assert prod.get("schema")

        db = client.get(f"/api/projects/{project_id}/database?environment=prod")
        assert db.status_code == 200
        assert db.json().get("environment") == "prod"
        assert db.json().get("prod_ready") is True


class TestBackgroundBuilds:
    def test_diff_checkpoint_files(self) -> None:
        changes = diff_checkpoint_files(
            base_files={"a.js": b"one\n"},
            head_files={"a.js": b"two\n", "b.js": b"new\n"},
        )
        paths = {item["path"]: item for item in changes}
        assert paths["a.js"]["op"] == "modify"
        assert paths["b.js"]["op"] == "create"
        assert "diff" in paths["a.js"]

    def test_review_store_notify_and_apply_flow(self, tmp_path: Path) -> None:
        store = ReviewStore(tmp_path / "projects")
        review = store.create_pending_review(
            tenant_id="tenant_a",
            project_id="proj_z",
            run_id="run_1",
            checkpoint_id="ckpt_new",
            base_checkpoint_id="ckpt_old",
            file_changes=[{"path": "App.js", "op": "modify", "diff": "+x", "additions": 1, "deletions": 0}],
            summary="done",
        )
        assert review["status"] == "pending"
        notes = store.list_notifications("tenant_a", unread_only=True)
        assert notes and notes[0]["review_id"] == review["review_id"]
        assert store.unread_count("tenant_a") == 1
        store.mark_read("tenant_a")
        assert store.unread_count("tenant_a") == 0
        applied = store.mark_applied(review["review_id"], tenant_id="tenant_a")
        assert applied is not None
        assert applied["status"] == "applied"

    def test_background_run_creates_pending_review(self, tmp_path: Path) -> None:
        """Offline scripted model only covers one run; drive the 2.9 park/apply path
        through RunManager after seeding a project (same finish → review → apply)."""
        from loopit_api.runs import RunState
        from loopit_api.workspace import Workspace

        projects_root = tmp_path / "projects"
        app = create_app(
            projects_root=projects_root,
            model_factory=offline_model_factory(),
            offline=True,
        )
        client = TestClient(app)
        response = client.post(
            "/api/auth/register",
            json={
                "email": "bg@example.com",
                "password": "correct horse battery staple",
                "org_name": "Acme",
            },
        )
        client.headers.update({"Authorization": f"Bearer {response.json()['access_token']}"})
        first = client.post("/api/runs", json={"prompt": "build a page"}).json()
        finished = _finish(client, first["run_id"])
        project_id = finished["project_id"]
        tenant_id = finished.get("tenant_id") or client.get("/api/auth/me").json().get("org_id")
        # Resolve tenant from project checkpoints listing (auth me may use different shape).
        base_checkpoints = client.get(f"/api/projects/{project_id}/checkpoints").json()
        base_live = next(item for item in base_checkpoints if item.get("live"))

        manager = app.state.run_manager
        # Prefer the live run's tenant if present.
        seed = manager.get(first["run_id"])
        if seed is not None:
            tenant_id = seed.tenant_id
        assert tenant_id

        workspace = Workspace(projects_root / tenant_id / project_id)
        workspace.write("App.js", "export default function App(){ return 'bg'; }\n")
        state = RunState(
            run_id="run_bg_test",
            prompt="tweak",
            project_id=project_id,
            tenant_id=tenant_id,
            actor_id="tester",
            background=True,
            base_checkpoint_id=base_live["checkpoint_id"],
            status="verified",
            summary="background ready",
            title="Background tweak",
        )
        checkpoint = manager._snapshot(
            workspace,
            project_id=project_id,
            tenant_id=tenant_id,
            run_id=state.run_id,
            verified=True,
            label=f"pending-review {state.run_id}",
            include_db_snapshot=True,
        )
        manager._finalize_background_review(state, workspace, checkpoint)
        assert state.pending_review_id

        reviews = client.get("/api/reviews").json()
        assert any(item["review_id"] == state.pending_review_id for item in reviews)
        review = client.get(f"/api/reviews/{state.pending_review_id}").json()
        assert review["status"] == "pending"
        assert review["checkpoint_id"] == checkpoint.checkpoint_id
        assert review["file_changes"]

        # Main line restored to the pre-background checkpoint.
        after = client.get(f"/api/projects/{project_id}/checkpoints").json()
        live = next(item for item in after if item.get("live"))
        assert live["checkpoint_id"] == base_live["checkpoint_id"]

        notes = client.get("/api/notifications").json()
        assert notes["unread_count"] >= 1

        applied = client.post(
            f"/api/reviews/{state.pending_review_id}/apply",
            json={"confirmed": True, "reason": "ship it"},
        )
        assert applied.status_code == 200
        merged = client.get(f"/api/projects/{project_id}/checkpoints").json()
        live_after = next(item for item in merged if item.get("live"))
        assert live_after["checkpoint_id"] == review["checkpoint_id"]

    def test_start_accepts_background_flag(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        first = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, first["run_id"])
        bg = client.post(
            "/api/runs",
            json={
                "prompt": "noop",
                "project_id": first["project_id"],
                "mode": "build",
                "background": True,
                "max_iterations": 1,
            },
        )
        assert bg.status_code == 200
        assert bg.json().get("background") is True
        _finish(client, bg.json()["run_id"])

    def test_health_exposes_phase2_flags(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        health = client.get("/api/health").json()
        assert health["background_builds"] is True
        assert health["dev_prod_databases"] is True
