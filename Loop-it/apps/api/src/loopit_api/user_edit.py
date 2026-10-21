"""User-driven file edits via apply_patch (Phase 3.1).

Monaco (and similar) editors send the full new file body. We generate a
unified diff against the live workspace, apply it through the same
``apply_patch`` path the agent uses (invariant I6 — no full-file rewrite
API), and return structured ``file_changes`` for the UI.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass
from typing import Any

from loopit_agent_core.tools import ToolCall

from .workspace import Workspace


@dataclass(frozen=True, slots=True)
class UserEditResult:
    """Outcome of applying a user edit through apply_patch."""

    ok: bool
    path: str
    patch: str
    file_changes: list[dict[str, Any]]
    message: str = ""


def unified_diff_for_path(path: str, old: str, new: str) -> str:
    """Build a unified diff the patch engine accepts (``a/`` / ``b/`` paths)."""
    if old == new:
        return ""
    if not old and new:
        # Create: --- /dev/null style that loopit_patch accepts via a/ empty.
        new_lines = new.splitlines(keepends=True)
        if new_lines and not new_lines[-1].endswith("\n"):
            new_lines[-1] = new_lines[-1] + "\n"
        body = "".join(f"+{line}" if line.endswith("\n") else f"+{line}\n" for line in new.splitlines())
        count = len(new.splitlines()) or 1
        return f"--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{count} @@\n{body}"
    return "".join(
        difflib.unified_diff(
            old.splitlines(keepends=True),
            new.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
            n=3,
        )
    )


def apply_user_file_edit(
    workspace: Workspace,
    *,
    path: str,
    content: str,
    patch: str | None = None,
) -> UserEditResult:
    """Apply ``content`` (or an explicit ``patch``) through workspace.apply_patch."""
    relative = path.lstrip("/").replace("\\", "/")
    if not relative or ".." in relative.split("/"):
        return UserEditResult(
            ok=False,
            path=relative or path,
            patch="",
            file_changes=[],
            message="invalid path",
        )

    try:
        old = workspace.read(relative)
    except Exception:
        old = ""

    diff = (patch or "").strip() or unified_diff_for_path(relative, old, content)
    if not diff.strip():
        return UserEditResult(
            ok=True,
            path=relative,
            patch="",
            file_changes=[],
            message="no changes",
        )

    result = workspace.apply_patch(ToolCall(tool="apply_patch", args={"patch": diff}))
    changes = []
    if isinstance(result.detail, dict):
        raw = result.detail.get("file_changes")
        if isinstance(raw, list):
            changes = [c for c in raw if isinstance(c, dict)]

    return UserEditResult(
        ok=result.ok,
        path=relative,
        patch=diff,
        file_changes=changes,
        message=result.output if not result.ok else (result.output or "apply_patch OK"),
    )


def extract_html_seo(html: str) -> dict[str, str | None]:
    """Pull title / description / og tags from an HTML document (Phase 3.3)."""
    import re

    def _meta(name: str) -> str | None:
        patterns = [
            rf'<meta[^>]+(?:name|property)=["\']{re.escape(name)}["\'][^>]+content=["\']([^"\']*)["\']',
            rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:name|property)=["\']{re.escape(name)}["\']',
        ]
        for pattern in patterns:
            match = re.search(pattern, html, flags=re.IGNORECASE)
            if match:
                return match.group(1).strip() or None
        return None

    title_match = re.search(r"<title[^>]*>([^<]*)</title>", html, flags=re.IGNORECASE)
    title = title_match.group(1).strip() if title_match else None
    return {
        "title": title or _meta("og:title"),
        "description": _meta("description") or _meta("og:description"),
        "og_image": _meta("og:image"),
        "og_title": _meta("og:title") or title,
    }


__all__ = [
    "UserEditResult",
    "apply_user_file_edit",
    "extract_html_seo",
    "unified_diff_for_path",
]
