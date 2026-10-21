from __future__ import annotations

import os
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_agent_core.config import SecretConfigurationError
from loopit_scheduler import InMemoryProvider, Scheduler, WarmPool
from loopit_scheduler import server as scheduler_server
from loopit_store import LeaseRecord, PostgresLeaseStore
from loopit_store.models import now_utc

SERVICE_TOKEN = "scheduler-service-token-with-at-least-thirty-two-chars"
LEASE_SECRET = "scheduler-lease-secret-with-at-least-thirty-two-chars"

os.environ.setdefault("LOOPIT_SERVICE_TOKEN", SERVICE_TOKEN)
os.environ.setdefault("LOOPIT_LEASE_TOKEN_SECRET", LEASE_SECRET)

from loopit_scheduler.server import ServerSettings, _verify_token, create_app  # noqa: E402


def _client() -> TestClient:
    scheduler = Scheduler(
        pool=WarmPool(InMemoryProvider(), target_size=0, max_live=2),
        audit=InMemoryAuditSink(),
        tenant_concurrency=1,
    )
    settings = ServerSettings(service_token=SERVICE_TOKEN, lease_token_secret=LEASE_SECRET)
    return TestClient(create_app(scheduler=scheduler, settings=settings))


@pytest.mark.parametrize("name", ["LOOPIT_LEASE_TOKEN_SECRET", "LOOPIT_SERVICE_TOKEN"])
@pytest.mark.parametrize("bad_value", [None, "too-short", "dev-service-token-change-me"])
def test_settings_reject_missing_short_or_placeholder_secrets(
    monkeypatch: pytest.MonkeyPatch, name: str, bad_value: str | None
) -> None:
    monkeypatch.setenv("LOOPIT_LEASE_TOKEN_SECRET", LEASE_SECRET)
    monkeypatch.setenv("LOOPIT_SERVICE_TOKEN", SERVICE_TOKEN)
    if bad_value is None:
        monkeypatch.delenv(name)
    else:
        monkeypatch.setenv(name, bad_value)

    with pytest.raises(SecretConfigurationError):
        ServerSettings.from_env()


def test_settings_accept_valid_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_LEASE_TOKEN_SECRET", LEASE_SECRET)
    monkeypatch.setenv("LOOPIT_SERVICE_TOKEN", SERVICE_TOKEN)

    settings = ServerSettings.from_env()

    assert settings.lease_token_secret == LEASE_SECRET
    assert settings.service_token == SERVICE_TOKEN


def test_settings_split_scheduler_store_dsn_from_append_only_audit_dsn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LOOPIT_LEASE_TOKEN_SECRET", LEASE_SECRET)
    monkeypatch.setenv("LOOPIT_SERVICE_TOKEN", SERVICE_TOKEN)
    monkeypatch.setenv("LOOPIT_AUDIT_DSN", "postgresql://audit-writer")
    monkeypatch.setenv("LOOPIT_SCHEDULER_STORE_DSN", "postgresql://scheduler-lease-writer")
    monkeypatch.setenv("LOOPIT_STORE_DSN", "postgresql://control-plane")

    settings = ServerSettings.from_env()

    assert settings.audit_dsn == "postgresql://audit-writer"
    assert settings.scheduler_store_dsn == "postgresql://scheduler-lease-writer"
    assert not hasattr(settings, "store_dsn")


def test_scheduler_audit_sink_uses_append_only_audit_dsn(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    class FakeAppendOnlyAuditSink:
        def __init__(self, conn: object) -> None:
            seen["conn"] = conn

    def fake_connect(dsn: str) -> str:
        seen["dsn"] = dsn
        return f"connected:{dsn}"

    monkeypatch.setattr(scheduler_server, "connect", fake_connect)
    monkeypatch.setattr(scheduler_server, "PostgresAppendOnlyAuditSink", FakeAppendOnlyAuditSink)

    sink = scheduler_server._audit_sink(
        ServerSettings(
            service_token=SERVICE_TOKEN,
            lease_token_secret=LEASE_SECRET,
            audit_dsn="postgresql://audit-writer",
            scheduler_store_dsn="postgresql://scheduler-lease-writer",
        )
    )

    assert isinstance(sink, FakeAppendOnlyAuditSink)
    assert seen == {
        "dsn": "postgresql://audit-writer",
        "conn": "connected:postgresql://audit-writer",
    }


def service_headers() -> dict[str, str]:
    return {"X-Loopit-Service-Token": SERVICE_TOKEN}


def lease_headers(token: str) -> dict[str, str]:
    return {"Authorization": "Bearer " + token}


def _acquire(
    client: TestClient, tenant_id: str = "tenant", project_id: str = "project"
) -> dict[str, str]:
    response = client.post(
        "/leases",
        headers=service_headers(),
        json={
            "tenant_id": tenant_id,
            "run_id": "run-" + tenant_id,
            "project_id": project_id,
            "base_checkpoint_id": "ckpt",
            "ttl_seconds": 60,
        },
    )
    assert response.status_code == 200
    return cast(dict[str, str], response.json())


def _lease_record() -> LeaseRecord:
    return LeaseRecord(
        lease_id="lease-real",
        tenant_id="tenant-real",
        run_id="run-real",
        project_id="project-real",
        sandbox_id="sandbox-real",
        base_checkpoint_id="ckpt-real",
        expires_at=now_utc(),
        caps={
            "cpu_millicores": 1000,
            "memory_mib": 512,
            "disk_mib": 1024,
            "wall_clock_seconds": 60,
            "max_processes": 16,
        },
        allowed_tools=("shell",),
    )


def _lease_row(record: LeaseRecord) -> dict[str, Any]:
    return {
        "lease_id": record.lease_id,
        "tenant_id": record.tenant_id,
        "run_id": record.run_id,
        "project_id": record.project_id,
        "sandbox_id": record.sandbox_id,
        "base_checkpoint_id": record.base_checkpoint_id,
        "expires_at": record.expires_at,
        "caps": record.caps,
        "allowed_tools": list(record.allowed_tools),
        "status": record.status,
        "released_at": record.released_at,
        "created_at": record.created_at,
    }


class _FakeCursor:
    rowcount = 1

    def __init__(self, row: dict[str, Any]) -> None:
        self._row = row

    def fetchone(self) -> dict[str, Any]:
        return self._row


class _FakePostgresConnection:
    def __init__(self, row: dict[str, Any]) -> None:
        self._row = row
        self.execute_count = 0
        self.commit_count = 0
        self.rollback_count = 0

    def execute(self, query: str, params: object | None = None) -> _FakeCursor:
        self.execute_count += 1
        return _FakeCursor(self._row)

    def commit(self) -> None:
        self.commit_count += 1

    def rollback(self) -> None:
        self.rollback_count += 1


def _postgres_store() -> tuple[PostgresLeaseStore, _FakePostgresConnection, LeaseRecord]:
    record = _lease_record()
    conn = _FakePostgresConnection(_lease_row(record))
    return PostgresLeaseStore(cast(Any, conn)), conn, record


def test_healthz() -> None:
    assert _client().get("/healthz").status_code == 200


def test_acquire_list_renew_release_lease() -> None:
    client = _client()
    body = _acquire(client)
    assert body["lease_token"]
    lease_id = body["lease_id"]
    headers = lease_headers(body["lease_token"])

    listed = client.get("/leases", headers=headers)
    assert listed.status_code == 200
    assert listed.json()["leases"][0]["lease_id"] == lease_id

    renewed = client.post(f"/leases/{lease_id}/renew", headers=headers, json={"ttl_seconds": 120})
    assert renewed.status_code == 200
    assert renewed.json()["status"] == "active"

    released = client.post(f"/leases/{lease_id}/release", headers=headers, json={})
    assert released.status_code == 200


def test_list_leases_round_trips_project_id_from_real_acquire_path() -> None:
    client = _client()
    body = _acquire(client, tenant_id="tenant-real", project_id="project-real")

    listed = client.get("/leases", headers=lease_headers(body["lease_token"]))

    assert listed.status_code == 200
    claims = _verify_token(body["lease_token"], cast(Any, client.app).state.settings)
    assert {
        "acquired_project_id": body["project_id"],
        "token_project_id": claims.project_id,
        "listed_project_id": listed.json()["leases"][0]["project_id"],
    } == {
        "acquired_project_id": "project-real",
        "token_project_id": "project-real",
        "listed_project_id": "project-real",
    }


def test_renew_returns_fresh_token_matching_persisted_expiry() -> None:
    client = _client()
    body = _acquire(client)
    lease_id = body["lease_id"]

    renewed = client.post(
        f"/leases/{lease_id}/renew",
        headers=lease_headers(body["lease_token"]),
        json={"ttl_seconds": 120},
    )

    assert renewed.status_code == 200
    renewed_body = renewed.json()
    assert renewed_body["lease_token"]
    assert renewed_body["lease_token"] != body["lease_token"]
    assert renewed_body["status"] == "active"
    app = cast(Any, client.app)
    record = app.state.lease_store.get(lease_id, tenant_id="tenant")
    assert record is not None
    assert renewed_body["expires_at"] == record.expires_at.isoformat().replace("+00:00", "Z")
    claims = _verify_token(renewed_body["lease_token"], app.state.settings)
    assert claims.expires_at == record.expires_at.timestamp()
    assert claims.project_id == record.project_id


def test_postgres_lease_create_commits_without_caller_transaction() -> None:
    store, conn, record = _postgres_store()

    created = store.create(record)

    assert created.project_id == "project-real"
    assert conn.commit_count == 1
    assert conn.rollback_count == 0


def test_postgres_lease_release_commits_without_caller_transaction() -> None:
    store, conn, record = _postgres_store()

    released = store.release(record.lease_id, tenant_id=record.tenant_id)

    assert released.lease_id == record.lease_id
    assert conn.commit_count == 1
    assert conn.rollback_count == 0


def test_postgres_lease_renew_commits_without_caller_transaction() -> None:
    store, conn, record = _postgres_store()

    renewed = store.renew(record)

    assert renewed.project_id == "project-real"
    assert conn.commit_count == 1
    assert conn.rollback_count == 0


def test_acquire_requires_service_credential() -> None:
    client = _client()
    payload = {
        "tenant_id": "tenant",
        "run_id": "run-1",
        "project_id": "project",
        "base_checkpoint_id": "ckpt",
    }

    assert client.post("/leases", json=payload).status_code == 401
    assert client.post("/leases", headers=service_headers(), json=payload).status_code == 200


def test_lease_routes_reject_absent_or_forged_credentials() -> None:
    client = _client()
    body = _acquire(client)
    lease_id = body["lease_id"]

    assert client.get("/leases", headers={"X-Loopit-Tenant": "tenant"}).status_code == 401
    assert client.post(f"/leases/{lease_id}/renew", json={"tenant_id": "tenant"}).status_code == 401
    assert (
        client.post(
            f"/leases/{lease_id}/release",
            headers=lease_headers("forged.token"),
            json={"tenant_id": "tenant"},
        ).status_code
        == 401
    )


def test_release_requires_verified_lease_ownership() -> None:
    client = _client()
    tenant = _acquire(client, "tenant")
    victim = _acquire(client, "victim")

    stolen_release = client.post(
        f"/leases/{victim['lease_id']}/release",
        headers=lease_headers(tenant["lease_token"]),
        json={},
    )
    assert stolen_release.status_code == 404

    still_listed = client.get("/leases", headers=lease_headers(victim["lease_token"]))
    assert still_listed.status_code == 200
    assert still_listed.json()["leases"][0]["lease_id"] == victim["lease_id"]


def test_service_release_requires_tenant_ownership() -> None:
    client = _client()
    victim = _acquire(client, "victim")

    wrong_tenant = client.post(
        f"/leases/{victim['lease_id']}/release",
        headers=service_headers(),
        json={"tenant_id": "tenant"},
    )
    assert wrong_tenant.status_code == 404

    released = client.post(
        f"/leases/{victim['lease_id']}/release",
        headers=service_headers(),
        json={"tenant_id": "victim"},
    )
    assert released.status_code == 200


def test_acquire_concurrency_denied() -> None:
    client = _client()
    payload = {
        "tenant_id": "tenant",
        "run_id": "run-1",
        "project_id": "project",
        "base_checkpoint_id": "ckpt",
    }
    assert client.post("/leases", headers=service_headers(), json=payload).status_code == 200
    payload["run_id"] = "run-2"
    assert client.post("/leases", headers=service_headers(), json=payload).status_code == 429
