from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

from jsonschema import Draft202012Validator

RECIPE_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["id", "stack", "prompt_seed", "expected_dag", "verification"],
    "additionalProperties": False,
    "properties": {
        "id": {"type": "string", "pattern": "^[a-z0-9-]+$"},
        "stack": {"const": "react-postgres"},
        "prompt_seed": {"type": "string", "minLength": 20},
        "expected_dag": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["id", "kind", "depends_on"],
                "additionalProperties": False,
                "properties": {
                    "id": {"type": "string"},
                    "kind": {"type": "string"},
                    "depends_on": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "verification": {
            "type": "object",
            "required": ["commands", "browser_flows"],
            "additionalProperties": False,
            "properties": {
                "commands": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "browser_flows": {"type": "array", "items": {"type": "string"}},
            },
        },
    },
}


def load_recipe(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    Draft202012Validator(RECIPE_SCHEMA).validate(data)
    return cast(dict[str, Any], data)


def load_recipes(root: Path) -> tuple[dict[str, Any], ...]:
    return tuple(load_recipe(path) for path in sorted(root.glob("*.json")))
