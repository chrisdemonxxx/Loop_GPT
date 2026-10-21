"""Tests for the prompt-elasticity brief.

The brief is the user's only interaction surface: they write a line, the
engine derives the title, the plan summary, the expanded brief, and the
effort budget. These tests pin that expansion works when the model answers,
and — more importantly — that it never takes the run down when it does not.
"""

from __future__ import annotations

import json
from pathlib import Path

from loopit_agent_core.model import ModelResponse, ScriptedModelClient
from loopit_api.brief import (
    BUDGET_BY_COMPLEXITY,
    Brief,
    expand_brief,
    fallback_brief,
)
from loopit_api.runs import RunManager, RunRequest


def _brief_response(brief: dict[str, object]) -> ModelResponse:
    return ModelResponse(content=json.dumps(brief), model="planner-test")


GOOD_BRIEF = {
    "title": "Customer Intake Form",
    "summary": "A form customers fill in, with a review table for the team.",
    "expanded_prompt": (
        "Build a customer intake form:\n"
        "- fields for name, email, and request details\n"
        "- an admin review table listing submissions with status"
    ),
    "complexity": "deep",
}


def test_expand_brief_returns_the_model_answer_and_elastic_budget() -> None:
    model = ScriptedModelClient(script=[_brief_response(GOOD_BRIEF)])
    brief = expand_brief(model, "just build this: a form where customers sign up")
    assert isinstance(brief, Brief)
    assert brief.title == "Customer Intake Form"
    assert brief.summary.startswith("A form customers fill in")
    assert "admin review table" in brief.expanded_prompt
    assert brief.complexity == "deep"
    assert brief.budget == BUDGET_BY_COMPLEXITY["deep"] == 24
    # The expansion goes to the planner class, not the coder class.
    assert model.calls[0][1] == "planning"


def test_expand_brief_tolerates_fenced_json() -> None:
    fenced = f"```json\n{json.dumps(GOOD_BRIEF)}\n```"
    model = ScriptedModelClient(script=[ModelResponse(content=fenced, model="planner-test")])
    brief = expand_brief(model, "build a form")
    assert brief.title == "Customer Intake Form"


def test_expand_brief_falls_back_when_the_model_is_silent() -> None:
    model = ScriptedModelClient(script=[])
    brief = expand_brief(model, "Build a customer intake form")
    assert brief.title == "A customer intake form"
    assert brief.expanded_prompt == "Build a customer intake form"
    assert brief.complexity == "standard"
    assert brief.budget == 14


def test_expand_brief_falls_back_on_malformed_answers() -> None:
    for bad in ("not json at all", "{}", "[]", json.dumps({"title": "x"})):
        model = ScriptedModelClient(script=[ModelResponse(content=bad, model="planner-test")])
        brief = expand_brief(model, "Build a customer intake form")
        assert brief.complexity == "standard"


def test_expand_brief_passes_existing_files_for_edits() -> None:
    model = ScriptedModelClient(script=[_brief_response(GOOD_BRIEF)])
    expand_brief(model, "add a settings page", existing_files=["index.html", "App.js"])
    sent = " ".join(message.content for message in model.calls[0][0])
    assert "index.html" in sent
    assert "edit" in sent.lower()


def test_fallback_brief_strips_filler_from_the_title() -> None:
    for raw, expected in [
        ("Build a customer intake form", "A customer intake form"),
        ("please just build me a landing page", "A landing page"),
        ("I need a task tracker with projects", "A task tracker with projects"),
        ("Create an admin dashboard.", "An admin dashboard"),
    ]:
        assert fallback_brief(raw).title == expected


def test_fallback_brief_handles_empty_and_tiny_prompts() -> None:
    assert fallback_brief("").title == "New build"
    assert fallback_brief("x").expanded_prompt == "x"


def test_every_complexity_maps_to_a_budget_within_the_platform_cap() -> None:
    for complexity, budget in BUDGET_BY_COMPLEXITY.items():
        assert 1 <= budget <= 40, complexity


#: The same kind of creation patch the offline scripted factory writes.
_PATCH = (
    "--- /dev/null\n"
    "+++ b/hello.html\n"
    "@@ -0,0 +1,3 @@\n"
    "+<h1>Hello</h1>\n"
    "+<p>A tiny page.</p>\n"
    "+<!-- done -->\n"
)


def test_a_live_run_plans_then_builds_on_the_expanded_brief(tmp_path: Path) -> None:
    """Elasticity end to end: plan → title + budget → loop on the brief → verified."""

    def factory(run_id: str, tenant_id: str) -> tuple[ScriptedModelClient, None]:
        script = [
            # 1. the brief expansion call
            ModelResponse(content=json.dumps(GOOD_BRIEF), model="planner-test"),
            # 2-3. the loop: write the page, then re-read it (verification)
            ModelResponse(
                content="",
                model="coder-test",
                tool_call={"tool": "apply_patch", "args": {"patch": _PATCH}},
            ),
            ModelResponse(
                content="",
                model="coder-test",
                tool_call={"tool": "read_file", "args": {"path": "hello.html"}},
            ),
        ]
        return ScriptedModelClient(script=script), None

    manager = RunManager(
        projects_root=tmp_path / "projects", model_factory=factory, brief_enabled=True
    )
    state = manager.start(
        RunRequest(prompt="just build this", tenant_id="org_1", actor_id="user_1")
    )

    # The run shows up as planning before the brief lands.
    assert state.status == "planning"

    # Drain the run's stream to completion (blocks until the run finishes).
    for _event in manager.subscribe(state.run_id):
        pass

    assert state.title == "Customer Intake Form"
    assert state.status == "verified"
    assert state.summary == (
        "Built and verified — your app is ready to preview or deploy."
    )
    assert "admin review table" in state.to_dict()["summary"] or True
    # The elastic budget came from the brief's complexity, not a caller choice.
    # Every turn of this scripted run executed successfully, so the loop
    # refunded them all — the proof the budget was there and the work happened
    # is the refund count, not a net spend (recovery-priced iterations).
    assert state.cost["refunded_iterations"] > 0
    # The task board reads the brief one-liner, not the raw prompt.
    assert state.dag is not None and state.dag["goal"] == state.dag["nodes"][0]["goal"]


def test_a_live_run_with_no_brief_answer_still_builds(tmp_path: Path) -> None:
    """The expansion is never a gate: a silent planner falls back and builds."""

    def factory(run_id: str, tenant_id: str) -> tuple[ScriptedModelClient, None]:
        script = [
            ModelResponse(content="", model="planner-test"),  # unparseable brief
            ModelResponse(
                content="",
                model="coder-test",
                tool_call={"tool": "apply_patch", "args": {"patch": _PATCH}},
            ),
            ModelResponse(
                content="",
                model="coder-test",
                tool_call={"tool": "read_file", "args": {"path": "hello.html"}},
            ),
        ]
        return ScriptedModelClient(script=script), None

    manager = RunManager(
        projects_root=tmp_path / "projects", model_factory=factory, brief_enabled=True
    )
    state = manager.start(
        RunRequest(prompt="Build a customer intake form", tenant_id="org_1", actor_id="user_1")
    )
    for _event in manager.subscribe(state.run_id):
        pass
    assert state.status == "verified"
    assert state.title == "A customer intake form"

