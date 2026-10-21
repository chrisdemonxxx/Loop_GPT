"""Run orchestration for the local preview: one agent loop, streamed live.

The loop already emits an audit record for every decision it makes — started,
tool called, tool result, verification verdict, stopped. Those records are the
run's ground truth, so the preview streams *them* rather than a second, parallel
narration invented for the UI. A UI fed from its own telemetry drifts from what
the platform actually recorded, and then the screen and the audit log disagree
about what happened.

The loop is synchronous and blocking, so each run gets a thread and publishes
into a queue the SSE endpoint drains. A run that no one is watching still
finishes: the queue is unbounded and the thread does not check for subscribers,
because a run whose progress depends on someone looking at it is a run that
behaves differently under observation.

Nothing here executes model-authored code. That decision lives in
:class:`~loopit_api.workspace.Workspace` and is off by default.
"""

from __future__ import annotations

import ast
import json
import logging
import os
import posixpath
import queue
import re
import threading
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any

import tree_sitter_javascript
from jsonschema import Draft202012Validator
from loopit_agent_core.audit import AuditEvent, redact
from loopit_agent_core.budget import Budget, BudgetExceeded
from loopit_agent_core.loop import AgentLoop, LoopOutcome
from loopit_agent_core.reflection import VerificationVerdict
from loopit_agent_core.tools import ToolCall
from loopit_checkpoint import Checkpoint, CheckpointError, FileCheckpointStore
from loopit_router.quota import QuotaExceeded
from tree_sitter import Language, Parser

from .brief import expand_brief, fallback_brief
from .metering import CreditsExhausted, LoopGptUsageMeter, MeteredModelClient, MeteringUnavailable
from .stacks import (
    REACT_STACK,
    STACKS,
    STATIC_STACK,
    guidance_for,
    infer_stack_from_files,
    scaffold_for,
    uses_sandbox_runtime,
)
from .workspace import Workspace, WorkspaceError, resolve_in_workspace

LOGGER = logging.getLogger(__name__)

#: Sentinel pushed when a run ends, so a reader knows to stop rather than
#: waiting on a queue that will never fill again.
_DONE = object()

#: Returned by :meth:`RunManager.next_event` once a run is over.
RUN_FINISHED = object()

#: A project id becomes a directory name, so it is constrained to characters
#: that cannot traverse, quote, or mean something to a shell.
PROJECT_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")

#: ``src=`` and ``href=`` targets. Deliberately a regex and not a parser: this
#: checks references, and a reference that only a lenient parser can find is one
#: no browser will follow either.
_LOCAL_REFERENCE = re.compile(r"""(?:src|href)\s*=\s*["']([^"']+)["']""", re.IGNORECASE)

#: ``import ... from "./x.js"`` and bare ``import "./x.js"``. Only relative
#: specifiers: a bare ``react`` is the import map's business, not the disk's.
_MODULE_IMPORT = re.compile(
    r"""(?:^|[\s;}])(?:import|export)\b[^;\n]*?["'](\.\.?/[^"']+)["']""",
    re.MULTILINE,
)

#: A tag opening where htm requires a template literal. Narrow on purpose: an
#: ``a < b`` comparison must never be reported as JSX, so this only matches the
#: two places JSX actually appears — returned, or as an arrow body.
_LOOKS_LIKE_JSX = re.compile(r"(?:return|=>)\s*\(?\s*<\s*[A-Za-z][\w.-]*[\s/>]")

#: `style="..."` is HTML, and it is what anyone writes by reflex. React refuses
#: a string here (error #62) and the whole tree fails to mount, so a project can
#: parse cleanly, resolve every reference, and still render an empty page. Found
#: exactly that way: three `verified` runs, one blank screenshot.
_STRING_STYLE_PROP = re.compile(r"""\bstyle\s*=\s*["'][^"']""")

#: Only meaningful in a file that renders through htm.
_USES_HTM = re.compile(r"\bhtml`")

#: Class names as written in markup, and as defined in a stylesheet. Markup is
#: full of class names the CSS never mentions when an agent builds structure and
#: calls it done: the project parses, resolves, renders, and looks like nothing.
#: Values holding an interpolation are skipped - a composed name is not a claim
#: about any one literal token.
_CLASS_ATTRIBUTE = re.compile(r"""\bclass(?:Name)?\s*=\s*["']([^"'{}]*)["']""")
_CSS_CLASS_SELECTOR = re.compile(r"\.(-?[A-Za-z_][\w-]*)")

#: Anything the project is not responsible for producing.
_EXTERNAL_PREFIXES = ("http://", "https://", "//", "data:", "mailto:", "tel:", "#", "javascript:")


def _is_external(target: str) -> bool:
    lowered = target.strip().lower()
    return not lowered or lowered.startswith(_EXTERNAL_PREFIXES)


#: JavaScript is the language the generated app is actually written in, so
#: leaving it unchecked meant the one thing that had to parse was the one thing
#: nobody parsed. A run went green on a project whose App.js stopped in the
#: middle of a template literal; the page rendered nothing at all.
_JAVASCRIPT = Language(tree_sitter_javascript.language())


def _javascript_failures(relative: str, body: str) -> list[str]:
    """Report the first syntax error in a module, or nothing.

    Parsing is not executing. tree-sitter builds a syntax tree and stops — it
    has no evaluator — which is the same reason ``ast.parse`` is allowed here
    while ``compile`` is not (I1).

    Getting the *location* right is most of the value. tree-sitter's outermost
    ``ERROR`` node starts at byte zero for an unterminated file, and an agent
    told its problem is on line 1 will rewrite the file unchanged and be told
    the same thing again — which is exactly what happened before this looked
    past the node's own position at the tokens it never closed.
    """
    tree = Parser(_JAVASCRIPT).parse(body.encode("utf-8"))
    if not tree.root_node.has_error:
        return []

    node = _first_error(tree.root_node)
    if node is None:
        return [f"{relative}: does not parse as JavaScript"]

    if node.is_missing:
        return [
            f"{relative}:{node.start_point[0] + 1}: missing {node.type!r}. "
            "The file does not parse as JavaScript."
        ]

    unclosed = _unclosed_openers(node) or _unclosed_in_tree(tree.root_node)
    if unclosed:
        opener, line = unclosed[-1]
        ends_at = body.count("\n") + 1
        outer = (
            f" (inside a {unclosed[0][0]!r} opened at line {unclosed[0][1]})"
            if len(unclosed) > 1
            else ""
        )
        closers = ", ".join(repr(_PAIRS[symbol]) for symbol, _ in reversed(unclosed))
        return [
            f"{relative}: a {opener!r} opened at line {line}{outer} is never closed — "
            f"the file ends at line {ends_at}. Either the closer was simply forgotten, "
            f"or the file was cut off. Read the end of the file: if the markup is "
            f"finished, add the missing {closers} on the last line; if it stops "
            "mid-thought, write the rest. Should the file be too long to finish in one "
            "patch, move part of it into a separate component file first."
        ]

    return [
        f"{relative}:{node.start_point[0] + 1}: unexpected input — the file does "
        "not parse as JavaScript."
    ]


def _first_error(root: Any) -> Any:
    """The outermost node the parser could not make sense of."""
    pending = [root]
    while pending:
        node = pending.pop(0)
        if node.type == "ERROR" or node.is_missing:
            return node
        pending.extend(child for child in node.children if child.has_error)
    return None


#: Bracket-alikes, and what closes them. A backtick closes itself.
_PAIRS = {"{": "}", "(": ")", "[": "]", "${": "}", "`": "`"}


def _unclosed_openers(node: Any) -> list[tuple[str, int]]:
    """Which openers inside a broken node were never closed, outermost first.

    When a file is cut off, tree-sitter leaves the openers it was still inside
    as bare token children of the ``ERROR`` node. Matching them up says which
    construct the file died in, which is the one thing the agent needs to know.
    """
    stack: list[tuple[str, int]] = []
    for child in node.children:
        symbol = child.type
        if symbol == "`" and stack and stack[-1][0] == "`":
            stack.pop()
        elif symbol in _PAIRS:
            stack.append((symbol, child.start_point[0] + 1))
        elif stack and symbol == _PAIRS[stack[-1][0]]:
            stack.pop()
    return stack


def _unclosed_in_tree(root: Any) -> list[tuple[str, int]]:
    """The same question asked of every token in the file.

    ``_unclosed_openers`` only works when tree-sitter parks the openers on the
    ``ERROR`` node itself, and it does not always do that — a file missing one
    backtick can produce an error node with no bare tokens at all, which fell
    through to "does not parse as JavaScript" and told the agent nothing. Every
    balanced pair cancels, so whatever is left over is genuinely unclosed.
    """
    stack: list[tuple[str, int]] = []
    pending = [root]
    leaves: list[Any] = []
    while pending:
        node = pending.pop()
        if node.child_count == 0:
            leaves.append(node)
        else:
            pending.extend(reversed(node.children))
    for leaf in sorted(leaves, key=lambda n: n.start_byte):
        symbol = leaf.type
        if symbol == "`" and stack and stack[-1][0] == "`":
            stack.pop()
        elif symbol in _PAIRS:
            stack.append((symbol, leaf.start_point[0] + 1))
        elif stack and symbol == _PAIRS[stack[-1][0]]:
            stack.pop()
    return stack


SYSTEM_PROMPT = """You are a software engineer building a web application in a \
sandboxed project directory.

You act only by emitting a single JSON tool call per turn. Never explain, never \
apologise, never emit prose — emit only the JSON object.

Available tools:
- search_code  args: {"query": "<text>"}
- read_file    args: {"path": "<project-relative path>"}
- apply_patch  args: {"patch": "<unified diff>"}

You may propose edits to LOOP.md (project knowledge) when the user asks for \
lasting instructions; otherwise leave it alone.

There is no shell and no sandbox here, so there is nothing to run and no tests \
to execute. Do not ask to run commands; the request will be refused and the \
turn wasted. (Sandbox / orchestrator stacks use a different system prompt that \
allows run_shell, install_package, start_dev_server, and read_logs.)

To create a new file, emit a creation diff:

--- /dev/null
+++ b/index.html
@@ -0,0 +1,3 @@
+<!doctype html>
+<html>
+</html>

To edit an existing file, read it first and make the context lines of your hunk \
match it exactly.

Work in small steps: look at the project, read what is already there, then \
change one file at a time. Read each file at most once before you patch it — \
re-reading a file you have already seen tells you nothing and the run is \
stopped if you do it repeatedly. Keep each patch under about 120 lines — a \
reply that runs past the output budget is cut off mid-diff and is worth \
nothing. Build anything larger across several turns, splitting the work across \
several files rather than one enormous one.

When files already exist, they are yours to extend: read a file before you \
patch it so your context lines match, and keep the existing look and structure \
unless you were asked to change them.

SCOPE DISCIPLINE (binding): Build EXACTLY what the goal states — every \
requested piece, nothing unrequested. Do not add extra pages, features, \
buttons, toggles, settings, sample dashboards, integrations, or \
"nice touches" the goal does not mention. Do not fabricate functionality: \
never fake a backend, fake data flow, fake auth, or placeholder controls \
that imply behavior the project does not implement. Ambiguity → the smallest \
complete interpretation that satisfies the goal. If the operator sends a new \
message mid-run, it amends the goal: follow it with the same discipline.

Make it look finished. Real spacing, a considered colour palette, readable \
type, hover and focus states, and a layout that holds up on a phone. Use \
plausible specific content, never lorem ipsum or "Item 1".

When you believe the work is finished, read back the main file you wrote. The \
run completes when the project parses and you have re-read your own work — you \
cannot declare success yourself.
"""

#: Used when the agent runs inside a leased sandbox (Temporal orchestrator /
#: workspace-dispatch). Local static/htm preview keeps :data:`SYSTEM_PROMPT`.
SANDBOX_SYSTEM_PROMPT = """You are a software engineer building a web application \
in a remote Linux sandbox.

You act only by emitting a single JSON tool call per turn. Never explain, never \
apologise, never emit prose — emit only the JSON object.

Available tools:
- search_code  args: {"query": "<text>"}
- read_file    args: {"path": "<project-relative path>"}
- apply_patch  args: {"patch": "<unified diff>"}
- run_shell    args: {"command": "<shell>", "cwd"?: "<path>", "timeout_seconds"?: int}
- install_package args: {"package": "<name>", "manager"?: "npm"|"pnpm"|"yarn"|"pip"|"uv", "dev"?: bool}
- start_dev_server args: {"command"?: "<cmd>", "cwd"?: "<path>", "log_path"?: "<path>"}
- read_logs    args: {"path"?: "<path>", "lines"?: int}

Outbound network is filtered by the egress allowlist (npm/pypi and friends). \
Prefer install_package over raw registry curl. After start_dev_server, use \
read_logs to inspect stdout/stderr.

You may propose edits to LOOP.md (project knowledge) when the user asks for \
lasting instructions; otherwise leave it alone.

To create a new file, emit a creation diff:

--- /dev/null
+++ b/index.html
@@ -0,0 +1,3 @@
+<!doctype html>
+<html>
+</html>

Work in small steps: read, patch, then run or install as needed. Prefer \
verify-by-running over guessing. Emit ONLY the JSON object.
"""


def system_prompt_for(*, shell_enabled: bool = False) -> str:
    """Pick the local (no-shell) or sandbox (shell-enabled) build prompt."""
    return SANDBOX_SYSTEM_PROMPT if shell_enabled else SYSTEM_PROMPT


CHAT_SYSTEM_PROMPT = """You are a software engineer discussing a web application \
in a sandboxed project directory. This is Chat mode: you may only read.

You act only by emitting a single JSON tool call per turn. Never explain, never \
apologise, never emit prose — emit only the JSON object.

Available tools:
- search_code  args: {"query": "<text>"}
- read_file    args: {"path": "<project-relative path>"}

apply_patch is refused. Answer the user's questions by reading the project. \
When you have enough context, emit a final read of a representative file and stop.
"""

PLAN_SYSTEM_PROMPT = """You are a software engineer drafting a build plan for a \
web application. Plan mode is read-only: inspect the project, do not patch files.

You act only by emitting a single JSON tool call per turn. Never explain, never \
apologise, never emit prose — emit only the JSON object.

Available tools:
- search_code  args: {"query": "<text>"}
- read_file    args: {"path": "<project-relative path>"}

apply_patch is refused. Survey the project so the plan DAG (already shown to \
the user) is grounded. Stop after a short orientation.
"""


class PreviewVerifier:
    """The preview's stand-in for the verification pipeline.

    The platform's rule is that an agent never declares its own success: a run
    ends when verification says so. The preview has no sandbox to run a test
    suite in, so it verifies the strongest thing it can actually establish —
    that every file the agent wrote parses — and requires the agent to have
    re-read its work afterwards.

    That second condition is what stops the run going green the moment the first
    file lands. A single parseable file is not a finished task, and a verifier
    that accepted it would end runs early and make the preview look like it does
    less than it does.
    """

    def __init__(self, workspace: Workspace, *, htm_rules: bool = True) -> None:
        self._workspace = workspace
        self._patched = False
        #: htm / no-build React rules. Disabled for Vite/JSX sandbox stacks.
        self._htm_rules = htm_rules

    def __call__(self, call: ToolCall, observation: Any) -> VerificationVerdict | str | None:
        if call.tool == "apply_patch":
            content = getattr(observation, "content", "")
            if "apply_patch OK" in content:
                self._patched = True
            return None

        if call.tool == "run_shell":
            content = getattr(observation, "content", "")
            if "passed" in content and "failed" not in content:
                return "the test command reported a pass"
            return None

        if call.tool not in {"read_file", "search_code"} or not self._patched:
            return None

        broken = self._parse_failures()
        if self._htm_rules:
            # Vite/npm stacks resolve modules differently; skip CDN/htm heuristics.
            broken = (
                broken
                + self._dangling_references()
                + self._unreachable_modules()
                + self._unstyled_class_names()
                + self._jsx_in_a_module()
                + self._props_react_will_reject()
            )
        if broken:
            # A red verdict is the next input, not an error to swallow: this is
            # the reflection mechanism the loop is built around.
            return VerificationVerdict(
                verified=False,
                summary="the project does not hold together",
                observation="Verification failed:\n" + "\n".join(broken),
            )
        return "the project parses and its files resolve"

    def _parse_failures(self) -> list[str]:
        """Parse every file the preview knows how to check.

        Parsing is not executing. ``ast.parse`` builds a syntax tree and stops;
        it never produces a code object, so nothing the agent wrote can run
        here. That distinction is the whole reason this check is allowed to
        live on the control plane at all.
        """
        failures: list[str] = []
        for relative in self._workspace.files():
            try:
                body = self._workspace.read(relative)
            except (WorkspaceError, OSError) as error:
                failures.append(f"{relative}: {error}")
                continue
            suffix = Path(relative).suffix.lower()
            if suffix == ".json":
                try:
                    json.loads(body)
                except json.JSONDecodeError as error:
                    failures.append(f"{relative}: invalid JSON at line {error.lineno}")
            elif suffix == ".py":
                try:
                    ast.parse(body, filename=relative)
                except SyntaxError as error:
                    failures.append(f"{relative}: {error.msg} at line {error.lineno}")
            elif suffix in {".js", ".mjs"}:
                failures.extend(_javascript_failures(relative, body))
        return failures

    def _dangling_references(self) -> list[str]:
        """Find local files a page links to but that were never written.

        Every file parsing is a weak claim once a project spans more than one
        of them: ``books.html`` linking a ``app.js`` that does not exist parses
        perfectly and is broken in the browser. The more files a project has
        the more chances there are for one of these, so this is exactly the
        check that has to exist before bigger projects mean anything.
        """
        present = set(self._workspace.files())
        failures: list[str] = []
        for relative in sorted(present):
            suffix = Path(relative).suffix.lower()
            if suffix not in {".html", ".htm", ".js", ".mjs"}:
                continue
            try:
                body = self._workspace.read(relative)
            except (WorkspaceError, OSError):
                continue
            if suffix in {".js", ".mjs"}:
                # A module importing a sibling that was never written is the
                # same bug as a page linking a missing stylesheet, and once
                # components live in their own files it is the likelier one.
                references = _MODULE_IMPORT.findall(body)
            else:
                references = _LOCAL_REFERENCE.findall(body)
            base = PurePosixPath(relative).parent
            for target in sorted(set(references)):
                if _is_external(target):
                    continue
                path = target.split("#", 1)[0].split("?", 1)[0]
                if not path:
                    continue
                resolved = posixpath.normpath(posixpath.join(str(base), path))
                if resolved not in present:
                    failures.append(
                        f"{relative} references {target!r}, which does not exist. "
                        "Create it or remove the reference."
                    )
        return failures

    def _unreachable_modules(self) -> list[str]:
        """Find modules nothing imports.

        The mirror image of a dangling reference, and the harder one to see: a
        component written into its own file, never wired into anything, is a
        run that reports success and a page that looks unchanged. Watched it
        happen — a FilterBar the agent built, verified, and never rendered.
        Reachability is walked from the entry points the HTML actually loads,
        so a file is only orphaned if no path leads to it.
        """
        present = set(self._workspace.files())
        modules = {f for f in present if Path(f).suffix.lower() in {".js", ".mjs"}}
        if not modules:
            return []

        reachable: set[str] = set()
        frontier: list[str] = []
        for relative in sorted(present):
            if Path(relative).suffix.lower() not in {".html", ".htm"}:
                continue
            try:
                body = self._workspace.read(relative)
            except (WorkspaceError, OSError):
                continue
            base = PurePosixPath(relative).parent
            for target in _LOCAL_REFERENCE.findall(body):
                if _is_external(target):
                    continue
                entry = posixpath.normpath(posixpath.join(str(base), target.split("?", 1)[0]))
                if entry in modules:
                    frontier.append(entry)

        while frontier:
            current = frontier.pop()
            if current in reachable:
                continue
            reachable.add(current)
            try:
                body = self._workspace.read(current)
            except (WorkspaceError, OSError):
                continue
            base = PurePosixPath(current).parent
            for target in _MODULE_IMPORT.findall(body):
                resolved = posixpath.normpath(posixpath.join(str(base), target))
                if resolved in modules and resolved not in reachable:
                    frontier.append(resolved)

        if not reachable:
            # No HTML entry point found: reachability says nothing, so it must
            # not be allowed to say everything is orphaned.
            return []
        return [
            f"{relative} is never imported by anything, so none of it runs. "
            "Import it from the module that should use it, or delete it."
            for relative in sorted(modules - reachable)
        ]

    def _unstyled_class_names(self) -> list[str]:
        """Find class names the markup uses and no stylesheet defines.

        "Make it look finished" is in the prompt and nothing enforced it, so a
        run could write a full component tree, name every element, never open
        the stylesheet, and be told it passed. The page rendered: unstyled black
        text on white. This is the dangling-reference check pointed at styling —
        a class with no rule is a reference to something that was never written.
        """
        stylesheets = [f for f in self._workspace.files() if Path(f).suffix.lower() == ".css"]
        if not stylesheets:
            # No stylesheet at all may be a deliberate inline-styled page, and
            # a check that fires on every project is a check nobody reads.
            return []

        defined: set[str] = set()
        for relative in stylesheets:
            try:
                defined.update(_CSS_CLASS_SELECTOR.findall(self._workspace.read(relative)))
            except (WorkspaceError, OSError):
                continue

        used: dict[str, str] = {}
        for relative in sorted(self._workspace.files()):
            if Path(relative).suffix.lower() not in {".html", ".htm", ".js", ".mjs"}:
                continue
            try:
                body = self._workspace.read(relative)
            except (WorkspaceError, OSError):
                continue
            for value in _CLASS_ATTRIBUTE.findall(body):
                for name in value.split():
                    used.setdefault(name, relative)

        missing = sorted(set(used) - defined)
        if not missing or len(missing) * 2 <= len(used):
            # A handful of unstyled utility classes is normal and the page still
            # looks finished; failing on those turns a working app into a
            # stalled run. What is worth blocking is markup whose stylesheet was
            # never really written - a majority of names with no rule at all.
            return []
        shown = ", ".join(missing[:8]) + (" ..." if len(missing) > 8 else "")
        return [
            f"{len(missing)} class name(s) used in markup have no rule in "
            f"{', '.join(sorted(stylesheets))}: {shown}. The page renders unstyled. "
            "Write the CSS for them, or drop the classes."
        ]

    def _jsx_in_a_module(self) -> list[str]:
        """Catch JSX written into a file the browser will run as-is.

        There is no build step, so JSX does not fail loudly — it fails as a
        blank page with an error nobody is looking at. An agent that has
        written React under a bundler a million times will reach for it, and
        the only useful moment to say so is here, where the answer becomes the
        next input instead of a support question.
        """
        failures: list[str] = []
        for relative in sorted(self._workspace.files()):
            if Path(relative).suffix.lower() not in {".js", ".mjs"}:
                continue
            try:
                body = self._workspace.read(relative)
            except (WorkspaceError, OSError):
                continue
            match = _LOOKS_LIKE_JSX.search(body)
            if match:
                line = body[: match.start()].count("\n") + 1
                failures.append(
                    f"{relative}:{line} looks like JSX, which has no build step here "
                    "and will render nothing. Use an htm tagged template instead: "
                    "html`<div>...</div>`, with components as <${Name} />."
                )
        return failures

    def _props_react_will_reject(self) -> list[str]:
        """Catch props that parse, resolve, and still blank the page.

        htm looks enough like HTML that a string ``style`` is the obvious thing
        to write, and React throws on it rather than ignoring it — so the whole
        tree fails to mount and the preview is empty. Every other check passed
        on a project that did this; only a browser saw it. Cheaper to say here.
        """
        failures: list[str] = []
        for relative in sorted(self._workspace.files()):
            if Path(relative).suffix.lower() not in {".js", ".mjs"}:
                continue
            try:
                body = self._workspace.read(relative)
            except (WorkspaceError, OSError):
                continue
            if not _USES_HTM.search(body):
                continue
            match = _STRING_STYLE_PROP.search(body)
            if match:
                line = body[: match.start()].count("\n") + 1
                failures.append(
                    f"{relative}:{line} passes style= a string. React requires an object "
                    "and throws otherwise, which mounts nothing at all. Write "
                    "style=${{ background: color.bg }} - note the doubled braces, and "
                    "camelCase keys like borderColor. Prefer a CSS class where you can."
                )
        return failures


@dataclass(frozen=True, slots=True)
class RunRequest:
    """What a person asked for.

    ``project_id`` is what makes a second prompt an *edit* rather than a fresh
    start. Anything beyond a single file gets built by asking repeatedly, so a
    run that always began in an empty directory capped the product at whatever
    one prompt could produce.
    """

    prompt: str
    tenant_id: str
    actor_id: str
    difficulty: str = "implementation"
    #: None means elastic: the brief decides the budget. An explicit value
    #: (operator override) is respected verbatim.
    max_iterations: int | None = None
    #: quick/standard/deep/max overrides the brief-derived budget. The brief
    #: still produces title/summary; the tier decides how long the run may keep
    #: trying before giving up.
    tier: str | None = None
    project_id: str | None = None
    stack: str = REACT_STACK
    run_id: str | None = None
    #: build (default) writes files; chat is read-only; plan is a local stub
    #: that drafts a multi-node DAG without Temporal DAG execution.
    mode: str = "build"
    #: Signed PrivateFile URLs (or other https URLs) from image paste/upload.
    #: Appended to the goal as text; vision routing is deferred.
    attachment_urls: tuple[str, ...] = ()
    #: Phase 2.9: approved plans can run detached; finish creates a pending
    #: review instead of staying on the main checkpoint line.
    background: bool = False


@dataclass(slots=True)
class RunState:
    """Everything the UI can know about one run."""

    run_id: str
    prompt: str
    status: str = "running"
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None
    iterations: int = 0
    summary: str = ""
    credits_spent: float = 0.0
    workspace: Path | None = None
    project_id: str = ""
    tenant_id: str = ""
    actor_id: str = ""
    stack: str = REACT_STACK
    dag: dict[str, Any] | None = None
    gates: list[dict[str, Any]] = field(default_factory=list)
    #: Binding hashes approved via POST .../gates/.../approve (local resume).
    approved_gate_bindings: set[str] = field(default_factory=set)
    #: Exact tool call waiting on a gate (local ApprovalSignal resume).
    pending_gate_call: dict[str, Any] | None = None
    checkpoints: list[dict[str, Any]] = field(default_factory=list)
    cost: dict[str, Any] = field(default_factory=dict)
    #: Product-style name from the brief; empty until the brief lands (or
    #: when no brief runs, e.g. offline mode) — the UI falls back.
    title: str = ""
    #: The effort tier (quick/standard/deep/max) chosen for this run, or None
    #: when the brief's derived complexity sized the budget.
    tier: str | None = None
    mode: str = "build"
    background: bool = False
    #: Checkpoint the project pointed at when a background build started.
    base_checkpoint_id: str | None = None
    #: Pending review created when a background build finishes.
    pending_review_id: str | None = None
    #: Operator steering messages queued while the run is live.
    inbox: queue.Queue[str] = field(default_factory=queue.Queue)
    #: Signals that the operator wants the run to stop.
    cancelled: threading.Event = field(default_factory=threading.Event)

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "project_id": self.project_id,
            "prompt": self.prompt,
            "title": self.title,
            "status": self.status,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "iterations": self.iterations,
            "summary": self.summary,
            "credits_spent": round(self.credits_spent, 6),
            "stack": self.stack,
            "mode": self.mode,
            "background": self.background,
            "base_checkpoint_id": self.base_checkpoint_id,
            "pending_review_id": self.pending_review_id,
            "dag": self.dag,
            "task_dag": self.dag,
            "gates": self.gates,
            "gate": self.gates[0] if self.gates else None,
            "tier": self.tier,
            "checkpoints": self.checkpoints,
            "cost": self.cost
            or {
                "iterations": self.iterations,
                "credits_spent": round(self.credits_spent, 6),
                "total_tokens": 0,
            },
        }


class StreamingAuditSink:
    """An audit sink that also publishes to a live queue.

    Wraps a real sink rather than replacing it: the preview must not be a reason
    for a run to go unaudited. Events are redacted on the way out, using the same
    helper the audit store uses, because the browser is a less trustworthy place
    to put a value than the audit log is.
    """

    def __init__(self, stream: queue.Queue[Any], inner: Any | None = None) -> None:
        self._stream = stream
        self._inner = inner
        self.events: list[AuditEvent] = []

    def emit(self, event: AuditEvent) -> None:
        self.events.append(event)
        if self._inner is not None:
            self._inner.emit(event)
        detail = redact(dict(event.detail))
        self._stream.put(
            {
                "kind": "audit",
                "type": event.type,
                "outcome": event.outcome,
                "occurred_at": event.occurred_at.isoformat(),
                "detail": detail,
            }
        )
        # Structured file-change events for the diff viewer (Phase 1.12).
        changes = detail.get("file_changes") if isinstance(detail, dict) else None
        if event.type == "tool.called" and isinstance(changes, list):
            for change in changes:
                if isinstance(change, dict) and change.get("path"):
                    self._stream.put({"kind": "file_change", **change})
        # Sandbox stdout/stderr → Console tab (Phase 1.5).
        if event.type == "tool.called" and isinstance(detail, dict):
            tool = detail.get("tool")
            if tool in {"run_shell", "read_logs", "start_dev_server", "install_package"}:
                for stream_name in ("stdout", "stderr"):
                    text = detail.get(stream_name)
                    if isinstance(text, str) and text.strip():
                        self._stream.put(
                            {
                                "kind": "log",
                                "stream": stream_name,
                                "text": text[-8000:],
                                "tool": tool,
                            }
                        )
                content = detail.get("content") or detail.get("observation")
                if isinstance(content, str) and content.strip() and "stdout" not in detail:
                    self._stream.put(
                        {
                            "kind": "log",
                            "stream": "stdout",
                            "text": content[-8000:],
                            "tool": tool,
                        }
                    )
        if event.type == "gate.requested" and isinstance(detail, dict):
            gate = {
                "gate_id": detail.get("gate_id"),
                "action": detail.get("tool"),
                "tool": detail.get("tool"),
                "reason": f"{detail.get('tool')} requires your approval",
                "args": detail.get("args") or {},
                "args_hash": detail.get("args_hash"),
                "status": "pending",
                "destructive": True,
            }
            self._stream.put({"kind": "gate", "gate": gate})


class _EventJournal:
    """Append-only per-run event log — durable build progress.

    The live queue is process-local and drains once, so a terminal run used to
    leave the PROGRESS panel permanently empty for anyone who was not watching
    at the time. Every event is stamped with a sequence number and appended to
    ``<projects_root>/.runs/<run_id>.jsonl``; subscribers replay the journal
    and then continue live, skipping anything already replayed.
    """

    def __init__(self, root: Path, run_id: str) -> None:
        self._path = root / ".runs" / f"{run_id}.jsonl"
        self._lock = threading.Lock()
        self._seq = 0
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            LOGGER.debug("journal root not writable: %s", self._path.parent)

    @staticmethod
    def exists(root: Path, run_id: str) -> bool:
        return (root / ".runs" / f"{run_id}.jsonl").is_file()

    def append(self, event: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._seq += 1
            stamped = {**event, "_seq": self._seq}
            try:
                with self._path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(stamped, default=str) + "\n")
            except OSError:
                LOGGER.debug("journal append failed for %s", self._path)
            return stamped

    def replay(self) -> list[dict[str, Any]]:
        try:
            with self._path.open("r", encoding="utf-8") as fh:
                out: list[dict[str, Any]] = []
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
                return out
        except OSError:
            return []


class _JournalingQueue(queue.Queue):
    """A run queue that stamps and journals every event it carries."""

    def __init__(self, journal: _EventJournal) -> None:
        super().__init__()
        self._journal = journal

    def put(self, item: Any, block: bool = True, timeout: Any = None) -> None:  # noqa: A002
        if isinstance(item, dict):
            item = self._journal.append(item)
        super().put(item, block, timeout)


class RunManager:
    """Owns every run this process has started.

    In-memory by design: the preview is a single process on one machine, and
    persisting runs would imply a durability guarantee it cannot keep. Phase 3
    replaces this with Temporal, where a run is a durable workflow.
    """

    def __init__(
        self,
        *,
        projects_root: Path,
        model_factory: Any,
        on_finished: Any | None = None,
        brief_enabled: bool = True,
        usage_meter: LoopGptUsageMeter | None = None,
        sandbox_tools: bool = False,
        on_verified_checkpoint: Any | None = None,
        verify_runner_factory: Any | None = None,
    ) -> None:
        self._projects_root = Path(projects_root).resolve()
        self._projects_root.mkdir(parents=True, exist_ok=True)
        self._model_factory = model_factory
        self._on_finished = on_finished
        #: Whether each run first expands the user's words into a brief
        #: (title, summary, elastic budget). Disabled for offline/scripted
        #: mode, whose deterministic client has no answer for that call.
        self._brief_enabled = brief_enabled
        #: Bills every model call to the parent's credits. None = not billed
        #: (local/offline; production sets LOOPIT_USAGE_URL).
        self._usage_meter = usage_meter
        #: When True (orchestrator mode), sandbox stacks get SANDBOX_SYSTEM_PROMPT.
        #: Offline local mode keeps the no-shell prompt even for vite scaffolds.
        self._sandbox_tools = sandbox_tools
        #: Optional ``(tenant_id, project_id) -> CommandRunner | None`` for L0–L2
        #: verify via workspace-dispatch. Offline leaves this None.
        self._verify_runner_factory = verify_runner_factory
        #: Optional ProjectBackendState for provision / secrets (set by the API).
        self.project_backend: Any | None = None
        #: Optional ReviewStore for background-build apply reviews (Phase 2.9).
        self.review_store: Any | None = None
        #: Phase 2.3: push verified checkpoints to a bound Git remote.
        self._on_verified_checkpoint = on_verified_checkpoint
        self._runs: dict[str, RunState] = {}
        self._streams: dict[str, queue.Queue[Any]] = {}
        self._journals: dict[str, _EventJournal] = {}
        self._workspaces: dict[str, Workspace] = {}
        self._projects: dict[tuple[str, str], Workspace] = {}
        self._project_stacks: dict[tuple[str, str], str] = {}
        # On the projects volume beside the run journals, so versions, rollback
        # targets and published snapshots outlive the process.
        self._checkpoints = FileCheckpointStore(self._projects_root / ".checkpoints")
        self._lock = threading.Lock()

    # -- queries ---------------------------------------------------------

    def get(self, run_id: str, *, tenant_id: str | None = None) -> RunState | None:
        state = self._runs.get(run_id)
        if state is None or (tenant_id is not None and state.tenant_id != tenant_id):
            return None
        return state

    def send_message(self, run_id: str, message: str, *, tenant_id: str) -> bool:
        """Queue a steering message for a live run. Returns False if not active."""
        state = self.get(run_id, tenant_id=tenant_id)
        if state is None or state.finished_at is not None:
            return False
        state.inbox.put(message)
        return True

    def cancel_run(self, run_id: str, *, tenant_id: str) -> bool:
        """Signal a live run to stop at the next iteration boundary."""
        state = self.get(run_id, tenant_id=tenant_id)
        if state is None or state.finished_at is not None:
            return False
        state.cancelled.set()
        return True

    def list_runs(self, *, tenant_id: str | None = None) -> list[RunState]:
        runs: list[RunState] = list(self._runs.values())
        if tenant_id is not None:
            runs = [run for run in runs if run.tenant_id == tenant_id]
        return sorted(runs, key=lambda r: r.started_at, reverse=True)

    def workspace(self, run_id: str, *, tenant_id: str | None = None) -> Workspace | None:
        if self.get(run_id, tenant_id=tenant_id) is None:
            return None
        return self._workspaces.get(run_id)

    def project(self, project_id: str, *, tenant_id: str) -> Workspace | None:
        known = self._projects.get((tenant_id, project_id))
        if known is not None:
            return known
        return self._rehydrate(project_id, tenant_id)

    def project_tenant(self, project_id: str) -> str | None:
        for tenant_id, candidate in self._projects:
            if candidate == project_id:
                return tenant_id
        # Not started by this process: the project may still be on the volume
        # from before a restart.
        if not PROJECT_ID.fullmatch(project_id):
            return None
        for tenant_dir in sorted(self._projects_root.iterdir()):
            if (
                tenant_dir.is_dir()
                and not tenant_dir.name.startswith(".")
                and (tenant_dir / project_id).is_dir()
            ):
                return tenant_dir.name
        return None

    def _rehydrate(self, project_id: str, tenant_id: str) -> Workspace | None:
        """Re-adopt a project left on disk by an earlier process."""
        if not PROJECT_ID.fullmatch(project_id) or not _is_path_segment(tenant_id):
            return None
        root = self._projects_root / tenant_id / project_id
        if not root.is_dir():
            return None
        workspace = Workspace(root=root)
        with self._lock:
            workspace = self._projects.setdefault((tenant_id, project_id), workspace)
            self._project_stacks.setdefault((tenant_id, project_id), _infer_stack(workspace))
        return workspace

    def checkpoint(self, checkpoint_id: str, *, tenant_id: str) -> Checkpoint:
        """One checkpoint, tenant-scoped. Raises ``CheckpointError`` if absent."""
        return self._checkpoints.get(checkpoint_id, tenant_id=tenant_id)

    def read_checkpoint_file(self, checkpoint: Checkpoint, path: str) -> bytes:
        return self._checkpoints.read_file(checkpoint, path)

    def list_checkpoints(self, project_id: str, *, tenant_id: str) -> list[dict[str, Any]]:
        live = None
        try:
            live = self._checkpoints.current(project_id, tenant_id=tenant_id).checkpoint_id
        except CheckpointError:
            live = None
        return [
            self._checkpoint_to_dict(checkpoint, live=checkpoint.checkpoint_id == live)
            for checkpoint in self._checkpoints.list_for_project(project_id, tenant_id=tenant_id)
        ]

    def project_has_live_run(self, project_id: str, *, tenant_id: str) -> bool:
        """True when a run is still writing this project's workspace."""
        for state in self._runs.values():
            if (
                state.tenant_id == tenant_id
                and state.project_id == project_id
                and state.finished_at is None
            ):
                return True
        return False

    def rollback(self, project_id: str, checkpoint_id: str, *, tenant_id: str) -> dict[str, Any]:
        if self.project_has_live_run(project_id, tenant_id=tenant_id):
            raise RuntimeError(
                "cannot rollback while a run is live on this project"
            )
        checkpoint = self._checkpoints.rollback(project_id, checkpoint_id, tenant_id=tenant_id)
        workspace = self.project(project_id, tenant_id=tenant_id)
        if workspace is None:
            workspace = Workspace(self._projects_root / tenant_id / project_id)
            self._projects[(tenant_id, project_id)] = workspace
        self._restore_checkpoint(workspace, checkpoint)
        return self._checkpoint_to_dict(checkpoint, live=True)

    def fork_checkpoint(
        self, project_id: str, checkpoint_id: str, *, tenant_id: str, actor_id: str
    ) -> dict[str, Any]:
        checkpoint = self._checkpoints.get(checkpoint_id, tenant_id=tenant_id)
        if checkpoint.project_id != project_id:
            raise ValueError(
                f"checkpoint {checkpoint_id} belongs to project {checkpoint.project_id}"
            )
        fork_project_id = f"proj_{uuid.uuid4().hex[:12]}"
        workspace = Workspace(self._projects_root / tenant_id / fork_project_id)
        self._restore_checkpoint(workspace, checkpoint)
        self._projects[(tenant_id, fork_project_id)] = workspace
        self._project_stacks[(tenant_id, fork_project_id)] = self._project_stacks.get(
            (tenant_id, project_id), REACT_STACK
        )
        forked = self._snapshot(
            workspace,
            project_id=fork_project_id,
            tenant_id=tenant_id,
            run_id=f"fork_{uuid.uuid4().hex[:12]}",
            label=f"forked by {actor_id}",
        )
        return {"project_id": fork_project_id, "checkpoint": self._checkpoint_to_dict(forked)}

    # -- lifecycle -------------------------------------------------------

    def start(self, request: RunRequest) -> RunState:
        """Create a run, start it on its own thread, and return immediately."""
        run_id = request.run_id or f"run_{uuid.uuid4().hex[:12]}"
        project_id = request.project_id or f"proj_{uuid.uuid4().hex[:12]}"
        if not PROJECT_ID.fullmatch(project_id):
            # The id becomes a directory name, so it is a path and has to be
            # treated as one. Rejecting outright beats sanitising: a caller who
            # sent "../.." should be told no, not quietly given somewhere else.
            raise ValueError(f"invalid project id: {project_id!r}")
        root = self._projects_root / request.tenant_id / project_id
        workspace = Workspace(root=root)

        # A project's stack is decided once, by the run that created it. A
        # follow-up that arrived with a different one would be asking the agent
        # to write React into a static site, which is not an edit — it is two
        # incompatible projects sharing a directory.
        project_key = (request.tenant_id, project_id)
        if project_key not in self._project_stacks and workspace.files():
            # A project from before a restart keeps the stack it was built on.
            self._project_stacks[project_key] = _infer_stack(workspace)
        stack = self._project_stacks.get(project_key, request.stack)
        if stack not in STACKS:
            raise ValueError(f"unknown stack: {stack!r}")
        if not workspace.files():
            # The entry point is not generated. An import map that is slightly
            # wrong renders a blank page with no readable error, and an agent
            # writing one from memory gets it slightly wrong often enough to
            # matter.
            for relative, body in scaffold_for(stack).items():
                workspace.write(relative, body)
            self._snapshot(
                workspace,
                project_id=project_id,
                tenant_id=request.tenant_id,
                run_id=run_id,
                verified=True,
                label="initial scaffold",
            )

        mode = request.mode if request.mode in {"build", "chat", "plan"} else "build"
        base_ckpt = self._current_checkpoint_id(project_id, request.tenant_id)
        # Background is only meaningful for write builds (approved plans).
        background = bool(request.background) and mode == "build"
        state = RunState(
            run_id=run_id,
            prompt=request.prompt,
            # "planning" while the brief is being composed, then "running".
            # Offline/scripted mode skips the brief and starts running.
            status="planning" if self._brief_enabled else "running",
            workspace=root,
            project_id=project_id,
            tenant_id=request.tenant_id,
            actor_id=request.actor_id,
            stack=stack,
            tier=request.tier,
            mode=mode,
            background=background,
            base_checkpoint_id=base_ckpt if background else None,
            dag=_single_node_dag(
                prompt=request.prompt,
                run_id=run_id,
                base_checkpoint_id=base_ckpt,
            ),
        )
        state.checkpoints = self.list_checkpoints(project_id, tenant_id=request.tenant_id)
        state.cost = {"iterations": 0, "credits_spent": 0.0, "total_tokens": 0}
        journal = _EventJournal(self._projects_root, run_id)
        stream: queue.Queue[Any] = _JournalingQueue(journal)

        with self._lock:
            self._runs[run_id] = state
            self._streams[run_id] = stream
            self._journals[run_id] = journal
            self._workspaces[run_id] = workspace
            self._projects[project_key] = workspace
            self._project_stacks[project_key] = stack

        thread = threading.Thread(
            target=self._drive,
            args=(state, workspace, stream, request),
            name=f"loopit-{run_id}",
            daemon=True,
        )
        thread.start()
        return state

    def has_journal(self, run_id: str) -> bool:
        """True when a durable event log exists for this run — including runs
        from before a process restart, which the in-memory maps no longer know."""
        if run_id in self._journals:
            return True
        return _EventJournal.exists(self._projects_root, run_id)

    def replay_events(self, run_id: str) -> list[dict[str, Any]]:
        """Every journaled event for the run, oldest first (empty when none)."""
        journal = self._journals.get(run_id)
        if journal is None:
            journal = _EventJournal(self._projects_root, run_id)
        return journal.replay()

    def finished(self, run_id: str) -> bool:
        state = self._runs.get(run_id)
        return state is not None and state.finished_at is not None

    def subscribe(self, run_id: str) -> Iterator[dict[str, Any]]:
        """Yield this run's events until it ends.

        Subscribers first replay the durable journal, then continue live,
        skipping anything the journal already covered (sequence numbers ride
        on each event). A run that ended before anyone looked still shows its
        full progress.
        """
        seen = 0
        for past in self.replay_events(run_id):
            seq = past.get("_seq")
            if isinstance(seq, int):
                seen = max(seen, seq)
            yield past
        stream = self._streams.get(run_id)
        if stream is None:
            return
        while True:
            item = stream.get()
            if item is _DONE:
                return
            seq = item.get("_seq") if isinstance(item, dict) else None
            if isinstance(seq, int) and seq <= seen:
                continue
            yield item

    def next_event(self, run_id: str, *, timeout: float = 1.0) -> Any:
        """Block for the next event, or return ``None`` on timeout.

        The timeout is what lets an async caller drain this from a worker thread
        without pinning that thread for the whole run: it wakes up regularly, so
        a disconnected client is noticed instead of being waited on forever.
        Returns :data:`RUN_FINISHED` when the run has ended.
        """
        stream = self._streams.get(run_id)
        if stream is None:
            return RUN_FINISHED
        try:
            item = stream.get(timeout=timeout)
        except queue.Empty:
            return None
        if item is _DONE:
            return RUN_FINISHED
        return item

    # -- the run itself --------------------------------------------------

    def _drive(
        self,
        state: RunState,
        workspace: Workspace,
        stream: queue.Queue[Any],
        request: RunRequest,
    ) -> None:
        audit = StreamingAuditSink(stream)
        try:
            model, ledger = self._model_factory(state.run_id, state.tenant_id)
            if self._usage_meter is not None:
                meter = self._usage_meter

                def _charge(call_index: int, response: Any) -> None:
                    meter.record(
                        run_id=state.run_id,
                        tenant_id=state.tenant_id,
                        actor_id=state.actor_id,
                        call_index=call_index,
                        response=response,
                    )

                model = MeteredModelClient(model, _charge)

            # Prompt elasticity: expand the user's words into a full brief
            # (title, summary, implementation detail, effort class) before
            # the loop runs. The user never picks a budget; the request does.
            if self._brief_enabled:
                brief = expand_brief(
                    model, request.prompt, existing_files=workspace.files() or None
                )
            else:
                brief = fallback_brief(request.prompt)
            state.title = brief.title
            state.summary = brief.summary
            if state.mode == "plan":
                # Local Plan stub: multi-node DAG for the UI. Approve in the
                # product starts a normal build run; Temporal DAG execution is
                # deferred to Phase 1.1 / 1.7 orchestrator work.
                state.dag = _plan_stub_dag(
                    prompt=request.prompt,
                    summary=brief.summary,
                    run_id=state.run_id,
                    base_checkpoint_id=self._current_checkpoint_id(
                        state.project_id, state.tenant_id
                    ),
                )
            elif state.dag:
                # The task board reads the brief's one-liner, not the prompt.
                state.dag["goal"] = brief.summary
                for node in state.dag["nodes"]:
                    node["goal"] = brief.summary
            state.status = "running"
            if request.max_iterations is not None:
                max_iterations = request.max_iterations
            elif request.tier is not None:
                from .brief import BUDGET_BY_COMPLEXITY

                max_iterations = BUDGET_BY_COMPLEXITY.get(request.tier, brief.budget)
            else:
                max_iterations = brief.budget
            if state.mode in {"chat", "plan"}:
                # Discuss / plan drafts stay short; they must not burn a full build budget.
                max_iterations = min(max_iterations, 8 if state.mode == "chat" else 6)
            stream.put({"kind": "dag", "dag": state.dag})
            stream.put({"kind": "run", **state.to_dict(), "files": workspace.files()})

            inbox: queue.Queue[str] = queue.Queue()
            cancelled = threading.Event()
            state.inbox = inbox
            state.cancelled = cancelled

            def _steer() -> str | None:
                try:
                    message = inbox.get_nowait()
                except queue.Empty:
                    return None
                stream.put({"kind": "chat", "role": "user", "text": message})
                return message

            def _is_cancelled() -> bool:
                return cancelled.is_set()

            def _assistant_turn(content: str) -> None:
                stream.put({"kind": "chat", "role": "assistant", "text": content})

            def _token(chunk: str) -> None:
                stream.put({"kind": "chat_chunk", "text": chunk})

            tool_mode = "chat" if state.mode in {"chat", "plan"} else "build"
            # Sandbox stacks + orchestrator → SANDBOX_SYSTEM_PROMPT (shell tools).
            # Offline local keeps the no-shell prompt (I1); scaffolds still land.
            shell_enabled = uses_sandbox_runtime(state.stack) and self._sandbox_tools
            system = system_prompt_for(shell_enabled=shell_enabled) + "\n" + guidance_for(state.stack)
            if state.mode == "chat":
                system = CHAT_SYSTEM_PROMPT + "\n" + guidance_for(state.stack)
            elif state.mode == "plan":
                system = PLAN_SYSTEM_PROMPT + "\n" + guidance_for(state.stack)

            from .verify_bridge import build_verifier

            verify_hook = None
            if tool_mode != "chat":
                runner = None
                if (
                    self._sandbox_tools
                    and uses_sandbox_runtime(state.stack)
                    and callable(self._verify_runner_factory)
                ):
                    try:
                        runner = self._verify_runner_factory(
                            state.tenant_id, state.project_id
                        )
                    except Exception:  # noqa: BLE001 — verify still runs parse-only
                        runner = None
                verify_hook = build_verifier(
                    workspace,
                    project_id=state.project_id,
                    stack=state.stack,
                    preview_verifier_factory=lambda ws, htm_rules=True: PreviewVerifier(
                        ws, htm_rules=htm_rules
                    ),
                    runner=runner,
                )

            provision_handler = None
            secret_handler = None
            backend = getattr(self, "project_backend", None)
            if backend is not None and tool_mode == "build":
                from loopit_agent_core.tools import ToolCall, ToolResult

                from . import project_backend as pb

                def provision_handler(call: ToolCall) -> ToolResult:  # noqa: F811
                    outcome = pb.provision_table(
                        backend,
                        projects_root=self._projects_root,
                        tenant_id=state.tenant_id,
                        project_id=state.project_id,
                        args=dict(call.args),
                    )
                    return ToolResult(
                        bool(outcome.get("ok")),
                        str(outcome.get("output") or ""),
                        dict(outcome.get("detail") or {}),
                    )

                def secret_handler(call: ToolCall) -> ToolResult:  # noqa: F811
                    req = pb.request_secret(
                        backend,
                        project_id=state.project_id,
                        name=str(call.args.get("name") or ""),
                        reason=str(call.args.get("reason") or "Agent requested a secret"),
                        run_id=state.run_id,
                    )
                    return ToolResult(
                        True,
                        (
                            f"Secret {req['name']!r} requested from the user. "
                            "They will paste it in Project Settings → Secrets."
                        ),
                        {"request_id": req["request_id"], "name": req["name"]},
                    )

            loop = AgentLoop(
                model=model,
                executor=workspace.executor(
                    mode=tool_mode,
                    provision_handler=provision_handler,
                    secret_handler=secret_handler,
                    approved_gates=frozenset(state.approved_gate_bindings),
                    run_id=state.run_id,
                ),
                audit=audit,
                tenant_id=state.tenant_id,
                project_id=state.project_id,
                run_id=state.run_id,
                task_id="task-1",
                budget=Budget(max_iterations=max_iterations),
                verify=verify_hook,
                difficulty=request.difficulty,  # type: ignore[arg-type]
                steer_hook=_steer,
                cancel_hook=_is_cancelled,
                assistant_hook=_assistant_turn,
                token_hook=_token,
                # The transcript is summarised past 50K tokens of history, so a
                # long build keeps its memory of failed approaches instead of
                # dying on a blown context window (I12 covers spend; this
                # covers fit).
                context_max_tokens=50_000,
            )
            result = loop.run(
                system,
                _goal_for(
                    request.prompt,
                    brief.expanded_prompt,
                    workspace,
                    attachment_urls=request.attachment_urls,
                ),
            )
            state.iterations = result.iterations
            state.status = (
                "verified" if result.outcome is LoopOutcome.VERIFIED else str(result.outcome)
            )
            state.summary = _friendly_outcome_summary(result.outcome, result.summary)
            if result.outcome is LoopOutcome.AWAITING_GATE:
                gate = _gate_from_audit(audit.events)
                if gate is not None:
                    state.gates = [gate]
                    state.pending_gate_call = {
                        "tool": gate.get("tool"),
                        "args": gate.get("args") or {},
                        "args_hash": gate.get("args_hash"),
                        "gate_id": gate.get("gate_id"),
                    }
                    stream.put({"kind": "gate", "gate": gate})
            if ledger is not None:
                state.credits_spent = ledger.spent(state.tenant_id)
            state.cost = {
                "iterations": state.iterations,
                "refunded_iterations": int(result.usage.get("refunded_iterations", 0)),
                "credits_spent": round(state.credits_spent, 6),
                "total_tokens": 0,
            }
            # Awaiting approval is a pause, not a finished run — skip snapshot
            # of a half-applied destructive step.
            if result.outcome is not LoopOutcome.AWAITING_GATE:
                label = f"run {state.run_id}"
                if state.background:
                    label = f"pending-review {state.run_id}"
                checkpoint = self._snapshot(
                    workspace,
                    project_id=state.project_id,
                    tenant_id=state.tenant_id,
                    run_id=state.run_id,
                    verified=state.status == "verified",
                    label=label,
                    include_db_snapshot=True,
                )
                if state.background and self.review_store is not None:
                    self._finalize_background_review(state, workspace, checkpoint)
                state.checkpoints = self.list_checkpoints(state.project_id, tenant_id=state.tenant_id)
                if state.dag:
                    for node in state.dag["nodes"]:
                        # Background builds wait for Apply — not auto-merged.
                        if state.background:
                            node["status"] = (
                                "awaiting_apply" if state.status == "verified" else "failed"
                            )
                        else:
                            node["status"] = "merged" if state.status == "verified" else "failed"
                        node["fork_checkpoint_id"] = checkpoint.parent_id or "root"
                # Background builds wait for Apply before pushing (gitsync etc.).
                if (
                    checkpoint.verified
                    and not state.background
                    and self._on_verified_checkpoint is not None
                ):
                    try:
                        self._on_verified_checkpoint(checkpoint, state.run_id)
                    except Exception:
                        LOGGER.exception(
                            "verified-checkpoint hook failed for %s", checkpoint.checkpoint_id
                        )
        except QuotaExceeded as error:
            # Distinct from INTERNAL_ERROR so the UI can show "this build cost
            # more than its compute budget" rather than "crashed unexpectedly".
            LOGGER.warning("run %s exceeded its credit budget", state.run_id)
            state.status = "budget_exceeded"
            state.summary = _friendly_error_summary(error)
            if state.dag:
                for node in state.dag["nodes"]:
                    node["status"] = "failed"
            if isinstance(error, CreditsExhausted):
                stream.put({"kind": "error", "message": state.summary, "code": "out_of_credits"})
            else:
                stream.put(
                    {"kind": "error", "message": "Build budget exceeded", "code": "budget_exceeded"}
                )
        except Exception as error:
            # A crashed run must say so. Leaving it "running" forever would let
            # the UI imply progress that stopped happening — and that includes
            # the DAG nodes, not just the run status: the success path below
            # flips them to merged/failed, so the crash path must too, or the
            # step badge reads "Running" on a dead run.
            LOGGER.exception("run %s crashed", state.run_id)
            state.status = "error"
            state.summary = _friendly_error_summary(error)
            if state.dag:
                for node in state.dag["nodes"]:
                    node["status"] = "failed"
            stream.put({"kind": "error", "message": state.summary})
        finally:
            awaiting = state.status == LoopOutcome.AWAITING_GATE.value or state.status == "awaiting_gate"
            if not awaiting:
                state.finished_at = datetime.now(UTC)
                if self._on_finished is not None:
                    self._on_finished(state)
            stream.put({"kind": "dag", "dag": state.dag})
            stream.put({"kind": "checkpoints", "checkpoints": state.checkpoints})
            stream.put({"kind": "cost", "cost": state.cost})
            stream.put({"kind": "run", **state.to_dict(), "files": workspace.files()})
            if not awaiting:
                stream.put(_DONE)

    def decide_gate(
        self,
        run_id: str,
        gate_id: str,
        *,
        approved: bool,
        reason: str,
        tenant_id: str,
        actor_id: str,
    ) -> bool:
        """Approve or reject a pending local gate and resume the run when approved.

        Returns False if the run is not awaiting this gate.
        """
        state = self.get(run_id, tenant_id=tenant_id)
        if state is None:
            return False
        if state.status not in {LoopOutcome.AWAITING_GATE.value, "awaiting_gate"}:
            return False
        pending = state.pending_gate_call or {}
        if str(pending.get("gate_id")) != gate_id:
            return False
        stream = self._streams.get(run_id)
        gate = next((g for g in state.gates if g.get("gate_id") == gate_id), None)
        if gate is None:
            gate = {"gate_id": gate_id, "tool": pending.get("tool"), "args": pending.get("args")}
        if not approved:
            gate = {**gate, "status": "rejected", "reason": reason}
            state.gates = []
            state.pending_gate_call = None
            state.status = "cancelled"
            state.summary = f"Declined: {reason}"
            state.finished_at = datetime.now(UTC)
            if stream is not None:
                stream.put({"kind": "gate", "gate": gate})
                stream.put({"kind": "run", **state.to_dict()})
                stream.put(_DONE)
            if self._on_finished is not None:
                self._on_finished(state)
            return True
        binding = str(pending.get("args_hash") or "")
        if binding:
            state.approved_gate_bindings.add(binding)
        gate = {**gate, "status": "approved", "reason": reason, "decision_actor_id": actor_id}
        state.gates = []
        state.pending_gate_call = None
        if stream is not None:
            stream.put({"kind": "gate", "gate": gate})
        state.status = "running"
        state.summary = "Approved — continuing"
        # Resume on a worker thread with the approved binding pre-seeded.
        thread = threading.Thread(
            target=self._resume_after_gate,
            args=(state, binding),
            name=f"loopit-gate-{run_id}",
            daemon=True,
        )
        thread.start()
        return True

    def _resume_after_gate(self, state: RunState, binding: str) -> None:
        """Re-enter the agent loop with the approved gate binding."""
        request = RunRequest(
            prompt=(
                f"{state.prompt}\n\n"
                "[system] The user approved the pending gated tool call. "
                "Re-issue that exact tool call now and continue the build."
            ),
            project_id=state.project_id,
            tenant_id=state.tenant_id,
            actor_id=state.actor_id,
            mode=state.mode,  # type: ignore[arg-type]
        )
        stream = self._streams.get(state.run_id)
        if stream is None:
            stream = queue.Queue()
            self._streams[state.run_id] = stream
        if binding:
            state.approved_gate_bindings.add(binding)
        workspace = self._workspaces.get(state.run_id) or self.project(
            state.project_id, tenant_id=state.tenant_id
        )
        if workspace is None:
            state.status = "error"
            state.summary = "Workspace missing; cannot resume"
            state.finished_at = datetime.now(UTC)
            stream.put({"kind": "run", **state.to_dict()})
            stream.put(_DONE)
            return
        try:
            self._drive(state, workspace, stream, request)
        except Exception:
            LOGGER.exception("gate resume failed for %s", state.run_id)
            state.status = "error"
            state.summary = "Could not resume after approval"
            state.finished_at = datetime.now(UTC)
            stream.put({"kind": "run", **state.to_dict()})
            stream.put(_DONE)

    def _current_checkpoint_id(self, project_id: str, tenant_id: str) -> str:
        try:
            return self._checkpoints.current(project_id, tenant_id=tenant_id).checkpoint_id
        except Exception:
            return "root"

    def _finalize_background_review(
        self, state: RunState, workspace: Workspace, checkpoint: Checkpoint
    ) -> None:
        """Park the new checkpoint as a pending review and restore the main line."""
        from .reviews import diff_checkpoint_files

        store = self.review_store
        if store is None:
            return
        base_id = state.base_checkpoint_id
        base_files: dict[str, bytes] = {}
        if base_id and base_id != "root":
            try:
                base = self._checkpoints.get(base_id, tenant_id=state.tenant_id)
                base_files = {
                    path: self._checkpoints.read_file(base, path) for path in base.files
                }
            except Exception:
                LOGGER.warning("background review: could not read base checkpoint %s", base_id)
        head_files = {
            path: resolve_in_workspace(workspace.root, path).read_bytes()
            for path in workspace.files()
        }
        changes = diff_checkpoint_files(base_files=base_files, head_files=head_files)
        review = store.create_pending_review(
            tenant_id=state.tenant_id,
            project_id=state.project_id,
            run_id=state.run_id,
            checkpoint_id=checkpoint.checkpoint_id,
            base_checkpoint_id=base_id if base_id != "root" else None,
            file_changes=changes,
            summary=state.summary or "Background build finished",
            title=state.title or "Background build ready",
        )
        state.pending_review_id = str(review["review_id"])
        # Restore main checkpoint line + workspace so Apply is an explicit merge.
        if base_id and base_id != "root":
            try:
                restored = self._checkpoints.rollback(
                    state.project_id, base_id, tenant_id=state.tenant_id
                )
                self._restore_checkpoint(workspace, restored)
            except Exception:
                LOGGER.exception(
                    "background review: failed to restore base checkpoint for %s", state.run_id
                )
        stream = self._streams.get(state.run_id)
        if stream is not None:
            stream.put(
                {
                    "kind": "pending_review",
                    "review": review,
                    "notification": True,
                }
            )

    def apply_pending_review(
        self, review_id: str, *, tenant_id: str
    ) -> dict[str, Any]:
        """Promote a pending background checkpoint onto the main line."""
        store = self.review_store
        if store is None:
            raise ValueError("review store is not configured")
        review = store.get_review(review_id, tenant_id=tenant_id)
        if review is None:
            raise LookupError("no such review")
        if review.get("status") != "pending":
            raise ValueError(f"review is {review.get('status')}, not pending")
        project_id = str(review["project_id"])
        if self.project_has_live_run(project_id, tenant_id=tenant_id):
            raise RuntimeError("cannot apply while a run is live on this project")
        checkpoint_id = str(review["checkpoint_id"])
        checkpoint = self.rollback(project_id, checkpoint_id, tenant_id=tenant_id)
        applied = store.mark_applied(review_id, tenant_id=tenant_id)
        return {"review": applied, "checkpoint": checkpoint}

    def _snapshot(
        self,
        workspace: Workspace,
        *,
        project_id: str,
        tenant_id: str,
        run_id: str,
        verified: bool = True,
        label: str | None = None,
        parent_id: str | None = None,
        include_db_snapshot: bool = False,
    ) -> Checkpoint:
        # Bytes, not decoded text: a published version is served from these
        # blobs, and an image round-tripped through UTF-8 is no longer an image.
        files = {
            path: resolve_in_workspace(workspace.root, path).read_bytes()
            for path in workspace.files()
        }
        db_snapshot_id: str | None = None
        backend = getattr(self, "project_backend", None)
        if include_db_snapshot and backend is not None:
            try:
                from .project_backend import dump_db_snapshot_stub

                db_snapshot_id = dump_db_snapshot_stub(
                    backend,
                    projects_root=self._projects_root,
                    tenant_id=tenant_id,
                    project_id=project_id,
                    environment="dev",
                )
            except Exception:
                LOGGER.warning("db snapshot stub failed for project %s", project_id)
        del run_id
        return self._checkpoints.snapshot(
            project_id=project_id,
            tenant_id=tenant_id,
            files=files,
            parent_id=_existing_parent_id(
                parent_id or self._current_checkpoint_id(project_id, tenant_id)
            ),
            db_snapshot_id=db_snapshot_id,
            verified=verified,
            label=label,
        )

    def _restore_checkpoint(self, workspace: Workspace, checkpoint: Checkpoint) -> None:
        wanted = set(checkpoint.files)
        for relative in workspace.files():
            if relative not in wanted:
                try:
                    (workspace.root / relative).unlink(missing_ok=True)
                except OSError:
                    pass
        for relative in wanted:
            target = resolve_in_workspace(workspace.root, relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(self._checkpoints.read_file(checkpoint, relative))

    @staticmethod
    def _checkpoint_to_dict(checkpoint: Checkpoint, *, live: bool = False) -> dict[str, Any]:
        return {
            "checkpoint_id": checkpoint.checkpoint_id,
            "parent_id": checkpoint.parent_id,
            "label": checkpoint.label,
            "created_at": checkpoint.created_at.isoformat(),
            "verified": checkpoint.verified,
            "db_snapshot_id": checkpoint.db_snapshot_id,
            "live": live,
        }


def _single_node_dag(
    *, prompt: str, run_id: str, base_checkpoint_id: str | None = None
) -> dict[str, Any]:
    dag = {
        "plan_id": f"plan-{run_id.replace('_', '-')}",
        "goal": prompt,
        "base_checkpoint_id": base_checkpoint_id or "root",
        "nodes": [
            {
                "id": "build-preview",
                "kind": "add_ui_page",
                "goal": prompt,
                "dag_parents": [],
                "fork_checkpoint_id": base_checkpoint_id or "root",
                "expected_verification": ["L0_typecheck_lint", "L2_browser_smoke"],
                "destructive": False,
                "status": "running",
            }
        ],
    }
    validate_task_dag_payload(dag)
    return dag


def _plan_stub_dag(
    *,
    prompt: str,
    summary: str,
    run_id: str,
    base_checkpoint_id: str | None = None,
) -> dict[str, Any]:
    """Local Plan-mode shell: a short editable-looking task list without Temporal."""
    base = base_checkpoint_id or "root"
    goal = summary or prompt
    dag = {
        "plan_id": f"plan-{run_id.replace('_', '-')}",
        "goal": goal,
        "base_checkpoint_id": base,
        "nodes": [
            {
                "id": "survey",
                "kind": "add_ui_page",
                "goal": f"Survey the current project for: {goal}",
                "dag_parents": [],
                "fork_checkpoint_id": base,
                "expected_verification": ["L0_typecheck_lint"],
                "destructive": False,
                "status": "pending",
            },
            {
                "id": "implement",
                "kind": "add_ui_page",
                "goal": f"Implement: {goal}",
                "dag_parents": ["survey"],
                "fork_checkpoint_id": base,
                "expected_verification": ["L0_typecheck_lint", "L2_browser_smoke"],
                "destructive": False,
                "status": "pending",
            },
            {
                "id": "verify",
                "kind": "add_ui_page",
                "goal": f"Verify and polish: {goal}",
                "dag_parents": ["implement"],
                "fork_checkpoint_id": base,
                "expected_verification": ["L2_browser_smoke"],
                "destructive": False,
                "status": "pending",
            },
        ],
    }
    validate_task_dag_payload(dag)
    return dag


def validate_task_dag_payload(dag: dict[str, Any]) -> None:
    errors = sorted(
        _task_dag_validator().iter_errors(_contract_dag(dag)), key=lambda item: item.path
    )
    if errors:
        raise ValueError(f"invalid task DAG payload: {errors[0].message}")


@lru_cache(maxsize=1)
def _task_dag_validator() -> Draft202012Validator:
    # Installed deployments (the slim runtime image) ship the contract
    # schemas at LOOPIT_CONTRACTS_DIR because the repo tree is absent; the
    # parents[4] layout only exists in a source checkout or editable install.
    contracts_dir = os.environ.get("LOOPIT_CONTRACTS_DIR")
    if contracts_dir:
        schema_path = Path(contracts_dir) / "task-dag.schema.json"
    else:
        schema_path = (
            Path(__file__).resolve().parents[4]
            / "packages"
            / "contracts"
            / "schemas"
            / "task-dag.schema.json"
        )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


def _contract_dag(dag: dict[str, Any]) -> dict[str, Any]:
    copy = dict(dag)
    copy["nodes"] = [
        {key: value for key, value in dict(node).items() if key not in {"status"}}
        for node in dag.get("nodes", [])
    ]
    return copy


def _existing_parent_id(checkpoint_id: str | None) -> str | None:
    return None if checkpoint_id in {None, "root"} else checkpoint_id


def _is_path_segment(value: str) -> bool:
    """A tenant id is a directory name under the projects root."""
    return bool(value) and not value.startswith(".") and PurePosixPath(value).name == value and (
        "\\" not in value
    )


def _infer_stack(workspace: Workspace) -> str:
    """Which stack an on-disk project was built on."""
    return infer_stack_from_files(set(workspace.files()))


#: Terminal wording a person reads on the build board. The loop's own
#: summaries ("stopped: ...", verdict strings) speak to the harness; these
#: speak to the person waiting on the result.
_OUTCOME_SUMMARIES: dict[str, str] = {
    "verified": "Built and verified — your app is ready to preview or deploy.",
    "budget_exceeded": (
        "This build reached its effort limit before finishing. Start it again "
        "from the same project to pick up where it left off."
    ),
    "awaiting_gate": "Paused for your approval on a sensitive step.",
    "stalled": "The builder could not make further progress. Try rephrasing the request.",
    "cancelled": "Stopped by you. Your project is unchanged from the last checkpoint.",
}


def _gate_from_audit(events: list[Any]) -> dict[str, Any] | None:
    """Pull the latest ``gate.requested`` audit into a UI gate payload."""
    for event in reversed(events):
        if getattr(event, "type", None) != "gate.requested":
            continue
        detail = dict(getattr(event, "detail", {}) or {})
        return {
            "gate_id": detail.get("gate_id"),
            "action": detail.get("tool"),
            "tool": detail.get("tool"),
            "reason": f"{detail.get('tool')} requires your approval",
            "args": detail.get("args") or {},
            "args_hash": detail.get("args_hash"),
            "status": "pending",
            "destructive": True,
        }
    return None


def _friendly_outcome_summary(outcome: LoopOutcome, summary: str) -> str:
    """The loop's outcome in product language; the harness text stays in the audit."""
    friendly = _OUTCOME_SUMMARIES.get(outcome.value if hasattr(outcome, "value") else str(outcome))
    if friendly:
        return friendly
    return summary or "The build ended."


def _friendly_error_summary(error: BaseException) -> str:
    """A crash explanation without exception names or stack text."""
    if isinstance(error, CreditsExhausted):
        return (
            "You're out of Loop credits, so the build stopped. Top up, then "
            "continue from the same project."
        )
    if isinstance(error, MeteringUnavailable):
        return (
            "The build stopped because its usage could not be recorded. Your "
            "project is unchanged — try again in a moment."
        )
    if isinstance(error, BudgetExceeded):
        return _OUTCOME_SUMMARIES["budget_exceeded"]
    if isinstance(error, WorkspaceError):
        return "The builder could not update the project files safely. Nothing was changed."
    return (
        "The build stopped because of an internal issue. Your project is "
        "unchanged — roll back to the last checkpoint or try again."
    )


#: The interpretation notes earn at most ~300 tokens of the goal. The brief
#: exists to structure vague requests; past this size it crowds out the
#: request itself and the file context, and long runs have died on the goal
#: ballooning past the window. ~4 chars per token.
BRIEF_GOAL_BUDGET_CHARS = 1200


def _cap_brief(brief_prompt: str, budget: int = BRIEF_GOAL_BUDGET_CHARS) -> str:
    """Trim interpretation notes to their budget at a paragraph or line break.

    Deterministic, not summarised: the raw prompt is already present and
    binding, so a lossy second opinion here only adds drift risk.
    """
    if len(brief_prompt) <= budget:
        return brief_prompt
    cut = brief_prompt[:budget]
    boundary = max(cut.rfind("\n\n"), cut.rfind("\n"))
    if boundary > budget // 2:
        cut = cut[:boundary]
    return cut.rstrip() + "\n[notes truncated — the request above is complete and binding]"


def _goal_for(
    raw_prompt: str,
    brief_prompt: str,
    workspace: Workspace,
    *,
    attachment_urls: tuple[str, ...] = (),
) -> str:
    """The task goal, with the user's words as the binding authority.

    The expanded brief can restructure and make the request concrete, but it
    must not expand scope. If the brief ever drifts from the user's words, the
    raw prompt wins.

    ``LOOP.md`` at the project root (when present) is injected after the user
    request as lasting project knowledge. Attachment URLs are listed as text;
    vision-capable routing is deferred.

    The contract has no ``list_files`` tool and refuses an empty ``search_code``
    query, so an agent cannot discover the project by asking. Supplying the
    listing as context is how the real system does it too — retrieval decides
    what the agent sees, rather than the agent spending iterations groping for
    it.
    """
    parts = [
        "THE USER'S REQUEST (binding — build exactly this, no more, no less):",
        raw_prompt,
    ]
    if attachment_urls:
        import os

        vision_on = os.environ.get("LOOPIT_VISION_ENABLED", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        vision_note = (
            "ATTACHMENTS (image/file URLs — vision is enabled; the model receives these as images):"
            if vision_on
            else "ATTACHMENTS (image/file URLs — set LOOPIT_VISION_ENABLED=1 and LOOPIT_VISION_ENDPOINT_URL for VL routing; otherwise treat as references):"
        )
        parts += [
            "",
            vision_note,
            *[f"- {url}" for url in attachment_urls],
        ]
    knowledge = _read_loop_md(workspace)
    if knowledge:
        parts += [
            "",
            "PROJECT KNOWLEDGE (LOOP.md — follow unless the request overrides; you may propose edits):",
            knowledge,
        ]
    parts += [
        "",
        "INTERPRETATION NOTES (subordinate to the request above; where they conflict, the request wins):",
        _cap_brief(brief_prompt),
    ]
    listing = workspace.files()
    if listing:
        # files() is already sorted; keep that order (a set would reshuffle).
        parts += ["", "Files already in the project:", *[f"- {path}" for path in listing]]
    else:
        parts += ["", "The project is empty; create the files you need."]
    return "\n".join(parts)


def _read_loop_md(workspace: Workspace) -> str | None:
    """Project-root LOOP.md when present (capped so it cannot dominate the goal)."""
    if "LOOP.md" not in workspace.files():
        return None
    try:
        text = workspace.read("LOOP.md").strip()
    except (WorkspaceError, OSError):
        return None
    if not text:
        return None
    if len(text) > 8_000:
        text = text[:8_000].rstrip() + "\n[LOOP.md truncated]"
    return text


__all__ = [
    "SANDBOX_SYSTEM_PROMPT",
    "SYSTEM_PROMPT",
    "PreviewVerifier",
    "RunManager",
    "RunRequest",
    "RunState",
    "StreamingAuditSink",
    "system_prompt_for",
    "validate_task_dag_payload",
]
