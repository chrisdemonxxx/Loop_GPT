from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_agent_core.config import SecretConfigurationError
from loopit_auth import TokenSigner
from loopit_router.quota import QuotaLedger, TenantQuota
from loopit_router.router import ModelRouter
from loopit_router.routing import InMemoryModelSelectionStore, default_policy
from loopit_router.upstream import StaticSecretResolver, UpstreamRequest, UpstreamResult

SECRET = "lease-token-secret-with-at-least-thirty-two-bytes"
IDENTITY_SECRET = "identity-secret-with-at-least-thirty-two-bytes"
MODEL_API_KEY = "model-api-key-with-at-least-thirty-two-bytes"

os.environ.setdefault("LOOPIT_LEASE_TOKEN_SECRET", SECRET)
os.environ.setdefault("LOOPIT_IDENTITY_SECRET", IDENTITY_SECRET)
os.environ.setdefault("LOOPIT_MODEL_API_KEY", MODEL_API_KEY)

from loopit_router.server import RouterSettings, create_app, mint_lease_token  # noqa: E402


class RecordingUpstream:
    def __init__(self) -> None:
        self.requests: list[UpstreamRequest] = []

    def complete(self, request: UpstreamRequest) -> UpstreamResult:
        self.requests.append(request)
        return UpstreamResult(content="hello", input_tokens=1, output_tokens=2, model=request.model)


def _client(limit: float = 100.0) -> tuple[TestClient, RecordingUpstream]:
    upstream = RecordingUpstream()
    policy = default_policy()
    refs = {spec.credential_ref for route in policy.routes.values() for spec in route}
    selection_store = InMemoryModelSelectionStore()
    router = ModelRouter(
        policy=policy,
        upstream=upstream,
        ledger=QuotaLedger({"tenant": TenantQuota("tenant", limit)}),
        secrets=StaticSecretResolver({ref: "sk-server-side-only" for ref in refs}),
        audit=InMemoryAuditSink(),
        selection_store=selection_store,
    )
    app = create_app(
        router=router,
        settings=RouterSettings(
            lease_token_secret=SECRET,
            identity_secret=IDENTITY_SECRET,
            default_credit_limit=limit,
        ),
    )
    app.state.selection_store = selection_store
    return TestClient(app), upstream


def _token(expires_delta: int = 300) -> str:
    return mint_lease_token(
        tenant_id="tenant",
        lease_id="lease",
        run_id="run",
        project_id="project",
        expires_at=(datetime.now(UTC) + timedelta(seconds=expires_delta)).timestamp(),
        secret=SECRET,
    )


def _identity(role: str = "owner", org_id: str = "tenant") -> str:
    signer = TokenSigner(
        issuer="loopit-gateway",
        audience="loopit-control-plane",
        keys={"local-1": IDENTITY_SECRET.encode()},
        current_kid="local-1",
    )
    return signer.mint_identity(
        subject="user",
        org_id=org_id,
        role=role,  # type: ignore[arg-type]
        scopes=("api",),
    )


@pytest.mark.parametrize(
    "name", ["LOOPIT_LEASE_TOKEN_SECRET", "LOOPIT_IDENTITY_SECRET", "LOOPIT_MODEL_API_KEY"]
)
@pytest.mark.parametrize("bad_value", [None, "too-short", "dev-router-key-change-me"])
def test_settings_reject_missing_short_or_placeholder_secrets(
    monkeypatch: pytest.MonkeyPatch, name: str, bad_value: str | None
) -> None:
    monkeypatch.setenv("LOOPIT_LEASE_TOKEN_SECRET", SECRET)
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", IDENTITY_SECRET)
    monkeypatch.setenv("LOOPIT_MODEL_API_KEY", MODEL_API_KEY)
    if bad_value is None:
        monkeypatch.delenv(name)
    else:
        monkeypatch.setenv(name, bad_value)

    with pytest.raises(SecretConfigurationError):
        RouterSettings.from_env()


def test_settings_accept_valid_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_LEASE_TOKEN_SECRET", SECRET)
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", IDENTITY_SECRET)
    monkeypatch.setenv("LOOPIT_MODEL_API_KEY", MODEL_API_KEY)

    settings = RouterSettings.from_env()

    assert settings.lease_token_secret == SECRET
    assert settings.identity_secret == IDENTITY_SECRET
    assert settings.model_api_key == MODEL_API_KEY


def test_health_and_ready() -> None:
    client, _ = _client()
    assert client.get("/healthz").status_code == 200
    assert client.get("/readyz").status_code == 200


def test_chat_requires_lease_token() -> None:
    client, _ = _client()
    response = client.post("/v1/chat/completions", json={"messages": []})
    assert response.status_code == 401


def test_chat_accepts_identity_jwt_for_portal_without_client_keys() -> None:
    client, upstream = _client()
    response = client.post(
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {_identity()}", "X-Loopit-Difficulty": "trivial"},
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "hello"
    assert upstream.requests[0].api_key == "sk-server-side-only"


def test_rejects_client_supplied_upstream_key() -> None:
    client, _ = _client()
    response = client.post(
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {_token()}"},
        json={"messages": [{"role": "user", "content": "hi"}], "api_key": "sk-client"},
    )
    assert response.status_code == 400


def test_rejects_client_supplied_upstream_base_url() -> None:
    client, _ = _client()
    response = client.post(
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {_token()}"},
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "upstream_base_url": "https://attacker.example",
        },
    )
    assert response.status_code == 400


def test_routes_openai_chat_with_server_side_key() -> None:
    client, upstream = _client()
    response = client.post(
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {_token()}", "X-Loopit-Difficulty": "trivial"},
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "hello"
    assert upstream.requests[0].api_key == "sk-server-side-only"


def test_chat_leaves_max_tokens_unbounded_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOOPIT_MAX_OUTPUT_TOKENS", raising=False)
    client, upstream = _client()
    response = client.post(
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {_token()}", "X-Loopit-Difficulty": "trivial"},
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 200
    assert upstream.requests[0].max_output_tokens is None


def test_chat_respects_explicit_max_tokens() -> None:
    client, upstream = _client()
    response = client.post(
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {_token()}", "X-Loopit-Difficulty": "trivial"},
        json={"messages": [{"role": "user", "content": "hi"}], "max_tokens": 512},
    )
    assert response.status_code == 200
    assert upstream.requests[0].max_output_tokens == 512


def test_expired_lease_token_is_denied() -> None:
    client, _ = _client()
    response = client.post(
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {_token(-1)}"},
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 401


def test_quota_enforcement_returns_429() -> None:
    client, _ = _client(limit=0.00001)
    response = client.post(
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {_token()}"},
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 429


def test_catalog_endpoint_is_rbac_gated() -> None:
    client, _ = _client()
    unauthenticated = client.get("/v1/models/catalog?org_id=tenant")
    assert unauthenticated.status_code == 401

    response = client.get(
        "/v1/models/catalog?org_id=tenant",
        headers={"Authorization": f"Bearer {_identity('viewer')}"},
    )
    assert response.status_code == 200
    models = response.json()["models"]
    assert {model["id"] for model in models} >= {"loopit/small", "loopit/coder", "loopit/planner"}
    assert "credential_ref" not in models[0]


def test_selection_endpoint_updates_project_routing_and_chat_uses_it() -> None:
    client, upstream = _client()
    response = client.put(
        "/v1/model-selection",
        headers={"Authorization": f"Bearer {_identity('member')}"},
        json={
            "org_id": "tenant",
            "project_id": "project",
            "routes": {
                "trivial": ["loopit/coder"],
                "implementation": ["loopit/planner"],
                "planning": ["loopit/planner"],
            },
        },
    )
    assert response.status_code == 200

    chat = client.post(
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {_token()}", "X-Loopit-Difficulty": "trivial"},
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert chat.status_code == 200
    assert upstream.requests[-1].model == "loopit/coder"


def test_selection_rejects_arbitrary_upstream_or_ineligible_model() -> None:
    client, _ = _client()
    injected = client.put(
        "/v1/model-selection",
        headers={"Authorization": f"Bearer {_identity('owner')}"},
        json={
            "org_id": "tenant",
            "upstream_base_url": "https://attacker.example",
            "routes": {
                "trivial": ["loopit/small"],
                "implementation": ["loopit/coder"],
                "planning": ["loopit/planner"],
            },
        },
    )
    assert injected.status_code == 400

    ineligible = client.put(
        "/v1/model-selection",
        headers={"Authorization": f"Bearer {_identity('owner')}"},
        json={
            "org_id": "tenant",
            "routes": {
                "trivial": ["loopit/small"],
                "implementation": ["loopit/coder"],
                "planning": ["loopit/small"],
            },
        },
    )
    assert ineligible.status_code == 400


def test_viewer_cannot_update_selection() -> None:
    client, _ = _client()
    response = client.put(
        "/v1/model-selection",
        headers={"Authorization": f"Bearer {_identity('viewer')}"},
        json={
            "org_id": "tenant",
            "routes": {
                "trivial": ["loopit/small"],
                "implementation": ["loopit/coder"],
                "planning": ["loopit/planner"],
            },
        },
    )
    assert response.status_code == 403
