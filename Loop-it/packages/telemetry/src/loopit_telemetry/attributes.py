from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from opentelemetry.util.types import AttributeValue

REDACTED = "[REDACTED]"

_SENSITIVE_KEY = re.compile(
    r"(secret|token|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|session)",
    re.IGNORECASE,
)
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_SENSITIVE_VALUES: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bhf_[A-Za-z0-9]{16,}\b"),
    re.compile(r"\bghp_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
)


def scrub_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return scrub_attributes(value)
    if isinstance(value, list | tuple):
        return [scrub_value(item) for item in value]
    if isinstance(value, str):
        redacted = _EMAIL.sub(REDACTED, value)
        for pattern in _SENSITIVE_VALUES:
            redacted = pattern.sub(REDACTED, redacted)
        return redacted
    return value


def scrub_attributes(attributes: Mapping[str, Any] | None) -> dict[str, AttributeValue]:
    safe: dict[str, AttributeValue] = {}
    for key, value in (attributes or {}).items():
        name = str(key)
        clean = REDACTED if _SENSITIVE_KEY.search(name) else scrub_value(value)
        safe[name] = _otel_value(clean)
    return safe


def scrub_log_record(record: Mapping[str, Any]) -> dict[str, Any]:
    return {
        str(key): REDACTED if _SENSITIVE_KEY.search(str(key)) else scrub_value(value)
        for key, value in record.items()
    }


def _otel_value(value: Any) -> AttributeValue:
    if isinstance(value, bool | str | int | float):
        return value
    if isinstance(value, list | tuple):
        return [str(item) for item in value]
    if value is None:
        return ""
    return str(value)
