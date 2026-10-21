"""Structured patch errors.

Every error carries an agent-readable ``observation`` string. Failures are the
normal case in an agent loop: a rejected patch is not an exception to swallow,
it is the *next input* to the loop (Doc 04 §8).
"""

from __future__ import annotations


class PatchError(Exception):
    """Base class for all patch failures."""

    def __init__(self, message: str, *, observation: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.observation = observation or message

    def __str__(self) -> str:
        return self.message


class MalformedPatchError(PatchError):
    """The patch text is not a well-formed unified diff."""


class UnsafePathError(PatchError):
    """A patch targets a path outside the project fork.

    Absolute paths and parent traversal are rejected: a task agent operates on a
    copy-on-write fork of one project and must not be able to name anything
    outside it.
    """


class ContextMismatchError(PatchError):
    """A hunk's context lines do not match the current file.

    This is stale-read protection. The agent read the file, the file changed (or
    the agent hallucinated the context), and applying anyway would silently
    corrupt code. The correct response is to re-read and re-patch.
    """

    def __init__(
        self,
        path: str,
        hunk_index: int,
        expected: list[str],
        actual: list[str],
        at_line: int,
    ) -> None:
        message = f"hunk {hunk_index + 1} of {path!r} does not match the file at line {at_line}"
        observation = (
            f"apply_patch REJECTED: {message}. "
            f"Expected context:\n"
            + "\n".join(f"  {line!r}" for line in expected)
            + "\nActual file content:\n"
            + "\n".join(f"  {line!r}" for line in actual)
            + "\nRe-read the file and emit a patch against its current content."
        )
        super().__init__(message, observation=observation)
        self.path = path
        self.hunk_index = hunk_index
        self.expected = expected
        self.actual = actual
        self.at_line = at_line
