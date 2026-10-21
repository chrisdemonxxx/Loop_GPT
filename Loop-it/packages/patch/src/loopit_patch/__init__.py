"""Unified-diff parsing, validation, and application.

This package is the **only** write path into a project filesystem (invariant I6,
Doc 04 §6). Full-file rewrites of existing files are the number-one cause of
silent regressions in agent systems, so the agent may not perform them: it emits
a unified diff, every hunk is validated against the *current* file content, and
a context mismatch is **rejected** rather than force-applied. A rejection forces
the agent to re-read the file instead of blindly overwriting it.
"""

from .apply import PatchApplication, apply_patch
from .errors import (
    ContextMismatchError,
    MalformedPatchError,
    PatchError,
    UnsafePathError,
)
from .parser import FilePatch, Hunk, HunkLine, parse_patch

__all__ = [
    "ContextMismatchError",
    "FilePatch",
    "Hunk",
    "HunkLine",
    "MalformedPatchError",
    "PatchApplication",
    "PatchError",
    "UnsafePathError",
    "apply_patch",
    "parse_patch",
]
