"""Row-level security, generated structurally rather than requested (I9).

The rule from Doc 06 §8 is blunt: *row-level security must be ON by default and
generated into every schema — not left to the model to remember.* This module is
how that is made true. There is no parameter anywhere below that disables RLS,
because a flag the agent can set is a flag prompt injection can set.

Four decisions here are the difference between real isolation and the appearance
of it:

**FORCE, not just ENABLE.** ``ENABLE ROW LEVEL SECURITY`` does not apply to the
table's owner, and generated apps routinely connect as the role that owns their
tables. RLS that the application bypasses by construction protects nobody, so
every table is also ``FORCE``d.

**WITH CHECK on every write, not only USING.** ``USING`` filters the rows a
statement may *see*; ``WITH CHECK`` constrains the rows it may *produce*. A
policy with ``USING`` alone lets a user take one of their own rows and update its
owner column to someone else's id — writing data into another tenant and losing
sight of it in the same statement.

**No policy is ever ``USING (true)``.** Postgres default-denies a table with RLS
enabled and no matching policy, which is the correct failure direction. A
permissive policy would convert that safe default into a full table scan, so the
generator has no code path that can emit one.

**PUBLIC is revoked first.** Policies restrict rows, not table access. Without
revoking the schema-level grant, a role can still reach the table; RLS then
narrows rows for a principal who should not have been there at all.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Literal

from .identifiers import quote_identifier, validate_identifier

#: How rows in a table are owned. There is deliberately no "none" or "public"
#: member: a table whose rows belong to nobody has no safe default policy, and
#: inventing one would mean guessing at an authorization model.
AccessModel = Literal["owner", "tenant"]

#: The SQL expression yielding the current end-user's id. GoTrue/PostgREST
#: convention (Doc 06 §4). It is a platform constant, never agent-supplied.
CURRENT_USER_EXPR: Final = "auth.uid()"

#: The current request's tenant/org id, read from the verified JWT claims rather
#: than from anything the application layer passes in.
CURRENT_TENANT_EXPR: Final = (
    "nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'org_id', '')::uuid"
)

#: The role generated applications connect as. Distinct from the migration role
#: that owns the tables, so ownership never becomes an accidental bypass.
APP_ROLE: Final = "app_user"

_COMMANDS: Final[tuple[str, ...]] = ("select", "insert", "update", "delete")


class RlsError(ValueError):
    """A table specification cannot be secured, so it must not be created."""


@dataclass(frozen=True, slots=True)
class RlsPolicy:
    """One generated ``CREATE POLICY`` statement."""

    name: str
    table: str
    command: str
    using: str | None
    with_check: str | None

    def to_sql(self, *, schema: str = "public") -> str:
        qualified_schema = quote_identifier(schema, kind="schema")
        qualified_table = quote_identifier(self.table, kind="table")
        target = f"{qualified_schema}.{qualified_table}"
        parts = [
            f"CREATE POLICY {quote_identifier(self.name, kind='policy')}",
            f"    ON {target}",
            f"    FOR {self.command.upper()}",
            f"    TO {quote_identifier(APP_ROLE, kind='role')}",
        ]
        if self.using is not None:
            parts.append(f"    USING ({self.using})")
        if self.with_check is not None:
            parts.append(f"    WITH CHECK ({self.with_check})")
        return "\n".join(parts) + ";"


def ownership_predicate(access: AccessModel, column: str) -> str:
    """The boolean expression that decides whether a row belongs to the caller."""
    quoted = quote_identifier(column, kind="ownership column")
    if access == "owner":
        return f"{quoted} = {CURRENT_USER_EXPR}"
    return f"{quoted} = {CURRENT_TENANT_EXPR}"


def generate_policies(
    table: str,
    *,
    access: AccessModel,
    ownership_column: str,
) -> tuple[RlsPolicy, ...]:
    """Build the four per-command policies for one table.

    Always four, always scoped by the same predicate. Splitting per command is
    what allows ``WITH CHECK`` to be attached to exactly the statements that
    write, while ``SELECT`` and ``DELETE`` carry only ``USING``.
    """
    validate_identifier(table, kind="table")
    predicate = ownership_predicate(access, ownership_column)

    policies: list[RlsPolicy] = []
    for command in _COMMANDS:
        # INSERT has no existing row to filter, so it takes WITH CHECK only;
        # UPDATE needs both, or a row can be written out of the caller's scope.
        using = None if command == "insert" else predicate
        with_check = predicate if command in ("insert", "update") else None
        policies.append(
            RlsPolicy(
                name=f"{table}_{command}_{access}",
                table=table,
                command=command,
                using=using,
                with_check=with_check,
            )
        )
    return tuple(policies)


def enable_rls_statements(table: str, *, schema: str = "public") -> tuple[str, ...]:
    """The statements that turn a table from open to default-deny.

    Order matters. RLS is enabled and forced before any grant is issued, so
    there is no window — not even within one migration — in which the table is
    both reachable and unprotected.
    """
    target = f"{quote_identifier(schema, kind='schema')}.{quote_identifier(table, kind='table')}"
    return (
        f"ALTER TABLE {target} ENABLE ROW LEVEL SECURITY;",
        # Without FORCE, the table owner bypasses every policy below.
        f"ALTER TABLE {target} FORCE ROW LEVEL SECURITY;",
        f"REVOKE ALL ON {target} FROM PUBLIC;",
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON {target} TO "
        f"{quote_identifier(APP_ROLE, kind='role')};",
    )


def assert_secured(statements: Sequence[str], table: str, *, schema: str = "public") -> None:
    """Fail loudly if a migration would leave ``table`` unprotected.

    This is the last line of defence and it exists because the failure it guards
    against is silent: a table created without RLS looks exactly like a working
    table until someone reads a row that is not theirs. Called by the provision
    tool on its own output, so a future refactor that drops a statement breaks
    the build instead of shipping.
    """
    joined = "\n".join(statements).lower()
    # Collapse whitespace so `USING (true)`, `USING(true)` and a line-wrapped
    # variant are all caught by the same check.
    normalised = re.sub(r"\s+", " ", joined)
    target = f'"{schema}"."{table}"'.lower()

    if (
        f"create table if not exists {target}" not in normalised
        and f"create table {target}" not in normalised
    ):
        raise RlsError(f"no CREATE TABLE for {target} in the migration")
    for requirement, description in (
        (f"alter table {target} enable row level security", "RLS is not enabled"),
        (
            f"alter table {target} force row level security",
            "RLS is not forced, so the owner bypasses it",
        ),
        (f"revoke all on {target} from public", "PUBLIC access is not revoked"),
    ):
        if requirement not in normalised:
            raise RlsError(f"{target}: {description}")

    if "create policy" not in normalised:
        raise RlsError(f"{target}: RLS is enabled but no policy exists, so the table is unusable")
    if re.search(r"using\s*\(\s*true\s*\)", normalised):
        raise RlsError(f"{target}: a permissive USING (true) policy defeats row-level security")
