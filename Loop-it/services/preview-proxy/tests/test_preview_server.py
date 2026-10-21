from __future__ import annotations

import os
import time

import httpx2
import pytest
from fastapi.testclient import TestClient
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_agent_core.config import SecretConfigurationError
from loopit_preview import Backend, PreviewProxy, Route, RouteTable, TokenSigner, mint_for

KEY = b"k" * 32
KEY_TEXT = "k" * 32
HOST = "proj.preview.loopit.dev"

os.environ.setdefault("LOOPIT_PREVIEW_SIGNING_KEY", KEY_TEXT)
os.environ.setdefault("LOOPIT_AUDIT_EPHEMERAL", "1")

from loopit_preview.server import PreviewSettings, create_app  # noqa: E402


@pytest.mark.parametrize("bad_value", [None, "too-short", "dev-preview-key-change-me"])
def test_settings_reject_missing_short_or_placeholder_signing_key(
    monkeypatch: pytest.MonkeyPatch, bad_value: str | None
) -> None:
    if bad_value is None:
        monkeypatch.delenv("LOOPIT_PREVIEW_SIGNING_KEY", raising=False)
    else:
        monkeypatch.setenv("LOOPIT_PREVIEW_SIGNING_KEY", bad_value)

    with pytest.raises(SecretConfigurationError):
        PreviewSettings.from_env()


def test_settings_accept_valid_signing_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_PREVIEW_SIGNING_KEY", KEY_TEXT)
    monkeypatch.setenv("LOOPIT_AUDIT_EPHEMERAL", "1")

    assert PreviewSettings.from_env().signing_key == KEY_TEXT


def test_settings_require_audit_dsn_unless_ephemeral_dev_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LOOPIT_PREVIEW_SIGNING_KEY", KEY_TEXT)
    monkeypatch.delenv("LOOPIT_AUDIT_DSN", raising=False)
    monkeypatch.delenv("LOOPIT_AUDIT_EPHEMERAL", raising=False)

    with pytest.raises(SecretConfigurationError):
        PreviewSettings.from_env()


def test_settings_allow_explicit_ephemeral_audit_for_dev(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LOOPIT_PREVIEW_SIGNING_KEY", KEY_TEXT)
    monkeypatch.delenv("LOOPIT_AUDIT_DSN", raising=False)
    monkeypatch.setenv("LOOPIT_AUDIT_EPHEMERAL", "1")

    assert PreviewSettings.from_env().audit_dsn == ""


def _client(ttl: int = 300) -> tuple[TestClient, str, list[httpx2.Request]]:
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(200, text="preview", headers={"Connection": "close"})

    routes = RouteTable()
    routes.bind(Route(HOST, "project", "tenant", "lease", Backend("backend.internal", 5173)))
    proxy = PreviewProxy(
        signer=TokenSigner(KEY),
        routes=routes,
        audit=InMemoryAuditSink(),
        preview_domain=".preview.loopit.dev",
    )
    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    token = mint_for(
        TokenSigner(KEY),
        project_id="project",
        tenant_id="tenant",
        lease_id="lease",
        subject="user",
        now=time.time(),
        ttl_seconds=ttl,
    )
    return TestClient(create_app(proxy=proxy, client=client)), token, seen


def test_healthz() -> None:
    client, _, _ = _client()
    assert client.get("/healthz").status_code == 200


def test_preview_requires_token() -> None:
    client, _, _ = _client()
    assert client.get("/", headers={"Host": HOST}).status_code == 401


def test_expired_token_is_denied() -> None:
    client, token, _ = _client(ttl=1)
    time.sleep(1.01)
    assert (
        client.get("/", headers={"Host": HOST, "Authorization": f"Bearer {token}"}).status_code
        == 404
    )


def test_reverse_proxy_strips_hop_headers_and_adds_security_headers() -> None:
    client, token, seen = _client()
    response = client.get(
        "/hello?secret=hidden",
        headers={
            "Host": HOST,
            "Authorization": f"Bearer {token}",
            "X-Loopit-Tenant": "attacker",
        },
    )
    assert response.status_code == 200
    assert response.text == "preview"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert seen[0].headers["x-loopit-tenant"] == "tenant"
