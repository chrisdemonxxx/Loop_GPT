"""Validate every JSON Schema in ``packages/contracts/schemas``.

Run in CI (job ``contracts``). Checks that each schema is itself a valid
JSON Schema 2020-12 document, that ``$id`` matches the filename, and that
every example under ``schemas/examples/<schema-stem>/`` validates.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ModuleNotFoundError:  # pragma: no cover - CI installs this
    print("jsonschema is not installed; run `uv sync --dev`", file=sys.stderr)
    raise SystemExit(2) from None

SCHEMA_DIR = Path(__file__).parent / "schemas"
EXAMPLE_DIR = SCHEMA_DIR / "examples"


def main() -> int:
    failures: list[str] = []
    schemas = sorted(SCHEMA_DIR.glob("*.schema.json"))
    if not schemas:
        print(f"no schemas found in {SCHEMA_DIR}", file=sys.stderr)
        return 1

    for path in schemas:
        try:
            schema = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            failures.append(f"{path.name}: invalid JSON: {exc}")
            continue

        try:
            Draft202012Validator.check_schema(schema)
        except Exception as exc:
            failures.append(f"{path.name}: not a valid JSON Schema 2020-12: {exc}")
            continue

        expected_id_suffix = f"/{path.name}"
        schema_id = schema.get("$id", "")
        if not schema_id.endswith(expected_id_suffix):
            failures.append(
                f"{path.name}: $id {schema_id!r} does not end with {expected_id_suffix!r}"
            )

        validator = Draft202012Validator(schema)
        stem = path.name.removesuffix(".schema.json")
        for example in sorted((EXAMPLE_DIR / stem).glob("*.json")) if EXAMPLE_DIR.exists() else []:
            instance = json.loads(example.read_text(encoding="utf-8"))
            should_fail = example.stem.startswith("invalid")
            errors = list(validator.iter_errors(instance))
            if should_fail and not errors:
                failures.append(f"{stem}/{example.name}: expected validation failure, got none")
            elif not should_fail and errors:
                detail = "; ".join(e.message for e in errors[:3])
                failures.append(f"{stem}/{example.name}: unexpected validation failure: {detail}")

        print(f"ok  {path.name}")

    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
