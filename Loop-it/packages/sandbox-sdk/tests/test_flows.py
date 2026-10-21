"""Tests for the critical-flow browser smoke (P2-7).

The isolation flow is the Phase 2 exit gate, so most of these tests are about
the ways an isolation check can *falsely pass*.
"""

from __future__ import annotations

import pytest
from loopit_sandbox_sdk.browser import ConsoleMessage, PageResult
from loopit_sandbox_sdk.flows import (
    Click,
    Credentials,
    ExpectAbsent,
    ExpectText,
    Fill,
    Flow,
    FlowResult,
    Visit,
    run_flow,
    signup_login_create_readback,
    tenant_isolation_flow,
)

ALICE = Credentials("alice@example.test", "pw-alice")
BOB = Credentials("bob@example.test", "pw-bob")
SECRET = "alice-private-task"


class FakeDriver:
    """A scripted browser. ``pages`` maps a path to (body, result)."""

    def __init__(
        self,
        pages: dict[str, tuple[str, PageResult]] | None = None,
        *,
        default_body: str = "Tasks",
    ) -> None:
        self.pages = pages or {}
        self.default_body = default_body
        self.body = default_body
        self.result = PageResult(url="/", status=200)
        self.filled: list[tuple[str, str]] = []
        self.clicked: list[str] = []

    def goto(self, path: str, *, timeout_seconds: float) -> PageResult:
        body, result = self.pages.get(path, (self.default_body, PageResult(url=path, status=200)))
        self.body = body
        self.result = result
        return result

    def fill(self, selector: str, value: str) -> None:
        self.filled.append((selector, value))

    def click(self, selector: str) -> None:
        self.clicked.append(selector)
        self.body = f"{self.body} {' '.join(v for _, v in self.filled)}"

    def text_content(self) -> str:
        return self.body

    def last_result(self) -> PageResult:
        return self.result


def _ok(path: str = "/") -> PageResult:
    return PageResult(url=path, status=200)


class TestStepExecution:
    def test_a_passing_flow_runs_every_step(self) -> None:
        flow = Flow("f", (Visit("/"), ExpectText("Tasks")))
        result = run_flow(FakeDriver(), flow)
        assert result.passed
        assert len(result.outcomes) == 2

    def test_execution_stops_at_the_first_failure(self) -> None:
        # Continuing would produce cascading noise: every later assertion fails
        # for the same upstream reason.
        flow = Flow("f", (ExpectText("missing"), ExpectText("Tasks"), ExpectText("Tasks")))
        result = run_flow(FakeDriver(), flow)
        assert not result.passed
        assert len(result.outcomes) == 1

    def test_a_driver_fault_is_a_step_failure_not_a_crash(self) -> None:
        class Broken(FakeDriver):
            def click(self, selector: str) -> None:
                raise RuntimeError("element detached")

        result = run_flow(Broken(), Flow("f", (Click("#go"),)))
        assert not result.passed
        failure = result.failure
        assert failure is not None
        assert "element detached" in failure.detail

    def test_an_unhealthy_page_fails_the_visit(self) -> None:
        page = PageResult(url="/", status=200, console=(ConsoleMessage("error", "boom"),))
        driver = FakeDriver({"/": ("Tasks", page)})
        result = run_flow(driver, Flow("f", (Visit("/"),)))
        assert not result.passed

    def test_an_empty_flow_is_refused(self) -> None:
        with pytest.raises(ValueError, match="no steps"):
            Flow("f", ())


class TestAbsenceFailsClosed:
    """The ways an isolation check can falsely report safety."""

    def test_absence_on_a_broken_page_does_not_pass(self) -> None:
        # A 500 contains no data at all, which is not the same as isolation.
        page = PageResult(url="/", status=500)
        driver = FakeDriver({"/": ("Internal Server Error", page)})
        driver.goto("/", timeout_seconds=1)
        result = run_flow(driver, Flow("f", (ExpectAbsent(SECRET, anchor="Tasks"),)))
        assert not result.passed
        failure = result.failure
        assert failure is not None
        assert "proves nothing" in failure.detail

    def test_absence_without_the_anchor_does_not_pass(self) -> None:
        # A login redirect shows no tasks either. Requiring a positive anchor is
        # what distinguishes "isolated" from "never got there".
        driver = FakeDriver(default_body="Please sign in")
        result = run_flow(driver, Flow("f", (ExpectAbsent(SECRET, anchor="Tasks"),)))
        assert not result.passed
        failure = result.failure
        assert failure is not None
        assert "anchor" in failure.detail

    def test_a_console_error_invalidates_the_absence(self) -> None:
        page = PageResult(url="/", status=200, console=(ConsoleMessage("error", "fetch failed"),))
        driver = FakeDriver({"/": ("Tasks", page)})
        driver.goto("/", timeout_seconds=1)
        result = run_flow(driver, Flow("f", (ExpectAbsent(SECRET, anchor="Tasks"),)))
        assert not result.passed

    def test_a_leak_is_caught(self) -> None:
        driver = FakeDriver(default_body=f"Tasks {SECRET}")
        result = run_flow(driver, Flow("f", (ExpectAbsent(SECRET, anchor="Tasks"),)))
        assert not result.passed
        failure = result.failure
        assert failure is not None
        assert "must not see it" in failure.detail

    def test_genuine_isolation_passes(self) -> None:
        driver = FakeDriver(default_body="Tasks bob-only-task")
        result = run_flow(driver, Flow("f", (ExpectAbsent(SECRET, anchor="Tasks"),)))
        assert result.passed


class TestCriticalFlows:
    def test_the_happy_path_reloads_before_reading_back(self) -> None:
        # A create that returns 201 and a list that never shows the row is the
        # commonest way a generated CRUD app is broken. Trusting the optimistic
        # UI update would miss it.
        steps = signup_login_create_readback(ALICE, "buy milk").steps
        create_index = steps.index(Click("[data-testid=create-task]"))
        assert Visit("/") in steps[create_index:]
        assert steps[-1] == ExpectText("buy milk")

    def test_the_isolation_flow_uses_two_identities(self) -> None:
        flow = tenant_isolation_flow(ALICE, BOB, SECRET)
        emails = {step.value for step in flow.steps if isinstance(step, Fill)}
        assert ALICE.email in emails
        assert BOB.email in emails

    def test_the_isolation_flow_logs_the_owner_out(self) -> None:
        # Otherwise the second session inherits the first one's cookies and the
        # check is meaningless.
        flow = tenant_isolation_flow(ALICE, BOB, SECRET)
        assert Visit("/logout") in flow.steps

    def test_the_isolation_flow_ends_with_an_anchored_absence(self) -> None:
        flow = tenant_isolation_flow(ALICE, BOB, SECRET)
        last = flow.steps[-1]
        assert isinstance(last, ExpectAbsent)
        assert last.text == SECRET
        assert last.anchor

    def test_the_isolation_flow_proves_the_data_existed_first(self) -> None:
        # Absence of data that was never created proves nothing, so the owner's
        # full create-and-read-back runs before the intruder logs in.
        flow = tenant_isolation_flow(ALICE, BOB, SECRET)
        assert ExpectText(SECRET) in flow.steps


class TestRedaction:
    def test_passwords_are_redacted_in_step_descriptions(self) -> None:
        # Step descriptions reach the transcript and the audit log.
        step = Fill("[name=password]", ALICE.password, secret=True)
        assert ALICE.password not in step.describe
        assert "[redacted]" in step.describe

    def test_no_rendered_flow_leaks_a_password(self) -> None:
        driver = FakeDriver()
        rendered = run_flow(driver, tenant_isolation_flow(ALICE, BOB, SECRET)).render()
        assert ALICE.password not in rendered
        assert BOB.password not in rendered

    def test_ordinary_values_are_not_redacted(self) -> None:
        assert "buy milk" in Fill("[name=title]", "buy milk").describe


class TestReporting:
    def test_a_failed_flow_names_the_failing_step(self) -> None:
        flow = Flow("f", (ExpectText("nope"),))
        rendered = run_flow(FakeDriver(), flow).render()
        assert "FAILED" in rendered
        assert "nope" in rendered

    def test_an_empty_result_is_not_a_pass(self) -> None:
        # A flow that never ran must not read as green.
        assert not FlowResult(flow="f").passed

    def test_credentials_need_both_fields(self) -> None:
        with pytest.raises(ValueError, match="both an email and a password"):
            Credentials("a@b.test", "")
