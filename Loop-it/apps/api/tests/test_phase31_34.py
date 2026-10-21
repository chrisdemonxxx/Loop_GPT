"""Phase 3.1–3.4: user apply-patch, preview-meta, pty info."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from loopit_api.app import create_app, offline_model_factory
from loopit_api.user_edit import apply_user_file_edit, extract_html_seo, unified_diff_for_path
from loopit_api.workspace import Workspace

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


def test_unified_diff_and_apply_user_edit(tmp_path: Path) -> None:
    ws = Workspace(root=tmp_path)
    ws.write("App.js", "export const x = 1\n")
    diff = unified_diff_for_path("App.js", "export const x = 1\n", "export const x = 2\n")
    assert "--- a/App.js" in diff
    assert "+export const x = 2" in diff
    result = apply_user_file_edit(ws, path="App.js", content="export const x = 2\n")
    assert result.ok
    assert "export const x = 2" in ws.read("App.js")
    assert result.file_changes


def test_extract_html_seo() -> None:
    html = """<!doctype html><html><head>
    <title>Hello</title>
    <meta name="description" content="World">
    <meta property="og:image" content="https://example.com/og.png">
    </head><body></body></html>"""
    seo = extract_html_seo(html)
    assert seo["title"] == "Hello"
    assert seo["description"] == "World"
    assert seo["og_image"] == "https://example.com/og.png"


def test_apply_patch_api_creates_checkpoint(tmp_path: Path) -> None:
    client = _client(tmp_path)
    started = client.post("/api/runs", json={"prompt": "make a hello page"}).json()
    run = _finish(client, started["run_id"])
    project_id = run["project_id"]
    before = client.get(f"/api/projects/{project_id}/checkpoints").json()
    response = client.post(
        f"/api/projects/{project_id}/apply-patch",
        json={"path": "App.js", "content": "export default function App(){ return null }\n", "label": "user edit"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["checkpoint"]["checkpoint_id"]
    after = client.get(f"/api/projects/{project_id}/checkpoints").json()
    assert len(after) >= len(before)


def test_preview_meta_and_pty_info(tmp_path: Path) -> None:
    client = _client(tmp_path)
    started = client.post("/api/runs", json={"prompt": "make a hello page"}).json()
    run = _finish(client, started["run_id"])
    project_id = run["project_id"]

    # Seed a title into index.html when present.
    workspace_root = tmp_path / "projects"
    # Find project dir under tenant
    html_files = list(workspace_root.rglob("index.html"))
    if html_files:
        html_files[0].write_text(
            "<html><head><title>Seeded</title><meta name='description' content='Desc'></head></html>",
            encoding="utf-8",
        )

    meta = client.get(f"/api/projects/{project_id}/preview-meta")
    assert meta.status_code == 200
    assert meta.json()["project_id"] == project_id

    pty = client.get(f"/api/projects/{project_id}/pty")
    assert pty.status_code == 200
    body = pty.json()
    assert body["mode"] in {"offline", "host", "sandbox"}
    assert "ws_path" in body
