from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

from opentelemetry import trace

from .attributes import scrub_log_record

_RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__)


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        span_context = trace.get_current_span().get_span_context()
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC)
            .isoformat()
            .replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "trace_id": _trace_id(span_context.trace_id),
            "span_id": _span_id(span_context.span_id),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(scrub_log_record(payload), sort_keys=True, separators=(",", ":"))


def configure_json_logging(level: str | int | None = None) -> None:
    root = logging.getLogger()
    if isinstance(level, str):
        root.setLevel(level.upper())
    elif isinstance(level, int):
        root.setLevel(level)
    elif root.level == logging.NOTSET:
        root.setLevel(logging.INFO)
    formatter = JsonLogFormatter()
    if not root.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(formatter)
        root.addHandler(handler)
        return
    for existing_handler in root.handlers:
        existing_handler.setFormatter(formatter)


def _trace_id(value: int) -> str:
    return "" if value == 0 else f"{value:032x}"


def _span_id(value: int) -> str:
    return "" if value == 0 else f"{value:016x}"
