"""Control-plane run/project catalog persistence."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from loopit_api.persist import (
    catalog_status,
    load_run_meta,
    persist_run_finished,
    persist_run_started,
    record_to_dict,
)
from loopit_api.runs import RunState
from loopit_store import InMemoryProjectStore, InMemoryRunStore


def test_persist_run_started_creates_project_and_starts_the_run() -> None:
    projects = InMemoryProjectStore()
    runs = InMemoryRunStore()
    record = persist_run_started(
        projects=projects,
        runs=runs,
        tenant_id="org_1",
        owner_user_id="user_1",
        project_id="proj_abc",
        run_id="run_abc",
        prompt="build a page",
        stack="react",
        max_iterations=12,
        difficulty="implementation",
    )
    assert record.status == "running"
    assert projects.get("proj_abc", tenant_id="org_1") is not None
    assert runs.get("run_abc", tenant_id="org_1") is not None
    assert runs.list_for_tenant("org_1")[0].run_id == "run_abc"


def test_persist_run_started_is_idempotent() -> None:
    projects = InMemoryProjectStore()
    runs = InMemoryRunStore()
    kwargs = dict(
        projects=projects,
        runs=runs,
        tenant_id="org_1",
        owner_user_id="user_1",
        project_id="proj_abc",
        run_id="run_abc",
        prompt="build a page",
        stack="react",
        max_iterations=12,
        difficulty="implementation",
    )
    persist_run_started(**kwargs)
    again = persist_run_started(**kwargs)
    assert again.status == "running"
    assert len(runs.list_for_tenant("org_1")) == 1


def test_persist_run_finished_maps_verified_to_succeeded() -> None:
    projects = InMemoryProjectStore()
    runs = InMemoryRunStore()
    persist_run_started(
        projects=projects,
        runs=runs,
        tenant_id="org_1",
        owner_user_id="user_1",
        project_id="proj_abc",
        run_id="run_abc",
        prompt="build a page",
        stack="react",
        max_iterations=12,
        difficulty="implementation",
    )
    assert catalog_status("verified") == "succeeded"
    finished = persist_run_finished(
        runs,
        RunState(
            run_id="run_abc",
            prompt="build a page",
            status="verified",
            tenant_id="org_1",
            project_id="proj_abc",
            iterations=3,
            summary="ok",
            credits_spent=0.01,
            finished_at=datetime.now(UTC),
        ),
    )
    assert finished is not None
    assert finished.status == "succeeded"
    assert finished.summary == "ok"


def test_persist_run_finished_writes_title_summary_stack_sidecar(tmp_path: Path) -> None:
    projects = InMemoryProjectStore()
    runs = InMemoryRunStore()
    persist_run_started(
        projects=projects,
        runs=runs,
        tenant_id="org_1",
        owner_user_id="user_1",
        project_id="proj_abc",
        run_id="run_abc",
        prompt="build a page",
        stack="react",
        max_iterations=12,
        difficulty="implementation",
    )
    state = RunState(
        run_id="run_abc",
        prompt="build a page",
        status="verified",
        tenant_id="org_1",
        project_id="proj_abc",
        iterations=2,
        summary="Built and verified",
        credits_spent=0.02,
        title="Acme landing",
        stack="react",
        finished_at=datetime.now(UTC),
    )
    finished = persist_run_finished(runs, state, projects_root=tmp_path)
    assert finished is not None
    meta = load_run_meta(tmp_path, "run_abc")
    assert meta["title"] == "Acme landing"
    assert meta["summary"] == "Built and verified"
    assert meta["stack"] == "react"
    project = projects.get("proj_abc", tenant_id="org_1")
    view = record_to_dict(finished, projects_root=tmp_path, project=project)
    assert view["title"] == "Acme landing"
    assert view["summary"] == "Built and verified"
    assert view["stack"] == "react"
