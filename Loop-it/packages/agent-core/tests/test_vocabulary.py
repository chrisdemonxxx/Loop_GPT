"""Tests for the planner task vocabulary (P2-6)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from loopit_agent_core.tools import _find_schema
from loopit_agent_core.vocabulary import (
    L0_STATIC,
    L1_TESTS,
    L2_5_SAST,
    L2_BROWSER,
    REACT_POSTGRES_VOCABULARY,
    TASK_KINDS,
    TaskKind,
    UnknownTaskKind,
    allowed_tools,
    describe_vocabulary,
    is_destructive,
    resolve_verification,
    task_kind,
)


class TestVocabularyIsClosed:
    def test_an_invented_kind_is_rejected(self) -> None:
        with pytest.raises(UnknownTaskKind):
            task_kind("train_a_model")

    def test_the_rejection_lists_the_vocabulary(self) -> None:
        # The planner should be able to re-emit rather than fail the run.
        with pytest.raises(UnknownTaskKind, match="add_api_route"):
            task_kind("do_the_thing")

    def test_the_schema_enum_matches_the_code(self) -> None:
        # A contract that drifts from the implementation validates plans the
        # implementation cannot run.
        schema = json.loads(Path(_find_schema("task-dag.schema.json")).read_text(encoding="utf-8"))
        enum = schema["$defs"]["taskNode"]["properties"]["kind"]["enum"]
        assert set(enum) == TASK_KINDS

    def test_kind_is_required_by_the_contract(self) -> None:
        schema = json.loads(Path(_find_schema("task-dag.schema.json")).read_text(encoding="utf-8"))
        assert "kind" in schema["$defs"]["taskNode"]["required"]


class TestVerificationFloor:
    def test_the_planner_cannot_lower_verification(self) -> None:
        # Asking for less than the kind requires is not judgement, it is
        # skipping the layer that would have caught the problem.
        resolved = resolve_verification("add_api_route", {L0_STATIC})
        assert L1_TESTS in resolved
        assert L2_BROWSER in resolved
        assert L2_5_SAST in resolved

    def test_the_planner_can_raise_verification(self) -> None:
        resolved = resolve_verification("add_ui_component", {L2_BROWSER})
        assert L2_BROWSER in resolved

    def test_omitting_verification_still_yields_the_floor(self) -> None:
        assert resolve_verification("add_table") == task_kind("add_table").verification_floor

    def test_auth_requires_a_browser_check(self) -> None:
        # Auth is the one flow whose failure mode is silent: a broken guard
        # still renders.
        assert L2_BROWSER in resolve_verification("wire_auth")

    def test_schema_changes_require_the_security_pass(self) -> None:
        assert L2_5_SAST in resolve_verification("add_table")

    @pytest.mark.parametrize("kind", sorted(TASK_KINDS))
    def test_every_kind_has_a_static_floor_at_minimum(self, kind: str) -> None:
        assert L0_STATIC in resolve_verification(kind)


class TestToolScoping:
    def test_ui_work_cannot_provision_or_deploy(self) -> None:
        # It does not matter how persuasive an injected instruction is if the
        # tool is not dispatchable from this node.
        tools = allowed_tools("add_ui_component")
        assert "provision" not in tools
        assert "deploy" not in tools

    def test_only_add_table_may_provision(self) -> None:
        provisioning = {k.name for k in REACT_POSTGRES_VOCABULARY if "provision" in k.allowed_tools}
        assert provisioning == {"add_table"}

    def test_only_deploy_may_deploy(self) -> None:
        deploying = {k.name for k in REACT_POSTGRES_VOCABULARY if "deploy" in k.allowed_tools}
        assert deploying == {"deploy"}

    def test_the_deploy_task_cannot_also_edit_code(self) -> None:
        # Deploy runs against a verified checkpoint; letting it patch first
        # would deploy something nothing verified.
        tools = allowed_tools("deploy")
        assert "apply_patch" not in tools
        assert "run_shell" not in tools

    def test_apply_patch_is_the_only_write_path(self) -> None:
        for kind in REACT_POSTGRES_VOCABULARY:
            writes = kind.allowed_tools & {"write_file", "overwrite_file", "put_file"}
            assert writes == set(), f"{kind.name} has a non-patch write path"

    @pytest.mark.parametrize("kind", sorted(TASK_KINDS))
    def test_every_kind_can_read(self, kind: str) -> None:
        assert "read_file" in allowed_tools(kind)


class TestDestructiveness:
    def test_deploy_is_destructive_however_it_was_flagged(self) -> None:
        # The planner may add caution, never remove it.
        assert is_destructive("deploy", declared=False)

    def test_a_planner_may_escalate_an_ordinary_kind(self) -> None:
        assert is_destructive("add_api_route", declared=True)

    def test_ordinary_kinds_are_not_gated_by_default(self) -> None:
        assert not is_destructive("add_ui_component")


class TestKindDefinitions:
    def test_a_kind_without_verification_is_refused(self) -> None:
        with pytest.raises(ValueError, match="no verification floor"):
            TaskKind("x", "d", frozenset(), frozenset({"read_file"}))

    def test_a_kind_without_tools_is_refused(self) -> None:
        with pytest.raises(ValueError, match="no permitted tools"):
            TaskKind("x", "d", frozenset({L0_STATIC}), frozenset())

    def test_the_prompt_text_lists_every_kind(self) -> None:
        text = describe_vocabulary()
        for kind in TASK_KINDS:
            assert kind in text

    def test_the_prompt_flags_kinds_needing_approval(self) -> None:
        assert "[requires human approval]" in describe_vocabulary()

    def test_add_table_tells_the_planner_not_to_write_policies(self) -> None:
        assert "do not write policies by hand" in task_kind("add_table").description
