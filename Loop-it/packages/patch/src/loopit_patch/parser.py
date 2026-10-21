"""Unified-diff parser.

Strict about what protects the codebase — safe paths, well-formed structure,
and (in the applier) exact context matching. Tolerant about what does not:
hunk-header line counts. Models habitually write plausible-looking @@ counts
that disagree with the hunk body; GNU patch has always treated the counts as
advisory and the body as authoritative, and so do we. Rejecting those diffs
cost builds: the model's context lines were right and the patch would have
applied cleanly (the pomodoro run of 2026-10-11 died repeating one).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from .errors import MalformedPatchError, UnsafePathError

_HUNK_HEADER = re.compile(
    r"^@@ -(?P<old_start>\d+)(?:,(?P<old_count>\d+))? "
    r"\+(?P<new_start>\d+)(?:,(?P<new_count>\d+))? @@(?P<section>.*)$"
)

_DEV_NULL = "/dev/null"

LineKind = Literal["context", "add", "remove"]


@dataclass(frozen=True, slots=True)
class HunkLine:
    """One line inside a hunk."""

    kind: LineKind
    text: str


@dataclass(frozen=True, slots=True)
class Hunk:
    """A contiguous change region with its surrounding context."""

    old_start: int
    old_count: int
    new_start: int
    new_count: int
    lines: tuple[HunkLine, ...]

    @property
    def old_lines(self) -> list[str]:
        """Lines this hunk expects to find in the current file."""
        return [line.text for line in self.lines if line.kind in ("context", "remove")]

    @property
    def new_lines(self) -> list[str]:
        """Lines this hunk produces."""
        return [line.text for line in self.lines if line.kind in ("context", "add")]


@dataclass(slots=True)
class FilePatch:
    """All hunks targeting a single file."""

    old_path: str | None
    new_path: str | None
    hunks: list[Hunk] = field(default_factory=list)

    @property
    def is_creation(self) -> bool:
        """Creating a brand-new file is a trivial 'rewrite' and is allowed (Doc 04 §6)."""
        return self.old_path is None

    @property
    def is_deletion(self) -> bool:
        return self.new_path is None

    @property
    def path(self) -> str:
        path = self.new_path or self.old_path
        if path is None:  # pragma: no cover - parser rejects this earlier
            raise MalformedPatchError("file patch has neither an old nor a new path")
        return path


def _strip_prefix(raw: str) -> str | None:
    """Strip the ``a/`` or ``b/`` diff prefix; return None for /dev/null."""
    path = raw.strip()
    # Drop a trailing timestamp column if the differ emitted one.
    if "\t" in path:
        path = path.split("\t", 1)[0]
    if path == _DEV_NULL:
        return None
    for prefix in ("a/", "b/"):
        if path.startswith(prefix):
            return path[len(prefix) :]
    return path


def _assert_safe_path(path: str) -> None:
    """Reject anything that could name a file outside the project fork."""
    if not path:
        raise UnsafePathError("patch targets an empty path")
    normalised = path.replace("\\", "/")
    if normalised.startswith("/"):
        raise UnsafePathError(
            f"patch targets an absolute path {path!r}; only project-relative paths are allowed"
        )
    if re.match(r"^[A-Za-z]:", normalised):
        raise UnsafePathError(f"patch targets a drive-qualified path {path!r}")
    parts = normalised.split("/")
    if ".." in parts:
        raise UnsafePathError(
            f"patch targets {path!r}, which escapes the project fork via parent traversal"
        )


def parse_patch(text: str) -> list[FilePatch]:
    """Parse a unified diff into per-file patches.

    Raises:
        MalformedPatchError: the text is not a well-formed unified diff.
        UnsafePathError: a target path escapes the project fork.
    """
    if not text.strip():
        raise MalformedPatchError("patch is empty")

    lines = text.splitlines()
    patches: list[FilePatch] = []
    current: FilePatch | None = None
    index = 0

    while index < len(lines):
        line = lines[index]

        if line.startswith("--- "):
            if index + 1 >= len(lines) or not lines[index + 1].startswith("+++ "):
                raise MalformedPatchError(
                    f"line {index + 1}: '---' header is not followed by a '+++' header"
                )
            old_path = _strip_prefix(line[4:])
            new_path = _strip_prefix(lines[index + 1][4:])
            if old_path is None and new_path is None:
                raise MalformedPatchError(
                    f"line {index + 1}: both sides of the file header are /dev/null"
                )
            for path in (old_path, new_path):
                if path is not None:
                    _assert_safe_path(path)
            current = FilePatch(old_path=old_path, new_path=new_path)
            patches.append(current)
            index += 2
            continue

        if line.startswith("@@"):
            if current is None:
                raise MalformedPatchError(
                    f"line {index + 1}: hunk header appears before any file header"
                )
            match = _HUNK_HEADER.match(line)
            if match is None:
                raise MalformedPatchError(f"line {index + 1}: malformed hunk header {line!r}")
            index += 1
            hunk, index = _parse_hunk_body(match, lines, index)
            current.hunks.append(hunk)
            continue

        # Everything else (git extended headers, 'diff --git', prose preamble) is skipped.
        index += 1

    if not patches:
        raise MalformedPatchError(
            "patch contains no file headers; expected unified diff with '--- ' / '+++ ' lines"
        )
    for patch in patches:
        if not patch.hunks and not patch.is_deletion:
            raise MalformedPatchError(f"file patch for {patch.path!r} contains no hunks")
    return patches


def _parse_hunk_body(match: re.Match[str], lines: list[str], index: int) -> tuple[Hunk, int]:
    old_start = int(match.group("old_start"))
    new_start = int(match.group("new_start"))
    # Header counts are advisory only. The hunk BODY — lines starting with
    # ' ', '+', '-' or '\' — is authoritative: it unambiguously defines both
    # sides of the change, and models get the counts wrong constantly while
    # getting the body right. The applier's exact context match is the real
    # integrity check; a wrong count has never stopped a bad patch.
    body: list[HunkLine] = []

    while index < len(lines):
        raw = lines[index]
        if raw.startswith("\\"):  # "\ No newline at end of file"
            index += 1
            continue
        if raw.startswith("--- ") or raw.startswith("@@"):
            break

        if raw.startswith("+"):
            body.append(HunkLine("add", raw[1:]))
        elif raw.startswith("-"):
            body.append(HunkLine("remove", raw[1:]))
        elif raw.startswith(" ") or raw == "":
            body.append(HunkLine("context", raw[1:] if raw else ""))
        else:
            raise MalformedPatchError(
                f"line {index + 1}: unexpected line {raw!r} inside a hunk; "
                "hunk lines must start with ' ', '+', '-' or '\\'"
            )
        index += 1

    if not body:
        raise MalformedPatchError(
            f"hunk @@ -{old_start} +{new_start} @@ contains no change lines"
        )

    old_count = sum(1 for line in body if line.kind in ("context", "remove"))
    new_count = sum(1 for line in body if line.kind in ("context", "add"))

    return (
        Hunk(
            old_start=old_start,
            old_count=old_count,
            new_start=new_start,
            new_count=new_count,
            lines=tuple(body),
        ),
        index,
    )
