"""Deterministic visual edits for click-to-edit (Phase 2.1).

When the preview inspector sends ``{selector, snippet, loc}`` and the user
applies a text / colour / spacing change, we try an AST-light codemod against
the source file named by ``data-loc`` (``file:line:col``). If the edit cannot
be applied safely, the caller falls back to an LLM patch prompt.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

EditKind = Literal["text", "color", "spacing", "class"]


@dataclass(frozen=True, slots=True)
class VisualEditRequest:
    """One user-driven visual edit."""

    kind: EditKind
    value: str
    selector: str = ""
    snippet: str = ""
    loc: str | None = None
    tag: str | None = None
    text: str | None = None


@dataclass(frozen=True, slots=True)
class VisualEditResult:
    """Outcome of attempting a deterministic codemod."""

    applied: bool
    mode: Literal["codemod", "llm"]
    path: str | None = None
    message: str = ""
    prompt: str | None = None


_LOC_RE = re.compile(
    r"^(?P<path>[^:]+?):(?P<line>\d+)(?::(?P<col>\d+))?$"
)


def parse_data_loc(loc: str | None) -> tuple[str, int, int] | None:
    """Parse ``data-loc="src/App.tsx:12:5"`` into path / line / col."""
    if not loc or not isinstance(loc, str):
        return None
    match = _LOC_RE.match(loc.strip())
    if not match:
        return None
    return (
        match.group("path").replace("\\", "/"),
        int(match.group("line")),
        int(match.group("col") or "0"),
    )


def _escape_js_string(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace('"', '\\"')
        .replace("\n", "\\n")
    )


def _replace_jsx_text(source: str, old_text: str, new_text: str) -> str | None:
    """Replace a simple JSX text node / string literal when unique enough."""
    old = (old_text or "").strip()
    if not old or old not in source:
        return None
    # Prefer exact JSX children: >old<
    pattern = re.compile(re.escape(f">{old}<"))
    if len(pattern.findall(source)) == 1:
        return pattern.sub(f">{new_text}<", source, count=1)
    # Quoted string literal.
    for quote in ('"', "'", "`"):
        needle = f"{quote}{old}{quote}"
        if source.count(needle) == 1:
            return source.replace(needle, f"{quote}{_escape_js_string(new_text)}{quote}", 1)
    if source.count(old) == 1:
        return source.replace(old, new_text, 1)
    return None


def _apply_color(source: str, value: str) -> str | None:
    """Set or replace a colour style / Tailwind text-* / bg-* when unambiguous."""
    colour = value.strip()
    if not colour:
        return None
    # style={{ color: '...' }} or color: "..."
    color_re = re.compile(r"(color\s*:\s*)(['\"])([^'\"]*)\2")
    matches = list(color_re.finditer(source))
    if len(matches) == 1:
        m = matches[0]
        return source[: m.start()] + f"{m.group(1)}{m.group(2)}{colour}{m.group(2)}" + source[m.end() :]
    # Tailwind text- / bg- token near data-loc line is too hard without line; skip.
    style_obj = re.compile(r"(style=\{\{)([^}]*)(\}\})")
    objs = list(style_obj.finditer(source))
    if len(objs) == 1:
        inner = objs[0].group(2)
        if "color" not in inner:
            sep = "" if not inner.strip() or inner.rstrip().endswith(",") else ", "
            new_inner = f"{inner.rstrip()}{sep}color: '{_escape_js_string(colour)}'"
            m = objs[0]
            return source[: m.start()] + f"{m.group(1)}{new_inner}{m.group(3)}" + source[m.end() :]
    return None


def _apply_spacing(source: str, value: str) -> str | None:
    """Replace padding/margin style or a single Tailwind spacing class."""
    raw = value.strip()
    if not raw:
        return None
    # style padding/margin
    for prop in ("padding", "margin", "gap"):
        prop_re = re.compile(rf"({prop}\s*:\s*)(['\"])([^'\"]*)\2")
        matches = list(prop_re.finditer(source))
        if len(matches) == 1:
            m = matches[0]
            return (
                source[: m.start()]
                + f"{m.group(1)}{m.group(2)}{raw}{m.group(2)}"
                + source[m.end() :]
            )
    # className with a single p- / m- / gap- token swap when value looks like Tailwind
    if re.fullmatch(r"(?:p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|gap)-[a-z0-9.\[\]/%]+", raw):
        class_re = re.compile(
            r"(className\s*=\s*\{?\s*['\"])([^'\"]+)(['\"]\s*\}?)"
        )
        matches = list(class_re.finditer(source))
        if len(matches) == 1:
            m = matches[0]
            classes = m.group(2).split()
            prefix = raw.split("-", 1)[0]
            replaced = False
            out: list[str] = []
            for token in classes:
                if token.startswith(prefix + "-"):
                    out.append(raw)
                    replaced = True
                else:
                    out.append(token)
            if not replaced:
                out.append(raw)
            return (
                source[: m.start()]
                + f"{m.group(1)}{' '.join(out)}{m.group(3)}"
                + source[m.end() :]
            )
    return None


def apply_visual_edit(
    workspace: Any,
    request: VisualEditRequest,
) -> VisualEditResult:
    """Try a deterministic file edit; otherwise return an LLM prompt payload."""
    parsed = parse_data_loc(request.loc)
    llm_prompt = _llm_prompt(request)

    if parsed is None:
        return VisualEditResult(
            applied=False,
            mode="llm",
            message="No source location on the element; requesting an LLM patch.",
            prompt=llm_prompt,
        )

    path, _line, _col = parsed
    try:
        source = workspace.read(path)
    except Exception as error:  # noqa: BLE001 — surface as LLM fallback
        return VisualEditResult(
            applied=False,
            mode="llm",
            path=path,
            message=f"Could not read {path}: {error}",
            prompt=llm_prompt,
        )

    updated: str | None = None
    if request.kind == "text":
        old = (request.text or "").strip() or _guess_text_from_snippet(request.snippet)
        updated = _replace_jsx_text(source, old, request.value)
    elif request.kind == "color":
        updated = _apply_color(source, request.value)
    elif request.kind == "spacing":
        updated = _apply_spacing(source, request.value)
    elif request.kind == "class":
        # Swap className wholesale when unique.
        class_re = re.compile(r"(className\s*=\s*\{?\s*['\"])([^'\"]+)(['\"]\s*\}?)")
        matches = list(class_re.finditer(source))
        if len(matches) == 1:
            m = matches[0]
            updated = (
                source[: m.start()]
                + f"{m.group(1)}{request.value}{m.group(3)}"
                + source[m.end() :]
            )

    if updated is None or updated == source:
        return VisualEditResult(
            applied=False,
            mode="llm",
            path=path,
            message="Deterministic codemod could not apply this edit safely.",
            prompt=llm_prompt,
        )

    try:
        workspace.write(path, updated)
    except Exception as error:  # noqa: BLE001
        return VisualEditResult(
            applied=False,
            mode="llm",
            path=path,
            message=f"Write failed: {error}",
            prompt=llm_prompt,
        )

    return VisualEditResult(
        applied=True,
        mode="codemod",
        path=path,
        message=f"Applied {request.kind} edit to {path}",
    )


def _guess_text_from_snippet(snippet: str) -> str:
    text = re.sub(r"<[^>]+>", "", snippet or "")
    return " ".join(text.split())[:200]


def _llm_prompt(request: VisualEditRequest) -> str:
    parts = [
        "Apply a visual edit to the selected preview element.",
        f"Kind: {request.kind}",
        f"New value: {request.value}",
    ]
    if request.selector:
        parts.append(f"CSS selector: {request.selector}")
    if request.loc:
        parts.append(f"Source location (data-loc): {request.loc}")
    if request.tag:
        parts.append(f"Tag: {request.tag}")
    if request.text:
        parts.append(f"Current text: {request.text}")
    if request.snippet:
        parts.append(f"HTML snippet:\n```html\n{request.snippet[:600]}\n```")
    parts.append("Prefer a minimal unified diff via apply_patch. Keep I6 (no full-file rewrite).")
    return "\n".join(parts)


def safe_path_under(root: Path, relative: str) -> Path | None:
    """Resolve a relative path under root without escaping."""
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    return candidate


__all__ = [
    "EditKind",
    "VisualEditRequest",
    "VisualEditResult",
    "apply_visual_edit",
    "parse_data_loc",
    "safe_path_under",
]
