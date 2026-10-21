"""Phase 3.5–3.9: connectors, analytics, collaboration (offline)."""

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


def _project(client: TestClient) -> str:
    run = client.post("/api/runs", json={"prompt": "build a page"}).json()
    finished = _finish(client, run["run_id"])
    return finished["project_id"]


class TestConnectors:
    def test_list_and_enable_stub(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        project_id = _project(client)

        listed = client.get(f"/api/projects/{project_id}/connectors")
        assert listed.status_code == 200
        kinds = {row["kind"] for row in listed.json()["connectors"]}
        assert kinds == {"stripe", "resend", "ai_router"}

        enabled = client.put(
            f"/api/projects/{project_id}/connectors",
            json={"kind": "stripe", "enabled": True},
        )
        assert enabled.status_code == 200
        assert enabled.json()["enabled"] is True
        assert enabled.json()["status"] == "stub"


class TestAnalytics:
    def test_seed_and_get(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        project_id = _project(client)

        empty = client.get(f"/api/projects/{project_id}/analytics")
        assert empty.status_code == 200
        assert empty.json()["page_views"] == 0

        seeded = client.post(
            f"/api/projects/{project_id}/analytics/seed",
            json={"page_views": 42},
        )
        assert seeded.status_code == 200
        assert seeded.json()["page_views"] == 42
        assert seeded.json()["source"] == "edge_stub"

        again = client.get(f"/api/projects/{project_id}/analytics")
        assert again.json()["page_views"] == 42


class TestCollab:
    def test_presence_and_chat(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        project_id = _project(client)

        beat = client.post(
            f"/api/projects/{project_id}/collab/presence",
            json={"display_name": "Owner"},
        )
        assert beat.status_code == 200
        assert beat.json()["online_count"] >= 1

        chat = client.post(
            f"/api/projects/{project_id}/collab/chat",
            json={"text": "hello team", "display_name": "Owner"},
        )
        assert chat.status_code == 200
        messages = chat.json()["messages"]
        assert any(m["text"] == "hello team" for m in messages)

        state = client.get(f"/api/projects/{project_id}/collab")
        assert state.status_code == 200
        assert state.json()["online_count"] >= 1
