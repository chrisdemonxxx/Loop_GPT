"""Tests for :mod:`loopit_patch`.

These tests guard invariant I6 (diff/patch only, never full-file rewrites) and
the stale-read protection that makes it safe.
"""

from __future__ import annotations

import pytest
from loopit_patch import (
    ContextMismatchError,
    MalformedPatchError,
    PatchError,
    UnsafePathError,
    apply_patch,
    parse_patch,
)

HELLO = "line one\nline two\nline three\n"


def test_applies_a_simple_modification() -> None:
    patch = (
        "--- a/app.py\n"
        "+++ b/app.py\n"
        "@@ -1,3 +1,3 @@\n"
        " line one\n"
        "-line two\n"
        "+line TWO\n"
        " line three\n"
    )
    result = apply_patch({"app.py": HELLO}, patch)

    assert result.files == {"app.py": "line one\nline TWO\nline three\n"}
    assert result.modified == ["app.py"]
    assert result.hunks_applied == 1
    assert "modified app.py" in result.summary()


def test_creates_a_new_file_from_dev_null() -> None:
    patch = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n"
    result = apply_patch({}, patch)

    assert result.files == {"new.txt": "alpha\nbeta\n"}
    assert result.created == ["new.txt"]


def test_deletes_a_file() -> None:
    patch = "--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n"
    result = apply_patch({"gone.txt": "bye\n"}, patch)

    assert result.files == {"gone.txt": None}
    assert result.deleted == ["gone.txt"]


def test_applies_multiple_disjoint_hunks() -> None:
    original = "a\nb\nc\nd\ne\nf\n"
    patch = "--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -5,2 +5,2 @@\n e\n-f\n+F\n"
    result = apply_patch({"x.txt": original}, patch)

    assert result.files["x.txt"] == "A\nb\nc\nd\ne\nF\n"
    assert result.hunks_applied == 2


def test_applies_patches_to_several_files_at_once() -> None:
    patch = (
        "--- a/one.txt\n"
        "+++ b/one.txt\n"
        "@@ -1,1 +1,1 @@\n"
        "-one\n"
        "+ONE\n"
        "--- a/two.txt\n"
        "+++ b/two.txt\n"
        "@@ -1,1 +1,1 @@\n"
        "-two\n"
        "+TWO\n"
    )
    result = apply_patch({"one.txt": "one\n", "two.txt": "two\n"}, patch)

    assert result.files == {"one.txt": "ONE\n", "two.txt": "TWO\n"}
    assert sorted(result.modified) == ["one.txt", "two.txt"]


def test_ignores_git_extended_headers() -> None:
    patch = (
        "diff --git a/app.py b/app.py\n"
        "index 1234567..89abcde 100644\n"
        "--- a/app.py\n"
        "+++ b/app.py\n"
        "@@ -1,1 +1,1 @@\n"
        "-line one\n"
        "+LINE ONE\n"
    )
    result = apply_patch({"app.py": "line one\n"}, patch)
    assert result.files["app.py"] == "LINE ONE\n"


# --- Stale-read protection (the point of the whole package) -------------------


def test_rejects_hunk_whose_context_does_not_match() -> None:
    patch = (
        "--- a/app.py\n"
        "+++ b/app.py\n"
        "@@ -1,3 +1,3 @@\n"
        " line one\n"
        "-line TWO WRONG\n"
        "+line two patched\n"
        " line three\n"
    )
    with pytest.raises(ContextMismatchError) as excinfo:
        apply_patch({"app.py": HELLO}, patch)

    error = excinfo.value
    assert error.path == "app.py"
    assert error.hunk_index == 0
    assert "Re-read the file" in error.observation


def test_rejects_hunk_starting_past_end_of_file() -> None:
    patch = "--- a/app.py\n+++ b/app.py\n@@ -99,1 +99,1 @@\n-nope\n+yep\n"
    with pytest.raises(ContextMismatchError):
        apply_patch({"app.py": HELLO}, patch)


def test_nothing_is_written_when_any_file_fails() -> None:
    patch = (
        "--- a/ok.txt\n"
        "+++ b/ok.txt\n"
        "@@ -1,1 +1,1 @@\n"
        "-ok\n"
        "+OK\n"
        "--- a/bad.txt\n"
        "+++ b/bad.txt\n"
        "@@ -1,1 +1,1 @@\n"
        "-wrong context\n"
        "+never applied\n"
    )
    files = {"ok.txt": "ok\n", "bad.txt": "actual\n"}
    with pytest.raises(ContextMismatchError):
        apply_patch(files, patch)

    assert files == {"ok.txt": "ok\n", "bad.txt": "actual\n"}


# --- Path safety --------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    ["/etc/passwd", "../../../etc/shadow", "a/../../outside.txt", "C:/Windows/system32"],
)
def test_rejects_paths_outside_the_project_fork(path: str) -> None:
    patch = f"--- a/{path}\n+++ b/{path}\n@@ -1,1 +1,1 @@\n-x\n+y\n"
    with pytest.raises(UnsafePathError):
        parse_patch(patch)


# --- Malformed input ----------------------------------------------------------


def test_rejects_empty_patch() -> None:
    with pytest.raises(MalformedPatchError):
        parse_patch("   \n")


def test_rejects_patch_with_no_file_header() -> None:
    with pytest.raises(MalformedPatchError):
        parse_patch("@@ -1,1 +1,1 @@\n-a\n+b\n")


def test_rejects_hunk_header_before_file_header() -> None:
    with pytest.raises(MalformedPatchError):
        parse_patch("some prose\n@@ -1,1 +1,1 @@\n-a\n+b\n")


def test_rejects_file_header_without_plus_line() -> None:
    with pytest.raises(MalformedPatchError):
        parse_patch("--- a/x.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n")


def test_wrong_header_counts_are_derived_from_the_body() -> None:
    """GNU patch semantics: @@ counts are advisory, the hunk body is
    authoritative. Models write wrong counts constantly while getting the
    body right — rejecting these cost real builds (the pomodoro run of
    2026-10-11 died repeating a patch whose context was exactly correct)."""
    patch = "--- a/x.txt\n+++ b/x.txt\n@@ -1,5 +1,5 @@\n-a\n+b\n"
    (file_patch,) = parse_patch(patch)
    (hunk,) = file_patch.hunks
    assert hunk.old_count == 1
    assert hunk.new_count == 1
    assert apply_patch({"x.txt": "a\n"}, patch).files["x.txt"] == "b\n"


def test_rejects_garbage_line_inside_hunk() -> None:
    patch = "--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n a\n!garbage\n"
    with pytest.raises(MalformedPatchError):
        parse_patch(patch)


def test_rejects_overlapping_hunks() -> None:
    patch = (
        "--- a/x.txt\n"
        "+++ b/x.txt\n"
        "@@ -1,2 +1,2 @@\n"
        "-line one\n"
        "+ONE\n"
        " line two\n"
        "@@ -2,2 +2,2 @@\n"
        "-line two\n"
        "+TWO\n"
        " line three\n"
    )
    with pytest.raises(MalformedPatchError, match="overlap"):
        apply_patch({"x.txt": HELLO}, patch)


def test_rejects_duplicate_file_sections() -> None:
    patch = (
        "--- a/x.txt\n"
        "+++ b/x.txt\n"
        "@@ -1,1 +1,1 @@\n"
        "-line one\n"
        "+ONE\n"
        "--- a/x.txt\n"
        "+++ b/x.txt\n"
        "@@ -3,1 +3,1 @@\n"
        "-line three\n"
        "+THREE\n"
    )
    with pytest.raises(MalformedPatchError, match="more than one file section"):
        apply_patch({"x.txt": HELLO}, patch)


def test_rejects_editing_a_file_that_does_not_exist() -> None:
    patch = "--- a/missing.txt\n+++ b/missing.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n"
    with pytest.raises(PatchError, match="does not exist"):
        apply_patch({}, patch)


def test_rejects_creating_a_file_that_already_exists() -> None:
    patch = "--- /dev/null\n+++ b/app.py\n@@ -0,0 +1,1 @@\n+new\n"
    with pytest.raises(PatchError, match="already exists"):
        apply_patch({"app.py": HELLO}, patch)


def test_rejects_deleting_a_file_that_does_not_exist() -> None:
    patch = "--- a/missing.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n"
    with pytest.raises(PatchError, match="does not exist"):
        apply_patch({}, patch)


def test_preserves_absence_of_trailing_newline() -> None:
    patch = "--- a/x.txt\n+++ b/x.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n"
    result = apply_patch({"x.txt": "a"}, patch)
    assert result.files["x.txt"] == "b"
