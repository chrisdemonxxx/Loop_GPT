"""Workspace-backed tool handlers for the local preview (apps/api).

The smoke script drives the loop against a dict of strings. That proves the
model can hold up its end of the tool contract; it does not let a person watch a
project take shape. These handlers work against a real directory instead, so the
preview shows files being read, written and re-read the way a run actually goes.

Two constraints shape this module, and neither is negotiable just because this
is "only" a local preview.

**Every path is confined to the workspace.** Handler arguments are model-authored
strings, so ``../../.ssh/id_rsa`` is an ordinary input, not an attack requiring
ingenuity. :func:`resolve_in_workspace` resolves symlinks before comparing, since
a symlink inside the workspace pointing outside it passes any prefix check
performed on the unresolved path.

**Shell execution is not possible here, at all.** Invariant I1 keeps
agent-authored code out of the control plane, and on this machine the control
plane *is* the user's laptop. There is no flag to turn it on: an invariant with
a local-preview exemption is not an invariant, and the repository's own I1 guard
fails the build on a ``subprocess`` call in a control-plane service. ``run_shell``
therefore refuses and explains why, and the preview verifies what it honestly
can — that the files the agent wrote *parse*, which is reading, not running.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loopit_agent_core.tools import ToolCall, ToolExecutor, ToolResult
from loopit_patch import PatchError
from loopit_patch import apply_patch as engine_apply_patch
from loopit_patch.apply import PatchApplication

#: How much of a file is returned in one observation.
#:
#: A model that reads a 200 KB lockfile spends the run's whole context on it and
#: learns nothing, so the read is truncated and says so.
MAX_OBSERVATION_CHARS = 20_000

#: Directories never walked or searched. They are large, generated, and contain
#: nothing the agent authored.
IGNORED_DIRECTORIES = frozenset({".git", "node_modules", "__pycache__", ".venv", "dist", "build"})


class WorkspaceError(Exception):
    """A tool argument was not usable against this workspace."""


def resolve_in_workspace(root: Path, candidate: str) -> Path:
    """Resolve ``candidate`` and prove it stays inside ``root``.

    Resolution happens *before* the containment check, and on both sides, so a
    symlink planted in the workspace cannot be used to reach past it.
    """
    if not candidate or candidate.strip() != candidate:
        raise WorkspaceError("path must be a non-empty project-relative path")
    if Path(candidate).is_absolute() or candidate.startswith("~"):
        raise WorkspaceError("path must be project-relative, not absolute")

    root = root.resolve()
    target = (root / candidate).resolve()
    if target != root and root not in target.parents:
        raise WorkspaceError(f"{candidate!r} resolves outside the project workspace")
    return target


def _truncate(text: str) -> str:
    if len(text) <= MAX_OBSERVATION_CHARS:
        return text
    dropped = len(text) - MAX_OBSERVATION_CHARS
    return f"{text[:MAX_OBSERVATION_CHARS]}\n... [{dropped} more characters not shown]"


@dataclass(slots=True)
class Workspace:
    """One project directory and the tools that act on it.

    Args:
        root: the project directory. Everything is confined to it.
    """

    root: Path
    touched: list[str] = field(default_factory=list, init=False)

    def __post_init__(self) -> None:
        self.root = Path(self.root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    # -- file surface ----------------------------------------------------

    def files(self) -> list[str]:
        """Every project file, workspace-relative, in stable order."""
        found: list[str] = []
        for path in sorted(self.root.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(self.root)
            if IGNORED_DIRECTORIES & set(relative.parts):
                continue
            found.append(relative.as_posix())
        return found

    def read_bytes(self, relative: str) -> bytes:
        target = resolve_in_workspace(self.root, relative)
        if not target.is_file():
            raise WorkspaceError(f"no such file: {relative}")
        return target.read_bytes()

    def write_bytes(self, relative: str, content: bytes) -> None:
        target = resolve_in_workspace(self.root, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        if relative not in self.touched:
            self.touched.append(relative)

    def read(self, relative: str) -> str:
        return self.read_bytes(relative).decode("utf-8", errors="replace")

    def write(self, relative: str, content: str) -> None:
        self.write_bytes(relative, content.encode("utf-8"))

    # -- tool handlers ---------------------------------------------------

    def read_file(self, call: ToolCall) -> ToolResult:
        relative = str(call.args.get("path", ""))
        try:
            return ToolResult(ok=True, output=_truncate(self.read(relative)))
        except (WorkspaceError, OSError) as error:
            return ToolResult(ok=False, output=str(error))

    def list_files(self, call: ToolCall) -> ToolResult:
        """List the project.

        Not reachable as a tool: the contract has no ``list_files``, and it
        rejects an empty ``search_code`` query. The listing is supplied to the
        agent as task context instead — see :meth:`RunManager._goal_for`.
        """
        listing = self.files()
        if not listing:
            return ToolResult(ok=True, output="the project is empty")
        return ToolResult(ok=True, output="\n".join(listing))

    def search_code(self, call: ToolCall) -> ToolResult:
        query = str(call.args.get("query", ""))
        if not query:
            return ToolResult(ok=False, output="search_code needs a non-empty query")

        hits: list[str] = []
        for relative in self.files():
            try:
                body = self.read(relative)
            except (WorkspaceError, OSError):
                continue
            for number, line in enumerate(body.splitlines(), 1):
                if query in line:
                    hits.append(f"{relative}:{number}: {line.strip()}")
        if not hits:
            return ToolResult(ok=True, output=f"no matches for {query!r}")
        return ToolResult(ok=True, output=_truncate("\n".join(hits)))

    def apply_patch(self, call: ToolCall) -> ToolResult:
        """Apply a unified diff through the platform's real patch engine.

        The preview does not get its own file-writing tool. The tool vocabulary
        is fixed by contract (``packages/contracts/schemas/tool-call.schema.json``),
        and widening it here so a demo felt smoother would mean the preview was
        exercising a system the platform does not have — including its path
        safety, which lives in the patch parser rather than being re-derived.

        On success, ``detail["file_changes"]`` carries structured per-file
        change records for the UI (path, op, unified diff slice, line counts).
        """
        patch = str(call.args.get("patch", ""))
        if not patch.strip():
            return ToolResult(ok=False, output="apply_patch needs a unified diff")

        current = {relative: self.read(relative) for relative in self.files()}
        try:
            application = engine_apply_patch(current, patch)
        except PatchError as error:
            # The engine's observation text is written for the model: it names
            # the mismatching context so the next attempt can be a correction
            # rather than a guess.
            return ToolResult(ok=False, output=str(error.observation or error))

        try:
            for relative, content in application.files.items():
                if content is None:
                    target = resolve_in_workspace(self.root, relative)
                    target.unlink(missing_ok=True)
                else:
                    self.write(relative, content)
        except (WorkspaceError, OSError) as error:
            return ToolResult(ok=False, output=f"patch parsed but could not be written: {error}")

        changes = describe_file_changes(current, application, patch)
        return ToolResult(ok=True, output=application.summary(), detail={"file_changes": changes})

    def refuse_patch(self, call: ToolCall) -> ToolResult:
        """Chat mode: patches are not allowed."""
        return ToolResult(
            ok=False,
            output=(
                "apply_patch is unavailable in chat mode. Answer with read_file "
                "or search_code only; switch to Build mode to change files."
            ),
        )

    def run_shell(self, call: ToolCall) -> ToolResult:
        """Always refuse, and say why.

        Refusing is the honest answer. Reporting a fabricated "tests passed"
        would make the preview lie about the one thing the verification layers
        exist to establish, and running the command for real would put
        model-authored code on the control plane.
        """
        command = str(call.args.get("command", ""))
        if not command:
            return ToolResult(ok=False, output="run_shell needs a command")
        return ToolResult(
            ok=False,
            output=(
                "run_shell is unavailable in this preview: there is no sandbox "
                "here, and executing model-authored commands on the control "
                "plane is what invariant I1 forbids. Verify your work by "
                "reading the files you wrote instead."
            ),
        )

    def executor(
        self,
        *,
        mode: str = "build",
        provision_handler: Any | None = None,
        secret_handler: Any | None = None,
        approved_gates: frozenset[str] = frozenset(),
        run_id: str = "local",
        browser_handler: Any | None = None,
    ) -> ToolExecutor:
        """The dispatch table handed to the agent loop.

        Local preview keeps ``run_shell`` refuse-only (I1). ``provision`` and
        ``request_secret`` are optional control-plane handlers behind gates.

        ``mode="chat"`` (and plan stubs that must not write) refuse ``apply_patch``.
        """
        apply = self.refuse_patch if mode in {"chat", "plan"} else self.apply_patch
        handlers: dict[str, Any] = {
            "read_file": self.read_file,
            "search_code": self.search_code,
            "apply_patch": apply,
            "run_shell": self.run_shell,
        }
        if provision_handler is not None and mode == "build":
            handlers["provision"] = provision_handler
        if secret_handler is not None and mode == "build":
            handlers["request_secret"] = secret_handler
        if browser_handler is not None and mode != "chat":
            handlers["browser"] = browser_handler
        return ToolExecutor(
            handlers,
            approved_gates=approved_gates,
            run_id=run_id,
        )


def describe_file_changes(
    before: dict[str, str],
    application: PatchApplication,
    patch: str,
) -> list[dict[str, Any]]:
    """Build structured ``file_change`` payloads from a successful patch apply."""
    hunks_by_path = _split_patch_by_path(patch)
    changes: list[dict[str, Any]] = []
    for path in sorted(application.files):
        if path in application.created:
            op = "create"
        elif path in application.deleted:
            op = "delete"
        else:
            op = "modify"
        old = before.get(path, "")
        new = application.files[path] or ""
        additions, deletions = _count_line_delta(old, new)
        changes.append(
            {
                "path": path,
                "op": op,
                "diff": hunks_by_path.get(path) or _synthetic_diff(path, old, new, op),
                "additions": additions,
                "deletions": deletions,
            }
        )
    return changes


def _count_line_delta(old: str, new: str) -> tuple[int, int]:
    old_lines = old.splitlines()
    new_lines = new.splitlines()
    # Cheap line-set approximation — enough for chips; full LCS is unnecessary.
    old_set = set(old_lines)
    new_set = set(new_lines)
    additions = sum(1 for line in new_lines if line not in old_set)
    deletions = sum(1 for line in old_lines if line not in new_set)
    if not additions and not deletions and old != new:
        additions = max(0, len(new_lines) - len(old_lines))
        deletions = max(0, len(old_lines) - len(new_lines))
        if additions == 0 and deletions == 0 and old != new:
            additions = 1
            deletions = 1
    return additions, deletions


def _split_patch_by_path(patch: str) -> dict[str, str]:
    """Slice a multi-file unified diff into per-path segments."""
    sections: dict[str, list[str]] = {}
    current: str | None = None
    buf: list[str] = []
    for line in patch.splitlines(keepends=True):
        if line.startswith("--- "):
            if current is not None and buf:
                sections.setdefault(current, []).extend(buf)
            buf = [line]
            current = None
            continue
        if line.startswith("+++ "):
            buf.append(line)
            target = line[4:].strip()
            if target.startswith("b/"):
                target = target[2:]
            if target == "/dev/null":
                # Deletion: path was on the --- line.
                for prior in reversed(buf[:-1]):
                    if prior.startswith("--- "):
                        src = prior[4:].strip()
                        if src.startswith("a/"):
                            src = src[2:]
                        current = src
                        break
            else:
                current = target
            continue
        buf.append(line)
    if current is not None and buf:
        sections.setdefault(current, []).extend(buf)
    return {path: "".join(lines) for path, lines in sections.items()}


def _synthetic_diff(path: str, old: str, new: str, op: str) -> str:
    if op == "create":
        body = "".join(f"+{line}\n" for line in new.splitlines())
        return f"--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{len(new.splitlines())} @@\n{body}"
    if op == "delete":
        body = "".join(f"-{line}\n" for line in old.splitlines())
        return f"--- a/{path}\n+++ /dev/null\n@@ -1,{len(old.splitlines())} +0,0 @@\n{body}"
    return f"--- a/{path}\n+++ b/{path}\n"


__all__ = [
    "IGNORED_DIRECTORIES",
    "MAX_OBSERVATION_CHARS",
    "Workspace",
    "WorkspaceError",
    "describe_file_changes",
    "resolve_in_workspace",
]
