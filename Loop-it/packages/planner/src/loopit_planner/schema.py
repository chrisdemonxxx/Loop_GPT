"""JSON Schema validation against the contracts package authority."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, cast

from jsonschema import Draft202012Validator

from .models import TaskDAG


@lru_cache(maxsize=1)
def task_dag_schema() -> dict[str, Any]:
    schema_path = (
        Path(__file__).resolve().parents[3] / "contracts" / "schemas" / "task-dag.schema.json"
    )
    return cast(dict[str, Any], json.loads(schema_path.read_text(encoding="utf-8")))


@lru_cache(maxsize=1)
def task_dag_validator() -> Draft202012Validator:
    return Draft202012Validator(task_dag_schema())


def validate_schema(dag: TaskDAG) -> list[str]:
    errors = sorted(task_dag_validator().iter_errors(dag.to_json()), key=lambda item: item.path)
    return [error.message for error in errors]
