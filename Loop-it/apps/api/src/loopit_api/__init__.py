"""Local preview API for Loop-it.

Wraps the real agent loop in an HTTP surface so the product can be used and
judged before Phase 3 builds durable orchestration behind it. Nothing here
reimplements platform logic: it starts a loop, streams the audit records that
loop already emits, and serves the files the run produced.
"""

from .app import build_default_app, create_app, live_model_factory, offline_model_factory
from .runs import RunManager, RunRequest, RunState
from .workspace import Workspace, WorkspaceError, resolve_in_workspace

__all__ = [
    "RunManager",
    "RunRequest",
    "RunState",
    "Workspace",
    "WorkspaceError",
    "build_default_app",
    "create_app",
    "live_model_factory",
    "offline_model_factory",
    "resolve_in_workspace",
]
