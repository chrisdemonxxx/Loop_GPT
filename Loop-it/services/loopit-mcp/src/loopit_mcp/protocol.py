"""Minimal MCP JSON-RPC (streamable HTTP, application/json responses)."""

from __future__ import annotations

import json
from typing import Any

from .client import LoopitApiClient, LoopitApiError
from .tools import dispatch_tool, list_tool_descriptors

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "loopit", "version": "0.1.0"}
INSTRUCTIONS = (
    "Build with Loop-it. start_run kicks a sandboxed Temporal build. "
    "Poll get_run. list_gates / approve_gate / reject_gate handle I7 confirmation. "
    "create_preview returns a signed site URL. git_export returns checkpoints plus that URL. "
    "The portal must send a Loop-it identity JWT as Authorization: Bearer. "
    "Never send model API keys; Loop-it router-svc owns upstream credentials."
)


def handle_rpc(
    payload: Any,
    *,
    client: LoopitApiClient,
    token: str,
) -> dict[str, Any] | list[dict[str, Any]] | None:
    if isinstance(payload, list):
        return [item for item in (_dispatch_one(item, client, token) for item in payload) if item]
    if isinstance(payload, dict):
        result = _dispatch_one(payload, client, token)
        return result
    return _rpc_error(None, -32600, "invalid request")


def _dispatch_one(
    message: dict[str, Any], client: LoopitApiClient, token: str
) -> dict[str, Any] | None:
    if message.get("jsonrpc") != "2.0":
        return _rpc_error(message.get("id"), -32600, "invalid request")
    method = message.get("method")
    req_id = message.get("id")
    raw_params = message.get("params")
    params: dict[str, Any] = raw_params if isinstance(raw_params, dict) else {}
    if not isinstance(method, str):
        return _rpc_error(req_id, -32600, "invalid request")
    if req_id is None:
        return None
    if method not in {"initialize", "ping", "tools/list", "tools/call"}:
        return _rpc_error(req_id, -32601, f"method not found: {method}")
    try:
        result = _call_method(method, params, client=client, token=token)
    except LoopitApiError as error:
        if error.status_code in {401, 403}:
            return _rpc_error(req_id, -32001, error.detail)
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "content": [{"type": "text", "text": error.detail}],
                "isError": True,
            },
        }
    except KeyError as error:
        return _rpc_error(req_id, -32602, f"missing argument {error.args[0]!r}")
    except (TypeError, ValueError) as error:
        return _rpc_error(req_id, -32602, str(error))
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _call_method(
    method: str,
    params: dict[str, Any],
    *,
    client: LoopitApiClient,
    token: str,
) -> Any:
    if method == "initialize":
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
            "instructions": INSTRUCTIONS,
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": list_tool_descriptors()}
    if method == "tools/call":
        name = str(params.get("name") or "")
        arguments = params.get("arguments")
        if not isinstance(arguments, dict):
            arguments = {}
        data = dispatch_tool(name, arguments, client=client, token=token)
        text = data if isinstance(data, str) else json.dumps(data, default=str)
        return {"content": [{"type": "text", "text": text}], "isError": False}
    raise AssertionError(f"unhandled MCP method {method}")


def _rpc_error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}
