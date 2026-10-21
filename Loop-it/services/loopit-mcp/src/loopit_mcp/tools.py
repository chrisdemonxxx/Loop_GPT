"""MCP tool catalog over Loop-it FastAPI routes."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from .client import LoopitApiClient, LoopitApiError

JsonSchema = dict[str, Any]


@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: str
    description: str
    input_schema: JsonSchema
    handler: Callable[[LoopitApiClient, str, Mapping[str, Any]], Any]


def _object(properties: dict[str, JsonSchema], required: tuple[str, ...] = ()) -> JsonSchema:
    schema: JsonSchema = {"type": "object", "properties": properties, "additionalProperties": False}
    if required:
        schema["required"] = list(required)
    return schema


def start_run(client: LoopitApiClient, token: str, args: Mapping[str, Any]) -> Any:
    body: dict[str, Any] = {"prompt": str(args["prompt"])}
    if args.get("project_id"):
        body["project_id"] = str(args["project_id"])
    if args.get("stack"):
        body["stack"] = str(args["stack"])
    if args.get("difficulty"):
        body["difficulty"] = str(args["difficulty"])
    if args.get("max_iterations") is not None:
        body["max_iterations"] = int(args["max_iterations"])
    return client.request("POST", "/api/runs", token=token, json=body)


def get_run(client: LoopitApiClient, token: str, args: Mapping[str, Any]) -> Any:
    return client.request("GET", f"/api/runs/{args['run_id']}", token=token)


def list_runs(client: LoopitApiClient, token: str, args: Mapping[str, Any]) -> Any:
    del args
    return client.request("GET", "/api/runs", token=token)


def list_gates(client: LoopitApiClient, token: str, args: Mapping[str, Any]) -> Any:
    return client.request("GET", f"/api/runs/{args['run_id']}/gates", token=token)


def approve_gate(client: LoopitApiClient, token: str, args: Mapping[str, Any]) -> Any:
    return client.request(
        "POST",
        f"/api/runs/{args['run_id']}/gates/{args['gate_id']}/approve",
        token=token,
        json={"reason": str(args["reason"])},
    )


def reject_gate(client: LoopitApiClient, token: str, args: Mapping[str, Any]) -> Any:
    return client.request(
        "POST",
        f"/api/runs/{args['run_id']}/gates/{args['gate_id']}/reject",
        token=token,
        json={"reason": str(args["reason"])},
    )


def list_checkpoints(client: LoopitApiClient, token: str, args: Mapping[str, Any]) -> Any:
    return client.request("GET", f"/api/projects/{args['project_id']}/checkpoints", token=token)


def create_preview(client: LoopitApiClient, token: str, args: Mapping[str, Any]) -> Any:
    path = str(args.get("path") or "index.html")
    return client.request(
        "POST",
        f"/api/projects/{args['project_id']}/preview",
        token=token,
        json={"path": path},
    )


def deploy_project(client: LoopitApiClient, token: str, args: Mapping[str, Any]) -> Any:
    return client.request(
        "POST",
        f"/api/projects/{args['project_id']}/deploy",
        token=token,
        json={
            "checkpoint_id": str(args["checkpoint_id"]),
            "confirmed": True,
            "reason": str(args.get("reason") or "mcp deploy of green checkpoint"),
        },
    )


def git_export(client: LoopitApiClient, token: str, args: Mapping[str, Any]) -> Any:
    """Compose checkpoint list + preview URL. Remote git push stays loopit-gitsync."""
    project_id = str(args["project_id"])
    checkpoints = client.request("GET", f"/api/projects/{project_id}/checkpoints", token=token)
    preview = client.request(
        "POST",
        f"/api/projects/{project_id}/preview",
        token=token,
        json={"path": str(args.get("path") or "index.html")},
    )
    return {
        "project_id": project_id,
        "checkpoints": checkpoints,
        "preview": preview,
        "git_remote": None,
        "note": (
            "Owned code is the checkpoint tree plus the preview URL. Binding a git "
            "remote and pushing verified checkpoints is loopit-gitsync (not this portal)."
        ),
    }


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        "start_run",
        "Start a Loop-it sandboxed build run from a prompt. Returns run_id, project_id, status.",
        _object(
            {
                "prompt": {"type": "string", "minLength": 1, "maxLength": 4000},
                "project_id": {"type": "string"},
                "stack": {"type": "string"},
                "difficulty": {"type": "string"},
                "max_iterations": {"type": "integer", "minimum": 1, "maximum": 40},
            },
            ("prompt",),
        ),
        start_run,
    ),
    ToolSpec(
        "get_run",
        "Get a Loop-it run: status, gates, files, cost fields.",
        _object({"run_id": {"type": "string"}}, ("run_id",)),
        get_run,
    ),
    ToolSpec(
        "list_runs",
        "List Loop-it runs for the authenticated tenant.",
        _object({}),
        list_runs,
    ),
    ToolSpec(
        "list_gates",
        "List pending and resolved confirmation gates for a run (I7).",
        _object({"run_id": {"type": "string"}}, ("run_id",)),
        list_gates,
    ),
    ToolSpec(
        "approve_gate",
        "Approve a pending destructive-action gate. Requires a reason.",
        _object(
            {
                "run_id": {"type": "string"},
                "gate_id": {"type": "string"},
                "reason": {"type": "string", "minLength": 1, "maxLength": 1000},
            },
            ("run_id", "gate_id", "reason"),
        ),
        approve_gate,
    ),
    ToolSpec(
        "reject_gate",
        "Reject a pending destructive-action gate. Requires a reason.",
        _object(
            {
                "run_id": {"type": "string"},
                "gate_id": {"type": "string"},
                "reason": {"type": "string", "minLength": 1, "maxLength": 1000},
            },
            ("run_id", "gate_id", "reason"),
        ),
        reject_gate,
    ),
    ToolSpec(
        "list_checkpoints",
        "List checkpoints for a Loop-it project.",
        _object({"project_id": {"type": "string"}}, ("project_id",)),
        list_checkpoints,
    ),
    ToolSpec(
        "create_preview",
        "Mint a signed preview URL for a project's generated site.",
        _object(
            {
                "project_id": {"type": "string"},
                "path": {"type": "string"},
            },
            ("project_id",),
        ),
        create_preview,
    ),
    ToolSpec(
        "deploy_project",
        "Promote a verified checkpoint to a live preview URL (I7 confirmation).",
        _object(
            {
                "project_id": {"type": "string"},
                "checkpoint_id": {"type": "string"},
                "reason": {"type": "string"},
            },
            ("project_id", "checkpoint_id"),
        ),
        deploy_project,
    ),
    ToolSpec(
        "git_export",
        "Export owned project artifacts: checkpoints plus a preview URL. No git remote push.",
        _object(
            {
                "project_id": {"type": "string"},
                "path": {"type": "string"},
            },
            ("project_id",),
        ),
        git_export,
    ),
)

_BY_NAME = {tool.name: tool for tool in TOOLS}


def list_tool_descriptors() -> list[dict[str, Any]]:
    return [
        {
            "name": tool.name,
            "description": tool.description,
            "inputSchema": tool.input_schema,
        }
        for tool in TOOLS
    ]


def dispatch_tool(
    name: str,
    arguments: Mapping[str, Any],
    *,
    client: LoopitApiClient,
    token: str,
) -> Any:
    tool = _BY_NAME.get(name)
    if tool is None:
        raise LoopitApiError(404, f"unknown tool {name!r}")
    return tool.handler(client, token, arguments)
