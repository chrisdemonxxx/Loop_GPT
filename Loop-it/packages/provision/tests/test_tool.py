"""Tests for the provision tool handler."""

from __future__ import annotations

from typing import Any

import pytest
from loopit_provision.tool import (
    ProvisionOutcome,
    SpecError,
    parse_table_spec,
    plan_migration,
    provision,
)


class Recorder:
    """Captures the SQL a call would have run."""

    def __init__(self) -> None:
        self.migrations: list[str] = []

    def __call__(self, sql: str) -> None:
        self.migrations.append(sql)


def _args(**spec: Any) -> dict[str, Any]:
    return {"resource": "table", "spec": spec}


TASKS = _args(
    name="tasks",
    access="owner",
    columns=[{"name": "title", "type": "text", "nullable": False}],
)


class TestStrictParsing:
    def test_unknown_keys_are_refused_not_ignored(self) -> None:
        # Silently dropping an unrecognised key is how a spec that looks like it
        # disabled RLS gets accepted and reported as success.
        with pytest.raises(SpecError, match="unsupported key"):
            parse_table_spec(
                {"name": "tasks", "access": "owner", "columns": [], "rls": False},
            )

    def test_unknown_column_keys_are_refused(self) -> None:
        with pytest.raises(SpecError, match="unsupported key"):
            parse_table_spec(
                {
                    "name": "tasks",
                    "access": "owner",
                    "columns": [{"name": "t", "type": "text", "primary_key": True}],
                }
            )

    @pytest.mark.parametrize("missing", ["name", "columns", "access"])
    def test_missing_required_keys_are_named(self, missing: str) -> None:
        spec: dict[str, Any] = {
            "name": "tasks",
            "access": "owner",
            "columns": [{"name": "t", "type": "text"}],
        }
        del spec[missing]
        with pytest.raises(SpecError, match=f"missing '{missing}'"):
            parse_table_spec(spec)

    def test_access_has_no_default(self) -> None:
        # Guessing at ownership is guessing at who may read the data.
        with pytest.raises(SpecError, match="'access' must be one of"):
            parse_table_spec({"name": "tasks", "access": "public", "columns": []})

    def test_access_error_explains_the_options(self) -> None:
        with pytest.raises(SpecError, match="signed-in user"):
            parse_table_spec({"name": "tasks", "access": "everyone", "columns": []})

    def test_columns_must_be_a_list(self) -> None:
        with pytest.raises(SpecError, match="'columns' must be a list"):
            parse_table_spec({"name": "tasks", "access": "owner", "columns": "title"})

    def test_non_object_spec_is_refused(self) -> None:
        with pytest.raises(SpecError, match="must be an object"):
            parse_table_spec("tasks")

    def test_nullable_must_be_boolean(self) -> None:
        with pytest.raises(SpecError, match="'nullable' must be a boolean"):
            parse_table_spec(
                {
                    "name": "tasks",
                    "access": "owner",
                    "columns": [{"name": "t", "type": "text", "nullable": "yes"}],
                }
            )


class TestUnsupportedResources:
    @pytest.mark.parametrize("resource", ["auth", "storage_bucket", "edge_function", "seed"])
    def test_unimplemented_resources_fail_loudly(self, resource: str) -> None:
        # Accepting and ignoring them would report success for work never done.
        with pytest.raises(SpecError, match="not implemented yet"):
            plan_migration({"resource": resource, "spec": {}})

    def test_missing_spec_is_refused(self) -> None:
        with pytest.raises(SpecError, match="requires a 'spec'"):
            plan_migration({"resource": "table"})


class TestMigrationPlanning:
    def test_a_single_table_spec_is_accepted(self) -> None:
        sql, tables = plan_migration(TASKS)
        assert [t.name for t in tables] == ["tasks"]
        assert 'ALTER TABLE "public"."tasks" FORCE ROW LEVEL SECURITY;' in sql

    def test_several_tables_land_in_one_transaction(self) -> None:
        args = {
            "resource": "table",
            "spec": {
                "tables": [
                    {
                        "name": "tasks",
                        "access": "owner",
                        "columns": [{"name": "t", "type": "text"}],
                    },
                    {
                        "name": "notes",
                        "access": "owner",
                        "columns": [{"name": "b", "type": "text"}],
                    },
                ]
            },
        }
        sql, tables = plan_migration(args)
        assert len(tables) == 2
        assert sql.count("BEGIN;") == 1
        for table in ("tasks", "notes"):
            assert f'ALTER TABLE "public"."{table}" FORCE ROW LEVEL SECURITY;' in sql

    def test_tables_must_be_a_list(self) -> None:
        with pytest.raises(SpecError, match="'tables' must be a list"):
            plan_migration({"resource": "table", "spec": {"tables": "tasks"}})


class TestHandler:
    def test_a_successful_call_runs_exactly_one_migration(self) -> None:
        recorder = Recorder()
        outcome = provision(TASKS, run_migration=recorder)
        assert outcome.ok
        assert len(recorder.migrations) == 1
        assert "FORCE ROW LEVEL SECURITY" in recorder.migrations[0]

    def test_the_agent_is_told_rls_was_applied_for_it(self) -> None:
        outcome = provision(TASKS, run_migration=Recorder())
        assert "do not write policies by hand" in outcome.output
        assert outcome.detail["rls"] == "forced"

    def test_a_rejected_spec_runs_no_migration(self) -> None:
        recorder = Recorder()
        outcome = provision(
            _args(name="tasks", access="nobody", columns=[]), run_migration=recorder
        )
        assert not outcome.ok
        assert recorder.migrations == []

    def test_rejection_is_returned_not_raised(self) -> None:
        # A malformed spec is the loop's next input, not a fatal error.
        outcome = provision({"resource": "table", "spec": {}}, run_migration=Recorder())
        assert isinstance(outcome, ProvisionOutcome)
        assert not outcome.ok
        assert outcome.output.startswith("provision REJECTED:")

    def test_a_hostile_table_name_is_rejected_without_running_sql(self) -> None:
        recorder = Recorder()
        outcome = provision(
            _args(
                name='x"; DROP SCHEMA public CASCADE; --',
                access="owner",
                columns=[{"name": "t", "type": "text"}],
            ),
            run_migration=recorder,
        )
        assert not outcome.ok
        assert recorder.migrations == []
        assert outcome.detail["error"] == "IdentifierError"

    def test_an_attempt_to_own_the_ownership_column_is_rejected(self) -> None:
        recorder = Recorder()
        outcome = provision(
            _args(
                name="tasks",
                access="owner",
                columns=[{"name": "user_id", "type": "text", "nullable": True}],
            ),
            run_migration=recorder,
        )
        assert not outcome.ok
        assert recorder.migrations == []

    def test_the_handler_holds_no_database_credential(self) -> None:
        # The runner is injected; the tool cannot reach a database it was not
        # given. Passing a runner that refuses proves nothing else connects.
        def refuse(sql: str) -> None:
            raise AssertionError("should not be reached")

        outcome = provision({"resource": "auth", "spec": {}}, run_migration=refuse)
        assert not outcome.ok
