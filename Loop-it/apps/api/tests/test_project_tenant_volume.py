"""Project tenant lookup on a mounted volume root (``lost+found`` is root-only)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from loopit_api.app import create_app, offline_model_factory
from loopit_api.runs import RunManager

IDENTITY_SECRET = "api-identity-secret-with-at-least-thirty-two-bytes"
PREVIEW_SECRET = "api-preview-secret-with-at-least-thirty-two-bytes"


@pytest.fixture(autouse=True)
def api_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", IDENTITY_SECRET)
    monkeypatch.setenv("LOOPIT_PREVIEW_SIGNING_KEY", PREVIEW_SECRET)


@pytest.fixture
def unreadable_lost_found(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make any stat under ``lost+found`` fail the way it does on Railway."""
    original = Path.is_dir

    def is_dir(self: Path, *args: object, **kwargs: object) -> bool:
        if "lost+found" in self.parts and self.name != "lost+found":
            raise PermissionError(13, "Permission denied", str(self))
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "is_dir", is_dir)


def _manager(root: Path) -> RunManager:
    return RunManager(projects_root=root, model_factory=offline_model_factory())


@pytest.mark.usefixtures("unreadable_lost_found")
def test_project_tenant_skips_unreadable_lost_found(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    (root / "lost+found").mkdir(parents=True)
    (root / "tenant_z" / "proj_abc123").mkdir(parents=True)

    manager = _manager(root)

    assert manager.project_tenant("proj_abc123") == "tenant_z"
    assert manager.project_tenant("proj_missing") is None


@pytest.mark.usefixtures("unreadable_lost_found")
def test_unknown_project_is_404_not_500(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    (root / "lost+found").mkdir(parents=True)
    app = create_app(projects_root=root, model_factory=offline_model_factory(), offline=True)
    client = TestClient(app, raise_server_exceptions=False)
    token = client.post(
        "/api/auth/register",
        json={"email": "owner@example.com", "password": "correct horse battery staple", "org_name": "Acme"},
    ).json()["access_token"]
    client.headers.update({"Authorization": f"Bearer {token}"})

    for path in ("deployments", "security-scan", "browser-tests"):
        response = client.get(f"/api/projects/proj_069c5ce02563/{path}")
        assert response.status_code == 404, (path, response.status_code)
    preview = client.post("/api/projects/proj_069c5ce02563/preview", json={"path": "index.html"})
    assert preview.status_code < 500
