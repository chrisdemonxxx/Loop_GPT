"""Table specifications and the migration emitter.

The agent describes *what data it wants to store*. It does not describe how that
data is secured — the ownership column, its type, its default and its policies
are all added here, from the table's declared access model. That split is the
whole point: a spec has no way to express "no owner column", so there is no spec
the agent can write that produces an unprotected table.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

from .identifiers import quote_identifier, validate_identifier
from .rls import (
    APP_ROLE,
    CURRENT_TENANT_EXPR,
    CURRENT_USER_EXPR,
    AccessModel,
    RlsError,
    assert_secured,
    enable_rls_statements,
    generate_policies,
)

#: Column types the generator will emit. An allowlist rather than a pass-through:
#: a free-text type is a SQL injection point, and it also lets the agent reach
#: for exotic types the verification layer has never been tested against.
COLUMN_TYPES: Final[frozenset[str]] = frozenset(
    {
        "text",
        "integer",
        "bigint",
        "boolean",
        "numeric",
        "uuid",
        "date",
        "timestamptz",
        "jsonb",
    }
)

#: The column name used for each access model, and the type it must have.
_OWNERSHIP_COLUMN: Final[dict[str, tuple[str, str, str]]] = {
    "owner": ("user_id", "uuid", CURRENT_USER_EXPR),
    "tenant": ("org_id", "uuid", CURRENT_TENANT_EXPR),
}


#: The trigger function that maintains ``updated_at``. Defined once per migration.
TOUCH_FUNCTION: Final = "public.loopit_set_updated_at"

#: ``SET search_path`` is not optional here. A ``SECURITY DEFINER``-adjacent
#: function with a mutable search_path can be hijacked by a caller who creates a
#: shadowing object in a schema earlier on the path.
_TOUCH_FUNCTION_SQL: Final = f"""CREATE OR REPLACE FUNCTION {TOUCH_FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    NEW."updated_at" = now();
    RETURN NEW;
END;
$$;"""


@dataclass(frozen=True, slots=True)
class ColumnSpec:
    """One agent-requested column."""

    name: str
    type: str
    nullable: bool = True
    default: str | None = None

    def __post_init__(self) -> None:
        validate_identifier(self.name, kind="column")
        if self.type not in COLUMN_TYPES:
            raise RlsError(
                f"column {self.name!r} has unsupported type {self.type!r}; "
                f"supported types are {sorted(COLUMN_TYPES)}"
            )
        # Defaults are raw SQL, so only a fixed set of platform-owned expressions
        # is accepted. Anything else would let the agent smuggle a subquery into
        # DDL that runs with migration privileges.
        if self.default is not None and self.default not in _ALLOWED_DEFAULTS:
            raise RlsError(
                f"column {self.name!r} has unsupported default {self.default!r}; "
                f"supported defaults are {sorted(_ALLOWED_DEFAULTS)}"
            )

    def to_sql(self) -> str:
        parts = [quote_identifier(self.name, kind="column"), self.type]
        if not self.nullable:
            parts.append("NOT NULL")
        if self.default is not None:
            parts.append(f"DEFAULT {self.default}")
        return " ".join(parts)


_ALLOWED_DEFAULTS: Final[frozenset[str]] = frozenset(
    {
        "now()",
        "gen_random_uuid()",
        "true",
        "false",
        "0",
        "''::text",
        "'{}'::jsonb",
        "'[]'::jsonb",
        CURRENT_USER_EXPR,
        CURRENT_TENANT_EXPR,
    }
)


@dataclass(frozen=True, slots=True)
class TableSpec:
    """A table the agent wants, plus the access model that secures it.

    ``access`` is required and has no default. Making it mandatory forces the
    question "who owns these rows?" to be answered at authoring time, which is
    the only moment anyone actually knows the answer.
    """

    name: str
    columns: tuple[ColumnSpec, ...]
    access: AccessModel
    schema: str = "public"

    def __post_init__(self) -> None:
        validate_identifier(self.name, kind="table")
        validate_identifier(self.schema, kind="schema")
        if not self.columns:
            raise RlsError(f"table {self.name!r} declares no columns")

        seen: set[str] = set()
        for column in self.columns:
            if column.name in seen:
                raise RlsError(f"table {self.name!r} declares column {column.name!r} twice")
            seen.add(column.name)

        # The agent may not supply the ownership column itself. If it could, it
        # could declare it nullable, or as text, or with a default of NULL —
        # each of which silently defeats the policies generated against it.
        owner_column, _, _ = _OWNERSHIP_COLUMN[self.access]
        if owner_column in seen:
            raise RlsError(
                f"table {self.name!r} must not declare {owner_column!r}; the "
                "ownership column is generated by the provisioning tool (I9)"
            )
        if "id" in seen:
            raise RlsError(
                f"table {self.name!r} must not declare 'id'; the primary key is generated"
            )

    @property
    def ownership_column(self) -> str:
        return _OWNERSHIP_COLUMN[self.access][0]

    @property
    def qualified_name(self) -> str:
        return (
            f"{quote_identifier(self.schema, kind='schema')}."
            f"{quote_identifier(self.name, kind='table')}"
        )


def _table_columns(spec: TableSpec) -> tuple[ColumnSpec, ...]:
    """Agent columns wrapped in the platform-owned ones."""
    owner_column, owner_type, owner_default = _OWNERSHIP_COLUMN[spec.access]
    return (
        ColumnSpec("id", "uuid", nullable=False, default="gen_random_uuid()"),
        # NOT NULL is load-bearing: a NULL owner compares NULL against auth.uid(),
        # which is neither true nor false, so the row becomes invisible to
        # everyone including its creator — a silent data-loss bug, not a breach,
        # but one that would push the agent towards weakening the policy.
        ColumnSpec(owner_column, owner_type, nullable=False, default=owner_default),
        *spec.columns,
        ColumnSpec("created_at", "timestamptz", nullable=False, default="now()"),
        ColumnSpec("updated_at", "timestamptz", nullable=False, default="now()"),
    )


def emit_table(spec: TableSpec) -> tuple[str, ...]:
    """Emit every statement needed to create ``spec`` as a secured table.

    Returns the statements in execution order: create, lock down, then policies.

    These statements reference :data:`TOUCH_FUNCTION`, which is emitted once per
    migration by :func:`emit_migration`. Use that as the entry point; calling
    this directly yields SQL that assumes the function already exists.
    """
    columns = ",\n".join(f"    {column.to_sql()}" for column in _table_columns(spec))
    create = (
        f"CREATE TABLE IF NOT EXISTS {spec.qualified_name} (\n"
        f"{columns},\n"
        f'    PRIMARY KEY ("id")\n'
        f");"
    )

    # An index on the ownership column is not decoration: every policy predicate
    # filters on it, so without one each query degrades to a sequential scan.
    index_name = f"{spec.name}_{spec.ownership_column}_idx"
    index = (
        f"CREATE INDEX IF NOT EXISTS {quote_identifier(index_name, kind='index')} "
        f"ON {spec.qualified_name} "
        f"({quote_identifier(spec.ownership_column, kind='column')});"
    )

    # Without this, `updated_at` would default to the insert time and never
    # change - a column that looks maintained but silently is not.
    trigger_name = f"{spec.name}_set_updated_at"
    trigger = (
        f"CREATE OR REPLACE TRIGGER {quote_identifier(trigger_name, kind='trigger')}\n"
        f"    BEFORE UPDATE ON {spec.qualified_name}\n"
        f"    FOR EACH ROW EXECUTE FUNCTION {TOUCH_FUNCTION}();"
    )

    policies = generate_policies(
        spec.name,
        access=spec.access,
        ownership_column=spec.ownership_column,
    )

    return (
        create,
        index,
        trigger,
        *enable_rls_statements(spec.name, schema=spec.schema),
        *(policy.to_sql(schema=spec.schema) for policy in policies),
    )


def emit_migration(specs: Sequence[TableSpec]) -> str:
    """Emit a complete, self-verifying migration for ``specs``.

    The migration is wrapped in a transaction so a partial apply cannot leave a
    created-but-unsecured table behind, and every table is checked with
    :func:`assert_secured` before the SQL is returned to the caller.
    """
    if not specs:
        raise RlsError("a migration must create at least one table")

    names = [spec.name for spec in specs]
    if len(set(names)) != len(names):
        raise RlsError("a migration must not create the same table twice")

    statements: list[str] = [_TOUCH_FUNCTION_SQL]
    for spec in specs:
        statements.extend(emit_table(spec))

    for spec in specs:
        assert_secured(statements, spec.name, schema=spec.schema)

    body = "\n\n".join(statements)
    return (
        "-- Generated by loopit_provision. Row-level security is emitted\n"
        "-- structurally by the provisioning tool, never requested by the agent (I9).\n"
        "-- Do not hand-edit: regenerate from the table specification instead.\n"
        "BEGIN;\n\n"
        f"{body}\n\n"
        "COMMIT;\n"
    )


__all__ = [
    "APP_ROLE",
    "COLUMN_TYPES",
    "ColumnSpec",
    "TableSpec",
    "emit_migration",
    "emit_table",
]
