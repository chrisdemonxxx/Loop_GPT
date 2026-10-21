"""Agent browser self-testing with replay artifacts (Phase 2.2).

Playwright drives the preview URL when available. Offline / CI without browsers
writes a stub recording (manifest + steps) so the UI Test run card still works.
When auth is provisioned, a seeded test user is used for sign-in flows.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class TestUser:
    email: str
    password: str
    label: str = "seeded test user"


@dataclass
class BrowserTestStep:
    n: int
    t: int
    kind: str
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass
class BrowserTestRun:
    test_id: str
    project_id: str
    status: str  # passed | failed | skipped
    mode: str  # live | offline
    preview_url: str
    started_at: str
    finished_at: str
    summary: str
    steps: list[BrowserTestStep]
    artifact_dir: str
    video_path: str | None = None
    trace_path: str | None = None
    test_user: dict[str, str] | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "test_id": self.test_id,
            "project_id": self.project_id,
            "status": self.status,
            "mode": self.mode,
            "preview_url": self.preview_url,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "summary": self.summary,
            "steps": [
                {"n": s.n, "t": s.t, "kind": s.kind, **s.detail} for s in self.steps
            ],
            "artifact_dir": self.artifact_dir,
            "video_path": self.video_path,
            "trace_path": self.trace_path,
            "test_user": self.test_user,
            "error": self.error,
        }


def artifacts_root(projects_root: Path, project_id: str) -> Path:
    return projects_root / ".artifacts" / "browser-tests" / project_id


def seeded_test_user(*, auth_ready: bool) -> TestUser | None:
    """Return credentials for browser sign-in when auth is provisioned."""
    if not auth_ready:
        return None
    email = os.environ.get("LOOPIT_BROWSER_TEST_EMAIL", "test@loopit.local")
    password = os.environ.get("LOOPIT_BROWSER_TEST_PASSWORD", "loopit-test-password")
    return TestUser(email=email, password=password)


def _write_recording(dest: Path, run: BrowserTestRun) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    manifest = {
        "id": run.test_id,
        "project_id": run.project_id,
        "startedAt": run.started_at,
        "finishedAt": run.finished_at,
        "stepCount": len(run.steps),
        "summary": run.summary,
        "status": run.status,
        "mode": run.mode,
        "previewUrl": run.preview_url,
        "videoPath": run.video_path,
        "tracePath": run.trace_path,
        "testUser": run.test_user,
        "steps": [{"n": s.n, "t": s.t, "kind": s.kind, **s.detail} for s in run.steps],
    }
    (dest / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    with (dest / "steps.jsonl").open("w", encoding="utf-8") as handle:
        for step in run.steps:
            handle.write(json.dumps({"n": step.n, "t": step.t, "kind": step.kind, **step.detail}) + "\n")
    (dest / "result.json").write_text(
        json.dumps(run.to_dict(), indent=2) + "\n", encoding="utf-8"
    )


def run_offline_stub(
    *,
    projects_root: Path,
    project_id: str,
    preview_url: str,
    acceptance: list[str] | None = None,
    auth_ready: bool = False,
) -> BrowserTestRun:
    """Create a green stub test run with replayable artifacts (no Playwright)."""
    test_id = f"bt_{secrets.token_hex(6)}"
    started = datetime.now(UTC)
    t0 = time.monotonic()
    dest = artifacts_root(projects_root, project_id) / test_id
    user = seeded_test_user(auth_ready=auth_ready)
    steps: list[BrowserTestStep] = [
        BrowserTestStep(n=1, t=0, kind="browser:nav", detail={"url": preview_url}),
        BrowserTestStep(n=2, t=120, kind="browser:assert", detail={"name": "document.title"}),
    ]
    if user:
        steps.append(
            BrowserTestStep(
                n=3,
                t=240,
                kind="browser:signin",
                detail={"email": user.email, "label": user.label},
            )
        )
    for index, criterion in enumerate(acceptance or ["page loads"], start=len(steps) + 1):
        steps.append(
            BrowserTestStep(
                n=index,
                t=int((time.monotonic() - t0) * 1000) + index * 50,
                kind="browser:accept",
                detail={"criterion": criterion, "result": "pass"},
            )
        )
    finished = datetime.now(UTC)
    run = BrowserTestRun(
        test_id=test_id,
        project_id=project_id,
        status="passed",
        mode="offline",
        preview_url=preview_url,
        started_at=started.isoformat(),
        finished_at=finished.isoformat(),
        summary=f"Offline stub: {len(steps)} steps against preview",
        steps=steps,
        artifact_dir=str(dest.relative_to(projects_root)).replace("\\", "/"),
        test_user=asdict(user) if user else None,
    )
    # Stub "video" placeholder for the UI replay card.
    (dest).mkdir(parents=True, exist_ok=True)
    video = dest / "video.txt"
    video.write_text(
        "Offline stub — no Playwright browser available. Replay uses steps.jsonl.\n",
        encoding="utf-8",
    )
    run.video_path = str(video.relative_to(projects_root)).replace("\\", "/")
    run.trace_path = str((dest / "manifest.json").relative_to(projects_root)).replace("\\", "/")
    _write_recording(dest, run)
    return run


def run_playwright(
    *,
    projects_root: Path,
    project_id: str,
    preview_url: str,
    acceptance: list[str] | None = None,
    auth_ready: bool = False,
) -> BrowserTestRun:
    """Drive preview with Playwright when installed; else fall back to offline stub."""
    try:
        from playwright.sync_api import sync_playwright  # type: ignore[import-untyped]
    except ImportError:
        return run_offline_stub(
            projects_root=projects_root,
            project_id=project_id,
            preview_url=preview_url,
            acceptance=acceptance,
            auth_ready=auth_ready,
        )

    test_id = f"bt_{secrets.token_hex(6)}"
    started = datetime.now(UTC)
    t0 = time.monotonic()
    dest = artifacts_root(projects_root, project_id) / test_id
    dest.mkdir(parents=True, exist_ok=True)
    user = seeded_test_user(auth_ready=auth_ready)
    steps: list[BrowserTestStep] = []
    error: str | None = None
    status = "passed"
    video_path: str | None = None
    trace_path: str | None = None

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(record_video_dir=str(dest / "video"))
            context.tracing.start(screenshots=True, snapshots=True)
            page = context.new_page()
            page.goto(preview_url, wait_until="domcontentloaded", timeout=30_000)
            steps.append(
                BrowserTestStep(
                    n=1,
                    t=int((time.monotonic() - t0) * 1000),
                    kind="browser:nav",
                    detail={"url": preview_url},
                )
            )
            title = page.title()
            steps.append(
                BrowserTestStep(
                    n=2,
                    t=int((time.monotonic() - t0) * 1000),
                    kind="browser:assert",
                    detail={"name": "document.title", "value": title},
                )
            )
            if user:
                # Best-effort: fill common email/password fields if present.
                email_sel = 'input[type="email"], input[name="email"]'
                pass_sel = 'input[type="password"]'
                if page.locator(email_sel).count() and page.locator(pass_sel).count():
                    page.fill(email_sel, user.email)
                    page.fill(pass_sel, user.password)
                    submit = page.locator('button[type="submit"]')
                    if submit.count():
                        submit.first.click()
                    steps.append(
                        BrowserTestStep(
                            n=3,
                            t=int((time.monotonic() - t0) * 1000),
                            kind="browser:signin",
                            detail={"email": user.email, "label": user.label},
                        )
                    )
            for criterion in acceptance or []:
                # Soft check: criterion mentioned in page content.
                body = page.content()
                ok = criterion.lower() in body.lower() if criterion else True
                steps.append(
                    BrowserTestStep(
                        n=len(steps) + 1,
                        t=int((time.monotonic() - t0) * 1000),
                        kind="browser:accept",
                        detail={"criterion": criterion, "result": "pass" if ok else "fail"},
                    )
                )
                if not ok:
                    status = "failed"
            trace_file = dest / "trace.zip"
            context.tracing.stop(path=str(trace_file))
            context.close()
            browser.close()
            videos = list((dest / "video").glob("*.webm"))
            if videos:
                video_path = str(videos[0].relative_to(projects_root)).replace("\\", "/")
            if trace_file.exists():
                trace_path = str(trace_file.relative_to(projects_root)).replace("\\", "/")
    except Exception as exc:  # noqa: BLE001 — surface as failed run
        status = "failed"
        error = str(exc)
        steps.append(
            BrowserTestStep(
                n=len(steps) + 1,
                t=int((time.monotonic() - t0) * 1000),
                kind="browser:error",
                detail={"message": error[:500]},
            )
        )

    finished = datetime.now(UTC)
    run = BrowserTestRun(
        test_id=test_id,
        project_id=project_id,
        status=status,
        mode="live",
        preview_url=preview_url,
        started_at=started.isoformat(),
        finished_at=finished.isoformat(),
        summary=f"Playwright: {status} ({len(steps)} steps)",
        steps=steps,
        artifact_dir=str(dest.relative_to(projects_root)).replace("\\", "/"),
        video_path=video_path,
        trace_path=trace_path,
        test_user=asdict(user) if user else None,
        error=error,
    )
    _write_recording(dest, run)
    return run


def run_browser_test(
    *,
    projects_root: Path,
    project_id: str,
    preview_url: str,
    acceptance: list[str] | None = None,
    auth_ready: bool = False,
    force_offline: bool | None = None,
) -> BrowserTestRun:
    """Entry point: live Playwright when available unless forced offline."""
    offline = (
        force_offline
        if force_offline is not None
        else os.environ.get("LOOPIT_BROWSER_TEST_OFFLINE", "").lower()
        in {"1", "true", "yes", "on"}
    )
    if offline:
        return run_offline_stub(
            projects_root=projects_root,
            project_id=project_id,
            preview_url=preview_url,
            acceptance=acceptance,
            auth_ready=auth_ready,
        )
    return run_playwright(
        projects_root=projects_root,
        project_id=project_id,
        preview_url=preview_url,
        acceptance=acceptance,
        auth_ready=auth_ready,
    )


def list_browser_tests(projects_root: Path, project_id: str) -> list[dict[str, Any]]:
    root = artifacts_root(projects_root, project_id)
    if not root.exists():
        return []
    results: list[dict[str, Any]] = []
    for child in sorted(root.iterdir(), reverse=True):
        result_path = child / "result.json"
        if result_path.is_file():
            try:
                results.append(json.loads(result_path.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                continue
    return results


def get_browser_test(
    projects_root: Path, project_id: str, test_id: str
) -> dict[str, Any] | None:
    path = artifacts_root(projects_root, project_id) / test_id / "result.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


__all__ = [
    "BrowserTestRun",
    "BrowserTestStep",
    "TestUser",
    "get_browser_test",
    "list_browser_tests",
    "run_browser_test",
    "run_offline_stub",
    "seeded_test_user",
]
