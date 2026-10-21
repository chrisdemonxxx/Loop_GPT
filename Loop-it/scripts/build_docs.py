from __future__ import annotations

import html
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
OUT = DOCS / "site"
PAGES = [
    "README.md",
    "getting-started.md",
    "core-concepts.md",
    "troubleshooting.md",
    "go-live-checklist.md",
    "privacy-data-handling-summary.md",
]


def main() -> None:
    OUT.mkdir(exist_ok=True)
    links = "\n".join(
        f'<li><a href="{Path(page).with_suffix(".html").name}">{page}</a></li>' for page in PAGES
    )
    for page in PAGES:
        source = DOCS / page
        if not source.exists():
            continue
        body = render_markdown(source.read_text(encoding="utf-8"))
        title = first_heading(source.read_text(encoding="utf-8")) or page
        (OUT / Path(page).with_suffix(".html").name).write_text(
            (
                "<!doctype html><meta charset='utf-8'><meta name='viewport' "
                "content='width=device-width,initial-scale=1'>"
                f"<title>{html.escape(title)} — Loop-it docs</title>"
                "<style>body{font:16px/1.55 system-ui;max-width:960px;margin:2rem auto;"
                "padding:0 1rem;color:#111827}code{background:#f3f4f6;padding:.1rem .25rem}"
                "pre{background:#111827;color:#f9fafb;padding:1rem;overflow:auto}"
                "a{color:#2563eb}nav{border-bottom:1px solid #e5e7eb;margin-bottom:1rem}</style>"
                f"<nav><strong>Loop-it docs</strong><ul>{links}</ul></nav><main>{body}</main>"
            ),
            encoding="utf-8",
        )


def first_heading(markdown: str) -> str | None:
    for line in markdown.splitlines():
        if line.startswith("# "):
            return line.removeprefix("# ").strip()
    return None


def render_markdown(markdown: str) -> str:
    chunks: list[str] = []
    in_list = False
    in_code = False
    code_lines: list[str] = []
    for line in markdown.splitlines():
        if line.startswith("```"):
            if in_code:
                chunks.append(f"<pre><code>{html.escape(chr(10).join(code_lines))}</code></pre>")
                code_lines = []
                in_code = False
            else:
                close_list(chunks, in_list)
                in_list = False
                in_code = True
            continue
        if in_code:
            code_lines.append(line)
            continue
        if line.startswith("#"):
            close_list(chunks, in_list)
            in_list = False
            level = min(len(line) - len(line.lstrip("#")), 6)
            chunks.append(f"<h{level}>{inline(line[level:].strip())}</h{level}>")
        elif line.startswith("- "):
            if not in_list:
                chunks.append("<ul>")
                in_list = True
            chunks.append(f"<li>{inline(line[2:].strip())}</li>")
        elif line.strip():
            close_list(chunks, in_list)
            in_list = False
            chunks.append(f"<p>{inline(line.strip())}</p>")
    close_list(chunks, in_list)
    return "\n".join(chunks)


def close_list(chunks: list[str], in_list: bool) -> None:
    if in_list:
        chunks.append("</ul>")


def inline(text: str) -> str:
    escaped = html.escape(text)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    return re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', escaped)


if __name__ == "__main__":
    main()
