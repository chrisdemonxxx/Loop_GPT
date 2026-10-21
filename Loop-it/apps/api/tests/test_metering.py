"""Build model usage is billed to Loop-GPT credits, and a refused charge stops the run."""

from __future__ import annotations

import secrets
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from loopit_agent_core.model import ModelResponse
from loopit_api.app import create_app, offline_model_factory
from loopit_api.metering import (
    CreditsExhausted,
    LoopGptUsageMeter,
    MeteringUnavailable,
    credits_url_from_usage,
)
from loopit_auth import TokenSigner

IDENTITY_SECRET = secrets.token_urlsafe(32)
USAGE_URL = "http://loop-gpt.internal/api/loopit/usage"
CREDITS_URL = credits_url_from_usage(USAGE_URL)


@pytest.fixture(autouse=True)
def api_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_IDENTITY_SECRET", IDENTITY_SECRET)
    monkeypatch.setenv("LOOPIT_PREVIEW_SIGNING_KEY", secrets.token_urlsafe(32))
    monkeypatch.delenv("LOOPIT_USAGE_URL", raising=False)


def _signer() -> TokenSigner:
    return TokenSigner(
        issuer="loopit-gateway",
        audience="loopit-control-plane",
        keys={"local-1": IDENTITY_SECRET.encode()},
        current_kid="local-1",
    )


class _Parent:
    """Stands in for Loop-GPT's usage endpoint."""

    def __init__(self, *statuses: int) -> None:
        self.statuses = list(statuses)
        self.calls: list[tuple[str, dict[str, Any], str]] = []

    def __call__(self, url: str, body: Any, token: str) -> tuple[int, str]:
        self.calls.append((url, dict(body), token))
        status = self.statuses.pop(0) if self.statuses else 200
        if status == 402:
            return status, '{"error":"Out of daily credits"}'
        return status, "{}"


class _Credits:
    """Stands in for Loop-GPT's credits preflight endpoint."""

    def __init__(self, *, credits: int = 10, unlimited: bool = False, status: int = 200) -> None:
        self.credits = credits
        self.unlimited = unlimited
        self.status = status
        self.calls: list[tuple[str, str]] = []

    def __call__(self, url: str, token: str) -> tuple[int, str]:
        self.calls.append((url, token))
        if self.status != 200:
            return self.status, '{"error":"Out of daily credits"}'
        return 200, f'{{"credits":{self.credits},"unlimited":{"true" if self.unlimited else "false"}}}'


def _response(tokens: int = 1200) -> ModelResponse:
    return ModelResponse(
        content="{}",
        model="qwen-coder",
        input_tokens=tokens,
        output_tokens=300,
        cached_input_tokens=100,
    )


def _meter(parent: _Parent, credits: _Credits | None = None) -> LoopGptUsageMeter:
    return LoopGptUsageMeter(
        url=USAGE_URL,
        signer=_signer(),
        post=parent,
        get=credits or _Credits(),
        backoff_seconds=0,
    )


def test_posts_an_idempotent_inference_event_as_the_runs_actor() -> None:
    parent = _Parent(200)
    _meter(parent).record(
        run_id="run_1", tenant_id="ws_1", actor_id="user_1", call_index=3, response=_response()
    )

    [(url, body, token)] = parent.calls
    assert url == USAGE_URL
    assert body == {
        "idempotencyKey": "run_1:model:3",
        "kind": "inference",
        "model": "qwen-coder",
        "inputTokens": 1200,
        "outputTokens": 300,
        "cachedInputTokens": 100,
        "runId": "run_1",
    }
    identity = _signer().verify_identity(token)
    assert (identity.subject, identity.org_id) == ("user_1", "ws_1")


def test_responses_without_usage_are_not_posted() -> None:
    parent = _Parent()
    _meter(parent).record(
        run_id="run_1",
        tenant_id="ws_1",
        actor_id="user_1",
        call_index=1,
        response=ModelResponse(content="{}", model="offline-demo"),
    )
    assert parent.calls == []


def test_out_of_credits_is_a_quota_refusal() -> None:
    with pytest.raises(CreditsExhausted):
        _meter(_Parent(402)).record(
            run_id="r", tenant_id="ws", actor_id="u", call_index=1, response=_response()
        )


def test_transient_failures_are_retried_with_the_same_key() -> None:
    parent = _Parent(503, 200)
    _meter(parent).record(
        run_id="r", tenant_id="ws", actor_id="u", call_index=1, response=_response()
    )
    assert [body["idempotencyKey"] for _, body, _ in parent.calls] == ["r:model:1", "r:model:1"]


def test_metering_fails_closed() -> None:
    with pytest.raises(MeteringUnavailable):
        _meter(_Parent(503, 503, 503)).record(
            run_id="r", tenant_id="ws", actor_id="u", call_index=1, response=_response()
        )
    rejected = _Parent(400)
    with pytest.raises(MeteringUnavailable):
        _meter(rejected).record(
            run_id="r", tenant_id="ws", actor_id="u", call_index=1, response=_response()
        )
    assert len(rejected.calls) == 1


def _billable_factory() -> Any:
    offline = offline_model_factory()

    def factory(run_id: str, tenant_id: str) -> tuple[Any, Any]:
        client, ledger = offline(run_id, tenant_id)
        client.script[:] = [
            replace(item, input_tokens=900, output_tokens=100) for item in client.script
        ]
        return client, ledger

    return factory


def _client(
    tmp_path: Path, parent: _Parent, credits: _Credits | None = None
) -> tuple[TestClient, _Credits]:
    balance = credits or _Credits()
    app = create_app(
        projects_root=tmp_path / "projects",
        model_factory=_billable_factory(),
        offline=True,
        usage_meter=LoopGptUsageMeter(
            url=USAGE_URL,
            signer=_signer(),
            post=parent,
            get=balance,
            backoff_seconds=0,
        ),
    )
    client = TestClient(app)
    token = client.post(
        "/api/auth/register",
        json={"email": "meter@example.com", "password": "password-123", "org_name": "Acme"},
    ).json()["access_token"]
    client.headers.update({"Authorization": f"Bearer {token}"})
    return client, balance


def _finish(client: TestClient, run_id: str) -> dict[str, Any]:
    for _ in range(200):
        run = client.get(f"/api/runs/{run_id}").json()
        if run["status"] not in {"planning", "running"}:
            return run
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def test_credits_url_is_derived_from_usage_url() -> None:
    assert credits_url_from_usage(USAGE_URL) == "http://loop-gpt.internal/api/loopit/credits"


def test_ensure_credits_refuses_a_zero_balance() -> None:
    with pytest.raises(CreditsExhausted):
        _meter(_Parent(), _Credits(credits=0)).ensure_credits(
            tenant_id="ws", actor_id="u", minimum=1
        )


def test_ensure_credits_allows_unlimited() -> None:
    _meter(_Parent(), _Credits(credits=0, unlimited=True)).ensure_credits(
        tenant_id="ws", actor_id="u", minimum=1
    )


def test_preflight_blocks_start_when_parent_balance_is_zero(tmp_path: Path) -> None:
    parent = _Parent()
    client, balance = _client(tmp_path, parent, credits=_Credits(credits=0))
    refused = client.post("/api/runs", json={"prompt": "build a page"})
    assert refused.status_code == 402
    assert balance.calls and balance.calls[0][0] == CREDITS_URL
    assert parent.calls == []


def test_every_model_call_of_a_build_is_billed(tmp_path: Path) -> None:
    parent = _Parent()
    client, balance = _client(tmp_path, parent)
    me = client.get("/api/auth/me").json()
    run = client.post("/api/runs", json={"prompt": "build a page"}).json()
    _finish(client, run["run_id"])

    assert balance.calls and balance.calls[0][0] == CREDITS_URL
    keys = [body["idempotencyKey"] for _, body, _ in parent.calls]
    assert keys == [f"{run['run_id']}:model:1", f"{run['run_id']}:model:2"]
    for _, _, token in parent.calls:
        identity = _signer().verify_identity(token)
        assert (identity.subject, identity.org_id) == (me["user_id"], me["org_id"])


def test_running_out_of_credits_stops_the_build(tmp_path: Path) -> None:
    parent = _Parent(402)
    client, _balance = _client(tmp_path, parent)
    run = client.post("/api/runs", json={"prompt": "build a page"}).json()
    finished = _finish(client, run["run_id"])

    assert finished["status"] == "budget_exceeded"
    assert "out of Loop credits" in finished["summary"]
    # The refused call is the last one: nothing more was spent or posted.
    assert len(parent.calls) == 1
