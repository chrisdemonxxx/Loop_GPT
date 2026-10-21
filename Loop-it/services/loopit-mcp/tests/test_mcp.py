from __future__ import annotations

import json
from typing import Any

import httpx
from fastapi.testclient import TestClient
from loopit_mcp.client import LoopitApiClient
from loopit_mcp.protocol import handle_rpc
from loopit_mcp.server import Settings, create_app
from loopit_mcp.tools import dispatch_tool


def _api(handler: Any) -> LoopitApiClient:
    def transport(request: httpx.Request) -> httpx.Response:
        return handler(request)

    return LoopitApiClient("http://api.test", transport=httpx.MockTransport(transport))


def test_start_run_forwards_bearer_and_prompt() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200, json={"run_id": "run_1", "project_id": "proj_1", "status": "running"}
        )

    result = dispatch_tool(
        "start_run",
        {"prompt": "build a page", "max_iterations": 8},
        client=_api(handler),
        token="jwt-user",
    )

    assert result["run_id"] == "run_1"
    assert seen[0].headers["authorization"] == "Bearer jwt-user"
    assert json.loads(seen[0].content) == {"prompt": "build a page", "max_iterations": 8}


def test_approve_gate_posts_reason() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/runs/run_1/gates/gate_1/approve"
        assert json.loads(request.content) == {"reason": "operator approves"}
        return httpx.Response(200, json={"status": "approved"})

    result = dispatch_tool(
        "approve_gate",
        {"run_id": "run_1", "gate_id": "gate_1", "reason": "operator approves"},
        client=_api(handler),
        token="jwt",
    )
    assert result == {"status": "approved"}


def test_git_export_composes_checkpoints_and_preview() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=[{"checkpoint_id": "ckpt_1"}])
        return httpx.Response(
            200,
            json={"url": "/api/projects/proj_1/site/t/tok/index.html", "token_type": "signed_url"},
        )

    result = dispatch_tool(
        "git_export", {"project_id": "proj_1"}, client=_api(handler), token="jwt"
    )
    assert result["checkpoints"][0]["checkpoint_id"] == "ckpt_1"
    assert result["preview"]["url"].endswith("index.html")
    assert result["git_remote"] is None


def test_missing_token_fails_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not call the API without a token")

    rpc = handle_rpc(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_runs"}},
        client=_api(handler),
        token="",
    )
    assert rpc is not None
    assert rpc["error"]["code"] == -32001


def test_initialize_and_tools_list_do_not_need_a_token() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("catalog must not hit the API")

    client = _api(handler)
    init = handle_rpc(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        client=client,
        token="",
    )
    listed = handle_rpc(
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        client=client,
        token="",
    )
    assert init is not None
    assert listed is not None
    names = {tool["name"] for tool in listed["result"]["tools"]}
    assert names == {
        "start_run",
        "get_run",
        "list_runs",
        "list_gates",
        "approve_gate",
        "reject_gate",
        "list_checkpoints",
        "create_preview",
        "deploy_project",
        "git_export",
    }
    assert "model API keys" in init["result"]["instructions"]


def test_http_mcp_endpoint_round_trip() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/runs"
        return httpx.Response(200, json=[{"run_id": "run_1"}])

    app = create_app(Settings(api_base_url="http://api.test"), client=_api(handler))
    response = TestClient(app).post(
        "/mcp",
        headers={"Authorization": "Bearer jwt"},
        json={
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": "list_runs", "arguments": {}},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert json.loads(body["result"]["content"][0]["text"]) == [{"run_id": "run_1"}]
    assert response.headers["mcp-session-id"]


def test_healthz() -> None:
    app = create_app(Settings(), client=_api(lambda request: httpx.Response(500)))
    assert TestClient(app).get("/healthz").json() == {"status": "ok"}


def test_api_error_becomes_tool_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"detail": "no such run"})

    rpc = handle_rpc(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "get_run", "arguments": {"run_id": "run_nope"}},
        },
        client=_api(handler),
        token="jwt",
    )
    assert rpc is not None
    assert rpc["result"]["isError"] is True
    assert "no such run" in rpc["result"]["content"][0]["text"]
