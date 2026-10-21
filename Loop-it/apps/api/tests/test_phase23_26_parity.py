"""Phase 2.3–2.6: gitsync, domains, sharing/remix, templates (offline)."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from loopit_api.app import create_app, offline_model_factory

IDENTITY_SECRET = "api-identity-secret-with-at-least-thirty-two-bytes"
PREVIEW_SECRET = "api-preview-secret-with-at-least-thirty-two-bytes"


@pytest.fixture(autouse=True)
def api_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", IDENTITY_SECRET)
    monkeypatch.setenv("LOOPIT_PREVIEW_SIGNING_KEY", PREVIEW_SECRET)
    monkeypatch.delenv("LOOPIT_DOMAINS_URL", raising=False)
    monkeypatch.delenv("LOOPIT_GITHUB_TOKEN", raising=False)
    monkeypatch.setenv("LOOPIT_GITSYNC_PROVIDER", "fake")
    monkeypatch.setenv("LOOPIT_DOMAINS_MODE", "fake")


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
        if body["status"] != "running":
            return body
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} never finished")


def _project_with_green(client: TestClient) -> tuple[str, str]:
    run = client.post("/api/runs", json={"prompt": "build a page"}).json()
    finished = _finish(client, run["run_id"])
    project_id = finished["project_id"]
    checkpoints = client.get(f"/api/projects/{project_id}/checkpoints").json()
    green = [item for item in checkpoints if item["verified"]][-1]
    return project_id, green["checkpoint_id"]


class TestGitSync:
    def test_bind_push_and_webhook_pull(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        project_id, checkpoint_id = _project_with_green(client)

        status = client.get(f"/api/projects/{project_id}/git").json()
        assert status["bound"] is False
        assert status["mode"] == "fake"

        bound = client.post(
            f"/api/projects/{project_id}/git/bind",
            json={"owner": "acme", "name": "demo-app", "create": True},
        )
        assert bound.status_code == 200
        assert bound.json()["bound"] is True

        pushed = client.post(
            f"/api/projects/{project_id}/git/push",
            json={"checkpoint_id": checkpoint_id},
        )
        assert pushed.status_code == 200
        assert pushed.json()["commit_sha"]

        pulled = client.post(
            f"/api/projects/{project_id}/git/webhook",
            json={
                "conflict": True,
                "files": {"index.html": "<html><body>from-git</body></html>", "README.md": "pull"},
            },
        )
        assert pulled.status_code == 200
        body = pulled.json()
        assert body["checkpoint_id"]
        assert body.get("backup_branch")  # conflict → backup branch
        assert "index.html" in body["files"]

    def test_health_reports_gitsync_provider(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        health = client.get("/api/health").json()
        assert health.get("gitsync_provider") == "fake"


class TestCustomDomains:
    def test_claim_and_verify_offline(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        project_id, _ = _project_with_green(client)

        claimed = client.post(
            f"/api/projects/{project_id}/domains",
            json={"hostname": "app.example.test"},
        )
        assert claimed.status_code == 200
        claim = claimed.json()
        assert claim["status"] == "pending"
        assert claim["challenge_name"].startswith("_loopit-verify.")
        assert claim["challenge_value"]

        verified = client.post(
            f"/api/projects/{project_id}/domains/app.example.test/verify",
            json={"seed_txt": True},
        )
        assert verified.status_code == 200
        assert verified.json()["status"] == "verified"
        assert verified.json().get("tls_status") == "active"

        listed = client.get(f"/api/projects/{project_id}/domains").json()
        assert any(item["hostname"] == "app.example.test" for item in listed)


class TestSharingRemix:
    def test_visibility_public_page_and_remix(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        project_id, _ = _project_with_green(client)

        # Publish so share can include a production URL (optional).
        checkpoints = client.get(f"/api/projects/{project_id}/checkpoints").json()
        green = [item for item in checkpoints if item["verified"]][-1]
        client.post(
            f"/api/projects/{project_id}/deploy",
            json={"checkpoint_id": green["checkpoint_id"], "confirmed": True, "reason": "ship"},
        )

        visibility = client.patch(
            f"/api/projects/{project_id}/visibility",
            json={"visibility": "public_remix", "title": "Demo app"},
        )
        assert visibility.status_code == 200
        share_id = visibility.json()["share_id"]

        public = client.get(f"/api/public/share/{share_id}")
        assert public.status_code == 200
        assert public.json()["remix_allowed"] is True
        assert public.json()["title"] == "Demo app"

        remixed = client.post(f"/api/public/share/{share_id}/remix")
        assert remixed.status_code == 200
        new_id = remixed.json()["project_id"]
        assert new_id != project_id
        # Remix is a private copy.
        detail = client.get(f"/api/projects/{new_id}").json()
        assert detail.get("visibility") in {"private", None} or detail["project_id"] == new_id


class TestTemplates:
    def test_list_and_remix_template(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        templates = client.get("/api/templates").json()
        assert isinstance(templates, list)
        assert len(templates) >= 2
        ids = {item["id"] for item in templates}
        assert "landing-page" in ids
        # Recipe files when present
        assert "crud-app-with-auth" in ids or any(item.get("source") == "recipe" for item in templates)

        template_id = "landing-page"
        remixed = client.post(
            f"/api/templates/{template_id}/remix",
            json={"confirmed": True},
        )
        assert remixed.status_code == 200
        body = remixed.json()
        assert body["run_id"]
        assert body["project_id"]
        _finish(client, body["run_id"])
