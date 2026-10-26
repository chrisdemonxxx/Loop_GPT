"""Call the Loop GPT paired-browser bridge. Stdlib HTTP only (I1).

The same Node socket Chat and Loop Bot use. This module does not open a
browser of its own. Smoke checks stay on the preview path.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

_ACTION_TOOLS = {
    "goto": ("browser_navigate", lambda args: {"url": str(args.get("path") or "")}),
    "click": ("browser_click", lambda args: {"selector": str(args.get("selector") or "")}),
    "fill": (
        "browser_type",
        lambda args: {
            "selector": str(args.get("selector") or ""),
            "text": str(args.get("value") or ""),
        },
    ),
    "screenshot": ("browser_screenshot", lambda _args: {}),
    "console_errors": ("browser_console", lambda _args: {}),
    "assert_text": ("browser_snapshot", lambda _args: {}),
}


def translate_browser_action(args: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """Map the existing Loop-it browser tool onto a bridge tool.

    ``smoke`` stays on the preview checker. Unknown actions are not forwarded.
    """
    action = str(args.get("action") or "")
    mapped = _ACTION_TOOLS.get(action)
    if mapped is None:
        return None
    tool, build = mapped
    return tool, build(args)


def invoke_paired_browser(
    *,
    user_id: str,
    device_id: str,
    run_id: str,
    tool: str,
    args: dict[str, Any],
    source: str = "build",
    grant_id: str = "",
) -> dict[str, Any]:
    """POST /api/browser/invoke. A missing secret is a clear not-configured error."""
    secret = os.environ.get("BROWSER_BRIDGE_SECRET", "").strip()
    if not secret:
        return {
            "ok": False,
            "content": "Paired browser is not configured: set BROWSER_BRIDGE_SECRET.",
        }
    base = os.environ.get("LOOP_API_URL", "http://127.0.0.1:3001").rstrip("/")
    payload: dict[str, Any] = {
        "userId": user_id,
        "deviceId": device_id,
        "runId": run_id,
        "tool": tool,
        "args": args,
        "source": source,
    }
    if grant_id:
        payload["grantId"] = grant_id
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{base}/api/browser/invoke",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-loop-browser-bridge": secret,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        return {"ok": False, "content": f"Paired browser call failed ({exc.code}): {detail}"}
    except OSError as exc:
        return {"ok": False, "content": f"Paired browser is unreachable: {exc}"}
    try:
        decoded = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {"ok": False, "content": "Paired browser returned a non-JSON result."}
    if not isinstance(decoded, dict):
        return {"ok": False, "content": "Paired browser returned an unexpected result."}
    return decoded


def stop_paired_browser(*, user_id: str, run_id: str) -> None:
    """Ask the bridge to close only the tabs this run opened."""
    secret = os.environ.get("BROWSER_BRIDGE_SECRET", "").strip()
    if not secret:
        return
    base = os.environ.get("LOOP_API_URL", "http://127.0.0.1:3001").rstrip("/")
    body = json.dumps({"userId": user_id}).encode("utf-8")
    request = urllib.request.Request(
        f"{base}/api/browser/runs/{urllib.parse.quote(run_id, safe='')}/stop",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-loop-browser-bridge": secret,
            "x-loop-browser-user": user_id,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10):
            return
    except (urllib.error.HTTPError, OSError):
        return
