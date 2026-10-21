"""The ``provision`` tool handler (Doc 04 §3).

This is the seam where an agent-authored resource spec becomes a migration. Two
things happen here and nowhere else:

* **Strict parsing.** The contract schema types ``spec`` as a bare object, because
  JSON Schema's per-tool branches cannot express the shape without becoming
  unmaintainable. So the real shape check lives here, and it is strict: unknown
  keys are refused rather than ignored. Silently dropping an unrecognised key is
  how a spec that *looks* like it disabled RLS gets accepted and reported as
  success.
* **No credentials.** The handler never opens a database connection. It emits SQL
  and hands it to a runner injected by the control plane, which holds the
  project-scoped credential. The tool cannot reach a database it was not given.

Rejections are returned as observations rather than raised, because a malformed
spec is the loop's next input — the agent should correct it, not crash the run.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final, get_args

from .identifiers import IdentifierError
from .rls import AccessModel, RlsError
from .schema import COLUMN_TYPES, ColumnSpec, TableSpec, emit_migration

#: Applies a migration to a project's database. Injected by the control plane so
#: the handler never holds a credential of its own.
MigrationRunner = Callable[[str], None]

_TABLE_KEYS: Final[frozenset[str]] = frozenset({"name", "columns", "access"})
_COLUMN_KEYS: Final[frozenset[str]] = frozenset({"name", "type", "nullable", "default"})

#: Resources the tool understands today. Anything else is refused explicitly
#: rather than accepted and quietly ignored.
_IMPLEMENTED: Final[frozenset[str]] = frozenset({"table"})


class SpecError(ValueError):
    """An agent-supplied resource spec is malformed."""


@dataclass(frozen=True, slots=True)
class ProvisionOutcome:
    """The result of one provision call."""

    ok: bool
    output: str
    detail: Mapping[str, Any] = field(default_factory=dict)


def _require_mapping(value: object, what: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SpecError(f"{what} must be an object, got {type(value).__name__}")
    return value


def _reject_unknown(keys: Mapping[str, Any], allowed: frozenset[str], what: str) -> None:
    unknown = sorted(set(keys) - allowed)
    if unknown:
        raise SpecError(
            f"{what} has unsupported key(s) {unknown}; supported keys are {sorted(allowed)}"
        )


def _parse_column(raw: object, table: str) -> ColumnSpec:
    column = _require_mapping(raw, f"column of table {table!r}")
    _reject_unknown(column, _COLUMN_KEYS, f"column of table {table!r}")

    for required in ("name", "type"):
        if required not in column:
            raise SpecError(f"column of table {table!r} is missing {required!r}")

    nullable = column.get("nullable", True)
    if not isinstance(nullable, bool):
        raise SpecError(f"column {column['name']!r}: 'nullable' must be a boolean")

    default = column.get("default")
    if default is not None and not isinstance(default, str):
        raise SpecError(f"column {column['name']!r}: 'default' must be a string")

    return ColumnSpec(
        name=str(column["name"]),
        type=str(column["type"]),
        nullable=nullable,
        default=default,
    )


def parse_table_spec(raw: object) -> TableSpec:
    """Parse one agent-supplied table spec, strictly.

    Raises:
        SpecError: the spec is malformed, with a message naming the exact
            problem so the agent can correct it.
    """
    spec = _require_mapping(raw, "table spec")
    _reject_unknown(spec, _TABLE_KEYS, "table spec")

    for required in ("name", "columns", "access"):
        if required not in spec:
            raise SpecError(f"table spec is missing {required!r}")

    access = spec["access"]
    valid_access = get_args(AccessModel)
    if access not in valid_access:
        # No default is applied. Guessing at ownership is guessing at who may
        # read the data, which is the one thing that must never be inferred.
        raise SpecError(
            f"table {spec['name']!r}: 'access' must be one of {list(valid_access)}, "
            f"got {access!r}. 'owner' scopes rows to the signed-in user; "
            "'tenant' scopes them to the user's organisation."
        )

    columns = spec["columns"]
    if not isinstance(columns, Sequence) or isinstance(columns, (str, bytes)):
        raise SpecError(f"table {spec['name']!r}: 'columns' must be a list")

    name = str(spec["name"])
    return TableSpec(
        name=name,
        columns=tuple(_parse_column(column, name) for column in columns),
        access=access,
    )


def plan_migration(args: Mapping[str, Any]) -> tuple[str, tuple[TableSpec, ...]]:
    """Turn validated ``provision`` args into migration SQL.

    Raises:
        SpecError: the resource is unsupported or the spec is malformed.
    """
    resource = args.get("resource")
    if resource not in _IMPLEMENTED:
        raise SpecError(
            f"resource {resource!r} is not implemented yet; "
            f"supported resources are {sorted(_IMPLEMENTED)}"
        )

    spec = args.get("spec")
    if spec is None:
        raise SpecError("provision requires a 'spec' describing the resource")

    # One call may create several related tables, so they land in one
    # transaction rather than leaving a half-built schema between calls.
    raw_tables = spec.get("tables") if isinstance(spec, Mapping) and "tables" in spec else [spec]
    if not isinstance(raw_tables, Sequence) or isinstance(raw_tables, (str, bytes)):
        raise SpecError("'tables' must be a list of table specs")

    tables = tuple(parse_table_spec(table) for table in raw_tables)
    return emit_migration(tables), tables


def provision(args: Mapping[str, Any], *, run_migration: MigrationRunner) -> ProvisionOutcome:
    """Execute one ``provision`` call.

    Spec and identifier problems come back as a failed outcome carrying a
    corrective message; only an actual migration failure propagates.
    """
    try:
        sql, tables = plan_migration(args)
    except (SpecError, RlsError, IdentifierError) as error:
        return ProvisionOutcome(
            ok=False,
            output=f"provision REJECTED: {error}",
            detail={"error": type(error).__name__},
        )

    run_migration(sql)

    created = ", ".join(table.name for table in tables)
    summary = "\n".join(
        f"  {table.name}: row-level security forced, rows scoped by "
        f"{table.ownership_column} ({table.access})"
        for table in tables
    )
    return ProvisionOutcome(
        ok=True,
        output=(
            f"Provisioned {len(tables)} table(s): {created}\n{summary}\n"
            "Row-level security was applied automatically; do not write policies by hand."
        ),
        detail={
            "tables": [table.name for table in tables],
            "rls": "forced",
            "sql_bytes": len(sql),
        },
    )


__all__ = [
    "COLUMN_TYPES",
    "MigrationRunner",
    "ProvisionOutcome",
    "SpecError",
    "parse_table_spec",
    "plan_migration",
    "provision",
]
