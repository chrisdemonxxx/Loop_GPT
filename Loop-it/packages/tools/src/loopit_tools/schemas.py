"""Per-tool parameter schemas mirroring packages/contracts."""

from __future__ import annotations

from typing import Any, Final

PROJECT_PATH: Final[dict[str, Any]] = {
    "type": "string",
    "minLength": 1,
    "maxLength": 4096,
    "pattern": r"^(?!/)(?!.*(?:^|/)\.\.(?:/|$)).+$",
}

TOOL_PARAM_SCHEMAS: Final[dict[str, dict[str, Any]]] = {
    "read_file": {
        "type": "object",
        "required": ["path"],
        "additionalProperties": False,
        "properties": {
            "path": PROJECT_PATH,
            "start_line": {"type": "integer", "minimum": 1},
            "end_line": {"type": "integer", "minimum": 1},
        },
    },
    "search_code": {
        "type": "object",
        "required": ["query"],
        "additionalProperties": False,
        "properties": {
            "query": {"type": "string", "minLength": 1, "maxLength": 1000},
            "glob": {"type": "string"},
            "max_results": {"type": "integer", "minimum": 1, "maximum": 200},
        },
    },
    "apply_patch": {
        "type": "object",
        "required": ["patch"],
        "additionalProperties": False,
        "properties": {"patch": {"type": "string", "minLength": 1}},
    },
    "run_shell": {
        "type": "object",
        "required": ["command"],
        "additionalProperties": False,
        "properties": {
            "command": {"type": "string", "minLength": 1, "maxLength": 8000},
            "cwd": PROJECT_PATH,
            "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 1800},
        },
    },
    "install_package": {
        "type": "object",
        "required": ["package"],
        "additionalProperties": False,
        "properties": {
            "package": {"type": "string", "minLength": 1, "maxLength": 512},
            "manager": {
                "type": "string",
                "enum": ["npm", "pnpm", "yarn", "pip", "uv"],
            },
            "dev": {"type": "boolean"},
        },
    },
    "start_dev_server": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "command": {"type": "string", "minLength": 1, "maxLength": 8000},
            "cwd": PROJECT_PATH,
            "log_path": {"type": "string", "minLength": 1, "maxLength": 4096},
        },
    },
    "read_logs": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "path": {"type": "string", "minLength": 1, "maxLength": 4096},
            "lines": {"type": "integer", "minimum": 1, "maximum": 2000},
        },
    },
    "browser": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": False,
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "goto",
                    "click",
                    "fill",
                    "assert_text",
                    "screenshot",
                    "console_errors",
                    "smoke",
                ],
            },
            "path": {"type": "string"},
            "selector": {"type": "string"},
            "value": {"type": "string"},
            "flow": {"type": "string"},
        },
    },
    "provision": {
        "type": "object",
        "required": ["resource"],
        "additionalProperties": False,
        "properties": {
            "resource": {
                "type": "string",
                "enum": ["table", "auth", "storage_bucket", "edge_function", "seed"],
            },
            "spec": {"type": "object"},
        },
    },
    "deploy": {
        "type": "object",
        "required": ["target"],
        "additionalProperties": False,
        "properties": {
            "target": {"type": "string", "enum": ["managed", "git", "user_cloud"]},
            "environment": {"type": "string", "enum": ["preview", "prod"]},
        },
    },
    "request_secret": {
        "type": "object",
        "required": ["name"],
        "additionalProperties": False,
        "properties": {
            "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 64,
                "pattern": "^[A-Z][A-Z0-9_]{0,63}$",
            },
            "reason": {"type": "string", "maxLength": 1000},
        },
    },
}
