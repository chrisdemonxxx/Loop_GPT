"""Turn a workflow failure into the text the run page can show."""

from __future__ import annotations

_MAX_CHARS = 500
_MAX_LINKS = 4


def describe_failure(exc: BaseException) -> str:
    """Keep the activity's own error. Temporal's wrapper only says the task failed."""
    parts: list[str] = []
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen and len(parts) < _MAX_LINKS:
        seen.add(id(current))
        text = f"{type(current).__name__}: {current}".strip()
        if text and text not in parts:
            parts.append(text)
        cause = current.__cause__
        if cause is None:
            nested = getattr(current, "cause", None)
            cause = nested if isinstance(nested, BaseException) else None
        current = cause
    return " — ".join(parts)[:_MAX_CHARS]
