"""Patch application with strict context validation.

Application is **all-or-nothing**: if any hunk of any file fails to validate,
nothing is written. A half-applied patch is worse than a rejected one, because
it leaves the project in a state neither the agent nor the user expects.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from .errors import ContextMismatchError, MalformedPatchError, PatchError
from .parser import FilePatch, Hunk, parse_patch


@dataclass(slots=True)
class PatchApplication:
    """Result of a successful application.

    ``files`` contains only the files that changed. ``None`` means the file was
    deleted.
    """

    files: dict[str, str | None] = field(default_factory=dict)
    created: list[str] = field(default_factory=list)
    modified: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    hunks_applied: int = 0

    def summary(self) -> str:
        """A compact, agent-readable observation of what changed."""
        parts: list[str] = []
        if self.created:
            parts.append(f"created {', '.join(sorted(self.created))}")
        if self.modified:
            parts.append(f"modified {', '.join(sorted(self.modified))}")
        if self.deleted:
            parts.append(f"deleted {', '.join(sorted(self.deleted))}")
        detail = "; ".join(parts) if parts else "no changes"
        return f"apply_patch OK ({self.hunks_applied} hunk(s)): {detail}"


def apply_patch(files: Mapping[str, str], patch: str) -> PatchApplication:
    """Validate and apply a unified diff against ``files``.

    Args:
        files: current project contents, keyed by project-relative path.
        patch: a unified diff.

    Returns:
        A :class:`PatchApplication` describing only the files that changed.

    Raises:
        MalformedPatchError: the diff is not well-formed.
        UnsafePathError: a target path escapes the project fork.
        ContextMismatchError: a hunk does not match the current file content.
        PatchError: any other precondition failure (e.g. creating a file that
            already exists, or editing one that does not).
    """
    file_patches = parse_patch(patch)
    result = PatchApplication()

    seen: set[str] = set()
    for file_patch in file_patches:
        path = file_patch.path
        if path in seen:
            raise MalformedPatchError(
                f"patch contains more than one file section for {path!r}; "
                "combine them into a single section"
            )
        seen.add(path)
        _apply_file_patch(file_patch, files, result)

    return result


def _apply_file_patch(
    file_patch: FilePatch, files: Mapping[str, str], result: PatchApplication
) -> None:
    path = file_patch.path

    if file_patch.is_deletion:
        if file_patch.old_path is None or file_patch.old_path not in files:
            raise PatchError(
                f"patch deletes {path!r} but that file does not exist",
                observation=(
                    f"apply_patch REJECTED: cannot delete {path!r} — it does not exist. "
                    "Re-read the project tree before deleting."
                ),
            )
        result.files[path] = None
        result.deleted.append(path)
        result.hunks_applied += len(file_patch.hunks)
        return

    if file_patch.is_creation:
        if path in files:
            raise PatchError(
                f"patch creates {path!r} but that file already exists",
                observation=(
                    f"apply_patch REJECTED: {path!r} already exists. "
                    "Emit a diff against its current content instead of creating it."
                ),
            )
        original: list[str] = []
    else:
        if path not in files:
            raise PatchError(
                f"patch edits {path!r} but that file does not exist",
                observation=(
                    f"apply_patch REJECTED: {path!r} does not exist. "
                    "Create it with a /dev/null diff, or fix the path."
                ),
            )
        original = files[path].splitlines()

    updated = _apply_hunks(path, original, file_patch.hunks)
    trailing_newline = file_patch.is_creation or files.get(path, "").endswith("\n")
    text = "\n".join(updated) + ("\n" if updated and trailing_newline else "")

    result.files[path] = text
    result.hunks_applied += len(file_patch.hunks)
    if file_patch.is_creation:
        result.created.append(path)
    else:
        result.modified.append(path)


def _apply_hunks(path: str, original: list[str], hunks: list[Hunk]) -> list[str]:
    """Apply hunks in order, validating each against the current content."""
    output: list[str] = []
    cursor = 0  # index into `original` of the next unconsumed line
    previous_end = 0

    for hunk_index, hunk in enumerate(sorted(hunks, key=lambda h: h.old_start)):
        start = hunk.old_start - 1 if hunk.old_count > 0 else hunk.old_start
        if start < previous_end:
            raise MalformedPatchError(
                f"hunks for {path!r} overlap at line {hunk.old_start}; "
                "hunks must be disjoint and ordered"
            )
        if start > len(original):
            raise ContextMismatchError(
                path=path,
                hunk_index=hunk_index,
                expected=hunk.old_lines,
                actual=[],
                at_line=hunk.old_start,
            )

        expected = hunk.old_lines
        actual = original[start : start + len(expected)]
        if actual != expected:
            raise ContextMismatchError(
                path=path,
                hunk_index=hunk_index,
                expected=expected,
                actual=actual,
                at_line=hunk.old_start,
            )

        output.extend(original[cursor:start])
        output.extend(hunk.new_lines)
        cursor = start + len(expected)
        previous_end = cursor

    output.extend(original[cursor:])
    return output
