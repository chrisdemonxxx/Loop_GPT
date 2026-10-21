"""JSON serialisation helpers for sandbox SDK envelopes."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from loopit_sandbox_sdk import Envelope


def envelope_to_dict(envelope: Envelope) -> dict[str, Any]:
    return {
        "lease_id": envelope.lease_id,
        "tenant_id": envelope.tenant_id,
        "run_id": envelope.run_id,
        "tool": envelope.tool,
        "args": dict(envelope.args),
        "nonce": envelope.nonce,
        "issued_at": envelope.issued_at.isoformat(),
        "expires_at": envelope.expires_at.isoformat(),
        "signature": envelope.signature,
    }


def envelope_from_dict(payload: Mapping[str, Any]) -> Envelope:
    return Envelope(
        lease_id=str(payload["lease_id"]),
        tenant_id=str(payload["tenant_id"]),
        run_id=str(payload["run_id"]),
        tool=str(payload["tool"]),
        args=_require_mapping(payload["args"]),
        nonce=str(payload["nonce"]),
        issued_at=_parse_datetime(payload["issued_at"]),
        expires_at=_parse_datetime(payload["expires_at"]),
        signature=None if payload.get("signature") is None else str(payload["signature"]),
    )


def _require_mapping(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError("envelope args must be an object")
    return value


def _parse_datetime(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("envelope timestamps must be strings")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
