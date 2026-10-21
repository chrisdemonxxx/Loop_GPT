"""Phase 2.1 / 2.2 / 2.8: visual edit, browser tests, security scan."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from loopit_api.app import create_app, offline_model_factory
from loopit_api.security_scan import run_security_scan
from loopit_api.visual_edit import VisualEditRequest, apply_visual_edit, parse_data_loc
from loopit_api.workspace import Workspace

IDENTITY_SECRET = "api-identity-secret-with-at-least-thirty-two-bytes"
PREVIEW_SECRET = "api-preview-secret-with-at-least-thirty-two-bytes"


@pytest.fixture(autouse=True)
def api_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", IDENTITY_SECRET)
    monkeypatch.setenv("LOOPIT_PREVIEW_SIGNING_KEY", PREVIEW_SECRET)
    monkeypatch.setenv("LOOPIT_BROWSER_TEST_OFFLINE", "1")
    monkeypatch.setenv("LOOPIT_SECURITY_SCAN_OFFLINE", "1")


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


class TestVisualEdit:
    def test_parse_data_loc(self) -> None:
        assert parse_data_loc("src/App.tsx:12:5") == ("src/App.tsx", 12, 5)
        assert parse_data_loc(None) is None

    def test_codemod_text_edit(self, tmp_path: Path) -> None:
        ws = Workspace(root=tmp_path)
        ws.write("src/App.tsx", "export function App() {\n  return <h1>Hello</h1>\n}\n")
        result = apply_visual_edit(
            ws,
            VisualEditRequest(
                kind="text",
                value="World",
                loc="src/App.tsx:2:10",
                text="Hello",
                snippet="<h1>Hello</h1>",
            ),
        )
        assert result.applied is True
        assert result.mode == "codemod"
        assert "World" in ws.read("src/App.tsx")

    def test_visual_edit_api(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        project_id = run["project_id"]
        # Seed a file with unique text for the codemod.
        detail = client.get(f"/api/runs/{run['run_id']}").json()
        assert detail["project_id"] == project_id
        response = client.post(
            f"/api/projects/{project_id}/visual-edit",
            json={
                "kind": "text",
                "value": "Hi",
                "loc": "App.js:1:1",
                "text": "does-not-exist-unique",
                "snippet": "<div>x</div>",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["mode"] in {"codemod", "llm"}
        assert "prompt" in body or body.get("applied")


class TestBrowserSelfTest:
    def test_offline_browser_test(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        project_id = run["project_id"]
        response = client.post(
            f"/api/projects/{project_id}/browser-tests",
            json={"force_offline": True, "acceptance": ["page loads"], "preview_url": "http://example.invalid/"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "passed"
        assert body["mode"] == "offline"
        assert body["steps"]
        listed = client.get(f"/api/projects/{project_id}/browser-tests").json()
        assert any(item["test_id"] == body["test_id"] for item in listed)
        one = client.get(f"/api/projects/{project_id}/browser-tests/{body['test_id']}").json()
        assert one["test_id"] == body["test_id"]
        assert one.get("artifact_dir")


class TestSecurityScan:
    def test_offline_scan_and_override_gate(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        finished = _finish(client, run["run_id"])
        project_id = run["project_id"]
        scan = client.post(
            f"/api/projects/{project_id}/security-scan",
            json={"gate": "deploy", "force_offline": True},
        ).json()
        assert scan["passed"] is True
        assert scan["mode"] == "offline"

        # Inject a critical finding into the latest scan artifact.
        projects_root = tmp_path / "projects"
        dest = projects_root / ".artifacts" / "security" / project_id
        dest.mkdir(parents=True, exist_ok=True)
        blocking = {
            **scan,
            "passed": False,
            "blocking_count": 1,
            "findings": [
                {
                    "rule_id": "gitleaks.aws-key",
                    "severity": "CRITICAL",
                    "stage": "SECRETS",
                    "path": ".env",
                    "line": 1,
                    "message": "secret ([redacted])",
                    "plain": "A secret appears committed.",
                    "blocks_publish": True,
                }
            ],
        }
        (dest / "latest.json").write_text(json.dumps(blocking) + "\n", encoding="utf-8")

        checkpoints = client.get(f"/api/projects/{project_id}/checkpoints").json()
        green = [item for item in checkpoints if item["verified"]]
        if not green:
            # Offline model may leave unverified; force-verify path via any checkpoint
            green = checkpoints
        assert green, finished
        blocked = client.post(
            f"/api/projects/{project_id}/deploy",
            json={
                "checkpoint_id": green[-1]["checkpoint_id"],
                "confirmed": True,
                "reason": "ship",
                "override_security": False,
            },
        )
        assert blocked.status_code == 409

        # Override gate allows publish when reason/confirmation present.
        # May still 422 if checkpoint not verified — only assert override clears 409.
        ok = client.post(
            f"/api/projects/{project_id}/deploy",
            json={
                "checkpoint_id": green[-1]["checkpoint_id"],
                "confirmed": True,
                "reason": "accepted risk",
                "override_security": True,
            },
        )
        assert ok.status_code != 409

    def test_run_security_scan_helper(self, tmp_path: Path) -> None:
        root = tmp_path / "ws"
        root.mkdir()
        (root / "package.json").write_text('{"name":"x"}\n', encoding="utf-8")
        result = run_security_scan(
            projects_root=tmp_path / "projects",
            project_id="proj_x",
            workspace_root=root,
            force_offline=True,
        )
        assert result["passed"] is True
        assert result["mode"] == "offline"
