"""Phase 1.8–1.11: hosting, database, secrets, local gates."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from loopit_api.app import create_app, offline_model_factory
from loopit_api.hosting import opaque_label_for
from loopit_api.project_backend import backend_from_env, list_secret_names, put_secret, request_secret
from loopit_deployer import StaticObjectHostingProvider as DeployerStatic

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


def _publish(client: TestClient, project_id: str) -> dict[str, Any]:
    checkpoints = client.get(f"/api/projects/{project_id}/checkpoints").json()
    green = [item for item in checkpoints if item["verified"]][-1]
    response = client.post(
        f"/api/projects/{project_id}/deploy",
        json={"checkpoint_id": green["checkpoint_id"], "confirmed": True, "reason": "ship"},
    )
    assert response.status_code == 200
    return response.json()


class TestHosting:
    def test_static_provider_is_exported(self, tmp_path: Path) -> None:
        provider = DeployerStatic(tmp_path / "cdn")
        assert callable(provider.health_check)
        assert opaque_label_for("proj_abc").startswith("p-")

    def test_deploy_records_hosting_metadata(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        record = _publish(client, run["project_id"])
        assert record["status"] == "live"
        assert record["production_url"]
        assert record.get("hosting_provider") in {"static", "signed_site", "fake"}
        assert "site_url" in record or str(record["production_url"]).startswith("/api/projects/")

    def test_deploy_history_supersedes_prior_live(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        first = _publish(client, run["project_id"])
        second = _publish(client, run["project_id"])
        history = client.get(f"/api/projects/{run['project_id']}/deployments").json()
        statuses = {item["deployment_id"]: item["status"] for item in history}
        assert statuses[first["deployment_id"]] == "superseded"
        assert statuses[second["deployment_id"]] == "live"

    def test_rollback_deployment_endpoint(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        first = _publish(client, run["project_id"])
        _publish(client, run["project_id"])
        rolled = client.post(
            f"/api/projects/{run['project_id']}/deployments/{first['deployment_id']}/rollback",
            json={"confirmed": True, "reason": "restore"},
        )
        assert rolled.status_code == 200
        assert rolled.json()["status"] == "live"


class TestDatabaseAndSecrets:
    def test_database_and_secrets_endpoints(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        run = client.post("/api/runs", json={"prompt": "build a page"}).json()
        _finish(client, run["run_id"])
        project_id = run["project_id"]
        db = client.get(f"/api/projects/{project_id}/database")
        assert db.status_code == 200
        assert "tables" in db.json()
        assert db.json().get("provider") == "memory"

        put = client.put(
            f"/api/projects/{project_id}/secrets",
            json={"name": "STRIPE_KEY", "value": "sk_test_123", "environment": "build"},
        )
        assert put.status_code == 200
        listed = client.get(f"/api/projects/{project_id}/secrets").json()
        assert any(item["name"] == "STRIPE_KEY" for item in listed)
        meta = client.get(f"/api/projects/{project_id}/runtime-env").json()
        assert "STRIPE_KEY" in meta["names"]
        assert "sk_test_123" not in str(meta)

        refused = client.put(
            f"/api/projects/{project_id}/secrets",
            json={"name": "VITE_PUBLIC", "value": "x", "environment": "build"},
        )
        assert refused.status_code == 422

    def test_secret_request_queue(self) -> None:
        state = backend_from_env()
        req = request_secret(state, project_id="proj_x", name="OPENAI_KEY", reason="needs API")
        assert req["status"] == "pending"
        put_secret(state, tenant_id="t1", project_id="proj_x", name="OPENAI_KEY", value="secret")
        remaining = [
            item
            for item in state.pending_secret_requests.get("proj_x", [])
            if item.get("status") == "pending"
        ]
        assert remaining == []

    def test_a_saved_secret_is_listed_from_the_persistent_store(self) -> None:
        from loopit_secrets import (
            Environment,
            InMemoryEncryptedSecretRepository,
            PersistentSecretStore,
            RootKey,
        )

        state = backend_from_env()
        state.build_secrets = PersistentSecretStore(
            Environment.BUILD,
            repository=InMemoryEncryptedSecretRepository(),
            root_key=RootKey(key_id="root-a", key=bytes([1]) * 32),
        )
        put_secret(
            state,
            tenant_id="t1",
            project_id="proj_x",
            name="AUDIT_PASS",
            value="ok",
        )
        names = list_secret_names(state, tenant_id="t1", project_id="proj_x")
        assert any(item["name"] == "AUDIT_PASS" for item in names)
        from loopit_api.project_backend import delete_secret

        assert delete_secret(state, tenant_id="t1", project_id="proj_x", name="AUDIT_PASS")
        names = list_secret_names(state, tenant_id="t1", project_id="proj_x")
        assert all(item["name"] != "AUDIT_PASS" for item in names)


class TestHealthParityFlags:
    def test_health_exposes_hosting_and_local_gates(self, tmp_path: Path) -> None:
        client = _client(tmp_path)
        health = client.get("/api/health").json()
        assert health["local_gates"] is True
        assert health["hosting_provider"]
        assert health["provision_provider"] == "memory"
