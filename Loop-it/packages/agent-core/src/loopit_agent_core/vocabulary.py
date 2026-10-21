"""The planner's task vocabulary (Doc 04 §2, P2-6).

Phase 2 supports exactly one stack, and this is where that opinion is encoded.
A planner that emits free-text goals can invent tasks the platform cannot verify,
cannot scope tools for, and cannot cost. Narrowing the vocabulary to a closed set
of stack-shaped kinds turns each node into something the rest of the system knows
how to handle.

Each kind carries three things the planner does not get to decide:

**A verification floor.** ``expected_verification`` may be *raised* by the
planner but never lowered below the kind's floor. A task that adds an API route
and claims it only needs a typecheck is not making a judgement call; it is
skipping the layer that would catch it being broken. :func:`resolve_verification`
takes the union, so the floor is a floor.

**A tool allowlist.** A task that adds a UI component has no business calling
``provision`` or ``deploy``. Scoping tools per node is the cheapest available
defence against a prompt-injected file talking a mid-plan task into doing
something outside its remit — it does not matter how persuasive the injected text
is if the tool is not dispatchable.

**Destructiveness.** Kinds that deploy or alter live schema are destructive by
construction, so the confirmation gate (I7) cannot be avoided by a planner that
simply omits the flag.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

#: Verification layer ids, matching ``task-dag.schema.json``.
L0_STATIC: Final = "L0_typecheck_lint"
L1_TESTS: Final = "L1_tests"
L2_BROWSER: Final = "L2_browser_smoke"
L2_5_SAST: Final = "L2_5_sast"
L3_VISUAL: Final = "L3_visual_diff"


@dataclass(frozen=True, slots=True)
class TaskKind:
    """One thing the planner is allowed to ask for."""

    name: str
    description: str
    verification_floor: frozenset[str]
    allowed_tools: frozenset[str]
    destructive: bool = False

    def __post_init__(self) -> None:
        if not self.verification_floor:
            raise ValueError(f"task kind {self.name!r} has no verification floor")
        if not self.allowed_tools:
            raise ValueError(f"task kind {self.name!r} has no permitted tools")


#: Read-only tools every task needs to orient itself. Granting these everywhere
#: costs nothing: neither can change state.
_ORIENT: Final[frozenset[str]] = frozenset({"read_file", "search_code"})

#: The edit-and-check cycle. `apply_patch` is the only write path (I6).
_EDIT: Final[frozenset[str]] = _ORIENT | {"apply_patch", "run_shell"}


REACT_POSTGRES_VOCABULARY: Final[tuple[TaskKind, ...]] = (
    TaskKind(
        name="scaffold_project",
        description="Copy the frozen react-postgres template and adjust naming.",
        verification_floor=frozenset({L0_STATIC, L1_TESTS}),
        allowed_tools=_EDIT,
    ),
    TaskKind(
        name="add_table",
        description=(
            "Add a table via the provision tool. Row-level security is emitted by "
            "the tool, never requested (I9); do not write policies by hand."
        ),
        verification_floor=frozenset({L0_STATIC, L1_TESTS, L2_5_SAST}),
        allowed_tools=_EDIT | {"provision"},
    ),
    TaskKind(
        name="add_api_route",
        description="Add or change an Express route, its handler and its tests.",
        # A route that typechecks and is never requested is not a working route.
        verification_floor=frozenset({L0_STATIC, L1_TESTS, L2_BROWSER, L2_5_SAST}),
        allowed_tools=_EDIT,
    ),
    TaskKind(
        name="add_ui_page",
        description="Add a React page and its route entry.",
        verification_floor=frozenset({L0_STATIC, L1_TESTS, L2_BROWSER}),
        allowed_tools=_EDIT | {"browser"},
    ),
    TaskKind(
        name="add_ui_component",
        description="Add or change a presentational React component.",
        verification_floor=frozenset({L0_STATIC, L1_TESTS}),
        allowed_tools=_EDIT,
    ),
    TaskKind(
        name="wire_auth",
        description="Wire signup/login/session handling against the managed auth service.",
        # Auth is the one flow whose failure mode is silent: a broken guard still
        # renders. The browser layer is what actually proves it holds.
        verification_floor=frozenset({L0_STATIC, L1_TESTS, L2_BROWSER, L2_5_SAST}),
        allowed_tools=_EDIT | {"browser"},
    ),
    TaskKind(
        name="add_dependency",
        description="Add a package and lockfile entry.",
        verification_floor=frozenset({L0_STATIC, L1_TESTS, L2_5_SAST}),
        allowed_tools=_EDIT,
    ),
    TaskKind(
        name="write_tests",
        description="Add or extend tests without changing behaviour.",
        verification_floor=frozenset({L0_STATIC, L1_TESTS}),
        allowed_tools=_EDIT,
    ),
    TaskKind(
        name="fix_verification_failure",
        description="Repair a specific failing check reported by the verification pipeline.",
        verification_floor=frozenset({L0_STATIC, L1_TESTS}),
        allowed_tools=_EDIT | {"browser"},
    ),
    TaskKind(
        name="deploy",
        description="Deploy a verified checkpoint. Always behind a human confirmation gate.",
        verification_floor=frozenset({L0_STATIC, L1_TESTS, L2_BROWSER, L2_5_SAST}),
        allowed_tools=_ORIENT | {"deploy"},
        destructive=True,
    ),
)

_BY_NAME: Final[dict[str, TaskKind]] = {kind.name: kind for kind in REACT_POSTGRES_VOCABULARY}

#: The closed set of task kinds a plan may use.
TASK_KINDS: Final[frozenset[str]] = frozenset(_BY_NAME)


class UnknownTaskKind(ValueError):
    """The planner used a task kind outside the stack's vocabulary."""

    def __init__(self, name: str) -> None:
        super().__init__(
            f"unknown task kind {name!r}; this stack supports {sorted(TASK_KINDS)}. "
            "Decompose the work into these kinds rather than inventing one."
        )
        self.name = name


def task_kind(name: str) -> TaskKind:
    """Look up a task kind.

    Raises:
        UnknownTaskKind: with a message that lists the vocabulary, so the
            planner can re-emit rather than fail the run.
    """
    try:
        return _BY_NAME[name]
    except KeyError:
        raise UnknownTaskKind(name) from None


def resolve_verification(
    kind: str, requested: frozenset[str] | set[str] | None = None
) -> frozenset[str]:
    """Combine the planner's request with the kind's floor.

    The union, never the intersection. A planner asking for less verification
    than the kind requires is not exercising judgement, it is skipping the layer
    that would have caught the problem.
    """
    return task_kind(kind).verification_floor | frozenset(requested or ())


def allowed_tools(kind: str) -> frozenset[str]:
    """The tools a task of this kind may dispatch."""
    return task_kind(kind).allowed_tools


def is_destructive(kind: str, *, declared: bool = False) -> bool:
    """Whether a task needs a confirmation gate.

    A kind that is destructive by construction stays destructive however the
    planner flagged it; the planner may only add caution, never remove it.
    """
    return task_kind(kind).destructive or declared


def describe_vocabulary() -> str:
    """The vocabulary as prompt text, so the planner sees exactly what validates."""
    lines = ["Available task kinds (use these; do not invent others):"]
    for kind in REACT_POSTGRES_VOCABULARY:
        gate = " [requires human approval]" if kind.destructive else ""
        lines.append(f"  {kind.name}{gate}: {kind.description}")
    return "\n".join(lines)


__all__ = [
    "L0_STATIC",
    "L1_TESTS",
    "L2_5_SAST",
    "L2_BROWSER",
    "L3_VISUAL",
    "REACT_POSTGRES_VOCABULARY",
    "TASK_KINDS",
    "TaskKind",
    "UnknownTaskKind",
    "allowed_tools",
    "describe_vocabulary",
    "is_destructive",
    "resolve_verification",
    "task_kind",
]
