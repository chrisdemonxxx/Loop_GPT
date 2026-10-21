"""SQL identifier handling for agent-supplied names.

Table and column names arrive from a model, which makes them attacker-influenceable
in exactly the way user input is: a prompt-injected file can ask for a table called
``x"; DROP SCHEMA public CASCADE; --``. Identifiers cannot be parameterised in SQL
the way values can, so the only safe treatment is a strict allowlist plus quoting,
in that order. Quoting alone is insufficient — a quoted identifier containing a
double quote still terminates early unless escaped, and a 64-byte name is silently
truncated by Postgres, which can make two distinct tables collide.
"""

from __future__ import annotations

import re
from typing import Final

#: Postgres truncates identifiers at NAMEDATALEN-1 bytes. Two names differing
#: only after byte 63 would become the same object, so they are refused instead.
MAX_IDENTIFIER_BYTES: Final = 63

#: Deliberately narrower than what Postgres accepts. Lower-case snake_case only:
#: it removes the entire class of quoting and case-folding surprises, and there
#: is no reason for a generated schema to need anything else.
_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]*$")

#: Legal identifiers that would still produce confusing or dangerous schemas:
#: system columns, plus reserved words that would need quoting everywhere.
_RESERVED: Final[frozenset[str]] = frozenset(
    {
        "all", "analyse", "analyze", "and", "any", "array", "as", "asc",
        "authorization", "between", "binary", "both", "case", "cast", "check",
        "collate", "column", "constraint", "create", "cross", "ctid",
        "current_date", "current_role", "current_time", "current_timestamp",
        "current_user", "default", "deferrable", "desc", "distinct", "do",
        "else", "end", "except", "false", "for", "foreign", "from", "grant",
        "group", "having", "in", "initially", "inner", "intersect", "into",
        "is", "join", "leading", "left", "like", "limit", "localtime",
        "localtimestamp", "natural", "not", "null", "offset", "on", "only",
        "or", "order", "outer", "overlaps", "placing", "primary", "references",
        "returning", "right", "select", "session_user", "similar", "some",
        "symmetric", "table", "tableoid", "then", "to", "trailing", "true",
        "union", "unique", "user", "using", "verbose", "when", "where",
        "window", "with", "xmax", "xmin",
    }
)  # fmt: skip


class IdentifierError(ValueError):
    """An agent-supplied name is not usable as a SQL identifier."""


def validate_identifier(name: str, *, kind: str = "identifier") -> str:
    """Return ``name`` if it is a safe identifier, else raise.

    Raises:
        IdentifierError: names the exact violation, so the rejection can be fed
            back to the agent as a correctable observation rather than a crash.
    """
    if not name:
        raise IdentifierError(f"{kind} must not be empty")
    if not _IDENTIFIER.match(name):
        raise IdentifierError(
            f"{kind} {name!r} must be lower-case snake_case matching "
            f"{_IDENTIFIER.pattern} — generated schemas do not use quoted or "
            "mixed-case names"
        )
    if len(name.encode("utf-8")) > MAX_IDENTIFIER_BYTES:
        raise IdentifierError(
            f"{kind} {name!r} exceeds {MAX_IDENTIFIER_BYTES} bytes; Postgres would "
            "truncate it and two distinct names could collide"
        )
    if name in _RESERVED:
        raise IdentifierError(f"{kind} {name!r} is a reserved word or system column")
    return name


def quote_identifier(name: str, *, kind: str = "identifier") -> str:
    """Validate ``name`` and return it double-quoted.

    Quoting is applied *after* validation, never instead of it: belt and braces,
    because the cost of being wrong here is arbitrary SQL execution.
    """
    return f'"{validate_identifier(name, kind=kind)}"'
