"""Critical-flow browser smoke tests (Doc 05, P2-7).

Navigation alone proves a page renders. It does not prove a user can sign up,
log in, create something, and see it again — which is the entire product. This
module turns those flows into declarative, replayable scripts the verification
pipeline can run at L2.

The flow that matters most is not the happy path.

**Tenant isolation is a flow, not a unit test.** The Phase 2 exit gate is a
multi-user app with login and persistent data, and the failure that gate exists
to catch is user B seeing user A's rows. That cannot be checked from one
session, so :func:`tenant_isolation_flow` drives two. It is the only check in the
system that exercises RLS end to end through a real browser against a real
database, which is why it lives here rather than in a unit test that would have
to mock the thing under test.

**Absence assertions must fail closed.** "User B's page does not contain user A's
task" is trivially true when the page 500s, when the session was rejected, or
when the app renders an empty error state. An isolation check that passes for
those reasons is worse than no check, because it reports safety it never
verified. :class:`ExpectAbsent` therefore requires the page to be *healthy* and
requires a positive anchor to be present first — proof the page actually
rendered — before the absence means anything.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from .browser import PageResult


class FlowError(Exception):
    """A flow could not be executed."""


@dataclass(frozen=True, slots=True)
class Credentials:
    """A test identity. Passwords here are generated per run, never fixtures."""

    email: str
    password: str

    def __post_init__(self) -> None:
        if not self.email or not self.password:
            raise ValueError("test credentials need both an email and a password")


@dataclass(frozen=True, slots=True)
class Visit:
    """Navigate to a preview path."""

    path: str

    @property
    def describe(self) -> str:
        return f"visit {self.path}"


@dataclass(frozen=True, slots=True)
class Fill:
    """Type a value into a field."""

    selector: str
    value: str
    #: Whether the value is a credential. Redacted when the step is described,
    #: because step descriptions reach the transcript and the audit log.
    secret: bool = False

    @property
    def describe(self) -> str:
        shown = "[redacted]" if self.secret else self.value
        return f"fill {self.selector} with {shown}"


@dataclass(frozen=True, slots=True)
class Click:
    """Click an element."""

    selector: str

    @property
    def describe(self) -> str:
        return f"click {self.selector}"


@dataclass(frozen=True, slots=True)
class ExpectText:
    """Assert the page shows some text."""

    text: str

    @property
    def describe(self) -> str:
        return f"expect page to show {self.text!r}"


@dataclass(frozen=True, slots=True)
class ExpectAbsent:
    """Assert the page does *not* show some text, having first proved it rendered.

    ``anchor`` is text that must be present. Without it, this assertion passes
    on a blank page, an error page, and a login redirect — none of which say
    anything about whether the data is isolated.
    """

    text: str
    anchor: str

    @property
    def describe(self) -> str:
        return f"expect {self.text!r} to be absent from a page showing {self.anchor!r}"


Step = Visit | Fill | Click | ExpectText | ExpectAbsent


@runtime_checkable
class FlowDriver(Protocol):
    """An interactive browser session inside the sandbox.

    Separate from :class:`~.browser.BrowserDriver` because a flow needs to type
    and click, and because each concurrent session must be independent — two
    flows sharing cookies would make the isolation check meaningless.
    """

    def goto(self, path: str, *, timeout_seconds: float) -> PageResult: ...

    def fill(self, selector: str, value: str) -> None: ...

    def click(self, selector: str) -> None: ...

    def text_content(self) -> str:
        """The rendered text of the current page."""
        ...

    def last_result(self) -> PageResult:
        """The most recent navigation or interaction outcome."""
        ...


@dataclass(frozen=True, slots=True)
class Flow:
    """A named sequence of steps."""

    name: str
    steps: tuple[Step, ...]

    def __post_init__(self) -> None:
        if not self.steps:
            raise ValueError(f"flow {self.name!r} has no steps")


@dataclass(frozen=True, slots=True)
class StepOutcome:
    """What one step did."""

    step: Step
    passed: bool
    detail: str = ""

    def render(self) -> str:
        mark = "ok" if self.passed else "FAILED"
        suffix = f" - {self.detail}" if self.detail else ""
        return f"  {mark}: {self.step.describe}{suffix}"


@dataclass(frozen=True, slots=True)
class FlowResult:
    """The outcome of one flow."""

    flow: str
    outcomes: tuple[StepOutcome, ...] = field(default_factory=tuple)

    @property
    def passed(self) -> bool:
        return bool(self.outcomes) and all(outcome.passed for outcome in self.outcomes)

    @property
    def failure(self) -> StepOutcome | None:
        return next((outcome for outcome in self.outcomes if not outcome.passed), None)

    def render(self) -> str:
        verdict = "passed" if self.passed else "FAILED"
        lines = [f"Flow {self.flow!r}: {verdict}"]
        lines.extend(outcome.render() for outcome in self.outcomes)
        return "\n".join(lines)


def _check(driver: FlowDriver, step: ExpectText | ExpectAbsent) -> StepOutcome:
    if isinstance(step, ExpectText):
        body = driver.text_content()
        if step.text in body:
            return StepOutcome(step, True)
        return StepOutcome(step, False, "text not found on the rendered page")

    body = driver.text_content()
    result = driver.last_result()
    # Fail closed: absence only means isolation if the page actually rendered.
    if not result.healthy:
        return StepOutcome(
            step,
            False,
            "page did not render cleanly, so the absence proves nothing",
        )
    if step.anchor not in body:
        return StepOutcome(
            step,
            False,
            f"anchor {step.anchor!r} missing, so the page is not the one under test",
        )
    if step.text in body:
        return StepOutcome(step, False, "value is visible to a user who must not see it")
    return StepOutcome(step, True)


def run_flow(driver: FlowDriver, flow: Flow, *, timeout_seconds: float = 30.0) -> FlowResult:
    """Execute ``flow``, stopping at the first failure.

    Continuing past a failed step would produce cascading noise: every later
    assertion fails for the same upstream reason, and the agent has to work out
    which one was the cause.
    """
    outcomes: list[StepOutcome] = []
    for step in flow.steps:
        try:
            if isinstance(step, Visit):
                result = driver.goto(step.path, timeout_seconds=timeout_seconds)
                outcome = StepOutcome(
                    step,
                    result.healthy,
                    "" if result.healthy else f"status {result.status}, console errors present",
                )
            elif isinstance(step, Fill):
                driver.fill(step.selector, step.value)
                outcome = StepOutcome(step, True)
            elif isinstance(step, Click):
                driver.click(step.selector)
                outcome = StepOutcome(step, True)
            else:
                outcome = _check(driver, step)
        except Exception as error:  # a driver fault is a step failure, not a crash
            outcome = StepOutcome(step, False, f"{type(error).__name__}: {error}")

        outcomes.append(outcome)
        if not outcome.passed:
            break

    return FlowResult(flow=flow.name, outcomes=tuple(outcomes))


def signup_login_create_readback(user: Credentials, item: str) -> Flow:
    """The critical path: signup then login then create then read back.

    The read-back is the point. A create that returns 201 and a list that never
    shows the row is the single most common way a generated CRUD app is broken,
    and it is invisible to every layer below this one.
    """
    return Flow(
        name="signup-login-create-readback",
        steps=(
            Visit("/signup"),
            Fill("[name=email]", user.email),
            Fill("[name=password]", user.password, secret=True),
            Click("[type=submit]"),
            Visit("/login"),
            Fill("[name=email]", user.email),
            Fill("[name=password]", user.password, secret=True),
            Click("[type=submit]"),
            ExpectText("Tasks"),
            Fill("[name=title]", item),
            Click("[data-testid=create-task]"),
            ExpectText(item),
            # Reload rather than trusting the optimistic UI update: the row must
            # have reached the database, not just React state.
            Visit("/"),
            ExpectText(item),
        ),
    )


def tenant_isolation_flow(owner: Credentials, intruder: Credentials, secret_item: str) -> Flow:
    """User A's data must be invisible to user B (Doc 06 §8, T2).

    This is the check the Phase 2 exit gate turns on. It runs as one script over
    two sessions because isolation is only observable from the second one.
    """
    return Flow(
        name="tenant-isolation",
        steps=(
            *signup_login_create_readback(owner, secret_item).steps,
            Visit("/logout"),
            Visit("/signup"),
            Fill("[name=email]", intruder.email),
            Fill("[name=password]", intruder.password, secret=True),
            Click("[type=submit]"),
            Visit("/login"),
            Fill("[name=email]", intruder.email),
            Fill("[name=password]", intruder.password, secret=True),
            Click("[type=submit]"),
            # The anchor proves the intruder's task list rendered. Without it,
            # a login failure would read as successful isolation.
            ExpectAbsent(secret_item, anchor="Tasks"),
        ),
    )


CRITICAL_FLOWS = (signup_login_create_readback, tenant_isolation_flow)


__all__ = [
    "CRITICAL_FLOWS",
    "Click",
    "Credentials",
    "ExpectAbsent",
    "ExpectText",
    "Fill",
    "Flow",
    "FlowDriver",
    "FlowError",
    "FlowResult",
    "Step",
    "StepOutcome",
    "Visit",
    "run_flow",
    "signup_login_create_readback",
    "tenant_isolation_flow",
]
